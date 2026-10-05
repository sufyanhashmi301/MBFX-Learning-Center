// The account pages' addresses and limits (ADR-123, ADR-125), split from
// account.ts (changes-62 #2).
//
// ZOD-FREE ON PURPOSE: the public header and mobile nav read ACCOUNT_PATH on
// every page, and account.ts builds schemas at load time, which drags all of
// Zod into the bundle. Keep schemas out of this file.

/** The page's address, locale-less — `@repo/i18n`'s `Link` prefixes it. */
export const ACCOUNT_PATH = "/account";

/** Progress and history, the account's second page (ADR-125). Locale-less. */
export const ACCOUNT_PROGRESS_PATH = "/account/progress";

/**
 * A learner's picture, in bytes. Well under the library's IMAGE ceiling
 * (`media.maxBytes.image`, 5 MB by default): the avatar renders at 80px at
 * most, and a public upload endpoint gets the narrower budget.
 */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

/**
 * How many rows each history band on `/account/progress` LOADS (ADR-125).
 * Raised in changes-42, when the bands gained a pager: a band now shows
 * `ACCOUNT_PROGRESS_PAGE_SIZE` rows at a time, so the cap is how far back the
 * history reaches rather than how much of it sits on screen.
 */
export const ACCOUNT_RECENT_COURSES = 48;
export const ACCOUNT_RECENT_QUIZ_ATTEMPTS = 100;
export const ACCOUNT_RECENT_READS = 100;
/** ADR-134 — lessons opened while signed in, most recent first. */
export const ACCOUNT_RECENT_LESSON_READS = 100;
/** Rows per page in each paged history band (changes-42). */
export const ACCOUNT_PROGRESS_PAGE_SIZE = 6;
