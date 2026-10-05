// changes-52 P4 (ADR-167): the public wiring of promotions, guarded where no
// type or lint rule reaches.
//
//   1. The popup host sits INSIDE `PublicSessionProvider`. Outside it,
//      `usePublicSession` answers "loading" forever (by design, it never
//      throws), so every guest-only or learner-only promotion would silently
//      never open.
//   2. `/api/promotions` is a READ. An anonymous POST here would be the third
//      anonymous mutation ADR-080/113 say needs its own ADR.
//   3. The home band suspends on its OWN. Its data is a sub-five-minute cache —
//      a dynamic hole — and it sits among the bands the home page renders
//      without a boundary, so a missing `<Suspense>` here fails the build.
//   4. Every target type maps to a feature flag the seed actually creates, so
//      a switched-off section hides its promotions instead of 404ing them.
//   5. (P5) The "Add to calendar" route is a read too, and it finds its
//      promotion in the SAME cached live list the popup reads — never a query
//      of its own with a second idea of "public" that could serve a draft's
//      webinar link as a file.
//   6. (P7, ADR-170) The counters' endpoint is the THIRD anonymous write. Its
//      five guards are pinned one by one, its table can hold no identifier,
//      and every POST route under `app/api` must name its gate — so a fourth
//      anonymous write fails here until someone declares it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PROMOTION_TARGET_TYPES } from "@repo/contracts";
import { PROMOTION_TARGET_FLAGS } from "./_lib/promotion-flags.ts";

const app = resolve(process.cwd(), "app");
const read = (path: string) => readFileSync(resolve(app, path), "utf8");

describe("promotions on the public site", () => {
  it("mounts the popup host inside the session provider", () => {
    const layout = read("(public)/[locale]/layout.tsx");
    const open = layout.indexOf("<PublicSessionProvider>");
    const host = layout.indexOf("<PromotionHost />");
    const close = layout.indexOf("</PublicSessionProvider>");
    expect(open).toBeGreaterThan(-1);
    expect(host).toBeGreaterThan(open);
    expect(host).toBeLessThan(close);
  });

  it("mounts both banner slots inside the session provider, the top one above the header (ADR-173)", () => {
    const layout = read("(public)/[locale]/layout.tsx");
    const open = layout.indexOf("<PublicSessionProvider>");
    const close = layout.indexOf("</PublicSessionProvider>");
    const top = layout.indexOf('<PromotionBars slot="top" />');
    const fixed = layout.indexOf('<PromotionBars slot="fixed" />');
    const header = layout.indexOf("<SiteHeader");
    for (const at of [top, fixed]) {
      expect(at).toBeGreaterThan(open);
      expect(at).toBeLessThan(close);
    }
    // In flow ABOVE the header, so a top banner never covers the sticky bar.
    expect(top).toBeLessThan(header);
    // The bottom strip's height reaches the FOOTER's padding (its dark ground,
    // never the body's light one — changes-57) and the back-to-top button.
    expect(layout).not.toContain("pb-(--promotion-bar-height)");
    expect(read("(public)/[locale]/_components/footer.tsx")).toContain(
      "pb-(--promotion-bar-height)",
    );
    expect(layout).toContain("bottom-(--floating-bottom)");
  });

  it("serves the popup's endpoint as a read only", () => {
    const route = read("api/promotions/route.ts");
    expect(route).toMatch(/export async function GET\b/);
    expect(route).not.toMatch(/export (async )?function (POST|PUT|PATCH|DELETE)\b/);
  });

  it("gives the home band its own Suspense boundary", () => {
    const band = read("(public)/[locale]/_sections/promotions.tsx");
    expect(band).toContain("<Suspense");
    expect(read("(public)/[locale]/_sections/registry.ts")).toMatch(/promotions: Promotions/);
  });

  it("maps every target type to a flag the seed creates", () => {
    expect(Object.keys(PROMOTION_TARGET_FLAGS).sort()).toEqual([...PROMOTION_TARGET_TYPES].sort());
    const seed = readFileSync(resolve(app, "..", "..", "..", "packages/db/prisma/seed.ts"), "utf8");
    for (const flag of new Set(Object.values(PROMOTION_TARGET_FLAGS))) {
      expect(seed, `feature flag "${flag}" is not seeded`).toMatch(
        new RegExp(`\\[\\s*"[\\w-]+",\\s*"${flag}",`),
      );
    }
  });

  it("serves the calendar file as a read of the popup's own live list", () => {
    const route = read("api/promotions/[id]/calendar.ics/route.ts");
    expect(route).toMatch(/export async function GET\b/);
    expect(route).not.toMatch(/export (async )?function (POST|PUT|PATCH|DELETE)\b/);
    expect(route).toContain("getLivePromotions(");
    expect(route).not.toMatch(/from "@repo\/db"|loadLivePromotions/);
    expect(route).toContain('"text/calendar; charset=utf-8"');
    // The card links to the path the contracts helper builds, not a copy of it.
    expect(read("(public)/[locale]/_components/promotion-card.tsx")).toContain(
      "promotionCalendarPath(",
    );
  });
});

describe("the promotion counters (ADR-170)", () => {
  const route = read("api/promotions/events/route.ts");

  it("accepts a POST and nothing else", () => {
    expect(route).toMatch(/export async function POST\b/);
    expect(route).not.toMatch(/export (async )?function (GET|PUT|PATCH|DELETE)\b/);
  });

  // ADR-170 #3: each stands in for part of the `requirePermission()` this
  // endpoint cannot have. Deleting one should fail here before production.
  it.each([
    ["live only", "getLivePromotions("],
    ["live only, inside the service too", "recordPromotionEvents("],
    ["the schema", "promotionEventsSchema"],
    ["same origin", "isSameOriginRequest("],
    ["a per-IP limit", "promo-events:ip:"],
    ["one count per network per day", "promo-events:once:"],
  ])("still checks %s", (_label, needle) => {
    expect(route).toContain(needle);
  });

  it("never touches the database directly, and hands the service no address", () => {
    expect(route).not.toMatch(/from "@repo\/db"/);
    expect(route).toMatch(/recordPromotionEvents\(fresh, live\)/);
  });

  it("answers every caller the same way", () => {
    expect(route).not.toMatch(/status:\s*(?!204)\d{3}/);
    expect(route).not.toContain("NextResponse.json");
  });

  it("keeps a table that can hold no identifier (ADR-170 #1)", () => {
    const schema = readFileSync(
      resolve(app, "..", "..", "..", "packages/db/prisma/schema.prisma"),
      "utf8",
    );
    const start = schema.indexOf("model PromotionDailyStat {");
    const block = schema.slice(start, schema.indexOf("\n}", start));
    const fields = [...block.matchAll(/^\s{2}(\w+)\s+\w/gm)].map((m) => m[1]).sort();
    expect(fields).toEqual(
      [
        "clicks",
        "day",
        "dismissals",
        "impressions",
        "promotion",
        "promotionId",
        "surface",
        "updatedAt",
      ].sort(),
    );
  });

  it("is reported by the popup, the band and the banner", () => {
    expect(read("(public)/[locale]/_components/promotion-host.tsx")).toContain(
      "reportPromotionEvent(",
    );
    expect(read("(public)/[locale]/_components/promotions-band-cards.tsx")).toContain(
      "reportPromotionEvent(",
    );
    expect(read("(public)/[locale]/_lib/promotion-events.ts")).toContain("PROMOTION_EVENTS_PATH");
    const bars = read("(public)/[locale]/_components/promotion-bars.tsx");
    for (const type of ["IMPRESSION", "CLICK", "DISMISS"]) {
      expect(bars).toContain(`surface: "BAR", type: "${type}"`);
    }
  });
});

describe("every POST route under app/api names its gate", () => {
  // The gates a route may rely on instead of being anonymous.
  // `cronAuthFailure` is the shared CRON_SECRET check (changes-54 N4).
  const GATES = ["requirePermission", "auth()", "guardQuizRequest", "cronAuthFailure"];

  // Anonymous by decision, each with the record that decided it. ADR-171 made
  // the fourth; a fifth anonymous write joins this list only with its own ADR.
  const DECLARED_ANONYMOUS: Record<string, string> = {
    "api/csp-report/route.ts": "a log line; stores nothing (changes-49)",
    "api/newsletter/unsubscribe/route.ts": "RFC 8058 one-click, token-gated (ADR-080)",
    "api/promotions/events/route.ts": "promotion counters (ADR-170)",
    "api/email/unsubscribe/route.ts": "announcement unsubscribe, HMAC-token-gated (ADR-171)",
  };

  function routes(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = resolve(dir, name);
      if (statSync(path).isDirectory()) return routes(path);
      return name === "route.ts" ? [path] : [];
    });
  }

  const posting = routes(resolve(app, "api"))
    .filter((path) => /export (async function|const) POST\b/.test(readFileSync(path, "utf8")))
    .map((path) => relative(app, path).replaceAll("\\", "/"));

  // Comments stripped first: a route explaining why it has NO
  // `requirePermission()` must not pass as one that calls it.
  const code = (path: string) =>
    read(path)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  it("finds the routes it is meant to police", () => {
    expect(posting.length).toBeGreaterThan(5);
  });

  it.each(posting)("%s is gated or declared", (path) => {
    const source = code(path);
    const gated = GATES.some((gate) => source.includes(gate));
    if (!gated) expect(Object.keys(DECLARED_ANONYMOUS)).toContain(path);
  });

  it("declares nothing that no longer exists", () => {
    for (const path of Object.keys(DECLARED_ANONYMOUS)) expect(posting).toContain(path);
  });
});

// changes-56 (ADR-174): each surface's shape, pinned where a refactor could
// quietly undo it.
describe("promotion surfaces (ADR-174)", () => {
  const bars = () => read("(public)/[locale]/_components/promotion-bars.tsx");

  it("rotates a banner with the reduced-motion guard and no pause button (changes-56)", () => {
    const source = bars();
    expect(source).toContain("ROTATE_MS");
    // The query lives in the shared guard file the spotlight uses too (ADR-175).
    expect(source).toContain("useMediaQuery(REDUCED_MOTION_QUERY)");
    expect(read("(public)/[locale]/_lib/document-state.ts")).toContain(
      "(prefers-reduced-motion: reduce)",
    );
    expect(source).not.toMatch(/t\("pause"\)/);
    expect(source).not.toMatch(/\bPause\b/);
  });

  it("decides the wide/narrow set in JS, so a hidden banner is never counted as seen", () => {
    const source = bars();
    expect(source).toContain("(min-width: 80rem)");
    // The ADR-173 duplicates hidden by a class are gone.
    expect(source).not.toMatch(/hidden xl:(block|flex)/);
  });

  it("gives the bottom strip a close tab that blocks no click outside itself", () => {
    const source = bars();
    expect(source).toContain("pointer-events-none container-page");
    expect(source).toContain("pointer-events-auto relative z-10 -mb-px");
  });

  // ADR-175 superseded ADR-174 #6: the band is a tabbed spotlight.
  it("runs the home band as a spotlight: tabs, a panel, and guarded autoplay", () => {
    const band = read("(public)/[locale]/_components/promotions-band-cards.tsx");
    expect(band).toContain("lg:grid-cols-(--grid-intro-main)");
    // The tiles pick; the start column is the selected promotion's panel.
    expect(band).toContain('role: "tablist"');
    expect(band).toContain('role="tab"');
    expect(band).toContain('role: "tabpanel"');
    // The ADR-174 #2 stops, pause button excepted (changes-56).
    expect(band).toContain("useMediaQuery(REDUCED_MOTION_QUERY)");
    expect(band).toContain("usePageVisible()");
    expect(band).toMatch(/!hovering && !focusWithin && !reducedMotion && inView && pageVisible/);
    // A transform on the track, never a scroll the page could inherit.
    expect(band).not.toContain("scrollIntoView");
    // The button's rules are the card's, not a copy (ADR-175 #6).
    expect(band).toContain("<PromotionCta");
    expect(band).toContain('surface: "BAND", type: "IMPRESSION"');
    expect(band).toContain('surface: "BAND", type: "CLICK"');
    // The selected tile's title card follows the button's destination, as a
    // sibling of the tab rather than a link nested inside a <button>.
    expect(band).toContain("const href = clock.recording ?? p.href;");
    expect(band).toContain("<Link href={href} onClick={onEngage}");
    expect(band).toContain("<TileTitle promotion={p} onEngage={onEngage} />");
  });

  it("draws the popup edge to edge with its own round, sticky close", () => {
    const host = read("(public)/[locale]/_components/promotion-host.tsx");
    expect(host).toContain("showCloseButton={false}");
    expect(host).toContain("<DialogClose");
    expect(host).toMatch(/sticky top-0 z-20 order-first/);
  });
});
