// Promotions (ADR-167, changes-52): time-boxed webinars, events, offers, news
// items and announcements shown as a popup on chosen pages and, optionally,
// in the home band.
//
// Two registries live here and nowhere else: the PLACEMENTS a promotion may
// name, and the paths a popup may never cover. Both are code, not admin
// options (ADR-167 #1) — where a slot exists is composition, and ADR-042
// settled that composition is code.
import { z } from "zod";
import { externalUrlSchema } from "./learn.ts";
import { internalPathSchema } from "./videos.ts";
import {
  HOME_BAND_PLACEMENTS,
  PROMOTION_EVENTS_MAX,
  PROMOTION_PLACEMENTS,
} from "./promotion-rules.ts";

const idSchema = z.string().min(1).max(64);
const localeSchema = z.string().min(2).max(10);

// ─── Vocabulary (mirrors the Prisma enums) ───────────────────

export const PROMOTION_KINDS = ["WEBINAR", "EVENT", "OFFER", "NEWS", "ANNOUNCEMENT"] as const;
export const promotionKindSchema = z.enum(PROMOTION_KINDS);
export type PromotionKindInput = z.infer<typeof promotionKindSchema>;

/** The kinds that carry their own event time (and may carry a recording). */
export const TIMED_PROMOTION_KINDS = [
  "WEBINAR",
  "EVENT",
] as const satisfies readonly PromotionKindInput[];

export const PROMOTION_STATUSES = ["DRAFT", "ACTIVE", "ARCHIVED"] as const;
export const promotionStatusSchema = z.enum(PROMOTION_STATUSES);
export type PromotionStatusInput = z.infer<typeof promotionStatusSchema>;

export const PROMOTION_FREQUENCIES = ["ONCE", "PER_SESSION", "DAILY", "EVERY_VISIT"] as const;
export const promotionFrequencySchema = z.enum(PROMOTION_FREQUENCIES);
export type PromotionFrequencyInput = z.infer<typeof promotionFrequencySchema>;

export const PROMOTION_AUDIENCES = ["ALL", "GUESTS", "LEARNERS"] as const;
export const promotionAudienceSchema = z.enum(PROMOTION_AUDIENCES);
export type PromotionAudienceInput = z.infer<typeof promotionAudienceSchema>;

export const PROMOTION_UNTRANSLATED = ["HIDE", "SHOW_DEFAULT"] as const;
export const promotionUntranslatedSchema = z.enum(PROMOTION_UNTRANSLATED);
export type PromotionUntranslatedInput = z.infer<typeof promotionUntranslatedSchema>;

export const PROMOTION_TARGET_TYPES = [
  "COURSE",
  "LESSON",
  "QUIZ",
  "ARTICLE",
  "VIDEO_TOPIC",
  "GLOSSARY_TERM",
  "TOOL",
] as const;
export const promotionTargetTypeSchema = z.enum(PROMOTION_TARGET_TYPES);
export type PromotionTargetTypeInput = z.infer<typeof promotionTargetTypeSchema>;

// ─── Banner positions (ADR-173) ──────────────────────────────

/**
 * Where a promotion's banner sits. A closed set, like the placements: an admin
 * picks one, never types one. `LEFT` and `RIGHT` render at the inline start
 * and end, so they mirror on a right-to-left page (ADR-173 #3).
 */
export const PROMOTION_BAR_POSITIONS = ["TOP", "BOTTOM", "LEFT", "RIGHT"] as const;
export const promotionBarPositionSchema = z.enum(PROMOTION_BAR_POSITIONS);
export type PromotionBarPositionInput = z.infer<typeof promotionBarPositionSchema>;

// ─── Placements (ADR-167 #1) ─────────────────────────────────
// The registry and the path rules live in promotion-rules.ts (zod-free).

export const promotionPlacementSchema = z.enum(PROMOTION_PLACEMENTS);

export const promotionPlacementsSchema = z
  .array(promotionPlacementSchema)
  .min(1, "choose at least one placement")
  .max(PROMOTION_PLACEMENTS.length)
  .refine((list) => new Set(list).size === list.length, {
    message: "a placement is listed twice",
  })
  .refine((list) => !list.includes("everywhere") || list.length === 1, {
    message: "everywhere cannot be combined with another placement",
  });

// ─── Link (ADR-167 #4) ───────────────────────────────────────

/**
 * Exactly one destination, as a discriminated union: which branch is present
 * IS the link kind, so a stored `linkKind` and a stray `targetUrl` beside a
 * CONTENT link cannot disagree. `NONE` is a standalone notice.
 */
export const promotionLinkSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("CONTENT"),
    targetType: promotionTargetTypeSchema,
    targetId: idSchema,
  }),
  z.object({ kind: z.literal("PATH"), path: internalPathSchema }),
  z.object({ kind: z.literal("EXTERNAL"), url: externalUrlSchema }),
  z.object({ kind: z.literal("NONE") }),
]);
export type PromotionLinkInput = z.infer<typeof promotionLinkSchema>;

// ─── Words (one locale) ──────────────────────────────────────

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

/**
 * One locale's words. Every field is optional here because a promotion LINKED
 * to site content borrows the target's title; the save schema below requires
 * a title when there is nothing to borrow from.
 *
 * `body` is rich text and is sanitized server-side on save (security.md #8).
 */
export const promotionTranslationSchema = z.object({
  locale: localeSchema,
  title: optionalText(160),
  body: optionalText(5000),
  badge: optionalText(40),
  ctaLabel: optionalText(60),
  imageAlt: optionalText(250),
});
export type PromotionTranslationInput = z.infer<typeof promotionTranslationSchema>;

// ─── Save ────────────────────────────────────────────────────

export const PROMOTION_MAX_PRIORITY = 1000;
export const PROMOTION_MAX_DELAY_SECONDS = 60;

export const promotionSaveSchema = z
  .object({
    /** Absent on create. */
    id: idSchema.optional(),
    kind: promotionKindSchema,
    placements: promotionPlacementsSchema,
    showAsPopup: z.boolean(),
    showInBand: z.boolean(),
    showAsBar: z.boolean(),
    barPosition: promotionBarPositionSchema,
    priority: z.int().min(0).max(PROMOTION_MAX_PRIORITY),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    eventStartsAt: z.coerce.date().nullable().optional(),
    eventEndsAt: z.coerce.date().nullable().optional(),
    frequency: promotionFrequencySchema,
    delaySeconds: z.int().min(0).max(PROMOTION_MAX_DELAY_SECONDS),
    audience: promotionAudienceSchema,
    untranslated: promotionUntranslatedSchema,
    imageAssetId: idSchema.nullable().optional(),
    link: promotionLinkSchema,
    recordingTopicId: idSchema.nullable().optional(),
    /** The default locale's words; other locales save through their own tab. */
    translation: promotionTranslationSchema,
  })
  .superRefine((value, ctx) => {
    if (value.endsAt.getTime() <= value.startsAt.getTime()) {
      ctx.addIssue({ code: "custom", path: ["endsAt"], message: "must be after the start" });
    }

    if (!value.showAsPopup && !value.showInBand && !value.showAsBar) {
      ctx.addIssue({
        code: "custom",
        path: ["showAsPopup"],
        message: "show it as a popup, in the home band, as a banner, or any of them",
      });
    }

    if (
      value.showInBand &&
      !value.placements.some((p) => (HOME_BAND_PLACEMENTS as readonly string[]).includes(p))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["showInBand"],
        message: "the band is on the home page, so the placements must include home",
      });
    }

    const timed = (TIMED_PROMOTION_KINDS as readonly string[]).includes(value.kind);
    if (value.eventStartsAt || value.eventEndsAt || value.recordingTopicId) {
      if (!timed) {
        ctx.addIssue({
          code: "custom",
          path: ["eventStartsAt"],
          message: "only a webinar or an event has its own time",
        });
      }
    }
    if (value.eventEndsAt && !value.eventStartsAt) {
      ctx.addIssue({ code: "custom", path: ["eventStartsAt"], message: "required with an end" });
    }
    if (
      value.eventStartsAt &&
      value.eventEndsAt &&
      value.eventEndsAt.getTime() <= value.eventStartsAt.getTime()
    ) {
      ctx.addIssue({ code: "custom", path: ["eventEndsAt"], message: "must be after the start" });
    }
    // The END, not just the start (changes-52 P5): the recording replaces the
    // button once the event has ended, and an event with no end never has.
    if (value.recordingTopicId && !value.eventEndsAt) {
      ctx.addIssue({
        code: "custom",
        path: ["recordingTopicId"],
        message: "a recording needs the event's end, to know when it has ended",
      });
    }

    // A standalone promotion has nothing to borrow a title from.
    if (value.link.kind !== "CONTENT" && !value.translation.title) {
      ctx.addIssue({
        code: "custom",
        path: ["translation", "title"],
        message: "required unless the promotion links to site content",
      });
    }
    // A button with no destination is a button that does nothing.
    if (value.link.kind === "NONE" && value.translation.ctaLabel) {
      ctx.addIssue({
        code: "custom",
        path: ["translation", "ctaLabel"],
        message: "a button label needs a link",
      });
    }
  });
export type PromotionSaveInput = z.infer<typeof promotionSaveSchema>;

/** One non-default locale's words, saved from its own tab (ADR-164). */
export const promotionTranslationSaveSchema = promotionTranslationSchema.extend({
  promotionId: idSchema,
  /** A "Translate with Google" prefill nobody has edited since (changes-52 P6). */
  machineTranslated: z.boolean().optional(),
});
export type PromotionTranslationSaveInput = z.infer<typeof promotionTranslationSaveSchema>;

export const promotionStatusChangeSchema = z.object({
  id: idSchema,
  status: promotionStatusSchema,
});
export type PromotionStatusChangeInput = z.infer<typeof promotionStatusChangeSchema>;

// ─── Derived status (ADR-167 #2) ─────────────────────────────

/**
 * What an admin sees in the list. Only DRAFT and ARCHIVED are stored as
 * such; an ACTIVE row is Scheduled, Live or Ended by the clock. The window is
 * `startsAt` inclusive, `endsAt` exclusive — the same bounds the public read
 * uses, so the list and the site cannot disagree about a boundary instant.
 */
export type PromotionPhase = "DRAFT" | "SCHEDULED" | "LIVE" | "ENDED" | "ARCHIVED";

export function promotionPhase(
  row: { status: PromotionStatusInput; startsAt: Date; endsAt: Date },
  now: Date,
): PromotionPhase {
  if (row.status !== "ACTIVE") return row.status;
  const t = now.getTime();
  if (t < row.startsAt.getTime()) return "SCHEDULED";
  if (t >= row.endsAt.getTime()) return "ENDED";
  return "LIVE";
}

/** `GET /api/promotions/[id]/calendar.ics` — the id from the path, the words' language from the query. */
export const promotionCalendarQuerySchema = z.object({
  id: idSchema,
  locale: z
    .string()
    .trim()
    .min(2)
    .max(10)
    .regex(/^[a-z]{2}(?:-[A-Za-z0-9]{2,8})?$/, "must be a locale code"),
});

/**
 * `GET /api/promotions` — the popup's one read. Locale only, never the path:
 * one URL per language is what a shared cache can hold, and the client files
 * the result by path itself (`promotionShowsOnPath`).
 */
export const publicPromotionsQuerySchema = z.object({
  locale: z
    .string()
    .trim()
    .min(2)
    .max(10)
    .regex(/^[a-z]{2}(?:-[A-Za-z0-9]{2,8})?$/, "must be a locale code"),
});

// ─── Counters (ADR-170, changes-52 P7) ───────────────────────

export const PROMOTION_SURFACES = ["POPUP", "BAND", "BAR"] as const;
export const promotionSurfaceSchema = z.enum(PROMOTION_SURFACES);
export type PromotionSurfaceInput = z.infer<typeof promotionSurfaceSchema>;

export const PROMOTION_EVENT_TYPES = ["IMPRESSION", "CLICK", "DISMISS"] as const;
export const promotionEventTypeSchema = z.enum(PROMOTION_EVENT_TYPES);
export type PromotionEventType = z.infer<typeof promotionEventTypeSchema>;

export const promotionEventSchema = z
  .object({
    id: idSchema,
    surface: promotionSurfaceSchema,
    type: promotionEventTypeSchema,
  })
  // The band has no dismiss control, so a band dismissal is a forged report.
  .refine((event) => event.type !== "DISMISS" || event.surface !== "BAND", {
    message: "only the popup and the banner can be dismissed",
    path: ["type"],
  });
export type PromotionEvent = z.infer<typeof promotionEventSchema>;

/** `POST /api/promotions/events` (ADR-170 #3). */
export const promotionEventsSchema = z.object({
  locale: z
    .string()
    .trim()
    .min(2)
    .max(10)
    .regex(/^[a-z]{2}(?:-[A-Za-z0-9]{2,8})?$/, "must be a locale code"),
  events: z.array(promotionEventSchema).min(1).max(PROMOTION_EVENTS_MAX),
});
export type PromotionEventsInput = z.infer<typeof promotionEventsSchema>;

/** Which surfaces a live promotion uses — all the counters need to know about it. */
export interface PromotionSurfaceFlags {
  id: string;
  showAsPopup: boolean;
  showInBand: boolean;
  showAsBar: boolean;
}

function usesSurface(promotion: PromotionSurfaceFlags, surface: PromotionSurfaceInput): boolean {
  switch (surface) {
    case "POPUP":
      return promotion.showAsPopup;
    case "BAND":
      return promotion.showInBand;
    case "BAR":
      return promotion.showAsBar;
  }
}

/**
 * ADR-170 #3.1: keep only events for a promotion that is LIVE, on a surface
 * it actually uses, once each. `live` is the cached public list the popup
 * itself read, so a draft, an ended promotion or an invented id can never
 * gain a counter row. Pure, so the rule is tested without a database.
 */
export function acceptedPromotionEvents(
  events: readonly PromotionEvent[],
  live: readonly PromotionSurfaceFlags[],
): PromotionEvent[] {
  const byId = new Map(live.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const accepted: PromotionEvent[] = [];
  for (const event of events) {
    const promotion = byId.get(event.id);
    if (!promotion) continue;
    if (!usesSurface(promotion, event.surface)) continue;
    const key = `${event.id}:${event.surface}:${event.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    accepted.push(event);
  }
  return accepted;
}

/** Clicks as a share of impressions, 0–100 with one decimal; null with no impressions. */
export function promotionClickRate(impressions: number, clicks: number): number | null {
  if (impressions <= 0) return null;
  return Math.round((Math.min(clicks, impressions) / impressions) * 1000) / 10;
}
