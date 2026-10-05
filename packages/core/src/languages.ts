// Settings → Translation → Languages: create, edit and delete a language
// (ADR-178 #2). Switching one on or off stays `setLocaleActive`
// (`translation-admin.ts`, ADR-163), whose gates are unchanged.
//
// The callers have run `requirePermission("locales.manage")` and parsed the
// input with `@repo/contracts`. Every mutation writes one audit row and drops
// the `locales` cache tag, so the public switcher and every admin picker see
// the change at once.
import { db, type Prisma } from "@repo/db";
import { invalidateActiveLocales, invalidateMessages } from "@repo/i18n";
import { isOfferedLocale, supportedLocale } from "@repo/i18n/routing";
import type { LocaleDeleteInput, LocaleSaveInput } from "@repo/contracts";

import { recordAudit } from "./index.ts";

/**
 * Every table that holds content WRITTEN in a language, by Prisma delegate.
 * A language with a row in any of them is refused deletion (ADR-178 #2):
 * those are people's translations, and switching the language off keeps
 * them, where deleting it would not. `languages.test.ts` fails when a
 * `*Translation` model with a `locale` column is missing from this list.
 */
export const LANGUAGE_CONTENT_TABLES = [
  "settingTranslation",
  "menuItemTranslation",
  "courseTranslation",
  "courseSectionTranslation",
  "lessonTranslation",
  "quizTranslation",
  "quizQuestionTranslation",
  "glossaryTopicTranslation",
  "glossaryTermTranslation",
  "videoCategoryTranslation",
  "videoTopicTranslation",
  "articleCategoryTranslation",
  "articleTagTranslation",
  "articleTranslation",
  "pageTranslation",
  "emailTemplateTranslation",
  "toolTranslation",
  "promotionTranslation",
  "emailCampaignContent",
] as const;

type ContentTable = (typeof LANGUAGE_CONTENT_TABLES)[number];

/** The one shape every listed delegate shares; Prisma's union is not callable. */
interface LocaleGroupBy {
  groupBy(args: {
    by: ["locale"];
    _count: { _all: true };
  }): Promise<Array<{ locale: string; _count: { _all: number } }>>;
}

/** Content rows per language, summed over every table. One query per table. */
export async function countContentByLocale(
  client: Prisma.TransactionClient = db,
): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  const groups = await Promise.all(
    LANGUAGE_CONTENT_TABLES.map((table: ContentTable) =>
      (client[table] as unknown as LocaleGroupBy).groupBy({
        by: ["locale"],
        _count: { _all: true },
      }),
    ),
  );
  for (const rows of groups) {
    for (const row of rows) {
      totals.set(row.locale, (totals.get(row.locale) ?? 0) + row._count._all);
    }
  }
  return totals;
}

export type LocaleSaveRefusal = "unsupported" | "exists" | "notFound" | "invalidFallback";
export type LocaleDeleteRefusal = "notFound" | "isDefault" | "isActive" | "hasContent";

export type LocaleSaveResult = { ok: true } | { ok: false; reason: LocaleSaveRefusal };
export type LocaleDeleteResult =
  { ok: true } | { ok: false; reason: LocaleDeleteRefusal; contentRows?: number };

/** A fallback must be another existing language, never the language itself. */
async function fallbackIsValid(code: string, fallbackCode: string | null): Promise<boolean> {
  if (fallbackCode === null) return true;
  if (fallbackCode === code) return false;
  return (await db.locale.count({ where: { code: fallbackCode } })) === 1;
}

function editableFields(input: LocaleSaveInput) {
  return {
    name: input.name,
    nativeName: input.nativeName,
    flagEmoji: input.flagEmoji === "" ? null : input.flagEmoji,
    fallbackCode: input.fallbackCode,
    sortOrder: input.sortOrder,
  };
}

/**
 * Adds a language from the registry, switched OFF (ADR-178 #2). Its
 * direction is the registry's; a code the site cannot route is refused here
 * even though the form only offers registry codes, because the form is UX.
 */
export async function createLocale(
  userId: string,
  input: LocaleSaveInput,
): Promise<LocaleSaveResult> {
  const supported = supportedLocale(input.code);
  // ADR-188: routable is not enough; the language must be one the owner offers.
  if (!supported || !isOfferedLocale(input.code)) return { ok: false, reason: "unsupported" };
  if ((await db.locale.count({ where: { code: input.code } })) > 0) {
    return { ok: false, reason: "exists" };
  }
  if (!(await fallbackIsValid(input.code, input.fallbackCode))) {
    return { ok: false, reason: "invalidFallback" };
  }

  const data = {
    code: input.code,
    direction: supported.direction === "rtl" ? ("RTL" as const) : ("LTR" as const),
    isActive: false,
    isDefault: false,
    ...editableFields(input),
  };
  await db.locale.create({ data });
  await recordAudit({
    userId,
    action: "locales.create",
    entityType: "Locale",
    entityId: input.code,
    changes: { after: data },
  });
  await invalidateActiveLocales();
  return { ok: true };
}

/** Edits a language's names, flag, fallback and order. Never its code or direction. */
export async function updateLocale(
  userId: string,
  input: LocaleSaveInput,
): Promise<LocaleSaveResult> {
  const before = await db.locale.findUnique({
    where: { code: input.code },
    select: { name: true, nativeName: true, flagEmoji: true, fallbackCode: true, sortOrder: true },
  });
  if (!before) return { ok: false, reason: "notFound" };
  if (!(await fallbackIsValid(input.code, input.fallbackCode))) {
    return { ok: false, reason: "invalidFallback" };
  }

  const data = editableFields(input);
  await db.locale.update({ where: { code: input.code }, data });
  await recordAudit({
    userId,
    action: "locales.update",
    entityType: "Locale",
    entityId: input.code,
    changes: { before, after: data },
  });
  await invalidateActiveLocales();
  return { ok: true };
}

/**
 * Deletes a language that is not the default, not live, and has no content
 * written in it (ADR-178 #2). Its interface-text overrides go with it (the
 * foreign key cascades), and a language that fell back to it falls back to
 * nothing — one transaction, so a refusal found late changes nothing.
 */
export async function deleteLocale(
  userId: string,
  input: LocaleDeleteInput,
): Promise<LocaleDeleteResult> {
  type Outcome =
    | { ok: false; reason: LocaleDeleteRefusal; contentRows?: number }
    | { ok: true; name: string; overrides: number };
  const result = await db.$transaction(async (tx): Promise<Outcome> => {
    const row = await tx.locale.findUnique({
      where: { code: input.locale },
      select: { code: true, name: true, isActive: true, isDefault: true },
    });
    if (!row) return { ok: false, reason: "notFound" };
    if (row.isDefault) return { ok: false, reason: "isDefault" };
    if (row.isActive) return { ok: false, reason: "isActive" };
    const contentRows = (await countContentByLocale(tx)).get(row.code) ?? 0;
    if (contentRows > 0) return { ok: false, reason: "hasContent", contentRows };

    const overrides = await tx.messageOverride.count({ where: { locale: row.code } });
    await tx.locale.updateMany({
      where: { fallbackCode: row.code },
      data: { fallbackCode: null },
    });
    await tx.locale.delete({ where: { code: row.code } });
    return { ok: true, name: row.name, overrides };
  });
  if (!result.ok) return result;

  await recordAudit({
    userId,
    action: "locales.delete",
    entityType: "Locale",
    entityId: input.locale,
    changes: { before: { name: result.name, interfaceTextOverrides: result.overrides } },
  });
  await invalidateActiveLocales();
  await invalidateMessages();
  return { ok: true };
}
