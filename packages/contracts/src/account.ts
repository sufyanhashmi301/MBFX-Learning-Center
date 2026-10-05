// The learner profile page (ADR-123): its inputs, its views, and the one pure
// decision it makes — which lesson "Resume" points at.
//
// Nothing here carries a `userId`. Every self-service input is scoped to the
// session that submitted it (security.md #7), so the id is not a field a
// caller could fill in: the route or action reads it from `auth()` and the
// schema has nowhere to put a second one.
import { z } from "zod";
import { MAX_PASSWORD_LENGTH } from "./auth.ts";
import { changeOwnPasswordSchema, updateOwnProfileSchema } from "./admin.ts";
import { COUNTRY_CODES } from "./countries.ts";

// ─── Inputs ──────────────────────────────────────────────────

/** The read beacon's body. An id and nothing else — the reader is the session. */
export const articleReadSchema = z.object({
  articleId: z.string().trim().min(1).max(191),
});
export type ArticleReadInput = z.infer<typeof articleReadSchema>;

/** The earliest birthday the form accepts (ADR-155 #6). */
export const BIRTH_DATE_MIN = "1900-01-01";

/**
 * Today as `YYYY-MM-DD` at the far east of the date line (UTC+14), so a reader
 * whose local date is already tomorrow's UTC date can still enter today.
 */
export function latestBirthDate(now: Date = new Date()): string {
  return new Date(now.getTime() + 14 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** A real calendar date as `YYYY-MM-DD` — rejects `2026-02-30`, which `Date` would roll over. */
function isCalendarDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * A date of birth (ADR-155 #6): a DATE, never a timestamp, between 1900 and
 * today. No minimum age — that is policy, not validation.
 */
export const birthDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isCalendarDate)
  .refine((value) => value >= BIRTH_DATE_MIN && value <= latestBirthDate());

/** An optional free-text field: trimmed, and blank means "not given" (null). */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => (value === "" ? null : value));

/**
 * Name, phone and birthday. EXTENDS the staff profile's schema (ADR-155 #5),
 * so the two still agree on every rule about a name; the birthday is the
 * learner's alone.
 */
export const learnerProfileSchema = updateOwnProfileSchema.extend({
  birthDate: z.union([birthDateSchema, z.literal("").transform(() => null), z.null()]).optional(),
});
export type LearnerProfileInput = z.infer<typeof learnerProfileSchema>;

/** The postal address, saved on its own (ADR-155 #5). Every line is optional. */
export const learnerAddressSchema = z.object({
  addressLine1: optionalText(200),
  addressLine2: optionalText(200),
  city: optionalText(100),
  region: optionalText(100),
  postalCode: optionalText(20),
  country: z
    .union([z.enum(COUNTRY_CODES), z.literal("").transform(() => null), z.null()])
    .optional(),
});
export type LearnerAddressInput = z.infer<typeof learnerAddressSchema>;

/**
 * The change-email form (ADR-155 #1). The body Better Auth's `/change-email`
 * takes — the callback is added by the caller, never typed by the reader.
 */
export const changeEmailFormSchema = z.object({
  newEmail: z.string().trim().toLowerCase().pipe(z.email().max(255)),
});

/**
 * The change-password FORM: Better Auth's own body plus the confirmation,
 * which never leaves the browser. The refinement is on the confirmation path
 * so the message lands under that field.
 */
export const changePasswordFormSchema = changeOwnPasswordSchema
  .extend({ confirmPassword: z.string().min(1) })
  .refine((value) => value.newPassword === value.confirmPassword, {
    path: ["confirmPassword"],
  });

/** Enabling or disabling two-factor asks for the password again (Better Auth requires it). */
export const twoFactorPasswordSchema = z.object({
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});

/**
 * A six-digit authenticator code. Spaces are stripped first: apps display the
 * code as `123 456`, and a reader who types what they see is not wrong.
 */
export const twoFactorCodeSchema = z.object({
  code: z
    .string()
    .transform((value) => value.replace(/\s+/g, ""))
    .pipe(z.string().regex(/^\d{6}$/)),
});

// ─── Views ───────────────────────────────────────────────────

export interface AccountProfileView {
  name: string;
  email: string;
  emailVerified: boolean;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  image: string | null;
  /** `YYYY-MM-DD`, or null (ADR-155). */
  birthDate: string | null;
  address: AccountAddressView;
  twoFactorEnabled: boolean;
  /** False for an OAuth-only account: there is no password to change or to confirm 2FA with. */
  hasPassword: boolean;
  createdAt: string;
}

export interface AccountAddressView {
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  /** ISO 3166-1 alpha-2, or null. */
  country: string | null;
}

/** The facts the completeness meter counts, in the order it lists what is missing. */
export const PROFILE_COMPLETENESS_ITEMS = [
  "picture",
  "fullName",
  "phone",
  "birthDate",
  "address",
  "emailVerified",
] as const;
export type ProfileCompletenessItem = (typeof PROFILE_COMPLETENESS_ITEMS)[number];

/**
 * How much of the profile is filled in (ADR-155). An address counts once it
 * has a first line, a city and a country — enough to post something to; a
 * full name needs both halves.
 */
export function profileCompleteness(
  profile: Pick<
    AccountProfileView,
    "image" | "firstName" | "lastName" | "phone" | "birthDate" | "address" | "emailVerified"
  >,
): { percent: number; missing: ProfileCompletenessItem[] } {
  const filled: Record<ProfileCompletenessItem, boolean> = {
    picture: Boolean(profile.image),
    fullName: Boolean(profile.firstName && profile.lastName),
    phone: Boolean(profile.phone),
    birthDate: Boolean(profile.birthDate),
    address: Boolean(
      profile.address.addressLine1 && profile.address.city && profile.address.country,
    ),
    emailVerified: profile.emailVerified,
  };
  const missing = PROFILE_COMPLETENESS_ITEMS.filter((item) => !filled[item]);
  const total = PROFILE_COMPLETENESS_ITEMS.length;
  return { percent: Math.round(((total - missing.length) / total) * 100), missing };
}

export interface AccountCourseView {
  courseId: string;
  track: string;
  title: string;
  /** Locale-less. */
  href: string;
  coverUrl: string | null;
  lessonsCompleted: number;
  lessonsTotal: number;
  percent: number;
  isCompleted: boolean;
  lastActiveAt: string;
  /** The lesson "Resume" opens, or null when every reachable lesson is done. */
  resume: { title: string; href: string } | null;
  /**
   * The course's final assessment and this learner's standing on it
   * (changes-42), or null when the course has none or its quiz is not publicly
   * reachable — the same null that stops it blocking completion (ADR-084 #8).
   */
  finalQuiz: {
    title: string;
    /** Locale-less. */
    href: string;
    passed: boolean;
    /** Best finished attempt, 0-100. Zero until one is finished. */
    bestPercentage: number;
    attempts: number;
  } | null;
}

export interface AccountQuizAttemptView {
  attemptId: string;
  title: string;
  href: string;
  percentage: number;
  passed: boolean;
  completedAt: string;
}

export interface AccountReadView {
  articleId: string;
  /** `ArticleKind` — NEWS, ANALYSIS, … — kept a string so contracts need no Prisma enum. */
  kind: string;
  title: string;
  href: string;
  coverImageUrl: string | null;
  readAt: string;
}

/** ADR-134 — one lesson the learner opened, with the course it belongs to. */
export interface AccountLessonReadView {
  lessonId: string;
  title: string;
  href: string;
  courseTitle: string;
  isCompleted: boolean;
  viewedAt: string;
}

/** Everything `/account/progress` shows (ADR-125); the profile is its own read. */
export interface LearnerActivityView {
  courses: AccountCourseView[];
  quizAttempts: AccountQuizAttemptView[];
  reads: AccountReadView[];
  lessonReads: AccountLessonReadView[];
  summary: LearnerProgressSummary;
}

/**
 * Whole-history totals for the progress page's summary row (changes-42).
 * COUNTED, not derived from the lists above: those are capped, and a total
 * read off a capped list stops being true the day a learner passes the cap.
 * Every count applies the same public rule its list does, so a course that was
 * unpublished leaves the total exactly as it leaves the list.
 */
export interface LearnerProgressSummary {
  coursesStarted: number;
  coursesCompleted: number;
  lessonsCompleted: number;
  /** Distinct quizzes with at least one passed attempt. */
  quizzesPassed: number;
  /** Finished attempts, passed or not. */
  quizAttempts: number;
  articlesRead: number;
}

// ─── The resume rule ─────────────────────────────────────────

export interface ResumeCandidate {
  id: string;
}

/**
 * Which lesson "Resume" opens, given the course's reachable lessons in reading
 * order and the ids this learner has completed.
 *
 * The lesson they were last in, when it is still incomplete — they left in
 * the middle of it. Otherwise the FIRST incomplete lesson in reading order,
 * not the one after `lastLessonId`: a learner who finished lesson 7 having
 * skipped lesson 3 is sent back to 3, because "resume" means "the next thing
 * you have not done", not "the next page".
 *
 * Null when every lesson is complete, or the course has none.
 */
export function pickResumeLesson<T extends ResumeCandidate>(
  lessons: readonly T[],
  completedIds: ReadonlySet<string>,
  lastLessonId: string | null,
): T | null {
  if (lastLessonId && !completedIds.has(lastLessonId)) {
    const last = lessons.find((lesson) => lesson.id === lastLessonId);
    if (last) return last;
  }
  return lessons.find((lesson) => !completedIds.has(lesson.id)) ?? null;
}
