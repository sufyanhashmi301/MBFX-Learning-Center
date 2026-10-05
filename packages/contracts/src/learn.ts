// Learn-area contracts (Module 11/12, ADR-055 + ADR-056).
//
// Every course, section, lesson and progress mutation parses its input through
// these before any service call — "parse, don't spread" (security.md #6).
//
// Two rules in this file are load-bearing and are the reason it exists rather
// than the schemas living beside their services:
//
//   1. A course slug may never be a RESERVED_COURSE_SLUGS member, or the
//      course shadows a real route (ADR-055 #3).
//   2. A lesson must carry at least one capability, or an empty lesson can be
//      published (ADR-055 #4).
//
// Both are enforced here so the admin form, the server action and the service
// all fail identically, rather than in three slightly different ways.
import { z } from "zod";
import { ROUTE_PATHS } from "./routes.ts";

// ─── Tracks (ADR-055 #2) ─────────────────────────────────────
//
// A track is site STRUCTURE, which ADR-042 keeps in code — so it is a registry
// here, not a `LearningProgram` table. `Course.track` stores the key and is
// validated against this map; there is no FK because there is no row.

export interface LearnTrackSpec {
  /**
   * Message key RELATIVE to the public `learn` namespace (ADR-043 #1), the
   * same convention `MegaColumnSpec.titleKey` uses for `nav`. Held as a plain
   * string because @repo/contracts depends only on zod — it may not import
   * @repo/i18n, and `ROUTE_PATHS` sets the same precedent.
   */
  readonly titleKey: string;
  readonly descriptionKey: string;
  readonly sortOrder: number;
}

/**
 * Registered tracks. Both are registered from Phase 1 even though only one
 * course set may be prepared: a registry entry is code and costs nothing,
 * while a track with no published courses must render NO band at all
 * (ADR-055 #2) — which is a test, not a convention.
 *
 * The track ICON deliberately lives in the app, not here, following ADR-048's
 * split: `MEGA_MENU_ICONS` maps route keys to `LucideIcon` values in
 * `app/(public)/[locale]/_nav/`, because a lucide name held as a string in a
 * shared package is a key nothing validates and fails silently.
 */
export const LEARN_TRACKS = {
  forex: {
    titleKey: "tracks.forex.title",
    descriptionKey: "tracks.forex.description",
    sortOrder: 1,
  },
  crypto: {
    titleKey: "tracks.crypto.title",
    descriptionKey: "tracks.crypto.description",
    sortOrder: 2,
  },
} as const satisfies Record<string, LearnTrackSpec>;

export type LearnTrackKey = keyof typeof LEARN_TRACKS;

export function isLearnTrack(key: string): key is LearnTrackKey {
  return Object.prototype.hasOwnProperty.call(LEARN_TRACKS, key);
}

/** Track keys in display order — the one place band ordering is decided. */
export const LEARN_TRACK_KEYS: readonly LearnTrackKey[] = (
  Object.keys(LEARN_TRACKS) as LearnTrackKey[]
).sort((a, b) => LEARN_TRACKS[a].sortOrder - LEARN_TRACKS[b].sortOrder);

export const learnTrackSchema = z.enum(
  Object.keys(LEARN_TRACKS) as [LearnTrackKey, ...LearnTrackKey[]],
);

/**
 * A quiz belongs to exactly one track (ADR-065 §3): it needs a single
 * canonical URL under `/learn/<track>/quizzes/`, which cannot be built from a
 * null. A glossary term does NOT — "leverage" is forex and crypto both, and
 * `null` there means "show it in every track's glossary", never "unfiled".
 */
export const quizTrackSchema = learnTrackSchema;
export const glossaryTrackSchema = learnTrackSchema.nullable();

/** `/learn/<track>` — the school index (ADR-065 §1). */
export function learnTrackPath(track: LearnTrackKey): string {
  return `${ROUTE_PATHS.learn}/${track}`;
}

/** `/learn/<track>/videos` — the track's video library (ADR-068 §1). */
export function learnTrackVideosPath(track: LearnTrackKey): string {
  return `${learnTrackPath(track)}/videos`;
}

/**
 * `/learn/<track>/videos/categories/<slug>` — one category, narrowed to this
 * school. The category itself spans tracks (ADR-068 §1): it is taxonomy, not
 * address, so this is a filtered view the way `/learn/<track>/glossary` is.
 */
export function learnTrackVideoCategoryPath(track: LearnTrackKey, slug: string): string {
  return `${learnTrackVideosPath(track)}/categories/${slug}`;
}

/** `/learn/<track>/quizzes` — the track's standalone quiz index. */
export function learnTrackQuizzesPath(track: LearnTrackKey): string {
  return `${learnTrackPath(track)}/quizzes`;
}

/**
 * `/learn/<track>/quizzes/<slug>` — ONE quiz.
 *
 * **The only way a surface outside the quiz index builds a quiz href**
 * (ADR-084 #1). Three of them do now — a course's final assessment, a
 * `QUIZ_PASS` lesson, and the lesson pager's forward step — and all three are
 * reading a quiz that belongs to a COURSE, whose track may not be the quiz's.
 * `Quiz.track` is required and independent (ADR-065 §3), so a href built from
 * the course's track 404s on a forex course pointing at a crypto quiz. Taking
 * the track as an argument makes that impossible to get wrong silently, and
 * `learn/quiz-links.test.ts` fails any call site that goes back to a template
 * literal.
 */
export function quizLinkPath(track: LearnTrackKey, slug: string): string {
  return `${learnTrackQuizzesPath(track)}/${slug}`;
}

/** `/learn/<track>/glossary` — the track's A–Z view onto the shared glossary. */
export function learnTrackGlossaryPath(track: LearnTrackKey): string {
  return `${learnTrackPath(track)}/glossary`;
}

// ─── Reserved slugs (ADR-055 #3) ─────────────────────────────

/**
 * Course slugs that would shadow a real route under `/learn/<track>/`.
 * `quizzes` is the standalone quiz index, `glossary` is the track's A–Z view
 * (ADR-065 §1) and `videos` is its video library (ADR-068 §1); a course
 * slugged any of them would be unreachable behind the static segment, so it is
 * rejected at WRITE time rather than discovered at read time.
 */
export const RESERVED_COURSE_SLUGS = ["quizzes", "glossary", "videos"] as const;
export type ReservedCourseSlug = (typeof RESERVED_COURSE_SLUGS)[number];

export function isReservedCourseSlug(slug: string): slug is ReservedCourseSlug {
  return (RESERVED_COURSE_SLUGS as readonly string[]).includes(slug.trim().toLowerCase());
}

/**
 * The same rule one section over (Phase 10, D27). `/glossary/topics` is a
 * static route segment, so a TERM slugged "topics" would sit behind it and be
 * unreachable. Rejected at write time rather than discovered at read time.
 */
export const RESERVED_GLOSSARY_SLUGS = ["topics"] as const;
export type ReservedGlossarySlug = (typeof RESERVED_GLOSSARY_SLUGS)[number];

export function isReservedGlossarySlug(slug: string): slug is ReservedGlossarySlug {
  return (RESERVED_GLOSSARY_SLUGS as readonly string[]).includes(slug.trim().toLowerCase());
}

/**
 * And once more, one level under `/learn/<track>/videos` (ADR-068 §1).
 * `categories` is a static segment ahead of `[topic]`, so a topic slugged
 * "categories" would never be reached.
 */
export const RESERVED_VIDEO_SLUGS = ["categories"] as const;
export type ReservedVideoSlug = (typeof RESERVED_VIDEO_SLUGS)[number];

export function isReservedVideoSlug(slug: string): slug is ReservedVideoSlug {
  return (RESERVED_VIDEO_SLUGS as readonly string[]).includes(slug.trim().toLowerCase());
}

// ─── External URLs (ADR-055 #5) ──────────────────────────────

/**
 * An external resource URL. Stored, never fetched — `security.md` #9 forbids
 * resolving arbitrary URLs server-side (SSRF), so there is no preview, no
 * oEmbed and no redirect following anywhere in the learning code.
 *
 * A bare `z.url()` is NOT enough: it accepts `javascript:` and `data:`, both of
 * which reach an `href` if we let them. Zod v4's `protocol` option pins the
 * scheme at parse time — checked against the URL parser's normalised protocol
 * rather than by a string prefix, so a crafted value cannot slip past on
 * casing or whitespace.
 */
export const externalUrlSchema = z.url({ protocol: /^https$/ }).max(500);

const idSchema = z.string().min(1).max(64);
const localeSchema = z.string().min(2).max(10);

// ─── Courses ─────────────────────────────────────────────────

export const courseDifficultySchema = z.enum(["BEGINNER", "INTERMEDIATE", "ADVANCED"]);
export const contentVisibilitySchema = z.enum(["PUBLIC", "AUTHENTICATED", "PREMIUM"]);

// Exported so an admin form can hold these in state WITHOUT casting a plain
// string back into the payload. A cast there would compile against a select
// whose options later drift; a named type makes that drift a type error.
export type CourseDifficulty = z.infer<typeof courseDifficultySchema>;
export type ContentVisibility = z.infer<typeof contentVisibilitySchema>;

export const createCourseSchema = z.object({
  track: learnTrackSchema,
  /** Default-locale title — the service creates base row + translation together. */
  title: z.string().trim().min(1).max(255),
});
export type CreateCourseInput = z.infer<typeof createCourseSchema>;

/**
 * ADR-139 — the article's three flags, on every learning content type.
 * `isActive` joins the type's public rule (it hides without touching status),
 * `isFeatured` is placement, `isPremium` is stored and labelled, not enforced.
 * Each is optional, so a save that does not send one leaves it alone.
 */
export const contentFlagsSchema = z.object({
  isFeatured: z.boolean().optional(),
  isActive: z.boolean().optional(),
  isPremium: z.boolean().optional(),
});
export type ContentFlagsInput = z.infer<typeof contentFlagsSchema>;

export const courseMetaSchema = z
  .object({
    track: learnTrackSchema.optional(),
    difficulty: courseDifficultySchema.optional(),
    estimatedHours: z.int().min(0).max(999).nullable().optional(),
    /** MediaAsset id, not a URL (ADR-055 #6). */
    coverAssetId: idSchema.nullable().optional(),
    /** An external course: the CTA points outward and the curriculum is optional. */
    externalUrl: externalUrlSchema.nullable().optional(),
    visibility: contentVisibilitySchema.optional(),
    sortOrder: z.int().min(0).max(9999).optional(),
    /**
     * The course's final quiz (ADR-056 #7 / ADR-058 #1). `null` detaches — the
     * picker's "No quiz" option, which is a value rather than a missing field.
     */
    finalQuizId: idSchema.nullable().optional(),
  })
  .extend(contentFlagsSchema.shape);
export type CourseMetaInput = z.infer<typeof courseMetaSchema>;

/**
 * A slug that is syntactically fine but reserved. The refinement is on the
 * translation schema, not on a bare string schema, because the reservation is
 * a property of "a course's slug", not of slugs in general — a SECTION could
 * legitimately be titled "Quizzes".
 */
/**
 * A course's FAQ (changes-49, ADR-147) — the glossary term's shape and caps,
 * restated here rather than imported because `glossary.ts` already imports
 * from this file. Plain text: the editor is a textarea, like the glossary's.
 */
export const COURSE_FAQ_MAX = 12;
export const courseFaqSchema = z
  .array(
    z.object({
      question: z.string().trim().min(1).max(300),
      answer: z.string().trim().min(1).max(5000),
    }),
  )
  .max(COURSE_FAQ_MAX);
export type CourseFaqItem = z.infer<typeof courseFaqSchema>[number];

export const courseTranslationSchema = z
  .object({
    // No `courseId` here on purpose. This schema is only ever nested inside
    // `courseInputSchema`, which already carries the id — repeating it would
    // let one payload name two different courses, and the service would have
    // to pick a winner. The id belongs to the envelope, not the translation.
    locale: localeSchema,
    title: z.string().trim().min(1).max(255),
    slug: z.string().trim().max(255).optional(),
    summary: z.string().trim().max(1000).nullable().optional(),
    description: z.string().max(200_000).nullable().optional(),
    seoTitle: z.string().trim().max(70).nullable().optional(),
    seoDescription: z.string().trim().max(180).nullable().optional(),
    seoFocusKeyword: z.string().trim().max(100).nullable().optional(),
    /** Omitted = leave the stored FAQ alone; `[]` = the author removed it all. */
    faq: courseFaqSchema.optional(),
    /**
     * This locale's text came from AI and has not been edited since (changes-29
     * B3, as `saveArticleTranslationSchema` has it). The save writes
     * `MACHINE_TRANSLATED` instead of `TRANSLATED`, which keeps it out of search
     * indexes and hreflang (ADR-159 #2) until a human's Save promotes it.
     */
    machineTranslated: z.boolean().optional(),
  })
  .refine((value) => value.slug === undefined || !isReservedCourseSlug(value.slug), {
    message: `slug is reserved (${RESERVED_COURSE_SLUGS.join(", ")}) and would shadow a route`,
    path: ["slug"],
  });
export type CourseTranslationInput = z.infer<typeof courseTranslationSchema>;

/**
 * Meta + translation + recommendations in one payload so `saveCourse` commits
 * in ONE transaction — the shape `saveArticleSchema` established.
 *
 * `recommendations` is optional and MEANS SOMETHING when present: an empty
 * array clears the set, `undefined` leaves it untouched. That distinction
 * matters because the curriculum tab and the recommendations tab save
 * separately, and a save from the former must not wipe the latter.
 */
export const courseInputSchema = z.object({
  courseId: idSchema,
  meta: courseMetaSchema,
  translation: courseTranslationSchema,
  recommendations: z.array(idSchema).max(12).optional(),
});
export type CourseInput = z.infer<typeof courseInputSchema>;

/**
 * Ordered recommendation targets. Array POSITION is the display order, and the
 * set is a full replacement, never a merge — both are `replaceRelations()`'s
 * existing semantics (ADR-055 relies on `ContentRelation`, so there is no new
 * table and no new service here).
 */
export const recommendationsSchema = z.object({
  courseId: idSchema,
  targetIds: z.array(idSchema).max(12),
});
export type RecommendationsInput = z.infer<typeof recommendationsSchema>;

export const reorderSchema = z.object({
  ids: z.array(idSchema).max(500),
});
export type ReorderInput = z.infer<typeof reorderSchema>;

// ─── Sections (ADR-055 #1) ───────────────────────────────────

export const sectionInputSchema = z.object({
  sectionId: idSchema,
  isPublished: z.boolean().optional(),
  sortOrder: z.int().min(0).max(9999).optional(),
  translation: z.object({
    locale: localeSchema,
    title: z.string().trim().min(1).max(255),
    description: z.string().trim().max(1000).nullable().optional(),
  }),
});
export type SectionInput = z.infer<typeof sectionInputSchema>;

export const reorderSectionsSchema = z.object({
  courseId: idSchema,
  sectionIds: z.array(idSchema).max(200),
});
export type ReorderSectionsInput = z.infer<typeof reorderSectionsSchema>;

// ─── Lessons ─────────────────────────────────────────────────

export const completionRuleSchema = z.enum(["MANUAL", "QUIZ_PASS"]);

/**
 * One attachment placement. Full replacement set — the service diffs it
 * against stored rows and syncs `ContentReference` so `deleteMedia()`'s in-use
 * guard sees course media (ADR-055 #6).
 */
export const lessonAttachmentSchema = z.object({
  assetId: idSchema,
  label: z.string().trim().max(200).nullable().optional(),
});
export type LessonAttachmentInput = z.infer<typeof lessonAttachmentSchema>;

export const lessonAttachmentsSchema = z.object({
  lessonId: idSchema,
  items: z.array(lessonAttachmentSchema).max(20),
});
export type LessonAttachmentsInput = z.infer<typeof lessonAttachmentsSchema>;

export const lessonMetaSchema = z
  .object({
    difficulty: courseDifficultySchema.optional(),
    estimatedMinutes: z.int().min(0).max(6000).nullable().optional(),
    /**
     * Provider whitelist (YouTube/Vimeo/Dailymotion) is enforced in the service
     * via @repo/utils `parseVideoUrl` — the contract only shapes it, exactly as
     * `updateArticleMetaSchema.videoUrl` already does.
     */
    videoUrl: externalUrlSchema.nullable().optional(),
    externalUrl: externalUrlSchema.nullable().optional(),
    heroAssetId: idSchema.nullable().optional(),
    completionRule: completionRuleSchema.optional(),
    isRequired: z.boolean().optional(),
    prerequisiteLessonId: idSchema.nullable().optional(),
    /**
     * The lesson's quiz (ADR-058 #1). Pairing it with
     * `completionRule: "QUIZ_PASS"` is what makes passing complete the lesson;
     * a quiz attached to a MANUAL lesson is simply extra practice, which is a
     * legitimate thing to want and is why the two fields are independent.
     */
    quizId: idSchema.nullable().optional(),
    visibility: contentVisibilitySchema.optional(),
    sortOrder: z.int().min(0).max(9999).optional(),
  })
  .extend(contentFlagsSchema.shape);
export type LessonMetaInput = z.infer<typeof lessonMetaSchema>;

export const lessonTranslationSchema = z.object({
  locale: localeSchema,
  title: z.string().trim().min(1).max(255),
  slug: z.string().trim().max(255).optional(),
  summary: z.string().trim().max(1000).nullable().optional(),
  /** Sanitized server-side on save, always (security.md #8). This cap only bounds the payload. */
  content: z.string().max(400_000).nullable().optional(),
  learningObjectives: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
  seoTitle: z.string().trim().max(70).nullable().optional(),
  seoDescription: z.string().trim().max(180).nullable().optional(),
  seoFocusKeyword: z.string().trim().max(100).nullable().optional(),
  /**
   * This locale's text came from AI and has not been edited since (changes-29
   * B3, as `saveArticleTranslationSchema` has it). The save writes
   * `MACHINE_TRANSLATED` instead of `TRANSLATED`, which keeps it out of search
   * indexes and hreflang (ADR-159 #2) until a human's Save promotes it.
   */
  machineTranslated: z.boolean().optional(),
});
export type LessonTranslationInput = z.infer<typeof lessonTranslationSchema>;

export const createLessonSchema = z.object({
  sectionId: idSchema,
  title: z.string().trim().min(1).max(255),
});
export type CreateLessonInput = z.infer<typeof createLessonSchema>;

/**
 * The lesson save payload, and the home of the capability rule (ADR-055 #4).
 *
 * `attachments` is REQUIRED rather than optional precisely so this rule can be
 * decided from the payload alone. An optional list cannot distinguish a caller
 * who sent no attachments from one who cleared them, so the check would pass
 * or fail depending on which the caller meant. It is a full replacement set,
 * the same discipline `updateArticleMetaSchema.tagIds` documents.
 *
 * Phase 6 adds `quizId` as a fifth capability; the disjunction below is
 * written so that is one added clause, not a rewrite.
 */
export const lessonInputSchema = z
  .object({
    lessonId: idSchema,
    meta: lessonMetaSchema,
    translation: lessonTranslationSchema,
    attachments: z.array(lessonAttachmentSchema).max(20),
  })
  .superRefine((value, ctx) => {
    const hasBody = (value.translation.content ?? "").trim().length > 0;
    const hasVideo = Boolean(value.meta.videoUrl);
    const hasExternal = Boolean(value.meta.externalUrl);
    const hasAttachments = value.attachments.length > 0;

    if (!hasBody && !hasVideo && !hasExternal && !hasAttachments) {
      ctx.addIssue({
        code: "custom",
        message:
          "a lesson needs at least one capability: body content, a video URL, " +
          "an external resource, or an attachment",
        path: ["translation", "content"],
      });
    }
  });
export type LessonInput = z.infer<typeof lessonInputSchema>;

export const moveLessonSchema = z.object({
  lessonId: idSchema,
  toSectionId: idSchema,
  index: z.int().min(0).max(9999),
});
export type MoveLessonInput = z.infer<typeof moveLessonSchema>;

export const reorderLessonsSchema = z.object({
  sectionId: idSchema,
  lessonIds: z.array(idSchema).max(500),
});
export type ReorderLessonsInput = z.infer<typeof reorderLessonsSchema>;

// ─── Progress (ADR-056) ──────────────────────────────────────
//
// Parsed at the ROUTE boundary of /api/learn/progress. That route — never the
// page — is the authorization boundary: it reads the session, applies
// visibility, and scopes every read and write to the session user. Note there
// is deliberately no `userId` field anywhere below: the caller does not get to
// say who they are.

export const progressQuerySchema = z.object({
  /**
   * Optional, and the absence is a real mode rather than a lenient parse:
   * `?course=<id>` asks for ONE course's per-lesson detail (the course and
   * lesson pages), no parameter asks for the learner's enrollment summaries
   * (the `/learn` shelf's "Your courses" band). One endpoint, because both
   * answers need the identical authorization: session, flag, and scoping to
   * the caller.
   */
  course: idSchema.optional(),
});
export type ProgressQueryInput = z.infer<typeof progressQuerySchema>;

// ─── Progress payloads (ADR-056 #1) ──────────────────────────
//
// These are API PAYLOAD shapes, shared verbatim between the route handler and
// the client island, which is why they live in contracts rather than beside
// the service: the island may not import @repo/core, and a second declaration
// of the same shape in the app is a drift waiting to happen.
//
// Timestamps are ISO strings, not `Date`. A `Date` does not survive JSON, so
// a view type that claims one would be lying to the only consumer these
// shapes have.

/**
 * There is deliberately no `"not-started"` member. The ABSENCE of a row is
 * "not started" (the same reason `LessonProgressStatus` has two members), and
 * the UI's `LessonState` adds `not-started` and `locked` as *rendering*
 * states that no row ever carries.
 */
export type LessonProgressState = "completed" | "in-progress";

export interface LessonProgressView {
  lessonId: string;
  state: LessonProgressState;
  completedAt: string | null;
}

export interface CourseProgressView {
  courseId: string;
  /** Completed PUBLISHED lessons, required or not — the numerator on screen. */
  lessonsCompleted: number;
  /** `Course.lessonCount`, so the fraction matches the curriculum shown. */
  lessonsTotal: number;
  percent: number;
  /** Every REQUIRED lesson done (ADR-056 #7). Phase 6 adds the quiz conjunct. */
  isCompleted: boolean;
  completedAt: string | null;
  /**
   * How many BLOCKING lessons are still outstanding — required, published,
   * and not already satisfied (ADR-084 #2). Zero is what unlocks the final
   * assessment card.
   *
   * It cannot be derived from the two counters above: `lessonsCompleted` and
   * `lessonsTotal` both count optional lessons, so `completed >= total` is
   * false forever on a course with one optional lesson. This is computed from
   * the same `blockingLessonWhere()` predicate `recomputeCourseCompletion`
   * blocks on, so the card and the completion rule cannot disagree.
   */
  requiredOutstanding: number;
  /**
   * The course's final assessment, as this learner stands on it. `null` when
   * the course has no final quiz OR its quiz is not publicly reachable — the
   * same two cases in which `CourseView.finalQuiz` is null and in which the
   * quiz stops blocking completion (ADR-084 #8), so one answer covers the
   * card, the lock and the rule.
   *
   * `attempts: 0` means the quiz exists and has never been finished.
   */
  finalQuiz: {
    passed: boolean;
    /** Best completed attempt, 0-100. Zero until one is finished. */
    bestPercentage: number;
    attempts: number;
  } | null;
  /** Drives "Continue learning" — the island maps it to an href it already has. */
  lastLessonId: string | null;
  /** Only lessons the learner has touched; everything else is not-started. */
  lessons: LessonProgressView[];
}

/**
 * One row per started course, newest activity first. Carries NO course title,
 * slug or cover: the shelf already has all three in its cached payload, so
 * repeating them here would put content in a per-learner, uncacheable response
 * for nothing.
 */
export interface EnrollmentSummary {
  courseId: string;
  lessonsCompleted: number;
  lessonsTotal: number;
  percent: number;
  isCompleted: boolean;
  lastLessonId: string | null;
  lastActiveAt: string;
}

/** What `GET /api/learn/progress` answers with when no course is named. */
export interface LearnerDashboardView {
  enrollments: EnrollmentSummary[];
}

export const progressWriteSchema = z.object({
  lessonId: idSchema,
  /**
   * `touch` records IN_PROGRESS and moves `CourseEnrollment.lastLessonId`;
   * `complete`/`incomplete` are the explicit learner action (ADR-056 #5).
   */
  action: z.enum(["complete", "incomplete", "touch"]),
});
export type ProgressWriteInput = z.infer<typeof progressWriteSchema>;

// ─── Lesson feedback (ADR-056 #8) ────────────────────────────

export const lessonFeedbackSchema = z.object({
  lessonId: idSchema,
  helpful: z.boolean(),
});
export type LessonFeedbackInput = z.infer<typeof lessonFeedbackSchema>;

// ─── Quizzes (ADR-058) ───────────────────────────────────────
//
// Two rules shape every schema below:
//
//   1. **The correct answer is an ADMIN input and never a public output.**
//      `quizQuestionSchema` carries `correctAnswer`; `QuizView` has no field
//      for it. The absence is the protection — no page, handler or refactor
//      can leak what the type cannot express (ADR-058 #2).
//   2. **The learner never sends a score.** `quizSubmitSchema` is an attempt
//      id and nothing else, so a forged score is unrepresentable rather than
//      ignored (ADR-058 #3).

export const questionTypeSchema = z.enum(["SINGLE_CHOICE", "MULTIPLE_CHOICE", "TRUE_FALSE"]);
export type QuestionTypeInput = z.infer<typeof questionTypeSchema>;

export const answerVisibilitySchema = z.enum(["NEVER", "AFTER_SUBMIT", "AFTER_PASS"]);
export type AnswerVisibilityInput = z.infer<typeof answerVisibilitySchema>;

/**
 * One option index, or a set of them.
 *
 * A single number for SINGLE_CHOICE and TRUE_FALSE, an array for
 * MULTIPLE_CHOICE. `quizQuestionSchema` refines the pairing, because a
 * TRUE_FALSE question holding `[0, 1]` is a data bug that would score every
 * attempt wrong.
 */
export const answerValueSchema = z.union([
  z.number().int().min(0).max(50),
  z.array(z.number().int().min(0).max(50)).min(1).max(20),
]);
export type AnswerValue = z.infer<typeof answerValueSchema>;

/** Bounded so a malformed row cannot make a question with 400 options. */
const MAX_OPTIONS = 12;

export const quizQuestionSchema = z
  .object({
    /** Absent for a new question; present when editing an existing one. */
    id: idSchema.optional(),
    type: questionTypeSchema,
    sortOrder: z.number().int().min(0),
    points: z.number().int().min(1).max(100).default(1),
    prompt: z.string().trim().min(1).max(1000),
    options: z.array(z.string().trim().min(1).max(300)).min(2).max(MAX_OPTIONS),
    /** Sparse, index-aligned with `options`; "" means no explanation. */
    explanations: z.array(z.string().trim().max(1000)).max(MAX_OPTIONS).optional(),
    correctAnswer: answerValueSchema,
  })
  .superRefine((question, ctx) => {
    const indices =
      typeof question.correctAnswer === "number"
        ? [question.correctAnswer]
        : question.correctAnswer;

    // An index past the end of the options list scores every attempt wrong and
    // is invisible until a learner complains. Rejected on write.
    for (const index of indices) {
      if (index >= question.options.length) {
        ctx.addIssue({
          code: "custom",
          path: ["correctAnswer"],
          message: `Option ${index} does not exist — this question has ${question.options.length}.`,
        });
      }
    }

    if (question.type === "MULTIPLE_CHOICE") {
      if (typeof question.correctAnswer === "number") {
        ctx.addIssue({
          code: "custom",
          path: ["correctAnswer"],
          message: "A multiple-choice question needs a list of correct options.",
        });
      } else if (new Set(question.correctAnswer).size !== question.correctAnswer.length) {
        ctx.addIssue({
          code: "custom",
          path: ["correctAnswer"],
          message: "The same option is marked correct twice.",
        });
      }
      return;
    }

    // SINGLE_CHOICE and TRUE_FALSE have exactly one right answer.
    if (typeof question.correctAnswer !== "number") {
      ctx.addIssue({
        code: "custom",
        path: ["correctAnswer"],
        message: "This question type has exactly one correct option.",
      });
    }
    if (question.type === "TRUE_FALSE" && question.options.length !== 2) {
      ctx.addIssue({
        code: "custom",
        path: ["options"],
        message: "A true/false question has exactly two options.",
      });
    }
  });
export type QuizQuestionInput = z.infer<typeof quizQuestionSchema>;

export const quizMetaSchema = z
  .object({
    passingScore: z.number().int().min(1).max(100),
    /** Null is unlimited, and is the default (D24). */
    maxAttempts: z.number().int().min(1).max(50).nullable(),
    showAnswersAfter: answerVisibilitySchema,
    isStandalone: z.boolean(),
    /** Required (ADR-065 §3): the quiz's URL segment, not a filter over one. */
    track: quizTrackSchema,
    category: z.string().trim().max(80).nullable(),
    /** MediaAsset id, not a URL (ADR-132, after ADR-055 #6). Null clears it. */
    coverAssetId: idSchema.nullable().optional(),
    visibility: contentVisibilitySchema.optional(),
  })
  .extend(contentFlagsSchema.shape);
export type QuizMetaInput = z.infer<typeof quizMetaSchema>;

export const quizTranslationSchema = z.object({
  locale: localeSchema,
  title: z.string().trim().min(1).max(255),
  /** Derived from the title when absent, like every other content slug. */
  slug: z.string().trim().max(255).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
});
export type QuizTranslationInput = z.infer<typeof quizTranslationSchema>;

export const createQuizSchema = z.object({
  title: z.string().trim().min(1).max(255),
  /** Asked for at creation: a quiz cannot have a URL without one (ADR-065 §3). */
  track: quizTrackSchema,
});
export type CreateQuizInput = z.infer<typeof createQuizSchema>;

export const quizInputSchema = z.object({
  quizId: idSchema,
  meta: quizMetaSchema.partial(),
  translation: quizTranslationSchema,
  /**
   * The WHOLE question set, in order. A replace rather than per-question CRUD:
   * an editor reorders, deletes and adds in one pass, and applying that as a
   * stream of individual mutations is how a half-saved quiz happens.
   */
  questions: z.array(quizQuestionSchema).max(100),
});
export type QuizInput = z.infer<typeof quizInputSchema>;

// ─── Quiz attempts (ADR-058 #3) ──────────────────────────────

export const quizStartSchema = z.object({ quizId: idSchema });
export type QuizStartInput = z.infer<typeof quizStartSchema>;

export const quizAnswerSchema = z.object({
  attemptId: idSchema,
  questionId: idSchema,
  answer: answerValueSchema,
});
export type QuizAnswerInput = z.infer<typeof quizAnswerSchema>;

/**
 * An attempt id and a locale — and NO score, which is rule 2 at the top of
 * this block. The locale only picks which translation of the explanations to
 * return in the review; it is a content selector, never an authorization
 * input, and a wrong one yields the fallback chain rather than more access.
 */
export const quizSubmitSchema = z.object({ attemptId: idSchema, locale: localeSchema });
export type QuizSubmitInput = z.infer<typeof quizSubmitSchema>;

// ─── Quiz payloads ───────────────────────────────────────────
//
// Shared verbatim between the route handlers and the runner island, like the
// progress views above, and for the same reason: the island may not import
// @repo/core.

/**
 * A question as the PUBLIC sees it. There is deliberately no `correctAnswer`
 * and no `explanations` field — review data arrives only in the result, and
 * only when `showAnswersAfter` allows.
 */
export interface QuizQuestionView {
  id: string;
  type: QuestionTypeInput;
  prompt: string;
  options: string[];
  points: number;
  /** True when more than one option must be selected. */
  multiple: boolean;
}

export interface QuizView {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  /** The track this quiz lives under — its URL's second segment (ADR-065 §3). */
  track: LearnTrackKey;
  category: string | null;
  passingScore: number;
  maxAttempts: number | null;
  showAnswersAfter: AnswerVisibilityInput;
  isStandalone: boolean;
  questionCount: number;
  totalPoints: number;
  questions: QuizQuestionView[];
  updatedAt: string;
}

/**
 * A quiz as a piece of CONTENT pointed at from somewhere else — a course's
 * final assessment, or the quiz a `QUIZ_PASS` lesson is completed by
 * (ADR-084 #1).
 *
 * It rides in the CACHED loaders (`CourseView`, `LessonView`), not in the
 * progress island's payload: a per-learner response carries counters and ids
 * and no content (ADR-056 #2), so a title and a slug in there would be
 * content in an uncacheable response — and the island is deliberately never
 * given slugs.
 *
 * `track` is the QUIZ's own, which is why it is here at all. Everything a
 * card needs to say what the assessment IS, and nothing about how anyone has
 * done on it. A question COUNT, never the questions: what a learner may see
 * of a question is `guardQuizRequest`'s business.
 */
export interface QuizLinkView {
  id: string;
  slug: string;
  track: LearnTrackKey;
  title: string;
  questionCount: number;
  passingScore: number;
  /** Null means unlimited, which is the default (D24). */
  maxAttempts: number | null;
}

/** The index card at /learn/<track>/quizzes — no questions, so the list stays small. */
export interface QuizCardView {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  track: LearnTrackKey;
  category: string | null;
  /**
   * The editor's uploaded cover, resolved (ADR-132). Null means none was
   * chosen, or its asset was deleted — the shelf then shows a generated panel.
   */
  coverUrl: string | null;
  questionCount: number;
  passingScore: number;
  /** ADR-139 #3 — placement: first on the shelf, and the Featured view. */
  isFeatured: boolean;
  /** ADR-139 #4 — a marker on the card; nothing is gated. */
  isPremium: boolean;
  /** ISO. The shelf's Newest view. */
  publishedAt: string | null;
  /** Finished attempts, by anyone — an aggregate, for the Popular view (ADR-139 #5). */
  attemptCount: number;
}

export interface QuizAttemptView {
  id: string;
  quizId: string;
  attemptNumber: number;
  /** Question id → whether the server graded it correct. Empty under NEVER. */
  grades: Record<string, boolean>;
  /** Question id → the option index(es) the learner chose. */
  answers: Record<string, AnswerValue>;
  completed: boolean;
}

export interface QuizReviewItem {
  questionId: string;
  correct: boolean;
  given: AnswerValue | null;
  correctAnswer: AnswerValue;
  /** Index-aligned with the question's options; "" where none was authored. */
  explanations: string[];
}

export interface QuizResultView {
  attemptId: string;
  quizId: string;
  attemptNumber: number;
  score: number;
  totalPoints: number;
  percentage: number;
  passed: boolean;
  passingScore: number;
  /** Null when `showAnswersAfter` withholds it — NEVER, or AFTER_PASS on a fail. */
  review: QuizReviewItem[] | null;
  /** Null means unlimited; otherwise how many starts remain. */
  attemptsRemaining: number | null;
}

/**
 * One row of the learner's quiz history, as the quiz INDEX reads it.
 *
 * A summary, not an attempt: it carries the best result the learner has ever
 * recorded for a quiz and how many goes it took, and nothing about which
 * questions were involved. That is the whole point — the index renders a bar
 * per card and must not become a second way to read a quiz's contents.
 *
 * `bestPercentage` is the maximum over COMPLETED attempts only. An attempt
 * that was started and abandoned scores 0 in the database, and letting that
 * pull a learner's card down to "0%" would punish them for closing a tab.
 */
export interface QuizProgressSummary {
  quizId: string;
  /** Highest percentage across completed attempts, 0-100. */
  bestPercentage: number;
  /** True when ANY attempt passed — not merely the best-scoring one. */
  passed: boolean;
  /** How many completed attempts exist. Zero rows are omitted entirely. */
  attempts: number;
}

/** The payload of `GET /api/learn/quiz/results`. */
export interface QuizProgressView {
  results: QuizProgressSummary[];
}

// ─── Status transitions ──────────────────────────────────────

/**
 * The full content status machine's vocabulary. Courses and lessons run
 * DRAFT → IN_REVIEW → SEO_REVIEW → APPROVED → SCHEDULED/PUBLISHED — a wider
 * machine than articles', which is why this cannot reuse
 * `articleStatusSchema`. A literal union rather than the `@repo/db` enum so
 * apps stay off the database package (architecture.md #2).
 *
 * Which transitions are LEGAL from a given state is `CONTENT_TRANSITIONS`'s
 * business in `@repo/core`; this only bounds the input.
 */
export const contentStatusSchema = z.enum([
  "DRAFT",
  "IN_REVIEW",
  "SEO_REVIEW",
  "APPROVED",
  "SCHEDULED",
  "PUBLISHED",
  "ARCHIVED",
]);
export type ContentStatusInput = z.infer<typeof contentStatusSchema>;
