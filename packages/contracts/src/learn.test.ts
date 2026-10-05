import { describe, expect, it } from "vitest";

import {
  courseTranslationSchema,
  externalUrlSchema,
  isLearnTrack,
  isReservedCourseSlug,
  learnTrackSchema,
  LEARN_TRACK_KEYS,
  LEARN_TRACKS,
  lessonInputSchema,
  progressWriteSchema,
  recommendationsSchema,
  RESERVED_COURSE_SLUGS,
  learnTrackPath,
  learnTrackQuizzesPath,
  learnTrackGlossaryPath,
  learnTrackVideosPath,
  learnTrackVideoCategoryPath,
  quizLinkPath,
  isReservedVideoSlug,
  RESERVED_VIDEO_SLUGS,
} from "./learn.ts";
import {
  LEARN_TRACK_ROUTE_KEYS,
  LEARN_TRACK_SURFACES,
  ROUTE_PATHS,
  type RouteKey,
} from "./index.ts";

// ─── Tracks (ADR-055 #2) ─────────────────────────────────────

describe("LEARN_TRACKS registry", () => {
  it("registers both launch tracks", () => {
    expect(Object.keys(LEARN_TRACKS).sort()).toEqual(["crypto", "forex"]);
  });

  it("orders keys by sortOrder, not by declaration or alphabet", () => {
    // "crypto" sorts before "forex" alphabetically; sortOrder must win.
    expect(LEARN_TRACK_KEYS).toEqual(["forex", "crypto"]);
  });

  it("gives every track a distinct sortOrder", () => {
    const orders = Object.values(LEARN_TRACKS).map((t) => t.sortOrder);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it("gives every track message keys relative to the learn namespace", () => {
    for (const spec of Object.values(LEARN_TRACKS)) {
      // Not absolute: the namespace is supplied by the caller (ADR-043 #1),
      // exactly as MegaColumnSpec.titleKey does for `nav`.
      expect(spec.titleKey.startsWith("learn.")).toBe(false);
      expect(spec.titleKey.length).toBeGreaterThan(0);
      expect(spec.descriptionKey.length).toBeGreaterThan(0);
    }
  });

  it("narrows a known key and rejects an unknown one", () => {
    expect(isLearnTrack("forex")).toBe(true);
    expect(isLearnTrack("crypto")).toBe(true);
    expect(isLearnTrack("stocks")).toBe(false);
    expect(isLearnTrack("")).toBe(false);
  });

  it("does not treat inherited Object properties as tracks", () => {
    // `key in LEARN_TRACKS` would answer true here; hasOwnProperty must not.
    expect(isLearnTrack("toString")).toBe(false);
    expect(isLearnTrack("constructor")).toBe(false);
  });

  it("accepts registered tracks and rejects anything else", () => {
    expect(learnTrackSchema.safeParse("forex").success).toBe(true);
    expect(learnTrackSchema.safeParse("stocks").success).toBe(false);
  });
});

// ─── Reserved course slugs (ADR-055 #3) ──────────────────────

describe("reserved course slugs", () => {
  it("reserves the quiz index segment", () => {
    expect(RESERVED_COURSE_SLUGS).toContain("quizzes");
  });

  it("matches case-insensitively and ignores surrounding whitespace", () => {
    expect(isReservedCourseSlug("quizzes")).toBe(true);
    expect(isReservedCourseSlug("QUIZZES")).toBe(true);
    expect(isReservedCourseSlug("  Quizzes  ")).toBe(true);
  });

  it("does not reserve a slug that merely contains a reserved word", () => {
    expect(isReservedCourseSlug("quizzes-explained")).toBe(false);
    expect(isReservedCourseSlug("forex-basics")).toBe(false);
  });

  it("rejects a reserved slug on a course translation", () => {
    const result = courseTranslationSchema.safeParse({
      locale: "en",
      title: "Quizzes",
      slug: "quizzes",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["slug"]);
    }
  });

  it("accepts a course whose TITLE is Quizzes when the slug differs", () => {
    const result = courseTranslationSchema.safeParse({
      locale: "en",
      title: "Quizzes",
      slug: "all-about-quizzes",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a translation with no slug — the service derives it", () => {
    const result = courseTranslationSchema.safeParse({
      locale: "en",
      title: "Forex Basics",
    });
    expect(result.success).toBe(true);
  });
});

// ─── External URLs (ADR-055 #5, security.md #9) ──────────────

describe("externalUrlSchema", () => {
  it("accepts an https URL", () => {
    expect(externalUrlSchema.safeParse("https://example.com/guide").success).toBe(true);
  });

  it.each([
    ["http", "http://example.com/guide"],
    ["javascript", "javascript:alert(1)"],
    ["data", "data:text/html,<script>alert(1)</script>"],
    ["file", "file:///etc/passwd"],
  ])("rejects a %s: URL", (_label, url) => {
    expect(externalUrlSchema.safeParse(url).success).toBe(false);
  });

  it("rejects a string that is not a URL at all", () => {
    expect(externalUrlSchema.safeParse("not-a-url").success).toBe(false);
    expect(externalUrlSchema.safeParse("").success).toBe(false);
  });

  it("accepts a single-slash https URL, which the URL parser normalises", () => {
    // `https:/example.com` parses to `https://example.com/` per WHATWG, and
    // navigates there. Documented rather than rejected: the protocol check is
    // what matters, and this is a real https destination, not a bypass.
    expect(externalUrlSchema.safeParse("https:/example.com").success).toBe(true);
  });

  it("rejects a URL longer than the column", () => {
    expect(externalUrlSchema.safeParse(`https://e.com/${"a".repeat(500)}`).success).toBe(false);
  });
});

// ─── Lesson capabilities (ADR-055 #4) ────────────────────────

const baseLesson = {
  lessonId: "l1",
  meta: {},
  translation: { locale: "en", title: "A lesson" },
  attachments: [],
};

describe("lessonInputSchema capability rule", () => {
  it("rejects a lesson with no capability at all", () => {
    const result = lessonInputSchema.safeParse(baseLesson);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/at least one capability/);
    }
  });

  it("rejects a lesson whose only body is whitespace", () => {
    const result = lessonInputSchema.safeParse({
      ...baseLesson,
      translation: { ...baseLesson.translation, content: "   \n  " },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a lesson with body content", () => {
    const result = lessonInputSchema.safeParse({
      ...baseLesson,
      translation: { ...baseLesson.translation, content: "<p>Pips explained.</p>" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a video-only lesson", () => {
    const result = lessonInputSchema.safeParse({
      ...baseLesson,
      meta: { videoUrl: "https://www.youtube.com/watch?v=abc123" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts an external-resource-only lesson", () => {
    const result = lessonInputSchema.safeParse({
      ...baseLesson,
      meta: { externalUrl: "https://example.com/textbook" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts an attachment-only lesson", () => {
    const result = lessonInputSchema.safeParse({
      ...baseLesson,
      attachments: [{ assetId: "a1", label: "Worksheet" }],
    });
    expect(result.success).toBe(true);
  });

  it("still rejects an http video URL, capability or not", () => {
    const result = lessonInputSchema.safeParse({
      ...baseLesson,
      meta: { videoUrl: "http://www.youtube.com/watch?v=abc123" },
    });
    expect(result.success).toBe(false);
  });

  it("requires attachments to be sent, so the rule can be decided from the payload", () => {
    const { attachments: _omitted, ...withoutAttachments } = baseLesson;
    const result = lessonInputSchema.safeParse({
      ...withoutAttachments,
      translation: { ...baseLesson.translation, content: "<p>Body.</p>" },
    });
    expect(result.success).toBe(false);
  });
});

// ─── Progress (ADR-056) ──────────────────────────────────────

describe("progressWriteSchema", () => {
  it("accepts the three learner actions", () => {
    for (const action of ["complete", "incomplete", "touch"]) {
      expect(progressWriteSchema.safeParse({ lessonId: "l1", action }).success).toBe(true);
    }
  });

  it("rejects an unknown action", () => {
    expect(progressWriteSchema.safeParse({ lessonId: "l1", action: "delete" }).success).toBe(false);
  });

  it("strips a caller-supplied userId rather than trusting it", () => {
    // The route resolves the user from the session; a client may not name one.
    const result = progressWriteSchema.parse({
      lessonId: "l1",
      action: "complete",
      userId: "somebody-else",
    });
    expect(result).not.toHaveProperty("userId");
  });
});

// ─── Recommendations (ADR-055, ContentRelation reuse) ────────

describe("recommendationsSchema", () => {
  it("accepts an ordered target list", () => {
    const result = recommendationsSchema.safeParse({ courseId: "c1", targetIds: ["c2", "c3"] });
    expect(result.success).toBe(true);
  });

  it("accepts an empty list — clearing recommendations is legal", () => {
    expect(recommendationsSchema.safeParse({ courseId: "c1", targetIds: [] }).success).toBe(true);
  });

  it("caps the list", () => {
    const targetIds = Array.from({ length: 13 }, (_, i) => `c${i}`);
    expect(recommendationsSchema.safeParse({ courseId: "c1", targetIds }).success).toBe(false);
  });
});

// ─── Tracks own routes (ADR-065 §1/§4) ───────────────────────
//
// The two registries that must never drift: LEARN_TRACKS decides which tracks
// exist, ROUTE_PATHS decides which URLs exist. Adding a track without its
// route keys — or a learn-* key without its track — fails here rather than at
// runtime as a menu row pointing at a 404.

describe("track route keys", () => {
  // Iterates LEARN_TRACK_SURFACES rather than a list typed here. ADR-068 added
  // a fourth surface and found three hardcoded copies of the original three in
  // this file, none of which failed — a drift guard only guards what it
  // enumerates, so it now enumerates the registry.
  it("gives every registered track a route key for every surface", () => {
    for (const track of LEARN_TRACK_KEYS) {
      const keys = (LEARN_TRACK_ROUTE_KEYS as Record<string, Record<string, RouteKey>>)[track];
      expect(keys, `track "${track}" has no route keys`).toBeDefined();
      for (const surface of LEARN_TRACK_SURFACES) {
        expect(keys![surface], `track "${track}" has no "${surface}" route key`).toBeDefined();
        expect(ROUTE_PATHS[keys![surface]!]).toBeDefined();
      }
      // No surface beyond the registered ones — an unlisted key here is a URL
      // nothing renders a tab for.
      expect(Object.keys(keys!).sort()).toEqual([...LEARN_TRACK_SURFACES].sort());
    }
  });

  it("registers no learn-* route key for an unregistered track", () => {
    const registered = new Set<string>(LEARN_TRACK_KEYS);
    for (const key of Object.keys(ROUTE_PATHS)) {
      const match = /^learn-([a-z0-9-]+?)(?:-videos|-quizzes|-glossary)?$/.exec(key);
      if (!match) continue;
      expect(registered.has(match[1]!), `route key "${key}" names no registered track`).toBe(true);
    }
  });

  it("builds the same paths the registry stores", () => {
    for (const track of LEARN_TRACK_KEYS) {
      const keys = LEARN_TRACK_ROUTE_KEYS[track];
      expect(learnTrackPath(track)).toBe(ROUTE_PATHS[keys.index]);
      expect(learnTrackVideosPath(track)).toBe(ROUTE_PATHS[keys.videos]);
      expect(learnTrackQuizzesPath(track)).toBe(ROUTE_PATHS[keys.quizzes]);
      expect(learnTrackGlossaryPath(track)).toBe(ROUTE_PATHS[keys.glossary]);
    }
  });

  it("reserves the static segments a track's course slug would shadow", () => {
    // All three are real routes one level under /learn/<track>.
    expect(isReservedCourseSlug("quizzes")).toBe(true);
    expect(isReservedCourseSlug("glossary")).toBe(true);
    expect(isReservedCourseSlug("videos")).toBe(true);
    expect(RESERVED_COURSE_SLUGS).toHaveLength(3);
  });

  // ADR-068 §1 — the same rule one level further down.
  it("reserves the static segment a video topic's slug would shadow", () => {
    expect(isReservedVideoSlug("categories")).toBe(true);
    expect(isReservedVideoSlug("CATEGORIES ")).toBe(true);
    expect(isReservedVideoSlug("category")).toBe(false);
    expect(RESERVED_VIDEO_SLUGS).toHaveLength(1);
  });

  // ADR-084 #1 — the one constructor for a quiz href outside the quiz index.
  it("builds a quiz path under the track's own quiz index", () => {
    for (const track of LEARN_TRACK_KEYS) {
      expect(quizLinkPath(track, "pips-and-lots")).toBe(
        `${learnTrackQuizzesPath(track)}/pips-and-lots`,
      );
    }
  });

  // The whole reason the track is an ARGUMENT rather than derived from the
  // course: a course in one school may point at a quiz filed under another,
  // and the href has to follow the QUIZ (ADR-065 §3).
  it("follows the quiz's own track", () => {
    const [first, second] = LEARN_TRACK_KEYS;
    expect(second, "this assertion needs two registered tracks").toBeDefined();
    expect(quizLinkPath(first!, "risk-of-ruin")).not.toBe(quizLinkPath(second!, "risk-of-ruin"));
  });

  it("builds a category path under the track's video library", () => {
    for (const track of LEARN_TRACK_KEYS) {
      expect(learnTrackVideoCategoryPath(track, "metatrader")).toBe(
        `${learnTrackVideosPath(track)}/categories/metatrader`,
      );
    }
  });
});
