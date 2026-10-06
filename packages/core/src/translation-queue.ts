// Enqueueing translation work (ADR-161 #1). Deliberately tiny and free of
// entity code, so every service that saves translatable content can import
// it without importing the job handlers (and so without an import cycle).
import { db } from "@repo/db";
import { enqueueTranslationJobs } from "@repo/translate";

/**
 * The locales content is machine-translated INTO: every active locale except
 * the default. Only an active locale is served (ADR-091), so translating for
 * an inactive one would spend money on pages nobody can open; activating a
 * locale backfills instead (ADR-162 #9).
 */
export async function translationTargetLocales(): Promise<string[]> {
  const rows = await db.locale.findMany({
    where: { isActive: true, isDefault: false },
    select: { code: true },
    orderBy: { code: "asc" },
  });
  return rows.map((row) => row.code);
}

/**
 * One job per target locale for this entity. Idempotent and cheap: with no
 * active non-default locale it writes nothing, which is the state of a
 * single-language install.
 */
export async function enqueueEntityTranslations(
  entityType: string,
  entityId: string,
): Promise<void> {
  const locales = await translationTargetLocales();
  if (locales.length === 0) return;
  await enqueueTranslationJobs(locales.map((locale) => ({ entityType, entityId, locale })));
}

/**
 * Where each translatable type keeps its translations: the table (as mapped)
 * and its FK column. One list, read by the services' sweep below and by the
 * engine's declarations, so the two cannot name different tables. Code
 * constants, never input — they are interpolated into SQL.
 */
export const TRANSLATION_TABLES = {
  article: { table: "article_translations", fk: "articleId" },
  course: { table: "course_translations", fk: "courseId" },
  course_section: { table: "course_section_translations", fk: "sectionId" },
  lesson: { table: "lesson_translations", fk: "lessonId" },
  glossary_term: { table: "glossary_term_translations", fk: "termId" },
  glossary_topic: { table: "glossary_topic_translations", fk: "topicId" },
  video_topic: { table: "video_topic_translations", fk: "topicId" },
  video_category: { table: "video_category_translations", fk: "categoryId" },
  tool: { table: "tool_translations", fk: "toolId" },
  article_category: { table: "article_category_translations", fk: "categoryId" },
  article_tag: { table: "article_tag_translations", fk: "tagId" },
  menu_item: { table: "menu_item_translations", fk: "menuItemId" },
  quiz: { table: "quiz_translations", fk: "quizId" },
  quiz_question: { table: "quiz_question_translations", fk: "questionId" },
  // ADR-167 #6, changes-52 P6.
  promotion: { table: "promotion_translations", fk: "promotionId" },
  // ADR-165: the English is `settings.value`, not a row here.
  setting: { table: "setting_translations", fk: "settingId" },
} as const;

export type TranslatableEntityType = keyof typeof TRANSLATION_TABLES;

/**
 * A Sync "reset" (ADR-191): forgets which English every MACHINE translation
 * in one language was made from, so the next backfill re-translates each in
 * place — every job handler skips a machine row only while its hash matches.
 * Nothing is deleted, so pages keep their text until the new one lands, and a
 * person's row (any other status) is not touched. Returns the rows marked.
 */
export async function markMachineTranslationsForRedo(locale: string): Promise<number> {
  let marked = 0;
  for (const { table } of Object.values(TRANSLATION_TABLES)) {
    marked += await db.$executeRawUnsafe(
      `UPDATE ${table} SET sourceHash = NULL WHERE locale = ? AND translationStatus = 'MACHINE_TRANSLATED'`,
      locale,
    );
  }
  return marked;
}

/**
 * After a person saved the ENGLISH text of an entity (ADR-161 #3/#4): a
 * person's TRANSLATED sibling whose hash no longer matches — or was never
 * known — becomes OUTDATED; a MACHINE_TRANSLATED one is left for the job,
 * which the enqueue arranges. The other human states are not touched: that is
 * what keeps a machine row from turning OUTDATED, which would make stale
 * machine text indexable (ADR-159 #2). `currentHash` is the hash of the source
 * as saved; null skips the sweep and only enqueues.
 */
export async function afterSourceSave(
  type: TranslatableEntityType,
  entityId: string,
  currentHash: string | null,
  defaultLocale: string,
  // False for a source with nothing to translate (an empty setting): the
  // sweep still flags a person's stale row, nothing queues.
  options: { enqueue?: boolean } = {},
): Promise<void> {
  const { table, fk } = TRANSLATION_TABLES[type];
  if (currentHash !== null) {
    await db.$executeRawUnsafe(
      `UPDATE ${table} SET translationStatus = 'OUTDATED'
        WHERE ${fk} = ? AND locale <> ? AND translationStatus = 'TRANSLATED'
          AND (sourceHash IS NULL OR sourceHash <> ?)`,
      entityId,
      defaultLocale,
      currentHash,
    );
  }
  if (options.enqueue ?? true) await enqueueEntityTranslations(type, entityId);
}
