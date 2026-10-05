// Proxy routing unit tests (SKILL.md Module 06: default locale unprefixed,
// /ar/... prefixed, unknown locale untouched by the proxy itself, /admin
// never locale-prefixed). `next/experimental/testing/server`'s
// `unstable_doesMiddlewareMatch` (testing.md's suggested tool) isn't
// present in this installed Next 16.3.3 — this instead invokes the
// exported `proxy()` function directly with constructed `NextRequest`s
// (the same technique, one layer more direct: real behavior, not just
// matcher-pattern prediction) and separately asserts the matcher regexes
// themselves for the one claim that can't be observed through `proxy()`
// alone — that /admin and /api are excluded from next-intl's own pattern.
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proxy, config } from "./proxy.ts";

// The proxy asks `/api/public-path` whether an unowned address answers
// (ADR-146). Stubbed at the network edge: the answer is what each test says,
// and "page" by default so the older routing tests see the old pass-through.
const lookup = vi.fn(async (): Promise<{ kind: string; to?: string }> => ({ kind: "page" }));
const fetchMock = vi.fn(async (_url: URL | string) => Response.json(await lookup()));
vi.stubGlobal("fetch", fetchMock);
beforeEach(() => {
  lookup.mockReset();
  lookup.mockResolvedValue({ kind: "page" });
});

function requestFor(path: string, cookie?: string) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  return new NextRequest(new URL(path, "http://localhost:3000"), { headers });
}

describe("proxy — locale routing (public surface)", () => {
  it("the default locale ('en') is not redirected — '/' resolves without a redirect", async () => {
    const response = await proxy(requestFor("/"));
    expect(response.status).not.toBe(307);
    expect(response.status).not.toBe(308);
  });

  it("a non-default locale prefix ('/es') is not redirected away from itself", async () => {
    const response = await proxy(requestFor("/es"));
    expect(response.status).not.toBe(307);
    expect(response.status).not.toBe(308);
    const location = response.headers.get("location");
    if (location) expect(new URL(location).pathname).toBe("/es");
  });

  it("an RTL locale prefix ('/ar') is not redirected away from itself", async () => {
    const response = await proxy(requestFor("/ar"));
    expect(response.status).not.toBe(307);
    expect(response.status).not.toBe(308);
    const location = response.headers.get("location");
    if (location) expect(new URL(location).pathname).toBe("/ar");
  });

  it("an unrecognized locale prefix passes through unredirected — the 404 for it is a page-level concern (hasLocale + notFound in the [locale] layout), not the proxy's", async () => {
    const response = await proxy(requestFor("/xx/anything"));
    expect(response.status).not.toBe(307);
    expect(response.status).not.toBe(308);
  });

  it("a CMS page path under a non-default locale ('/es/about') is locale-routed, not redirected away from itself (Module 16)", async () => {
    const response = await proxy(requestFor("/es/about"));
    expect(response.status).not.toBe(307);
    expect(response.status).not.toBe(308);
    const location = response.headers.get("location");
    if (location) expect(new URL(location).pathname).toBe("/es/about");
  });
});

describe("proxy — the admin's default language, public site only (ADR-182)", () => {
  // `/api/locales` is cached for a minute inside the proxy. Each test runs on
  // a fake clock two minutes after the last, so no answer outlives its test,
  // and the clock sits in the PAST so nothing cached survives into the real
  // clock the other suites run on.
  let tick = 0;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2000, 0, 1) + (tick += 1) * 120_000);
  });
  afterEach(() => vi.useRealTimers());

  function serving(defaultLocale: string | null, locales = ["en", "ar"]) {
    fetchMock.mockImplementation(async (url) =>
      new URL(String(url)).pathname === "/api/locales"
        ? Response.json({ locales, defaultLocale })
        : Response.json({ kind: "page" }),
    );
  }
  afterEach(() => fetchMock.mockImplementation(async () => Response.json(await lookup())));

  function location(response: Response): string | null {
    const target = response.headers.get("location");
    if (!target) return null;
    const url = new URL(target);
    return `${url.pathname}${url.search}`;
  }

  it("sends a visitor who has not chosen a language to the admin's default, same page", async () => {
    serving("ar");
    const home = await proxy(requestFor("/"));
    expect(home.status).toBe(307);
    expect(location(home)).toBe("/ar");

    const page = await proxy(requestFor("/news/some-article?page=2"));
    expect(page.status).toBe(307);
    expect(location(page)).toBe("/ar/news/some-article?page=2");
  });

  it("outranks the browser's Accept-Language", async () => {
    serving("ar");
    const request = requestFor("/news");
    request.headers.set("accept-language", "en-US,en;q=0.9");
    expect(location(await proxy(request))).toBe("/ar/news");
  });

  it("never moves a visitor who chose a language with the switcher", async () => {
    serving("ar");
    const response = await proxy(requestFor("/news", "NEXT_LOCALE=en"));
    expect(location(response)).not.toBe("/ar/news");
  });

  it("leaves an address that already names a language alone", async () => {
    serving("ar");
    const response = await proxy(requestFor("/es/news"));
    expect(location(response) ?? "").not.toMatch(/^\/ar/);
  });

  it("does nothing when the default is English, unserved, or unknown", async () => {
    serving("en");
    expect((await proxy(requestFor("/news"))).status).not.toBe(307);
    vi.setSystemTime(Date.now() + 120_000);
    serving(null);
    expect((await proxy(requestFor("/news"))).status).not.toBe(307);
    vi.setSystemTime(Date.now() + 120_000);
    // The route answers null for an unserved choice; a code next-intl cannot
    // route is refused here too.
    serving("xx", ["en", "xx"]);
    expect((await proxy(requestFor("/news"))).status).not.toBe(307);
  });

  it("never redirects a form post or a Server Action", async () => {
    serving("ar");
    const post = new NextRequest(new URL("/support", "http://localhost:3000"), { method: "POST" });
    expect(location(await proxy(post))).not.toBe("/ar/support");
    const action = requestFor("/support");
    action.headers.set("next-action", "abc");
    expect(location(await proxy(action))).not.toBe("/ar/support");
  });

  it("never touches the admin portal", async () => {
    serving("ar");
    const response = await proxy(requestFor("/keystone"));
    expect(location(response)).toBeNull();
  });
});

/** A rewrite to the global not-found (ADR-146): Next serves it with a real 404. */
function rewrittenTo(response: Response): string | null {
  const target = response.headers.get("x-middleware-rewrite");
  return target ? new URL(target).pathname : null;
}

describe("proxy — the staff credential screens live at /keystone (ADR-146, ADR-151)", () => {
  it.each(["/keystone", "/keystone/forgot-password", "/keystone/reset-password"])(
    "%s is served anonymously from its own file — no gate, no redirect, no rewrite",
    async (path) => {
      const response = await proxy(requestFor(path));
      expect(response.status).not.toBe(307);
      expect(response.headers.get("location")).toBeNull();
      expect(rewrittenTo(response)).toBeNull();
    },
  );

  it.each(["/keystone", "/keystone/forgot-password", "/keystone/reset-password"])(
    "%s gets the admin surface's headers and a per-request nonce",
    async (path) => {
      const response = await proxy(requestFor(path));
      expect(response.headers.get("X-Frame-Options")).toBe("DENY");
      const csp = response.headers.get("Content-Security-Policy")!;
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
    },
  );

  it.each(["/keystone/dashboard", "/keystone/sign-in", "/keystone/reset-password/extra"])(
    "an anonymous %s is gated — membership of the open set is exact, never a prefix",
    async (path) => {
      const response = await proxy(requestFor(path));
      expect(response.headers.get("location")).toBeNull();
      expect(rewrittenTo(response)).toBe("/not-found-page");
    },
  );

  it("/keystone-debug is not the portal at all", async () => {
    const response = await proxy(requestFor("/keystone-debug"));
    expect(response.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
  });
});

describe("proxy — the old /admin prefix is gone (ADR-151)", () => {
  it.each(["/admin", "/admin/users", "/admin/sign-in", "/admin/api/email/preview"])(
    "%s is a 404 — anonymous or signed in — and never a redirect that names the new address",
    async (path) => {
      for (const cookie of [undefined, "better-auth.session_token=a-real-session-token"]) {
        const response = await proxy(requestFor(path, cookie));
        expect(response.status).not.toBe(307);
        expect(response.headers.get("location")).toBeNull();
        expect(rewrittenTo(response)).toBe("/not-found-page");
      }
    },
  );
});

describe("proxy — /keystone STAFF gate (security.md #3: the two-lock proxy gate)", () => {
  it.each([
    "/keystone/dashboard",
    "/keystone/users",
    "/keystone/website",
    "/keystone/forgot-password-debug",
  ])("an anonymous %s is a 404, never a redirect that names the sign-in address", async (path) => {
    const response = await proxy(requestFor(path));
    expect(response.status).not.toBe(307);
    expect(response.headers.get("location")).toBeNull();
    expect(rewrittenTo(response)).toBe("/not-found-page");
  });

  it("/keystone is never routed through next-intl", async () => {
    const response = await proxy(requestFor("/keystone/dashboard"));
    expect(rewrittenTo(response)).not.toMatch(/^\/(en|es|ar|ur)\//);
  });

  // changes-21 F5 / ADR-078 #8 — the email preview is framed by the template
  // editor, and a frame the surrounding policy says DENY to renders nothing.
  it("the email preview is the one /keystone path that may be framed", async () => {
    const response = await proxy(
      requestFor("/keystone/api/email/preview", "better-auth.session_token=a-real-session-token"),
    );
    expect(response.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'self'");
  });

  it("every other /keystone path — its own siblings included — stays DENY", async () => {
    for (const path of [
      "/keystone/dashboard",
      "/keystone/settings/email",
      "/keystone/settings/email/templates/auth.password_reset",
      "/keystone/api/email/preview-all",
      "/keystone/api/email",
    ]) {
      const response = await proxy(
        requestFor(path, "better-auth.session_token=a-real-session-token"),
      );
      expect(response.headers.get("X-Frame-Options"), path).toBe("DENY");
      expect(response.headers.get("Content-Security-Policy"), path).toContain(
        "frame-ancestors 'none'",
      );
    }
  });

  it("the admin CSP is ENFORCED, and Next is handed the nonce on the request", async () => {
    const response = await proxy(
      requestFor("/keystone/dashboard", "better-auth.session_token=a-real-session-token"),
    );
    expect(response.headers.get("Content-Security-Policy-Report-Only")).toBeNull();
    const csp = response.headers.get("Content-Security-Policy")!;
    expect(csp).toContain("report-uri /api/csp-report");
    // Next forwards request-header overrides as `x-middleware-request-*`.
    expect(response.headers.get("x-middleware-request-content-security-policy")).toBe(csp);
  });

  it("a NAVIGATION carrying a session token but no fresh cookie cache is let through — the cache expires after 5 minutes and nothing rewrites it on a page view (changes-18 PR 1)", async () => {
    const response = await proxy(
      requestFor("/keystone/glossary", "better-auth.session_token=a-real-session-token"),
    );
    expect(response.headers.get("location")).toBeNull();
    expect(rewrittenTo(response)).toBeNull();
  });

  it("that fall-through is not a hole: the request reaches (admin)/layout.tsx, which loads the subject from the database and 404s a non-STAFF user (ADR-006 — the proxy is a gate, the layout is the boundary)", async () => {
    const response = await proxy(
      requestFor("/keystone/dashboard", "better-auth.session_token=learner-token"),
    );
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("location")).toBeNull();
  });

  it("a Server Action request with a stale/missing cookie cache is let through — rejecting it breaks the client's action-response parsing (regression: 'An unexpected response was received from the server' saving the theme)", async () => {
    const request = requestFor("/keystone/theme");
    request.headers.set("next-action", "0123456789abcdef0123456789abcdef01234567");
    const response = await proxy(request);
    expect(response.headers.get("location")).toBeNull();
    expect(rewrittenTo(response)).toBeNull();
  });
});

describe("proxy — real 404s on the public surface (changes-49, ADR-146)", () => {
  it.each(["/login", "/dashboard", "/LICENSE", "/xx/anything", "/es/nothing-here"])(
    "an address nothing answers (%s) is rewritten to the global not-found",
    async (path) => {
      lookup.mockResolvedValueOnce({ kind: "not-found" });
      const response = await proxy(requestFor(path));
      expect(rewrittenTo(response)).toBe("/not-found-page");
    },
  );

  it("asks the resolver with the locale split off the path", async () => {
    lookup.mockResolvedValueOnce({ kind: "not-found" });
    await proxy(requestFor("/es/nothing-here"));
    const asked = new URL(String(fetchMock.mock.calls.at(-1)![0]));
    expect(asked.pathname).toBe("/api/public-path");
    expect(asked.searchParams.get("locale")).toBe("es");
    expect(asked.searchParams.get("path")).toBe("/nothing-here");
  });

  // changes-62 #6: behind nginx + Cloudflare the request's own origin is the
  // public one, the lookup left the box and failed, and every unknown address
  // answered a soft 200.
  it("asks this process over loopback when PORT is set, never the public origin", async () => {
    vi.stubEnv("PORT", "3003");
    try {
      lookup.mockResolvedValueOnce({ kind: "not-found" });
      await proxy(new NextRequest("https://learn.example.com/nothing-here"));
      const asked = new URL(String(fetchMock.mock.calls.at(-1)![0]));
      expect(asked.origin).toBe("http://localhost:3003");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("a stored redirect is a real 308 to a same-site path", async () => {
    lookup.mockResolvedValueOnce({ kind: "redirect", to: "/support" });
    const response = await proxy(requestFor("/about/support"));
    expect(response.status).toBe(308);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/support");
  });

  it("a redirect to another host is ignored, never followed", async () => {
    lookup.mockResolvedValueOnce({ kind: "redirect", to: "//evil.example" });
    const response = await proxy(requestFor("/about/support"));
    expect(response.status).not.toBe(308);
  });

  it("a page that exists is let through to locale routing", async () => {
    lookup.mockResolvedValueOnce({ kind: "page" });
    const response = await proxy(requestFor("/es/about"));
    expect(rewrittenTo(response)).not.toBe("/not-found-page");
  });

  it("a failed lookup falls back to letting the page answer (the old soft 404), never an outage", async () => {
    fetchMock.mockRejectedValueOnce(new Error("down"));
    const response = await proxy(requestFor("/somewhere"));
    expect(rewrittenTo(response)).not.toBe("/not-found-page");
  });

  it("a coded route's first segment is never looked up", async () => {
    fetchMock.mockClear();
    await proxy(requestFor("/news/some-article"));
    await proxy(requestFor("/learn/forex"));
    // `/api/locales` may be asked (ADR-182's default language); the page
    // resolver must not be.
    const asked = fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname);
    expect(asked).not.toContain("/api/public-path");
  });

  it.each(["/foo.txt/news", "/admin.json", "/es/foo.txt"])(
    "a dotted first segment (%s) is a 404 — it used to become a bogus [locale] and a 500",
    async (path) => {
      const response = await proxy(requestFor(path));
      expect(rewrittenTo(response)).toBe("/not-found-page");
    },
  );

  it("an anonymous /account is sent to sign-in by the proxy, with its way back", async () => {
    const response = await proxy(requestFor("/account/progress"));
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/sign-in");
    expect(location.searchParams.get("redirect")).toBe("/account/progress");
  });

  it("a public response carries an enforced CSP and no hreflang Link header", async () => {
    const response = await proxy(requestFor("/"));
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    expect(response.headers.get("Content-Security-Policy-Report-Only")).toBeNull();
    expect(response.headers.get("link")).toBeNull();
  });
});

describe("proxy matcher — /admin, /keystone and /api excluded from next-intl's own pattern", () => {
  // Next's matcher strings compile via path-to-regexp, not `new RegExp()`,
  // so these assert the source text rather than re-implementing the compiler.
  const [localeRoutingSource] = config.matcher;

  it("the negative lookahead names each exclusion up to a `/` or the end — never a bare prefix", () => {
    expect(localeRoutingSource).toContain("(?!api(?:/|$)|admin(?:/|$)|keystone(?:/|$)|");
  });

  it("the gate's own entries cover /admin and /keystone, bare and nested", () => {
    for (const entry of ["/admin", "/admin/:path*", "/keystone", "/keystone/:path*"]) {
      expect(config.matcher).toContain(entry);
    }
  });
});

describe("proxy — Google reCAPTCHA origins in the CSP (ADR-185)", () => {
  // A session cookie gets a staff path past the gate to its headers.
  const cspOf = async (path: string) =>
    (await proxy(requestFor(path, "better-auth.session_token=a-real-session-token"))).headers.get(
      "Content-Security-Policy",
    ) ?? "";

  // changes-62 #5: a soft navigation keeps the FIRST page's policy, so the
  // home page must already allow the sign-in form's captcha.
  it.each([
    "/",
    "/news",
    "/sign-in",
    "/support",
    "/ar/sign-in",
    "/keystone",
    "/keystone/settings/seo",
    "/keystone/forgot-password",
  ])("%s allows Google's script, scoring frame and clr fetch", async (path) => {
    const csp = await cspOf(path);
    expect(csp).toMatch(/script-src [^;]*https:\/\/www\.gstatic\.com\/recaptcha\//);
    expect(csp).toMatch(/frame-src [^;]*https:\/\/www\.google\.com\/recaptcha\//);
    // Regression (2026-09-24): its api2/clr request is a fetch from the page.
    expect(csp).toMatch(/connect-src [^;]*https:\/\/www\.google\.com\/recaptcha\//);
  });

  it("still allows no other Google origin", async () => {
    const csp = await cspOf("/");
    expect(csp).not.toMatch(/https:\/\/www\.google\.com\/(?!recaptcha\/)/);
  });
});
