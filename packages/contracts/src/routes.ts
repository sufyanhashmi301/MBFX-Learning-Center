// The route registry (Module 08), split from navigation.ts (changes-62 #2).
//
// ZOD-FREE ON PURPOSE. Client components across the public site read
// ROUTE_PATHS, and a module that also builds a schema at load time drags all
// of Zod (~370 KB) into every page that touches it. Keep schemas out of this
// file; `apps/web/app/contracts-client-modules.test.ts` fails if one arrives.

/**
 * Internal route registry: the routeKeys menu items may reference, mapped
 * to their path under the [locale] segment. A menu item pointing at a
 * route is stored as a KEY, not a path — paths can be reorganized in one
 * place here without touching every menu row in the database.
 */
export const ROUTE_PATHS = {
  home: "/",
  learn: "/learn",
  // Per-track learning surfaces (ADR-065 §1/§4). Spelled literally rather
  // than generated from LEARN_TRACKS, because `RouteKey` has to stay a union
  // of string literals — a computed key would widen it to `string` and take
  // the menu row's compile-time check with it. `LEARN_TRACK_ROUTE_KEYS` below
  // binds these back to the registry, and a test fails if the two disagree.
  "learn-forex": "/learn/forex",
  "learn-forex-videos": "/learn/forex/videos",
  "learn-forex-quizzes": "/learn/forex/quizzes",
  "learn-forex-glossary": "/learn/forex/glossary",
  "learn-crypto": "/learn/crypto",
  "learn-crypto-videos": "/learn/crypto/videos",
  "learn-crypto-quizzes": "/learn/crypto/quizzes",
  "learn-crypto-glossary": "/learn/crypto/glossary",
  glossary: "/glossary",
  tools: "/tools",
  // The eight trading tools (ADR-086 §3). Spelled out literally for the same
  // reason the learn tracks above are: `RouteKey` has to stay a union of
  // string literals, and a key computed from TOOL_KEYS would widen it to
  // `string` and take the menu row's compile-time check with it.
  // `TOOL_ROUTE_KEYS` in `tools.ts` binds these back to the registry, and
  // `tools.test.ts` fails if the two disagree in either direction.
  "tool-position-size": "/tools/position-size",
  "tool-pip-value": "/tools/pip-value",
  "tool-margin": "/tools/margin",
  "tool-profit-loss": "/tools/profit-loss",
  "tool-risk-reward": "/tools/risk-reward",
  "tool-gain-loss": "/tools/gain-loss",
  "tool-pivot-points": "/tools/pivot-points",
  "tool-market-hours": "/tools/market-hours",
  "tool-currency-converter": "/tools/currency-converter",
  "tool-correlation": "/tools/correlation",
  "tool-risk-sentiment": "/tools/risk-sentiment",
  // The two market boards (ADR-136 §5). They live under /tools but are NOT
  // `TOOLS` members, like the economic calendar (ADR-115 #2), so their keys
  // carry no `tool-` prefix: `tools.test.ts` reserves that prefix for
  // registered tools and fails on one without its tool.
  "live-rates": "/tools/live-rates",
  volatility: "/tools/volatility",
  // The vendor's headline feed as a page of its own (changes-40). Same
  // standing as the two boards above: a framed widget with our chrome, no
  // `Tool` row, no config schema, no editor — there is nothing on it for an
  // admin to configure, which is exactly ADR-115 #2's test.
  "market-news": "/tools/market-news",
  analysis: "/analysis",
  "economic-calendar": "/economic-calendar",
  news: "/news",
  "sign-in": "/sign-in",
  "sign-up": "/sign-up",
  // Support (changes-33, ADR-109). What survives of the About section: one
  // coded page, no children, no section bar. The four pages around it said
  // things a learning centre with no facts recorded could not say, and the
  // one page that answered a reader's actual question was buried three
  // clicks in.
  support: "/support",
  // The reader's sitemap (ADR-110). A page, not `sitemap.xml` — the footer
  // row the reference carries is for a person who cannot find something.
  sitemap: "/sitemap",
} as const satisfies Record<string, string>;

export type RouteKey = keyof typeof ROUTE_PATHS;

export function isRouteKey(key: string): key is RouteKey {
  return key in ROUTE_PATHS;
}

/**
 * The four route keys each learning track owns (ADR-065 §4, extended by
 * ADR-068 §1): its school index, its video library, its quiz index and its
 * glossary view.
 *
 * This is the join between two registries that must not drift —
 * `LEARN_TRACKS` in `learn.ts` decides which tracks exist, `ROUTE_PATHS`
 * above decides which URLs exist, and `learn.test.ts` fails if either grows
 * an entry the other has not. The mega-menu panels, the seeded menu rows, the
 * section bar and the sitemap all read the tracks through here, so adding a
 * track lights up every surface from one edit plus its two route entries.
 */
export const LEARN_TRACK_ROUTE_KEYS = {
  forex: {
    index: "learn-forex",
    videos: "learn-forex-videos",
    quizzes: "learn-forex-quizzes",
    glossary: "learn-forex-glossary",
  },
  crypto: {
    index: "learn-crypto",
    videos: "learn-crypto-videos",
    quizzes: "learn-crypto-quizzes",
    glossary: "learn-crypto-glossary",
  },
} as const satisfies Record<
  string,
  { index: RouteKey; videos: RouteKey; quizzes: RouteKey; glossary: RouteKey }
>;

/**
 * The surfaces a track owns, in section-bar order. Enumerated here so the
 * drift test iterates the registry instead of a list typed beside it — the
 * mistake ADR-068 Consequences records, where three places in `learn.test.ts`
 * hardcoded the original three and none of them failed when a fourth arrived.
 */
export const LEARN_TRACK_SURFACES = ["index", "videos", "quizzes", "glossary"] as const;
export type LearnTrackSurface = (typeof LEARN_TRACK_SURFACES)[number];

export type LearnTrackRouteKeys =
  (typeof LEARN_TRACK_ROUTE_KEYS)[keyof typeof LEARN_TRACK_ROUTE_KEYS];
