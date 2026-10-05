# ADR-187 — The home promotions band is prerendered, so `/` can be edge-cached

- **Status:** Accepted
- **Date:** 2026-10-05
- **Module:** 12 (public site)
- **Settles:** ADR-167's open "home band's freshness method" (left to P4's
  measurement). The decision under changes-62 #4, to make the band a
  `connection()` hole, is superseded.

## Context

changes-65 asked why the live site is slow. The origin answers in 15–90 ms.
Through Cloudflare, from the owner's region, HTML takes 1.6–1.8 s to its
first byte, against 0.7 s for a file Cloudflare has cached. The difference is
the Singapore edge → Netherlands origin trip, which every HTML request makes,
because no HTML is cached at the edge.

Most public pages already send `s-maxage=300` and only need a Cloudflare
cache rule. `/` is different: it answers `private, no-store`
(`x-nextjs-postponed: 1`). Its one dynamic hole is the promotions band, a
`connection()` call in front of `getLivePromotions`, whose `expire` of 120 s
is "short-lived" under Next's cacheLife rules. One hole is enough to make the
whole response uncacheable. That hole sits in front of the most visited page
on the site.

## Decision

1. The band reads a new `getLivePromotionsForBand` (`@repo/core`):
   `cacheLife({ stale: 60, revalidate: 60, expire: 300 })`, tagged `content`.
   An `expire` of five minutes is not under five minutes, so the band stays in
   the prerender. The `connection()` call is removed, and the `<Suspense>` is
   kept.
2. The home page therefore revalidates every 60 seconds. A promotion appears
   or disappears up to about a minute after `startsAt`/`endsAt`, plus the
   edge's own lifetime. An admin save still shows at once through the
   `content` tag.
3. `getLivePromotions` keeps its two-minute lifetime for the popup, the bars,
   the counters and the calendar file. Those are endpoints, and endpoints are
   request-time anyway.
4. `/news` stays dynamic. It reads `searchParams` for search and paging, and
   that is correct.

## Consequences

- With a Cloudflare cache rule (`docs/ops/deploy.md` §Edge caching), `/` is
  served from the edge, like the other public pages.
- One home regeneration per minute under traffic. The page was already
  rendered on every request, so this is less work, not more.
- A promotion's clock is accurate to about a minute, not to the request.
  Promotions are scheduled in hours and days, so this was judged acceptable.

## Alternatives considered

- **Client-side band (fetch `/api/promotions`).** This makes the page static
  too, but it adds a request and a layout shift high on the page for content
  that is usually absent.
- **Keep the hole and rely on Partial Prerendering's streaming.** The shell
  does stream, but the response is still `private, no-store`, and the edge
  trip is the cost being removed.
