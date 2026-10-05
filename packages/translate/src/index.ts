// @repo/translate — automatic translation through Google Cloud Translation
// Basic (v2) or DeepL (ADR-160, ADR-161, ADR-162, ADR-186).
//
// **One door.** `translateSegments` (and the two shapes over it,
// `translateTexts` and `translateHtml`) is the only way to reach the provider, and
// it meters every outcome. The driver and `loadTranslateDriver` are NOT
// exported: `index.test.ts` pins this surface, so a later export that hands a
// caller a second way in fails the suite.
//
// **Nothing here writes content.** Every result is returned to a caller that
// saves it under its own permission check and schema; the only rows this
// package writes are its own provider, usage and budget rows.

export {
  translateSegments,
  translateTexts,
  translateHtml,
  translateHtmlMany,
  DEFAULT_RETRY_DELAYS_MS,
  type TranslateOptions,
} from "./translate.ts";

export { TranslateError, isPausing, isTransient, reasonOf } from "./errors.ts";

export { numbersMatch, extractNumbers } from "./numbers.ts";

export type { GlossaryPair } from "./html.ts";

export {
  planMessage,
  rebuildMessage,
  translateCatalogMessages,
  PlaceholderMismatchError,
  UnsupportedMessageError,
  type CatalogTranslation,
  type MessagePlan,
  type RebuiltMessage,
} from "./icu.ts";

export {
  loadTranslateSettings,
  saveTranslateSettings,
  testTranslateConnection,
  getAutoTranslateProvider,
  isAutoTranslateAvailable,
  TEST_SAMPLE,
  type TranslateSettingsRefusal,
  type TranslateSettingsResult,
  type TranslateSettingsView,
} from "./settings.ts";

export { TRANSLATE_SECRET_KEY_ENV, hasTranslateSecretKey } from "./secret.ts";

export { currentPeriod, getPeriodUsage, recentRequestsBy, type PeriodUsage } from "./usage.ts";

export {
  enqueueTranslationJobs,
  claimJobs,
  recoverStaleJobs,
  runClaimedJobs,
  runTranslationQueue,
  nextBudgetPeriod,
  enqueueLocaleBackfill,
  expandBackfill,
  parseBackfillCursor,
  retryFailedJobs,
  countJobs,
  loadBackfillStates,
  listFailedJobs,
  purgeTranslationRows,
  BACKFILL_WILDCARD,
  BACKFILL_PAGE_SIZE,
  DEFAULT_CLAIM_LIMIT,
  LEASE_MS,
  MAX_ATTEMPTS,
  type BackfillSource,
  type BackfillState,
  type BackfillSummary,
  type FailedJob,
  type JobCount,
  type JobKindName,
  type JobStatusName,
  type ClaimedJob,
  type JobHandler,
  type JobHandlers,
  type JobKey,
  type JobOutcome,
  type RunSummary,
} from "./jobs.ts";
