// Promotions (ADR-167, changes-52 P2): the service behind /keystone/promotions
// and the public popup and home band.
//
// Three rules shape everything here:
//
// 1. Status is what a PERSON decided (draft, active, archived). Scheduled,
//    live and ended are the clock's business, decided in the query
//    (`liveWhere`) and in `promotionPhase` — never written by a sweep.
// 2. A promotion that links to site content borrows that content's words and
//    picture, and DISAPPEARS when the content is not public by its own
//    module's rule. The rules are the modules' (`publicCourseWhere` & co.),
//    composed, never copied — the lesson public-search.ts records.
// 3. A reader in locale L sees L's words when they are current (TRANSLATED or
//    MACHINE_TRANSLATED). A row the number check flagged, or whose English
//    moved on, counts as missing, and missing means hidden unless the
//    promotion says to fall back to the default language (ADR-167 #6).
import { cacheLife, cacheTag, revalidateTag } from "next/cache";
import { TranslationStatus, db, type ContentStatus, type Prisma } from "@repo/db";
import {
  isToolKey,
  promotionPhase,
  toolPath,
  type PromotionAudienceInput,
  type PromotionBarPositionInput,
  type PromotionFrequencyInput,
  type PromotionKindInput,
  type PromotionPhase,
  type PromotionPlacement,
  type PromotionSaveInput,
  type PromotionStatusChangeInput,
  type PromotionTargetTypeInput,
  type PromotionTranslationSaveInput,
  type PromotionUntranslatedInput,
  PROMOTION_PLACEMENTS,
} from "@repo/contracts";
import { can, type Subject } from "@repo/rbac";
import { htmlLead, stripInlineTags } from "@repo/utils";
import { syncReferences } from "./cms/references.ts";
import { sanitizeRichText } from "./content.ts";
import { recordAudit } from "./index.ts";
import { hashPromotionSource, loadPromotionSource } from "./promotion-source.ts";
import { publicArticleWhere } from "./public-articles.ts";
import { publicGlossaryTermWhere } from "./public-content.ts";
import { publicCourseWhere, publicLessonWhere } from "./public-courses.ts";
import { publicQuizWhere } from "./quiz-links.ts";
import { afterSourceSave } from "./translation-queue.ts";
import { publicVideoWhere } from "./videos.ts";

// ─── Errors ──────────────────────────────────────────────────

export class PromotionNotFoundError extends Error {
  constructor(id: string) {
    super(`Promotion ${id} not found`);
    this.name = "PromotionNotFoundError";
  }
}

/**
 * Defence in depth behind the action's `requirePermission` (security.md #1).
 * The service holds the one rule an action cannot express by key alone: a
 * change to a promotion that is ACTIVE reaches visitors the moment it saves,
 * so it needs `promotions.publish` exactly as activating it does.
 */
export class PromotionPermissionError extends Error {
  constructor(readonly permission: string) {
    super(`Missing permission: ${permission}`);
    this.name = "PromotionPermissionError";
  }
}

export type PromotionRefusal =
  | "notDefaultLocale"
  | "localeNotActive"
  | "targetMissing"
  | "recordingMissing"
  | "imageMissing"
  | "windowEnded"
  | "noWords"
  | "deleted";

/** A save or state change refused for a reason the admin can act on. */
export class PromotionRefusedError extends Error {
  constructor(readonly reason: PromotionRefusal) {
    super(`Promotion refused: ${reason}`);
    this.name = "PromotionRefusedError";
  }
}

// ─── Shared helpers ──────────────────────────────────────────

interface Locales {
  defaultLocale: string;
  active: string[];
}

async function locales(): Promise<Locales> {
  const rows = await db.locale.findMany({
    where: { isActive: true },
    select: { code: true, isDefault: true },
    orderBy: { sortOrder: "asc" },
  });
  return {
    defaultLocale: rows.find((row) => row.isDefault)?.code ?? "en",
    active: rows.map((row) => row.code),
  };
}

function requireKey(actor: Subject, permission: string): void {
  if (!can(actor, permission)) throw new PromotionPermissionError(permission);
}

/** A blank field is absent, not an empty string on the page. */
function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Borrowed content's lead paragraph as plain text, capped on a word boundary.
 * Inline markup is glued to its words first (`stripInlineTags`), so
 * "Start <strong>here</strong>." does not read "Start here .".
 */
function plainExcerpt(value: string | null | undefined, max = 200): string | null {
  if (!value) return null;
  const text = htmlLead(stripInlineTags(value), max);
  return text === "" ? null : text;
}

/**
 * The statuses a reader may be shown (ADR-167 #6). Deliberately narrower
 * than `INDEXABLE_TRANSLATION_STATUSES` plus machine rows: OUTDATED is
 * served elsewhere on the site, but a promotion is short-lived and usually
 * carries a price, a date or a percentage, and a stale figure misleads.
 */
export const SHOWABLE_PROMOTION_STATUSES: readonly TranslationStatus[] = [
  TranslationStatus.TRANSLATED,
  TranslationStatus.MACHINE_TRANSLATED,
];

function placementsOf(value: Prisma.JsonValue): PromotionPlacement[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is PromotionPlacement =>
    (PROMOTION_PLACEMENTS as readonly unknown[]).includes(entry),
  );
}

async function mediaUrls(ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map();
  const assets = await db.mediaAsset.findMany({
    where: { id: { in: unique }, deletedAt: null },
    select: { id: true, url: true },
  });
  return new Map(assets.map((asset) => [asset.id, asset.url]));
}

// ─── Target resolution (ADR-167 #4) ──────────────────────────

export interface TargetRef {
  type: PromotionTargetTypeInput;
  id: string;
}

interface TargetWords {
  slug: string;
  title: string;
  excerpt: string | null;
}

/**
 * Everything needed to link to one piece of content in any locale. Paths are
 * LOCALE-LESS — the public renderer's `Link` adds the reader's prefix, the
 * same contract `SearchHit.href` keeps.
 */
interface ResolvedTarget {
  coverAssetId: string | null;
  byLocale: Map<string, TargetWords>;
  /** Builds the path from the words chosen for a locale. */
  path: (locale: string, words: TargetWords) => string | null;
}

const targetKey = (ref: TargetRef) => `${ref.type}:${ref.id}`;

/**
 * Load targets in batches, one query per type. With `publicOnly` a target
 * that its module would not serve is simply absent from the result — which is
 * how a promotion pointing at a draft, a hidden course or a disabled tool
 * disappears instead of linking to a 404.
 */
async function loadTargets(
  refs: readonly TargetRef[],
  localesWanted: readonly string[],
  { publicOnly, now }: { publicOnly: boolean; now: Date },
): Promise<Map<string, ResolvedTarget>> {
  const out = new Map<string, ResolvedTarget>();
  const idsOf = (type: PromotionTargetTypeInput) => [
    ...new Set(refs.filter((ref) => ref.type === type).map((ref) => ref.id)),
  ];
  const inLocales = { locale: { in: [...localesWanted] } };
  const words = <T extends { locale: string }>(
    rows: T[],
    pick: (row: T) => TargetWords,
  ): Map<string, TargetWords> => new Map(rows.map((row) => [row.locale, pick(row)]));

  const courseIds = idsOf("COURSE");
  if (courseIds.length > 0) {
    const rows = await db.course.findMany({
      where: {
        id: { in: courseIds },
        ...(publicOnly ? publicCourseWhere(now) : { deletedAt: null }),
      },
      select: {
        id: true,
        track: true,
        coverAssetId: true,
        translations: {
          where: inLocales,
          select: { locale: true, slug: true, title: true, summary: true },
        },
      },
    });
    for (const row of rows) {
      out.set(`COURSE:${row.id}`, {
        coverAssetId: row.coverAssetId,
        byLocale: words(row.translations, (t) => ({
          slug: t.slug,
          title: t.title,
          excerpt: plainExcerpt(t.summary),
        })),
        path: (_locale, w) => `/learn/${row.track}/${w.slug}`,
      });
    }
  }

  const lessonIds = idsOf("LESSON");
  if (lessonIds.length > 0) {
    const rows = await db.lesson.findMany({
      where: {
        id: { in: lessonIds },
        ...(publicOnly
          ? {
              ...publicLessonWhere(now),
              // Reachable only through a visible section of a public course —
              // the rule `Course.lessonCount` and search both use (ADR-081 #2).
              section: { isPublished: true, course: publicCourseWhere(now) },
            }
          : { deletedAt: null }),
      },
      select: {
        id: true,
        heroAssetId: true,
        translations: {
          where: inLocales,
          select: { locale: true, slug: true, title: true, summary: true },
        },
        section: {
          select: {
            course: {
              select: {
                track: true,
                coverAssetId: true,
                translations: { where: inLocales, select: { locale: true, slug: true } },
              },
            },
          },
        },
      },
    });
    for (const row of rows) {
      const course = row.section.course;
      const courseSlugs = new Map(course.translations.map((t) => [t.locale, t.slug]));
      out.set(`LESSON:${row.id}`, {
        coverAssetId: row.heroAssetId ?? course.coverAssetId,
        byLocale: words(row.translations, (t) => ({
          slug: t.slug,
          title: t.title,
          excerpt: plainExcerpt(t.summary),
        })),
        // The course slug must exist in the SAME locale as the lesson's, or the
        // path mixes two languages and 404s (public-search.ts drops these too).
        path: (locale, w) => {
          const courseSlug = courseSlugs.get(locale);
          return courseSlug ? `/learn/${course.track}/${courseSlug}/${w.slug}` : null;
        },
      });
    }
  }

  const quizIds = idsOf("QUIZ");
  if (quizIds.length > 0) {
    const rows = await db.quiz.findMany({
      where: { id: { in: quizIds }, ...(publicOnly ? publicQuizWhere(now) : { deletedAt: null }) },
      select: {
        id: true,
        track: true,
        coverAssetId: true,
        translations: {
          where: inLocales,
          select: { locale: true, slug: true, title: true, description: true },
        },
      },
    });
    for (const row of rows) {
      out.set(`QUIZ:${row.id}`, {
        coverAssetId: row.coverAssetId,
        byLocale: words(row.translations, (t) => ({
          slug: t.slug,
          title: t.title,
          excerpt: plainExcerpt(t.description),
        })),
        path: (_locale, w) => `/learn/${row.track}/quizzes/${w.slug}`,
      });
    }
  }

  const articleIds = idsOf("ARTICLE");
  if (articleIds.length > 0) {
    const rows = await db.article.findMany({
      where: {
        id: { in: articleIds },
        ...(publicOnly ? publicArticleWhere(now) : { deletedAt: null }),
      },
      select: {
        id: true,
        kind: true,
        coverImageAssetId: true,
        translations: {
          where: inLocales,
          select: { locale: true, slug: true, title: true, excerpt: true },
        },
      },
    });
    for (const row of rows) {
      out.set(`ARTICLE:${row.id}`, {
        coverAssetId: row.coverImageAssetId,
        byLocale: words(row.translations, (t) => ({
          slug: t.slug,
          title: t.title,
          excerpt: plainExcerpt(t.excerpt),
        })),
        // ADR-015's two surfaces: NEWS at /news, the other kinds at /analysis.
        path: (_locale, w) => `${row.kind === "NEWS" ? "/news" : "/analysis"}/${w.slug}`,
      });
    }
  }

  const videoIds = idsOf("VIDEO_TOPIC");
  if (videoIds.length > 0) {
    const rows = await db.videoTopic.findMany({
      where: {
        id: { in: videoIds },
        ...(publicOnly ? publicVideoWhere(now) : { deletedAt: null }),
      },
      select: {
        id: true,
        track: true,
        coverAssetId: true,
        translations: {
          where: inLocales,
          select: { locale: true, slug: true, title: true, summary: true },
        },
      },
    });
    for (const row of rows) {
      out.set(`VIDEO_TOPIC:${row.id}`, {
        coverAssetId: row.coverAssetId,
        byLocale: words(row.translations, (t) => ({
          slug: t.slug,
          title: t.title,
          excerpt: plainExcerpt(t.summary),
        })),
        path: (_locale, w) => `/learn/${row.track}/videos/${w.slug}`,
      });
    }
  }

  const termIds = idsOf("GLOSSARY_TERM");
  if (termIds.length > 0) {
    const rows = await db.glossaryTerm.findMany({
      where: {
        id: { in: termIds },
        ...(publicOnly ? publicGlossaryTermWhere(now) : { deletedAt: null }),
      },
      select: {
        id: true,
        translations: {
          where: inLocales,
          select: { locale: true, slug: true, term: true, simpleExplanation: true },
        },
      },
    });
    for (const row of rows) {
      out.set(`GLOSSARY_TERM:${row.id}`, {
        coverAssetId: null,
        byLocale: words(row.translations, (t) => ({
          slug: t.slug,
          title: t.term,
          excerpt: plainExcerpt(t.simpleExplanation),
        })),
        path: (_locale, w) => `/glossary/${w.slug}`,
      });
    }
  }

  const toolIds = idsOf("TOOL");
  if (toolIds.length > 0) {
    const rows = await db.tool.findMany({
      where: { id: { in: toolIds }, ...(publicOnly ? { isEnabled: true } : {}) },
      select: {
        id: true,
        key: true,
        coverAssetId: true,
        translations: { where: inLocales, select: { locale: true, title: true, intro: true } },
      },
    });
    for (const row of rows) {
      // A row whose key the code no longer registers has no route at all.
      const key = row.key;
      if (!isToolKey(key)) continue;
      out.set(`TOOL:${row.id}`, {
        coverAssetId: row.coverAssetId,
        byLocale: words(row.translations, (t) => ({
          slug: key,
          title: t.title,
          excerpt: plainExcerpt(t.intro),
        })),
        path: () => toolPath(key),
      });
    }
  }

  return out;
}

/** The first locale in `chain` the target has words in, with its path. */
function linkIn(
  target: ResolvedTarget,
  chain: readonly string[],
): { locale: string; words: TargetWords; href: string } | null {
  for (const locale of chain) {
    const words = target.byLocale.get(locale);
    if (!words) continue;
    const href = target.path(locale, words);
    if (href) return { locale, words, href };
  }
  return null;
}

// ─── Public read (ADR-167 #3) ────────────────────────────────

/**
 * What the popup and the band render — words already chosen for the reader,
 * the link already resolved. It carries NO target id, no status and nothing
 * a draft could leak through: an admin's unpublished choice of target is not
 * the public's business.
 */
export interface PublicPromotion {
  id: string;
  version: number;
  kind: PromotionKindInput;
  placements: PromotionPlacement[];
  showAsPopup: boolean;
  showInBand: boolean;
  showAsBar: boolean;
  barPosition: PromotionBarPositionInput;
  frequency: PromotionFrequencyInput;
  delaySeconds: number;
  audience: PromotionAudienceInput;
  /** The window's end — the client re-checks it so an open tab never shows an ended offer. */
  endsAt: string;
  eventStartsAt: string | null;
  eventEndsAt: string | null;
  /** The language the WORDS are in — differs from the page when falling back. */
  lang: string;
  title: string;
  /** Sanitized rich text (security.md #8), or null. */
  bodyHtml: string | null;
  /** Plain text borrowed from linked content, shown when there is no body. */
  summary: string | null;
  badge: string | null;
  ctaLabel: string | null;
  /** Locale-less site path, or an https URL when `external`. */
  href: string | null;
  external: boolean;
  imageUrl: string | null;
  imageAlt: string;
  /** A public video topic's path, for "Watch the recording" after the event. */
  recordingHref: string | null;
}

/** The public rule: active, not deleted, inside its window. */
export function liveWhere(now: Date): Prisma.PromotionWhereInput {
  return {
    status: "ACTIVE",
    deletedAt: null,
    startsAt: { lte: now },
    endsAt: { gt: now },
  };
}

/**
 * Every promotion live for `locale` at `now`, highest priority first.
 *
 * All placements are returned; the caller filters with `promotionShowsOnPath`
 * (@repo/contracts). One result per locale is what a cache can hold — one per
 * PATH would be a cache entry for every article on the site.
 */
export interface LivePromotionOptions {
  /**
   * Target types whose SECTION is switched off by a feature flag, so their
   * pages 404 even when the content is public. Flags are decided at the route
   * against an anonymous subject, as search does (ADR-108); a promotion linking
   * into a switched-off section is hidden like one linking to a draft.
   */
  unavailableTargetTypes?: readonly PromotionTargetTypeInput[];
}

export async function loadLivePromotions(
  locale: string,
  now: Date = new Date(),
  options: LivePromotionOptions = {},
): Promise<PublicPromotion[]> {
  const unavailable = new Set(options.unavailableTargetTypes ?? []);
  const { defaultLocale } = await locales();
  const wanted = [...new Set([locale, defaultLocale])];

  const rows = await db.promotion.findMany({
    where: liveWhere(now),
    orderBy: [{ priority: "desc" }, { startsAt: "desc" }, { id: "asc" }],
    include: { translations: { where: { locale: { in: wanted } } } },
  });
  if (rows.length === 0) return [];

  const targetRefs: TargetRef[] = [];
  for (const row of rows) {
    if (row.linkKind === "CONTENT" && row.targetType && row.targetId) {
      if (!unavailable.has(row.targetType))
        targetRefs.push({ type: row.targetType, id: row.targetId });
    }
    if (row.recordingTopicId && !unavailable.has("VIDEO_TOPIC")) {
      targetRefs.push({ type: "VIDEO_TOPIC", id: row.recordingTopicId });
    }
  }
  const targets = await loadTargets(targetRefs, wanted, { publicOnly: true, now });

  const out: Array<PublicPromotion & { imageAssetId: string | null }> = [];
  for (const row of rows) {
    // Which language's words (ADR-167 #6).
    const own = row.translations.find((t) => t.locale === locale);
    const fallback = row.translations.find((t) => t.locale === defaultLocale);
    const ownUsable =
      own &&
      (locale === defaultLocale || SHOWABLE_PROMOTION_STATUSES.includes(own.translationStatus));
    let words = ownUsable ? own : null;
    if (!words && row.untranslated === "SHOW_DEFAULT") words = fallback ?? null;
    if (!words) continue;
    const lang = words.locale;

    // Where it links, and what it borrows.
    let href: string | null = null;
    let external = false;
    let borrowed: { words: TargetWords; coverAssetId: string | null } | null = null;
    if (row.linkKind === "CONTENT") {
      const target =
        row.targetType && row.targetId
          ? targets.get(targetKey({ type: row.targetType, id: row.targetId }))
          : undefined;
      // The reader's own slug first, then the default's — the address a
      // content page itself falls back through.
      const link = target ? linkIn(target, [locale, defaultLocale]) : null;
      if (!target || !link) continue; // not public: the promotion is hidden, never a 404
      href = link.href;
      const inWordsLanguage = target.byLocale.get(lang) ?? link.words;
      borrowed = { words: inWordsLanguage, coverAssetId: target.coverAssetId };
    } else if (row.linkKind === "PATH") {
      href = row.targetPath;
    } else if (row.linkKind === "EXTERNAL") {
      href = row.targetUrl;
      external = true;
    }

    const title = words.title ?? borrowed?.words.title ?? null;
    if (!title) continue;

    const recording = row.recordingTopicId
      ? targets.get(targetKey({ type: "VIDEO_TOPIC", id: row.recordingTopicId }))
      : undefined;

    out.push({
      id: row.id,
      version: row.version,
      kind: row.kind,
      placements: placementsOf(row.placements),
      showAsPopup: row.showAsPopup,
      showInBand: row.showInBand,
      showAsBar: row.showAsBar,
      barPosition: row.barPosition,
      frequency: row.frequency,
      delaySeconds: row.delaySeconds,
      audience: row.audience,
      endsAt: row.endsAt.toISOString(),
      eventStartsAt: row.eventStartsAt?.toISOString() ?? null,
      eventEndsAt: row.eventEndsAt?.toISOString() ?? null,
      lang,
      title,
      bodyHtml: words.body,
      summary: words.body ? null : (borrowed?.words.excerpt ?? null),
      badge: words.badge,
      ctaLabel: href ? words.ctaLabel : null,
      href,
      external,
      imageUrl: null,
      imageAssetId: row.imageAssetId ?? borrowed?.coverAssetId ?? null,
      imageAlt: words.imageAlt ?? "",
      recordingHref: recording ? (linkIn(recording, [locale, defaultLocale])?.href ?? null) : null,
    });
  }

  const urls = await mediaUrls(out.map((p) => p.imageAssetId));
  return out.map(({ imageAssetId, ...promotion }) => ({
    ...promotion,
    imageUrl: imageAssetId ? (urls.get(imageAssetId) ?? null) : null,
  }));
}

/**
 * The cached public read — the popup's endpoint and the home band call this,
 * never `loadLivePromotions` directly.
 *
 * `content`-tagged, so an admin save shows at once. The SHORT lifetime is for
 * the clock: a promotion goes live at `startsAt` with no admin action, so
 * nothing would invalidate the tag at that moment. An `expire` under five
 * minutes also makes the home band a "dynamic hole" rather than a prerendered
 * part of the page (Next's cacheLife docs, "Prerendering behavior"): the band
 * resolves per request inside its own `<Suspense>`, and the rest of the home
 * page keeps its own, much longer, lifetime — changes-52 §7.4 Option A,
 * without the leak §7.4 was worried about.
 *
 * Pass `unavailableTargetTypes` SORTED, so equal sets share one cache entry.
 */
export async function getLivePromotions(
  locale: string,
  unavailableTargetTypes: readonly PromotionTargetTypeInput[] = [],
): Promise<PublicPromotion[]> {
  "use cache";
  cacheTag("content");
  cacheLife({ stale: 30, revalidate: 60, expire: 120 });
  return loadLivePromotions(locale, new Date(), { unavailableTargetTypes });
}

/**
 * The home band's read (ADR-187, changes-65). Same rows as
 * `getLivePromotions`, with a lifetime long enough to stay IN the prerender:
 * an `expire` of five minutes is not "under five minutes", so the home page
 * is prerendered whole and can be cached at the edge. Before this, the band
 * was the home page's one dynamic hole, and that hole made every `/` response
 * `private, no-store`.
 *
 * The cost is a clock-driven change that lands late: the page revalidates
 * every 60 seconds, so a promotion appears (or disappears) up to about a
 * minute after `startsAt`/`endsAt`, plus the edge's own `s-maxage`. An admin
 * save still shows at once through the `content` tag. The popup, the bars and
 * the counters keep `getLivePromotions`, whose two-minute lifetime is right
 * for an endpoint.
 */
export async function getLivePromotionsForBand(
  locale: string,
  unavailableTargetTypes: readonly PromotionTargetTypeInput[] = [],
): Promise<PublicPromotion[]> {
  "use cache";
  cacheTag("content");
  cacheLife({ stale: 60, revalidate: 60, expire: 300 });
  return loadLivePromotions(locale, new Date(), { unavailableTargetTypes });
}

// ─── Admin reads ─────────────────────────────────────────────

export type PromotionLocaleState = TranslationStatus | "MISSING";

export interface PromotionAdminRow {
  id: string;
  kind: PromotionKindInput;
  status: "DRAFT" | "ACTIVE" | "ARCHIVED";
  phase: PromotionPhase;
  title: string | null;
  startsAt: Date;
  endsAt: Date;
  placements: PromotionPlacement[];
  showAsPopup: boolean;
  showInBand: boolean;
  showAsBar: boolean;
  barPosition: PromotionBarPositionInput;
  priority: number;
  linkKind: "CONTENT" | "PATH" | "EXTERNAL" | "NONE";
  /** CONTENT only: false when the target is not public, so the promotion is hidden. */
  targetPublic: boolean | null;
  /** One entry per ACTIVE locale, default first. */
  locales: Array<{ locale: string; state: PromotionLocaleState }>;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface ListPromotionsFilter {
  /** true lists the trash instead of the live set. */
  deleted?: boolean;
}

/**
 * The admin list. Promotions are few and short-lived, so this returns the
 * whole set rather than a page — the table filters and sorts client-side,
 * as the social links and roles screens do.
 */
export async function listPromotions(
  filter: ListPromotionsFilter = {},
  now: Date = new Date(),
): Promise<PromotionAdminRow[]> {
  const { defaultLocale, active } = await locales();
  const rows = await db.promotion.findMany({
    where: { deletedAt: filter.deleted ? { not: null } : null },
    orderBy: [{ startsAt: "desc" }, { id: "asc" }],
    include: {
      translations: { select: { locale: true, title: true, translationStatus: true } },
    },
  });

  const contentRefs = rows
    .filter((row) => row.linkKind === "CONTENT" && row.targetType && row.targetId)
    .map((row) => ({ type: row.targetType!, id: row.targetId! }));
  const [publicTargets, anyTargets] = await Promise.all([
    loadTargets(contentRefs, [defaultLocale], { publicOnly: true, now }),
    loadTargets(contentRefs, [defaultLocale], { publicOnly: false, now }),
  ]);

  return rows.map((row) => {
    const source = row.translations.find((t) => t.locale === defaultLocale);
    const ref =
      row.linkKind === "CONTENT" && row.targetType && row.targetId
        ? targetKey({ type: row.targetType, id: row.targetId })
        : null;
    const borrowedTitle = ref ? anyTargets.get(ref)?.byLocale.get(defaultLocale)?.title : undefined;
    const ordered = [defaultLocale, ...active.filter((code) => code !== defaultLocale)];
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      phase: promotionPhase(row, now),
      title: source?.title ?? borrowedTitle ?? null,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      placements: placementsOf(row.placements),
      showAsPopup: row.showAsPopup,
      showInBand: row.showInBand,
      showAsBar: row.showAsBar,
      barPosition: row.barPosition,
      priority: row.priority,
      linkKind: row.linkKind,
      targetPublic: ref ? publicTargets.has(ref) : null,
      locales: ordered.map((locale) => ({
        locale,
        state: row.translations.find((t) => t.locale === locale)?.translationStatus ?? "MISSING",
      })),
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt,
    };
  });
}

export interface PromotionTargetSummary {
  type: PromotionTargetTypeInput;
  id: string;
  title: string | null;
  /** False: the promotion is hidden until this content is public. */
  isPublic: boolean;
  /** False: the content was deleted, so saving again will be refused. */
  exists: boolean;
}

export interface PromotionDetail {
  id: string;
  kind: PromotionKindInput;
  status: "DRAFT" | "ACTIVE" | "ARCHIVED";
  phase: PromotionPhase;
  placements: PromotionPlacement[];
  showAsPopup: boolean;
  showInBand: boolean;
  showAsBar: boolean;
  barPosition: PromotionBarPositionInput;
  priority: number;
  startsAt: Date;
  endsAt: Date;
  eventStartsAt: Date | null;
  eventEndsAt: Date | null;
  frequency: PromotionFrequencyInput;
  delaySeconds: number;
  audience: PromotionAudienceInput;
  untranslated: PromotionUntranslatedInput;
  imageAssetId: string | null;
  imageUrl: string | null;
  linkKind: "CONTENT" | "PATH" | "EXTERNAL" | "NONE";
  target: PromotionTargetSummary | null;
  targetPath: string | null;
  targetUrl: string | null;
  recording: PromotionTargetSummary | null;
  version: number;
  deletedAt: Date | null;
  translations: Array<{
    locale: string;
    title: string | null;
    body: string | null;
    badge: string | null;
    ctaLabel: string | null;
    imageAlt: string | null;
    translationStatus: TranslationStatus;
    updatedAt: Date;
  }>;
}

async function summarizeTargets(
  refs: TargetRef[],
  defaultLocale: string,
  now: Date,
): Promise<Map<string, PromotionTargetSummary>> {
  const [pub, any] = await Promise.all([
    loadTargets(refs, [defaultLocale], { publicOnly: true, now }),
    loadTargets(refs, [defaultLocale], { publicOnly: false, now }),
  ]);
  return new Map(
    refs.map((ref) => {
      const key = targetKey(ref);
      const found = any.get(key);
      return [
        key,
        {
          ...ref,
          title: found?.byLocale.get(defaultLocale)?.title ?? null,
          isPublic: pub.has(key),
          exists: Boolean(found),
        },
      ];
    }),
  );
}

/** The editor's load. Includes a trashed row, so it can be restored from its page. */
export async function getPromotion(
  id: string,
  now: Date = new Date(),
): Promise<PromotionDetail | null> {
  const row = await db.promotion.findUnique({
    where: { id },
    include: { translations: { orderBy: { locale: "asc" } } },
  });
  if (!row) return null;
  const { defaultLocale } = await locales();

  const refs: TargetRef[] = [];
  const target =
    row.linkKind === "CONTENT" && row.targetType && row.targetId
      ? { type: row.targetType, id: row.targetId }
      : null;
  if (target) refs.push(target);
  const recording = row.recordingTopicId
    ? { type: "VIDEO_TOPIC" as const, id: row.recordingTopicId }
    : null;
  if (recording) refs.push(recording);
  const summaries = await summarizeTargets(refs, defaultLocale, now);
  const urls = await mediaUrls([row.imageAssetId]);

  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    phase: promotionPhase(row, now),
    placements: placementsOf(row.placements),
    showAsPopup: row.showAsPopup,
    showInBand: row.showInBand,
    showAsBar: row.showAsBar,
    barPosition: row.barPosition,
    priority: row.priority,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    eventStartsAt: row.eventStartsAt,
    eventEndsAt: row.eventEndsAt,
    frequency: row.frequency,
    delaySeconds: row.delaySeconds,
    audience: row.audience,
    untranslated: row.untranslated,
    imageAssetId: row.imageAssetId,
    imageUrl: row.imageAssetId ? (urls.get(row.imageAssetId) ?? null) : null,
    linkKind: row.linkKind,
    target: target ? (summaries.get(targetKey(target)) ?? null) : null,
    targetPath: row.targetPath,
    targetUrl: row.targetUrl,
    recording: recording ? (summaries.get(targetKey(recording)) ?? null) : null,
    version: row.version,
    deletedAt: row.deletedAt,
    translations: row.translations.map((t) => ({
      locale: t.locale,
      title: t.title,
      body: t.body,
      badge: t.badge,
      ctaLabel: t.ctaLabel,
      imageAlt: t.imageAlt,
      translationStatus: t.translationStatus,
      updatedAt: t.updatedAt,
    })),
  };
}

// ─── Link picker ─────────────────────────────────────────────

export interface LinkableContent {
  type: PromotionTargetTypeInput;
  id: string;
  title: string;
  /** The module's own status word, for the picker's badge. */
  status: ContentStatus | "ENABLED" | "DISABLED";
  /** False: choosing it is allowed, but the promotion stays hidden until it is. */
  isPublic: boolean;
}

const LINKABLE_PER_TYPE = 8;

/**
 * The admin link picker: drafts included and labelled, because an editor
 * announcing a course that goes live next week must be able to pick it now.
 * Matches the TITLE in the default language only — the same reason search
 * never matches rich text (public-search.ts): markup is not words.
 */
export async function searchLinkableContent(
  rawQuery: string,
  types: readonly PromotionTargetTypeInput[] = [
    "COURSE",
    "LESSON",
    "QUIZ",
    "ARTICLE",
    "VIDEO_TOPIC",
    "GLOSSARY_TERM",
    "TOOL",
  ],
  now: Date = new Date(),
): Promise<LinkableContent[]> {
  const query = rawQuery
    .replace(/[%_\\]/g, "")
    .trim()
    .slice(0, 100);
  const { defaultLocale } = await locales();
  const wanted = new Set(types);
  const match = query ? { contains: query } : undefined;
  const take = LINKABLE_PER_TYPE;
  const base = { locale: defaultLocale };

  const [courses, lessons, quizzes, articles, videos, terms, tools] = await Promise.all([
    wanted.has("COURSE")
      ? db.courseTranslation.findMany({
          where: { ...base, title: match, course: { deletedAt: null } },
          select: { title: true, course: { select: { id: true, status: true } } },
          orderBy: { title: "asc" },
          take,
        })
      : [],
    wanted.has("LESSON")
      ? db.lessonTranslation.findMany({
          where: { ...base, title: match, lesson: { deletedAt: null } },
          select: { title: true, lesson: { select: { id: true, status: true } } },
          orderBy: { title: "asc" },
          take,
        })
      : [],
    wanted.has("QUIZ")
      ? db.quizTranslation.findMany({
          where: { ...base, title: match, quiz: { deletedAt: null } },
          select: { title: true, quiz: { select: { id: true, status: true } } },
          orderBy: { title: "asc" },
          take,
        })
      : [],
    wanted.has("ARTICLE")
      ? db.articleTranslation.findMany({
          where: { ...base, title: match, article: { deletedAt: null } },
          select: { title: true, article: { select: { id: true, status: true } } },
          orderBy: { updatedAt: "desc" },
          take,
        })
      : [],
    wanted.has("VIDEO_TOPIC")
      ? db.videoTopicTranslation.findMany({
          where: { ...base, title: match, topic: { deletedAt: null } },
          select: { title: true, topic: { select: { id: true, status: true } } },
          orderBy: { title: "asc" },
          take,
        })
      : [],
    wanted.has("GLOSSARY_TERM")
      ? db.glossaryTermTranslation.findMany({
          where: { ...base, term: match, glossaryTerm: { deletedAt: null } },
          select: { term: true, glossaryTerm: { select: { id: true, status: true } } },
          orderBy: { term: "asc" },
          take,
        })
      : [],
    wanted.has("TOOL")
      ? db.toolTranslation.findMany({
          where: { ...base, title: match },
          select: { title: true, tool: { select: { id: true, isEnabled: true } } },
          orderBy: { title: "asc" },
          take,
        })
      : [],
  ]);

  const found: Omit<LinkableContent, "isPublic">[] = [
    ...courses.map((r) => ({
      type: "COURSE" as const,
      id: r.course.id,
      title: r.title,
      status: r.course.status,
    })),
    ...lessons.map((r) => ({
      type: "LESSON" as const,
      id: r.lesson.id,
      title: r.title,
      status: r.lesson.status,
    })),
    ...quizzes.map((r) => ({
      type: "QUIZ" as const,
      id: r.quiz.id,
      title: r.title,
      status: r.quiz.status,
    })),
    ...articles.map((r) => ({
      type: "ARTICLE" as const,
      id: r.article.id,
      title: r.title,
      status: r.article.status,
    })),
    ...videos.map((r) => ({
      type: "VIDEO_TOPIC" as const,
      id: r.topic.id,
      title: r.title,
      status: r.topic.status,
    })),
    ...terms.map((r) => ({
      type: "GLOSSARY_TERM" as const,
      id: r.glossaryTerm.id,
      title: r.term,
      status: r.glossaryTerm.status,
    })),
    ...tools.map((r) => ({
      type: "TOOL" as const,
      id: r.tool.id,
      title: r.title,
      status: r.tool.isEnabled ? ("ENABLED" as const) : ("DISABLED" as const),
    })),
  ];
  const publicOnes = await loadTargets(found, [defaultLocale], { publicOnly: true, now });
  return found.map((item) => ({ ...item, isPublic: publicOnes.has(targetKey(item)) }));
}

// ─── Writes ──────────────────────────────────────────────────

/** Every id the save names must exist (any status — a draft target is allowed). */
async function assertReferencesExist(input: PromotionSaveInput, now: Date): Promise<void> {
  const refs: TargetRef[] = [];
  if (input.link.kind === "CONTENT")
    refs.push({ type: input.link.targetType, id: input.link.targetId });
  if (input.recordingTopicId) refs.push({ type: "VIDEO_TOPIC", id: input.recordingTopicId });
  if (refs.length > 0) {
    const found = await loadTargets(refs, [], { publicOnly: false, now });
    if (input.link.kind === "CONTENT" && !found.has(targetKey(refs[0]!))) {
      throw new PromotionRefusedError("targetMissing");
    }
    if (input.recordingTopicId && !found.has(`VIDEO_TOPIC:${input.recordingTopicId}`)) {
      throw new PromotionRefusedError("recordingMissing");
    }
  }
  if (input.imageAssetId) {
    const asset = await db.mediaAsset.findFirst({
      where: { id: input.imageAssetId, deletedAt: null, kind: "IMAGE" },
      select: { id: true },
    });
    if (!asset) throw new PromotionRefusedError("imageMissing");
  }
}

function linkColumns(link: PromotionSaveInput["link"]) {
  return {
    linkKind: link.kind,
    targetType: link.kind === "CONTENT" ? link.targetType : null,
    targetId: link.kind === "CONTENT" ? link.targetId : null,
    targetPath: link.kind === "PATH" ? link.path : null,
    targetUrl: link.kind === "EXTERNAL" ? link.url : null,
  };
}

function wordColumns(t: PromotionSaveInput["translation"]) {
  const body = blankToNull(t.body);
  return {
    title: blankToNull(t.title),
    // security.md #8 — sanitized on save whatever the editor sent. A body
    // that sanitizes to nothing is absent, not an empty paragraph.
    body: body ? blankToNull(sanitizeRichText(body)) : null,
    badge: blankToNull(t.badge),
    ctaLabel: blankToNull(t.ctaLabel),
    imageAlt: blankToNull(t.imageAlt),
  };
}

/**
 * Create or update a promotion and its default-language words in ONE
 * transaction. Status is never set here — `setPromotionStatus` is the only
 * door to ACTIVE, so `promotions.publish` gates going live in one place.
 *
 * Every update bumps `version`, which the popup's "already seen" key
 * includes: a promotion edited after a visitor dismissed it is news again.
 */
export async function savePromotion(
  actor: Subject,
  input: PromotionSaveInput,
  now: Date = new Date(),
): Promise<string> {
  const { defaultLocale } = await locales();
  if (input.translation.locale !== defaultLocale) {
    throw new PromotionRefusedError("notDefaultLocale");
  }

  let existing: { status: string; deletedAt: Date | null } | null = null;
  if (input.id) {
    existing = await db.promotion.findUnique({
      where: { id: input.id },
      select: { status: true, deletedAt: true },
    });
    if (!existing) throw new PromotionNotFoundError(input.id);
    if (existing.deletedAt) throw new PromotionRefusedError("deleted");
    requireKey(actor, "promotions.update");
    if (existing.status === "ACTIVE") requireKey(actor, "promotions.publish");
  } else {
    requireKey(actor, "promotions.create");
  }

  await assertReferencesExist(input, now);

  const columns = {
    kind: input.kind,
    placements: [...input.placements],
    showAsPopup: input.showAsPopup,
    showInBand: input.showInBand,
    showAsBar: input.showAsBar,
    barPosition: input.barPosition,
    priority: input.priority,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    eventStartsAt: input.eventStartsAt ?? null,
    eventEndsAt: input.eventEndsAt ?? null,
    frequency: input.frequency,
    delaySeconds: input.delaySeconds,
    audience: input.audience,
    untranslated: input.untranslated,
    imageAssetId: input.imageAssetId ?? null,
    recordingTopicId: input.recordingTopicId ?? null,
    ...linkColumns(input.link),
    updatedById: actor.id,
  };
  const words = {
    ...wordColumns(input.translation),
    translationStatus: TranslationStatus.TRANSLATED,
  };

  const id = await db.$transaction(async (tx) => {
    const row = input.id
      ? await tx.promotion.update({
          where: { id: input.id },
          data: { ...columns, version: { increment: 1 } },
          select: { id: true },
        })
      : await tx.promotion.create({
          data: { ...columns, createdById: actor.id },
          select: { id: true },
        });
    await tx.promotionTranslation.upsert({
      where: { promotionId_locale: { promotionId: row.id, locale: defaultLocale } },
      update: { ...words, translatedBy: actor.id },
      create: { promotionId: row.id, locale: defaultLocale, ...words, translatedBy: actor.id },
    });
    // The image is a ContentReference so deleteMedia()'s in-use guard
    // protects it (the ADR-132 cover precedent).
    await syncReferences(
      tx,
      { sourceType: "PROMOTION", sourceId: row.id },
      input.imageAssetId
        ? [{ refType: "MEDIA", refId: input.imageAssetId, field: "imageAssetId" }]
        : [],
    );
    return row.id;
  });

  await recordAudit({
    userId: actor.id,
    action: input.id ? "promotions.update" : "promotions.create",
    entityType: "promotion",
    entityId: id,
    changes: {
      after: {
        kind: input.kind,
        title: words.title,
        startsAt: input.startsAt.toISOString(),
        endsAt: input.endsAt.toISOString(),
        placements: input.placements,
        link: input.link.kind,
      },
    },
  });

  // ADR-164: the English row records the hash of what it now says, a person's
  // translation made from older English turns OUTDATED (and so, for a
  // promotion, hidden — ADR-167 #6), and one job per active language is
  // queued. Hashed from the STORED row, so it is the sanitized body.
  const source = await loadPromotionSource(db, id, defaultLocale);
  const hash = source ? hashPromotionSource(source) : null;
  if (hash) {
    await db.promotionTranslation.updateMany({
      where: { promotionId: id, locale: defaultLocale },
      data: { sourceHash: hash },
    });
  }
  await afterSourceSave("promotion", id, hash, defaultLocale);
  revalidateTag("content", { expire: 0 });
  return id;
}

/**
 * One non-default language's words, saved by a person — TRANSLATED, the
 * ADR-161 rule, with the hash of the English it was made from (computed here,
 * never taken from the client — ADR-164). `machineTranslated` keeps a
 * "Translate with Google" prefill nobody edited MACHINE_TRANSLATED, as the
 * article editor does: the first edit makes it a person's.
 *
 * Does NOT bump `version`: correcting an Arabic typo should not show the popup
 * again to every English reader who dismissed it.
 */
export async function savePromotionTranslation(
  actor: Subject,
  input: PromotionTranslationSaveInput,
): Promise<void> {
  requireKey(actor, "promotions.update");
  const { defaultLocale, active } = await locales();
  if (input.locale === defaultLocale) throw new PromotionRefusedError("notDefaultLocale");
  if (!active.includes(input.locale)) throw new PromotionRefusedError("localeNotActive");

  const row = await db.promotion.findUnique({
    where: { id: input.promotionId },
    select: { status: true, deletedAt: true },
  });
  if (!row) throw new PromotionNotFoundError(input.promotionId);
  if (row.deletedAt) throw new PromotionRefusedError("deleted");
  if (row.status === "ACTIVE") requireKey(actor, "promotions.publish");

  const english = await loadPromotionSource(db, input.promotionId, defaultLocale);
  const words = {
    ...wordColumns(input),
    translationStatus: input.machineTranslated
      ? TranslationStatus.MACHINE_TRANSLATED
      : TranslationStatus.TRANSLATED,
    sourceHash: english ? hashPromotionSource(english) : null,
    translatedBy: actor.id,
  };
  await db.promotionTranslation.upsert({
    where: { promotionId_locale: { promotionId: input.promotionId, locale: input.locale } },
    update: words,
    create: { promotionId: input.promotionId, locale: input.locale, ...words },
  });

  await recordAudit({
    userId: actor.id,
    action: "promotions.update",
    entityType: "promotion",
    entityId: input.promotionId,
    changes: { after: { locale: input.locale, title: words.title } },
  });
  revalidateTag("content", { expire: 0 });
}

/**
 * Draft → Active → Archived, and back. `promotions.publish` is the whole
 * gate (ADR-167 #7). Activating refuses a promotion whose window has already
 * closed — it would go "live" and show nowhere — and one with no words to
 * show in the default language.
 */
export async function setPromotionStatus(
  actor: Subject,
  input: PromotionStatusChangeInput,
  now: Date = new Date(),
): Promise<void> {
  requireKey(actor, "promotions.publish");
  const { defaultLocale } = await locales();
  const row = await db.promotion.findUnique({
    where: { id: input.id },
    include: { translations: { where: { locale: defaultLocale } } },
  });
  if (!row) throw new PromotionNotFoundError(input.id);
  if (row.deletedAt) throw new PromotionRefusedError("deleted");
  if (row.status === input.status) return;

  if (input.status === "ACTIVE") {
    if (row.endsAt.getTime() <= now.getTime()) throw new PromotionRefusedError("windowEnded");
    const source = row.translations[0];
    if (!source || (!source.title && row.linkKind !== "CONTENT")) {
      throw new PromotionRefusedError("noWords");
    }
  }

  await db.promotion.update({
    where: { id: input.id },
    data: { status: input.status, updatedById: actor.id },
  });
  await recordAudit({
    userId: actor.id,
    action: input.status === "ACTIVE" ? "promotions.publish" : "promotions.status",
    entityType: "promotion",
    entityId: input.id,
    changes: { before: { status: row.status }, after: { status: input.status } },
  });
  revalidateTag("content", { expire: 0 });
}

/**
 * A copy as DRAFT, every language included, window unchanged — the editor
 * moves the dates. This is the recurring webinar: v1 has no recurrence rules
 * (changes-52 §12), and a copy the editor adjusts beats a rule nobody reads.
 */
export async function duplicatePromotion(actor: Subject, id: string): Promise<string> {
  requireKey(actor, "promotions.create");
  const row = await db.promotion.findUnique({ where: { id }, include: { translations: true } });
  if (!row || row.deletedAt) throw new PromotionNotFoundError(id);

  const {
    id: _id,
    status: _status,
    version: _version,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    deletedAt: _deletedAt,
    createdById: _createdById,
    translations,
    placements,
    ...rest
  } = row;

  const copyId = await db.$transaction(async (tx) => {
    const copy = await tx.promotion.create({
      data: {
        ...rest,
        placements: placements as Prisma.InputJsonValue,
        status: "DRAFT",
        createdById: actor.id,
        updatedById: actor.id,
      },
      select: { id: true },
    });
    for (const t of translations) {
      const { id: _tid, promotionId: _pid, createdAt: _c, updatedAt: _u, ...fields } = t;
      await tx.promotionTranslation.create({ data: { ...fields, promotionId: copy.id } });
    }
    await syncReferences(
      tx,
      { sourceType: "PROMOTION", sourceId: copy.id },
      row.imageAssetId
        ? [{ refType: "MEDIA", refId: row.imageAssetId, field: "imageAssetId" }]
        : [],
    );
    return copy.id;
  });

  await recordAudit({
    userId: actor.id,
    action: "promotions.create",
    entityType: "promotion",
    entityId: copyId,
    changes: { after: { duplicatedFrom: id } },
  });
  return copyId;
}

/**
 * To the trash. The image reference is KEPT, so a restore needs nothing
 * re-picked; a trashed promotion is never public (`liveWhere`).
 */
export async function softDeletePromotion(actor: Subject, id: string): Promise<void> {
  requireKey(actor, "promotions.delete");
  const row = await db.promotion.findUnique({ where: { id }, select: { deletedAt: true } });
  if (!row) throw new PromotionNotFoundError(id);
  if (row.deletedAt) return;
  await db.promotion.update({
    where: { id },
    data: { deletedAt: new Date(), updatedById: actor.id },
  });
  await recordAudit({
    userId: actor.id,
    action: "promotions.delete",
    entityType: "promotion",
    entityId: id,
  });
  revalidateTag("content", { expire: 0 });
}

/**
 * Out of the trash as a DRAFT, whatever it was. A deleted live offer should
 * not reappear on the site because someone undid a mistake in the list; going
 * live again is a publish decision, made with `promotions.publish`.
 */
export async function restorePromotion(actor: Subject, id: string): Promise<void> {
  requireKey(actor, "promotions.delete");
  const row = await db.promotion.findUnique({ where: { id }, select: { deletedAt: true } });
  if (!row) throw new PromotionNotFoundError(id);
  if (!row.deletedAt) return;
  await db.promotion.update({
    where: { id },
    data: { deletedAt: null, status: "DRAFT", updatedById: actor.id },
  });
  await recordAudit({
    userId: actor.id,
    action: "promotions.restore",
    entityType: "promotion",
    entityId: id,
  });
  revalidateTag("content", { expire: 0 });
}
