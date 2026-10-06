// @repo/core — domain services (courses, glossary, tools, market).
// Route handlers never touch Prisma directly; they call services here.
// Implementation lands across Modules 08, 11, 13 (see plan.md Part D).
//
// recordAudit() is the one exception, added in Module 04 per ADR-011: every
// mutation writes an audit row (security.md #5), and @repo/rbac's own ADR
// put that responsibility here rather than in rbac itself.
import { db } from "@repo/db";

export * from "./navigation.ts";
export * from "./social-links.ts";
export * from "./review-platforms.ts";
export * from "./admin.ts";
export * from "./admin-reads.ts";
export * from "./users.ts";
export * from "./employees.ts";
export * from "./roles.ts";
export * from "./content.ts";
export * from "./public-content.ts";
export * from "./articles.ts";
export * from "./content-relations.ts";
export * from "./public-articles.ts";
// Automatic translation (ADR-160…163): enqueue, run, the article job, and the
// dashboard / languages / review services behind Settings → Translation.
export { enqueueEntityTranslations, translationTargetLocales } from "./translation-queue.ts";
export {
  runTranslationWork,
  runQuizTranslationWork,
  drainTranslationQueue,
  CRON_DRAIN_BUDGET_MS,
  TRANSLATION_JOB_HANDLERS,
  type DrainSummary,
} from "./translation-runner.ts";
export {
  fitTo,
  loadGlossaryPairs,
  translateArticleJob,
  articleSegments,
  articleSourceCharacters,
} from "./article-translation.ts";
export {
  TRANSLATABLE_TYPES,
  type ReviewRow,
  type ReviewStatus,
  type TranslatableType,
} from "./translatable-types.ts";
export { toCoverage, type CoverageBucket, type CoverageCounts } from "./translation-coverage.ts";
export * from "./translation-admin.ts";
export * from "./languages.ts";
export * from "./interface-text.ts";
// Translatable settings (ADR-165): the Site text editor and the English save's
// sweep.
export {
  afterSettingsSaved,
  loadSiteText,
  saveSettingTranslation,
  type SaveSettingTranslationResult,
  type SiteTextEntry,
  type SiteTextField,
} from "./site-text.ts";
export {
  prefillTranslation,
  PREFILL_REQUESTS_PER_MINUTE,
  type PrefillResult,
} from "./translation-prefill.ts";
export { hashArticleSource, loadArticleSource, type ArticleSource } from "./article-source.ts";
export * from "./article-search.ts";
export * from "./translation-indexing.ts";
export * from "./courses.ts";
export * from "./course-sections.ts";
export * from "./lessons.ts";
export * from "./public-courses.ts";
export * from "./progress.ts";
export * from "./lesson-feedback.ts";
export * from "./quiz-links.ts";
export * from "./quizzes.ts";
export * from "./videos.ts";
export * from "./learn-analytics.ts";
export * from "./learn-analytics-filter.ts";
export * from "./glossary-topics.ts";
export * from "./promotions.ts";
export * from "./promotion-stats.ts";
export * from "./public-search.ts";
export * from "./market.ts";
export * from "./market-admin.ts";
export * from "./market-analytics.ts";
export * from "./tools.ts";
export * from "./sitemap.ts";
export * from "./notifications.ts";
export * from "./search.ts";
export * from "./media.ts";
export * from "./brand-assets.ts";
export * from "./email-admin.ts";
export * from "./newsletter.ts";
export * from "./announcements.ts";
export * from "./announcement-runner.ts";
export * from "./custom-emails.ts";
export {
  countAudience,
  type AudienceContext,
  type AudienceCounts,
} from "./announcement-audience.ts";
export {
  courseAvailability,
  emailTrackCover,
  pickCourseWords,
  type TargetAvailability,
} from "./announcement-target.ts";
export * from "./support.ts";
export * from "./ai-admin.ts";
export * from "./ai-media.ts";
export * from "./purge.ts";
export * from "./cms/index.ts";

export interface RecordAuditInput {
  userId: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  changes?: { before?: unknown; after?: unknown };
  ipAddress?: string | null;
  userAgent?: string | null;
}

export async function recordAudit(input: RecordAuditInput): Promise<void> {
  await db.auditLog.create({
    data: {
      userId: input.userId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      changes: input.changes as never,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    },
  });
}
export * from "./account.ts";
