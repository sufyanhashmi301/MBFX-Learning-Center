import { describe, expect, it } from "vitest";
import { ROUTE_PATHS } from "./index.ts";
import {
  PROMOTION_EXCLUDED_PATHS,
  PROMOTION_PLACEMENTS,
  isPromotionExcludedPath,
  placementsForPath,
  promotionLinkSchema,
  promotionPhase,
  promotionPlacementsSchema,
  promotionSaveSchema,
  promotionShowsOnPath,
  promotionAudienceIncludes,
  promotionSeenKey,
  promotionBarSeenKey,
  PROMOTION_BAR_POSITIONS,
  shouldShowPromotion,
  publicPromotionsQuerySchema,
  promotionCalendarPath,
  promotionCalendarQuerySchema,
  promotionCountdown,
  promotionEventPhase,
  promotionTranslationSaveSchema,
  PROMOTION_EVENTS_MAX,
  acceptedPromotionEvents,
  promotionClickRate,
  promotionEventsSchema,
  type PromotionEvent,
  type PromotionPlacement,
} from "./index.ts";
import { translatePrefillSchema } from "./translate.ts";

const START = "2026-10-01T09:00:00.000Z";
const END = "2026-10-08T09:00:00.000Z";

function valid(overrides: Record<string, unknown> = {}) {
  return {
    kind: "OFFER",
    placements: ["home"],
    showAsPopup: true,
    showInBand: false,
    showAsBar: false,
    barPosition: "BOTTOM",
    priority: 0,
    startsAt: START,
    endsAt: END,
    frequency: "PER_SESSION",
    delaySeconds: 5,
    audience: "ALL",
    untranslated: "HIDE",
    link: { kind: "PATH", path: "/support" },
    translation: { locale: "en", title: "Autumn offer", ctaLabel: "Find out more" },
    ...overrides,
  };
}

function issuePaths(input: unknown): string[] {
  const result = promotionSaveSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));
}

describe("promotionSaveSchema", () => {
  it("accepts a complete standalone promotion", () => {
    expect(promotionSaveSchema.safeParse(valid()).success).toBe(true);
  });

  it("coerces ISO strings to dates", () => {
    const parsed = promotionSaveSchema.parse(valid());
    expect(parsed.startsAt).toBeInstanceOf(Date);
    expect(parsed.startsAt.toISOString()).toBe(START);
  });

  it("refuses a window that ends at or before its start", () => {
    expect(issuePaths(valid({ endsAt: START }))).toContain("endsAt");
    expect(issuePaths(valid({ startsAt: END, endsAt: START }))).toContain("endsAt");
  });

  it("refuses a promotion shown on no surface at all", () => {
    expect(issuePaths(valid({ showAsPopup: false, showInBand: false }))).toContain("showAsPopup");
  });

  describe("banner (ADR-173)", () => {
    it("is a surface on its own — a banner alone is enough", () => {
      expect(
        promotionSaveSchema.safeParse(valid({ showAsPopup: false, showAsBar: true })).success,
      ).toBe(true);
    });

    it("takes each of the four positions and nothing else", () => {
      for (const barPosition of PROMOTION_BAR_POSITIONS) {
        expect(promotionSaveSchema.safeParse(valid({ showAsBar: true, barPosition })).success).toBe(
          true,
        );
      }
      expect(issuePaths(valid({ showAsBar: true, barPosition: "MIDDLE" }))).toContain(
        "barPosition",
      );
      expect(issuePaths(valid({ barPosition: undefined }))).toContain("barPosition");
    });

    it("remembers a closed banner apart from a seen popup, per version", () => {
      expect(promotionBarSeenKey("p1", 3)).toBe("promo:bar:p1:v3");
      expect(promotionBarSeenKey("p1", 3)).not.toBe(promotionSeenKey("p1", 3));
      expect(promotionBarSeenKey("p1", 4)).not.toBe(promotionBarSeenKey("p1", 3));
    });
  });

  it("refuses the band unless the placements reach the home page", () => {
    expect(issuePaths(valid({ showInBand: true, placements: ["learn"] }))).toContain("showInBand");
    expect(promotionSaveSchema.safeParse(valid({ showInBand: true })).success).toBe(true);
    expect(
      promotionSaveSchema.safeParse(valid({ showInBand: true, placements: ["everywhere"] }))
        .success,
    ).toBe(true);
  });

  it("requires a title when there is no linked content to borrow one from", () => {
    const untitled = { locale: "en", title: null };
    expect(issuePaths(valid({ translation: untitled }))).toContain("translation.title");
    expect(issuePaths(valid({ translation: untitled, link: { kind: "NONE" } }))).toContain(
      "translation.title",
    );
  });

  it("lets a promotion linked to site content borrow its title", () => {
    const linked = valid({
      link: { kind: "CONTENT", targetType: "COURSE", targetId: "c1" },
      translation: { locale: "en" },
    });
    expect(promotionSaveSchema.safeParse(linked).success).toBe(true);
  });

  it("refuses a button label with no link", () => {
    expect(issuePaths(valid({ link: { kind: "NONE" } }))).toContain("translation.ctaLabel");
  });

  describe("event time", () => {
    const webinar = (extra: Record<string, unknown>) => valid({ kind: "WEBINAR", ...extra });

    it("accepts a webinar with its own time and a recording", () => {
      const input = webinar({
        eventStartsAt: "2026-10-05T15:00:00.000Z",
        eventEndsAt: "2026-10-05T16:00:00.000Z",
        recordingTopicId: "topic-1",
      });
      expect(promotionSaveSchema.safeParse(input).success).toBe(true);
    });

    it("refuses an event time on a kind that has none", () => {
      expect(issuePaths(valid({ eventStartsAt: "2026-10-05T15:00:00.000Z" }))).toContain(
        "eventStartsAt",
      );
    });

    it("refuses an end without a start, and an end before the start", () => {
      expect(issuePaths(webinar({ eventEndsAt: "2026-10-05T16:00:00.000Z" }))).toContain(
        "eventStartsAt",
      );
      expect(
        issuePaths(
          webinar({
            eventStartsAt: "2026-10-05T16:00:00.000Z",
            eventEndsAt: "2026-10-05T15:00:00.000Z",
          }),
        ),
      ).toContain("eventEndsAt");
    });

    it("refuses a recording with no event time to end", () => {
      expect(issuePaths(webinar({ recordingTopicId: "topic-1" }))).toContain("recordingTopicId");
      // A start alone never ends, so the recording would never show.
      expect(
        issuePaths(
          webinar({ eventStartsAt: "2026-10-05T15:00:00.000Z", recordingTopicId: "topic-1" }),
        ),
      ).toContain("recordingTopicId");
    });
  });

  it("bounds priority and delay", () => {
    expect(issuePaths(valid({ priority: -1 }))).toContain("priority");
    expect(issuePaths(valid({ delaySeconds: 61 }))).toContain("delaySeconds");
  });
});

describe("promotionLinkSchema — exactly one destination", () => {
  it("accepts each kind on its own", () => {
    for (const link of [
      { kind: "CONTENT", targetType: "ARTICLE", targetId: "a1" },
      { kind: "PATH", path: "/learn/forex" },
      { kind: "EXTERNAL", url: "https://zoom.us/j/123" },
      { kind: "NONE" },
    ]) {
      expect(promotionLinkSchema.safeParse(link).success).toBe(true);
    }
  });

  it("refuses a protocol-relative path, which would leave the site", () => {
    expect(promotionLinkSchema.safeParse({ kind: "PATH", path: "//evil.example/x" }).success).toBe(
      false,
    );
  });

  it("refuses anything but https on an external link", () => {
    for (const url of ["http://zoom.us/j/1", "javascript:alert(1)", "data:text/html,x"]) {
      expect(promotionLinkSchema.safeParse({ kind: "EXTERNAL", url }).success).toBe(false);
    }
  });

  it("refuses an unknown target type and a kind with its payload missing", () => {
    expect(
      promotionLinkSchema.safeParse({ kind: "CONTENT", targetType: "PAGE", targetId: "x" }).success,
    ).toBe(false);
    expect(promotionLinkSchema.safeParse({ kind: "EXTERNAL" }).success).toBe(false);
  });

  it("drops a second destination instead of storing it", () => {
    const parsed = promotionLinkSchema.parse({
      kind: "PATH",
      path: "/support",
      url: "https://evil.example",
    });
    expect(parsed).toEqual({ kind: "PATH", path: "/support" });
  });
});

describe("promotionPlacementsSchema", () => {
  it("requires at least one registered placement", () => {
    expect(promotionPlacementsSchema.safeParse([]).success).toBe(false);
    expect(promotionPlacementsSchema.safeParse(["homepage"]).success).toBe(false);
  });

  it("refuses duplicates", () => {
    expect(promotionPlacementsSchema.safeParse(["home", "home"]).success).toBe(false);
  });

  it("keeps everywhere exclusive", () => {
    expect(promotionPlacementsSchema.safeParse(["everywhere"]).success).toBe(true);
    expect(promotionPlacementsSchema.safeParse(["everywhere", "home"]).success).toBe(false);
  });
});

describe("placementsForPath", () => {
  it("maps each section to its placement, plus everywhere", () => {
    const cases: Array<[string, PromotionPlacement[]]> = [
      ["/", ["home", "everywhere"]],
      ["/learn", ["learn", "everywhere"]],
      ["/learn/forex/some-course/some-lesson", ["learn", "everywhere"]],
      ["/learn/crypto/glossary", ["learn", "glossary", "everywhere"]],
      ["/news/some-article", ["news", "everywhere"]],
      ["/analysis", ["news", "everywhere"]],
      ["/glossary/pip", ["glossary", "everywhere"]],
      ["/tools/pip-value", ["tools", "everywhere"]],
      ["/economic-calendar", ["tools", "everywhere"]],
      ["/support", ["support", "everywhere"]],
      ["/sitemap", ["everywhere"]],
      ["/account/progress", ["everywhere"]],
    ];
    for (const [path, expected] of cases) expect(placementsForPath(path), path).toEqual(expected);
  });

  it("matches whole segments, so /newsletter is not /news", () => {
    expect(placementsForPath("/newsletter/confirm")).toEqual([]);
    expect(placementsForPath("/newsroom")).toEqual(["everywhere"]);
    expect(placementsForPath("/learning")).toEqual(["everywhere"]);
  });

  it("ignores a trailing slash, a query and a hash", () => {
    expect(placementsForPath("/support/")).toEqual(["support", "everywhere"]);
    expect(placementsForPath("/?utm=x")).toEqual(["home", "everywhere"]);
    expect(placementsForPath("/tools#top")).toEqual(["tools", "everywhere"]);
  });

  it("gives an excluded path no placement at all, not even everywhere", () => {
    for (const prefix of PROMOTION_EXCLUDED_PATHS) {
      expect(placementsForPath(prefix), prefix).toEqual([]);
      expect(placementsForPath(`${prefix}/anything`), prefix).toEqual([]);
    }
  });

  it("keeps the quiz runner clear but not the quiz index", () => {
    expect(isPromotionExcludedPath("/learn/forex/quizzes/basics")).toBe(true);
    expect(placementsForPath("/learn/forex/quizzes")).toEqual(["learn", "everywhere"]);
  });

  it("files every registered route: a section, everywhere alone on purpose, or excluded", () => {
    // A new ROUTE_PATHS entry must be filed here. `everywhere`-only is a
    // deliberate answer (the sitemap is not a section), not a default.
    const everywhereOnly = new Set(["/sitemap"]);
    for (const [key, path] of Object.entries(ROUTE_PATHS)) {
      const placements = placementsForPath(path);
      if (isPromotionExcludedPath(path)) {
        expect(placements, key).toEqual([]);
      } else if (everywhereOnly.has(path)) {
        expect(placements, key).toEqual(["everywhere"]);
      } else {
        expect(placements.length, `${key} (${path}) belongs to no section`).toBeGreaterThan(1);
      }
    }
  });

  it("returns placements in registry order", () => {
    const placements = placementsForPath("/learn/forex/glossary");
    const order = placements.map((p) => PROMOTION_PLACEMENTS.indexOf(p));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe("promotionShowsOnPath", () => {
  it("shows a section promotion inside its section only", () => {
    expect(promotionShowsOnPath(["learn"], "/learn/forex")).toBe(true);
    expect(promotionShowsOnPath(["learn"], "/news")).toBe(false);
  });

  it("shows an everywhere promotion on any allowed page and never on an excluded one", () => {
    expect(promotionShowsOnPath(["everywhere"], "/sitemap")).toBe(true);
    expect(promotionShowsOnPath(["everywhere"], "/sign-in")).toBe(false);
    expect(promotionShowsOnPath(["home"], "/reset-password")).toBe(false);
  });
});

describe("promotionPhase — derived, never stored", () => {
  const row = {
    status: "ACTIVE" as const,
    startsAt: new Date(START),
    endsAt: new Date(END),
  };

  it("is Scheduled before the window, Live inside it, Ended after it", () => {
    expect(promotionPhase(row, new Date("2026-09-30T00:00:00Z"))).toBe("SCHEDULED");
    expect(promotionPhase(row, new Date("2026-10-03T00:00:00Z"))).toBe("LIVE");
    expect(promotionPhase(row, new Date("2026-10-09T00:00:00Z"))).toBe("ENDED");
  });

  it("includes the start instant and excludes the end instant", () => {
    expect(promotionPhase(row, new Date(START))).toBe("LIVE");
    expect(promotionPhase(row, new Date(END))).toBe("ENDED");
  });

  it("passes Draft and Archived through whatever the clock says", () => {
    const now = new Date("2026-10-03T00:00:00Z");
    expect(promotionPhase({ ...row, status: "DRAFT" }, now)).toBe("DRAFT");
    expect(promotionPhase({ ...row, status: "ARCHIVED" }, now)).toBe("ARCHIVED");
  });
});

describe("shouldShowPromotion", () => {
  const never = { lastShownAt: null, inThisSession: false };
  const noon = new Date(2026, 9, 5, 12, 0, 0);
  const earlierToday = new Date(2026, 9, 5, 8, 0, 0).getTime();
  const yesterday = new Date(2026, 9, 4, 23, 59, 0).getTime();

  it("shows everything the first time", () => {
    for (const frequency of ["ONCE", "PER_SESSION", "DAILY", "EVERY_VISIT"] as const) {
      expect(shouldShowPromotion(frequency, never, noon), frequency).toBe(true);
    }
  });

  it("never repeats ONCE, whatever the session or the day", () => {
    const seen = { lastShownAt: yesterday - 30 * 86_400_000, inThisSession: false };
    expect(shouldShowPromotion("ONCE", seen, noon)).toBe(false);
  });

  it("repeats PER_SESSION only in a new session", () => {
    expect(
      shouldShowPromotion("PER_SESSION", { lastShownAt: earlierToday, inThisSession: true }, noon),
    ).toBe(false);
    expect(
      shouldShowPromotion("PER_SESSION", { lastShownAt: earlierToday, inThisSession: false }, noon),
    ).toBe(true);
  });

  it("repeats DAILY once the reader's day has rolled over", () => {
    expect(
      shouldShowPromotion("DAILY", { lastShownAt: earlierToday, inThisSession: false }, noon),
    ).toBe(false);
    expect(
      shouldShowPromotion("DAILY", { lastShownAt: yesterday, inThisSession: true }, noon),
    ).toBe(true);
  });

  it("always shows EVERY_VISIT", () => {
    expect(
      shouldShowPromotion("EVERY_VISIT", { lastShownAt: earlierToday, inThisSession: true }, noon),
    ).toBe(true);
  });

  it("keys the record by version, so an edit is shown again", () => {
    expect(promotionSeenKey("p1", 3)).not.toBe(promotionSeenKey("p1", 4));
    expect(promotionSeenKey("p1", 3)).toBe("promo:seen:p1:v3");
  });
});

describe("promotionAudienceIncludes", () => {
  it("includes everyone for ALL, even before the session is known", () => {
    expect(promotionAudienceIncludes("ALL", null)).toBe(true);
  });

  it("waits for the session instead of guessing", () => {
    expect(promotionAudienceIncludes("GUESTS", null)).toBe(false);
    expect(promotionAudienceIncludes("LEARNERS", null)).toBe(false);
  });

  it("splits guests from learners", () => {
    expect(promotionAudienceIncludes("GUESTS", false)).toBe(true);
    expect(promotionAudienceIncludes("GUESTS", true)).toBe(false);
    expect(promotionAudienceIncludes("LEARNERS", true)).toBe(true);
    expect(promotionAudienceIncludes("LEARNERS", false)).toBe(false);
  });
});

describe("publicPromotionsQuerySchema", () => {
  it("accepts a locale code and refuses anything else", () => {
    expect(publicPromotionsQuerySchema.safeParse({ locale: "ar" }).success).toBe(true);
    expect(publicPromotionsQuerySchema.safeParse({ locale: "../etc" }).success).toBe(false);
    expect(publicPromotionsQuerySchema.safeParse({}).success).toBe(false);
  });
});

describe("promotionEventPhase", () => {
  const event = {
    eventStartsAt: "2026-10-05T15:00:00.000Z",
    eventEndsAt: "2026-10-05T16:00:00.000Z",
  };
  const at = (iso: string) => new Date(iso);

  it("is null for a promotion with no event time", () => {
    expect(promotionEventPhase({ eventStartsAt: null, eventEndsAt: null }, at(START))).toBeNull();
  });

  it("is UPCOMING before the start, LIVE from it, ENDED from the end", () => {
    expect(promotionEventPhase(event, at("2026-10-05T14:59:59.999Z"))).toBe("UPCOMING");
    expect(promotionEventPhase(event, at("2026-10-05T15:00:00.000Z"))).toBe("LIVE");
    expect(promotionEventPhase(event, at("2026-10-05T15:59:59.999Z"))).toBe("LIVE");
    expect(promotionEventPhase(event, at("2026-10-05T16:00:00.000Z"))).toBe("ENDED");
  });

  it("never ends an event that has no end", () => {
    const open = { eventStartsAt: event.eventStartsAt, eventEndsAt: null };
    expect(promotionEventPhase(open, at("2027-01-01T00:00:00.000Z"))).toBe("LIVE");
  });
});

describe("promotionCountdown", () => {
  const now = new Date("2026-10-01T12:00:00.000Z");
  const plus = (ms: number) => new Date(now.getTime() + ms);
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  it("uses days and hours past a day", () => {
    expect(promotionCountdown(plus(2 * DAY + 4 * HOUR + 59 * MIN), now)).toEqual({
      unit: "days",
      days: 2,
      hours: 4,
    });
  });

  it("uses hours and minutes under a day", () => {
    expect(promotionCountdown(plus(3 * HOUR + 7 * MIN + 30_000), now)).toEqual({
      unit: "hours",
      hours: 3,
      minutes: 7,
    });
  });

  it("uses minutes under an hour, rounding down", () => {
    expect(promotionCountdown(plus(59 * MIN + 59_000), now)).toEqual({
      unit: "minutes",
      minutes: 59,
    });
    expect(promotionCountdown(plus(30_000), now)).toEqual({ unit: "minutes", minutes: 0 });
  });

  it("is null once the moment has come, or for a bad date", () => {
    expect(promotionCountdown(now, now)).toBeNull();
    expect(promotionCountdown(plus(-1), now)).toBeNull();
    expect(promotionCountdown("not a date", now)).toBeNull();
  });
});

describe("the calendar address", () => {
  it("builds the path the route serves", () => {
    expect(promotionCalendarPath("p1", "ar")).toBe("/api/promotions/p1/calendar.ics?locale=ar");
  });

  it("parses an id and a locale, and refuses a traversal", () => {
    expect(promotionCalendarQuerySchema.safeParse({ id: "p1", locale: "en" }).success).toBe(true);
    expect(promotionCalendarQuerySchema.safeParse({ id: "p1", locale: "../x" }).success).toBe(
      false,
    );
    expect(promotionCalendarQuerySchema.safeParse({ id: "", locale: "en" }).success).toBe(false);
  });
});

describe("promotionTranslationSaveSchema (changes-52 P6)", () => {
  it("carries the machine-written flag of an untouched Google prefill", () => {
    const base = { promotionId: "p1", locale: "es", title: "Hola" };
    expect(promotionTranslationSaveSchema.parse(base).machineTranslated).toBeUndefined();
    expect(
      promotionTranslationSaveSchema.parse({ ...base, machineTranslated: true }).machineTranslated,
    ).toBe(true);
  });

  it("lets a promotion be prefilled through Google", () => {
    const prefill = { sourceLocale: "en", targetLocale: "es", texts: { title: "Hi" } };
    expect(
      translatePrefillSchema.safeParse({ ...prefill, entity: { type: "promotion", id: "p1" } })
        .success,
    ).toBe(true);
    expect(
      translatePrefillSchema.safeParse({ ...prefill, entity: { type: "course", id: "c1" } })
        .success,
    ).toBe(false);
  });
});

describe("promotion counters (ADR-170)", () => {
  const event = (overrides: Partial<PromotionEvent> = {}): PromotionEvent => ({
    id: "p1",
    surface: "POPUP",
    type: "IMPRESSION",
    ...overrides,
  });

  it("accepts a bounded report and refuses anything larger", () => {
    expect(promotionEventsSchema.safeParse({ locale: "ar", events: [event()] }).success).toBe(true);
    expect(promotionEventsSchema.safeParse({ locale: "ar", events: [] }).success).toBe(false);
    const tooMany = Array.from({ length: PROMOTION_EVENTS_MAX + 1 }, () => event());
    expect(promotionEventsSchema.safeParse({ locale: "ar", events: tooMany }).success).toBe(false);
  });

  it("refuses unknown enums, a bad locale and a dismissal from the band", () => {
    const parse = (events: unknown[], locale = "en") =>
      promotionEventsSchema.safeParse({ locale, events }).success;
    expect(parse([{ ...event(), type: "HOVER" }])).toBe(false);
    expect(parse([{ ...event(), surface: "BANNER" }])).toBe(false);
    expect(parse([event()], "../../etc")).toBe(false);
    expect(parse([event({ surface: "BAND", type: "DISMISS" })])).toBe(false);
    expect(parse([event({ surface: "POPUP", type: "DISMISS" })])).toBe(true);
    expect(parse([event({ surface: "BAR", type: "DISMISS" })])).toBe(true);
    expect(parse([{ ...event(), id: "x".repeat(65) }])).toBe(false);
  });

  it("strips anything the schema does not name (parse, don't spread)", () => {
    const parsed = promotionEventsSchema.parse({
      locale: "en",
      events: [{ ...event(), ip: "1.2.3.4", count: 1000 }],
      userId: "u1",
    });
    expect(parsed).toEqual({ locale: "en", events: [event()] });
  });

  const live = [
    { id: "popup", showAsPopup: true, showInBand: false, showAsBar: false },
    { id: "band", showAsPopup: false, showInBand: true, showAsBar: false },
    { id: "bar", showAsPopup: false, showInBand: false, showAsBar: true },
  ];

  it("counts only a live promotion, on a surface it uses", () => {
    expect(
      acceptedPromotionEvents(
        [
          event({ id: "popup" }),
          event({ id: "popup", surface: "BAND" }),
          event({ id: "band", surface: "BAND", type: "CLICK" }),
          event({ id: "band" }),
          event({ id: "draft-or-invented" }),
        ],
        live,
      ),
    ).toEqual([event({ id: "popup" }), event({ id: "band", surface: "BAND", type: "CLICK" })]);
  });

  it("counts a banner event only for a promotion with the banner on (ADR-173 #6)", () => {
    expect(
      acceptedPromotionEvents(
        [
          event({ id: "bar", surface: "BAR" }),
          event({ id: "bar", surface: "BAR", type: "DISMISS" }),
          event({ id: "popup", surface: "BAR" }),
          event({ id: "bar" }),
        ],
        live,
      ),
    ).toEqual([
      event({ id: "bar", surface: "BAR" }),
      event({ id: "bar", surface: "BAR", type: "DISMISS" }),
    ]);
  });

  it("counts each (promotion, surface, event) once per report", () => {
    expect(acceptedPromotionEvents([event({ id: "popup" }), event({ id: "popup" })], live)).toEqual(
      [event({ id: "popup" })],
    );
  });

  it("states a click rate only against real impressions", () => {
    expect(promotionClickRate(0, 0)).toBeNull();
    expect(promotionClickRate(0, 3)).toBeNull();
    expect(promotionClickRate(200, 7)).toBe(3.5);
    // A click can outlive its impression's bucket; a rate never passes 100%.
    expect(promotionClickRate(2, 5)).toBe(100);
  });
});
