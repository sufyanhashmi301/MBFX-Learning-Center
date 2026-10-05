// changes-64 — "preloaded but not used" on every admin page.
//
// React wrote each page's stylesheets (and the home hero's priority image)
// into a `Link: rel=preload` response header. Cloudflare's Early Hints caches
// that header per URL and replays it as a `103` on later requests, after a
// deploy as well, so browsers preloaded the previous build's files.
import { describe, expect, it } from "vitest";
import nextConfig from "../next.config.ts";

describe("changes-64 — no React Link headers for Early Hints to cache", () => {
  it("gives React no room to emit preload headers", () => {
    expect(nextConfig.reactMaxHeadersLength).toBe(0);
  });
});
