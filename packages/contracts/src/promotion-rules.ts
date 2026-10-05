// The parts of the promotions contract a BROWSER runs (ADR-167), split from
// promotions.ts (changes-62 #2): placements and path rules, the "seen" and
// frequency logic, the event clock, and the two report addresses.
//
// ZOD-FREE ON PURPOSE. The popup, banner and band are on every public page,
// and promotions.ts builds its schemas at load time, so importing one helper
// from it pulled all of Zod (~370 KB) into every page. Types from
// promotions.ts are fine (`import type` is erased); values are not.
import type { PromotionAudienceInput, PromotionFrequencyInput } from "./promotions.ts";

// ─── Placements (ADR-167 #1) ─────────────────────────────────

/**
 * Where a promotion may appear. `everywhere` means every public page a popup
 * is allowed on, and is exclusive: naming it beside another placement says
 * nothing more and reads as though it did.
 *
 * Adding a placement is an entry here, a rule in `placementsForPath`, and an
 * `admin.promotions.placements.*` catalog key.
 */
export const PROMOTION_PLACEMENTS = [
  "home",
  "learn",
  "news",
  "glossary",
  "tools",
  "support",
  "everywhere",
] as const;
export type PromotionPlacement = (typeof PROMOTION_PLACEMENTS)[number];

/**
 * The only placements the home BAND reads. The band exists on the home page
 * alone in v1 (changes-52 §4), so `showInBand` on a promotion placed nowhere
 * near home would be a switch that does nothing — code-style.md #28.
 */
export const HOME_BAND_PLACEMENTS = [
  "home",
  "everywhere",
] as const satisfies readonly PromotionPlacement[];

/**
 * Paths a popup never covers, whatever a promotion says. A popup over a
 * password form, a legal document, a newsletter confirmation, a staff preview
 * or a quiz mid-attempt is always wrong, so this is not an admin option.
 * Locale-less, matched by whole segments (`/news` does not cover
 * `/newsletter`).
 */
export const PROMOTION_EXCLUDED_PATHS = [
  "/sign-in",
  "/sign-up",
  "/forgot-password",
  "/reset-password",
  "/newsletter",
  "/legal",
  "/news/preview",
  "/keystone",
  "/admin",
  "/api",
] as const;

/** `/learn/{track}/quizzes/{quiz}` — the runner, where an attempt happens. */
const QUIZ_RUNNER = /^\/learn\/[^/]+\/quizzes\/[^/]+$/;
/** `/learn/{track}/glossary` — a track's view onto the glossary. */
const TRACK_GLOSSARY = /^\/learn\/[^/]+\/glossary$/;

function normalizePath(pathname: string): string {
  const bare = pathname.split(/[?#]/, 1)[0] ?? "";
  const trimmed = bare.length > 1 ? bare.replace(/\/+$/, "") : bare;
  return trimmed === "" ? "/" : trimmed;
}

/** True when `path` is `prefix` or lies under it, by whole segments. */
function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function isPromotionExcludedPath(pathname: string): boolean {
  const path = normalizePath(pathname);
  return PROMOTION_EXCLUDED_PATHS.some((prefix) => under(path, prefix)) || QUIZ_RUNNER.test(path);
}

/**
 * The placements a LOCALE-LESS public path belongs to, in registry order.
 * An excluded path belongs to none — not even `everywhere`. Every other path
 * belongs to `everywhere` plus whichever sections it sits in.
 */
export function placementsForPath(pathname: string): PromotionPlacement[] {
  const path = normalizePath(pathname);
  if (isPromotionExcludedPath(path)) return [];

  const matched = new Set<PromotionPlacement>(["everywhere"]);
  if (path === "/") matched.add("home");
  if (under(path, "/learn")) matched.add("learn");
  if (under(path, "/news") || under(path, "/analysis")) matched.add("news");
  if (under(path, "/glossary") || TRACK_GLOSSARY.test(path)) matched.add("glossary");
  if (under(path, "/tools") || under(path, "/economic-calendar")) matched.add("tools");
  if (under(path, "/support")) matched.add("support");

  return PROMOTION_PLACEMENTS.filter((placement) => matched.has(placement));
}

/** Does a promotion placed at `placements` appear on `pathname`? */
export function promotionShowsOnPath(
  placements: readonly PromotionPlacement[],
  pathname: string,
): boolean {
  const here = placementsForPath(pathname);
  return placements.some((placement) => here.includes(placement));
}

// ─── How often a visitor sees it (ADR-167, changes-52 §7.2) ──

/** What the popup host remembers about one promotion, in this browser. */
export interface PromotionSeen {
  /** Epoch ms of the last time it was SHOWN (localStorage), or null. */
  lastShownAt: number | null;
  /** Shown already in this browsing session (sessionStorage). */
  inThisSession: boolean;
}

/**
 * The storage key for one promotion's "seen" record. The VERSION is part of
 * it: an edited promotion is news again, so a visitor who dismissed version 3
 * sees version 4. Old keys are simply never read again.
 */
export function promotionSeenKey(id: string, version: number): string {
  return `promo:seen:${id}:v${version}`;
}

/**
 * The storage key for a BANNER's "closed" record (ADR-173 #5). Separate from
 * the popup's, so closing the banner never hides the popup, nor the reverse.
 */
export function promotionBarSeenKey(id: string, version: number): string {
  return `promo:bar:${id}:v${version}`;
}

/** Same calendar day in the READER's time zone — "once a day" is their day. */
function sameLocalDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return (
    x.getFullYear() === y.getFullYear() &&
    x.getMonth() === y.getMonth() &&
    x.getDate() === y.getDate()
  );
}

/**
 * Should the popup open for this promotion now? The banner asks the same
 * question with `seen` recording when it was CLOSED (ADR-173 #5), so the
 * frequency says when a closed banner comes back. Pure, so the rule is tested
 * here rather than through a browser, and a future native app reuses it.
 * "Shown" is recorded when the popup OPENS, not when it is dismissed: a
 * visitor who navigates away mid-popup has still seen it.
 */
export function shouldShowPromotion(
  frequency: PromotionFrequencyInput,
  seen: PromotionSeen,
  now: Date,
): boolean {
  switch (frequency) {
    case "ONCE":
      return seen.lastShownAt === null;
    case "PER_SESSION":
      return !seen.inThisSession;
    case "DAILY":
      return seen.lastShownAt === null || !sameLocalDay(seen.lastShownAt, now.getTime());
    case "EVERY_VISIT":
      return true;
  }
}

/** Does the promotion's audience include this reader? `null` = session unknown yet. */
export function promotionAudienceIncludes(
  audience: PromotionAudienceInput,
  signedIn: boolean | null,
): boolean {
  if (audience === "ALL") return true;
  // Unknown is NOT a guess: a guest-only offer must not flash at a learner
  // while their session loads, nor the reverse.
  if (signedIn === null) return false;
  return audience === "LEARNERS" ? signedIn : !signedIn;
}

// ─── A timed promotion's own clock (changes-52 P5) ───────────

/**
 * Where a webinar or event stands against its OWN time — not the display
 * window, which opens a week earlier and may close a day later.
 *
 * `UPCOMING` counts down and offers "Add to calendar"; `LIVE` says so;
 * `ENDED` hands over to the recording when there is one. An event with no end
 * never reaches `ENDED` (the save schema refuses a recording without one).
 * `null` means the promotion has no event time at all.
 */
export type PromotionEventPhase = "UPCOMING" | "LIVE" | "ENDED";

export function promotionEventPhase(
  event: { eventStartsAt: Date | string | null; eventEndsAt: Date | string | null },
  now: Date,
): PromotionEventPhase | null {
  if (!event.eventStartsAt) return null;
  const t = now.getTime();
  if (t < new Date(event.eventStartsAt).getTime()) return "UPCOMING";
  if (event.eventEndsAt && t >= new Date(event.eventEndsAt).getTime()) return "ENDED";
  return "LIVE";
}

/**
 * "Starts in 2 d 4 h" as numbers, two units at most, so the words stay in the
 * catalog. Rounded DOWN to the minute: a countdown that says "0 min" a minute
 * early reads as late, and one that rounds up promises a start that has not
 * come. Under a minute is `{ minutes: 0 }` — the caller says "starting now".
 */
export type PromotionCountdown =
  | { unit: "days"; days: number; hours: number }
  | { unit: "hours"; hours: number; minutes: number }
  | { unit: "minutes"; minutes: number };

export function promotionCountdown(until: Date | string, now: Date): PromotionCountdown | null {
  const ms = new Date(until).getTime() - now.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return { unit: "days", days, hours };
  if (hours > 0) return { unit: "hours", hours, minutes };
  return { unit: "minutes", minutes };
}

/** The public "Add to calendar" address — one place, so the card and the route agree. */
export function promotionCalendarPath(id: string, locale: string): string {
  return `/api/promotions/${encodeURIComponent(id)}/calendar.ics?locale=${encodeURIComponent(locale)}`;
}

/** Most events one report may carry: a three-promotion dialog seen, then closed. */
export const PROMOTION_EVENTS_MAX = 6;

/** Where the popup, the band and the banner report. One place, so the client and the route agree. */
export const PROMOTION_EVENTS_PATH = "/api/promotions/events";
