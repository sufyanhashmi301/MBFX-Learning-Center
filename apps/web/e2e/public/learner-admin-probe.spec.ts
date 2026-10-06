import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { LEARNER_EMAIL, LEARNER_PASSWORD } from "../accounts.ts";
import { waitForHydration } from "../hydration.ts";

// The single-app cross-surface probe (ADR-006 consequence, testing.md #4,
// hardening SKILL.md's launch gate): **a learner session against every
// `/keystone/*` route and admin handler → never 200.**
//
// It was the one blocking launch-gate item with no test at all. ADR-006 put
// the public site and the admin portal in ONE Next.js app on ONE origin, and
// named this probe as the price of that: with two apps a learner simply cannot
// reach `/keystone`, and with one app the only thing standing between them is
// code we wrote.
//
// A LEARNER, not an anonymous visitor, on purpose. The two are refused by
// different code: anonymous has no session cookie and dies at `proxy.ts`'s
// gate, while a learner holds a valid session and is refused for `userType`
// alone — by the `(admin)` layout's re-check and by every service behind it
// (security.md #3, "two locks"). Only the second can regress silently, and it
// is the one this file exercises. The fixture learner holds NO role, so a
// refusal here can never be mistaken for "missing permission".
//
// Lives in `public/` because it runs in the anonymous project — it must NOT
// inherit the admin storageState.

/**
 * Every routed `/keystone` page. Kept as a literal list rather than globbed at
 * runtime: a probe that discovers its own targets stops covering a route the
 * moment the discovery breaks, and reads green while doing it. `admin-surface.
 * test.ts` is what fails when this list and the tree disagree.
 *
 * `[id]`-style segments carry a plausible-looking value. Existence is not the
 * point — a learner must be turned away before the route ever asks whether the
 * row exists, which is also why a 404 from a bad id would be a WEAKER pass
 * than the redirect these assert.
 */
const PLACEHOLDER_ID = "00000000-0000-0000-0000-000000000000";

/**
 * A real 1×1 PNG, magic bytes and all. Uploads validate MIME from the BYTES
 * rather than the client's `File.type` (security.md #9), so a dummy string
 * would be rejected as a bad image — a 400 that says nothing about
 * authorization. This one would be accepted for a permitted subject, which is
 * what makes the refusal meaningful.
 */
const PROBE_PNG = {
  name: "probe.png",
  mimeType: "image/png",
  buffer: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
    "base64",
  ),
};

const ADMIN_PAGES = [
  "/keystone/dashboard",
  // The catch-all (`[...notFound]`): every /keystone address no other route
  // owns. It renders from the same `(admin)` layout as the rest, so a learner
  // must be turned away from a mistyped portal address exactly as from a real
  // screen. Spelled out rather than interpolated because it has no probed
  // ancestor to inherit from, and `admin-surface.test.ts` reads this list as
  // TEXT — a template literal here is a path the drift guard cannot see.
  "/keystone/00000000-0000-0000-0000-000000000000",
  "/keystone/ai",
  "/keystone/settings/ai",
  "/keystone/settings/ai/usage",
  "/keystone/settings/ai/features",
  "/keystone/settings/ai/limits",
  "/keystone/settings/ai/providers",
  "/keystone/settings/ai/providers/new",
  `/keystone/settings/ai/providers/${PLACEHOLDER_ID}`,
  "/keystone/articles",
  "/keystone/articles/categories",
  "/keystone/articles/tags",
  `/keystone/articles/${PLACEHOLDER_ID}`,
  // ADR-167 — the list; `new` and `[id]` render under the same (admin) gate.
  "/keystone/promotions",
  "/keystone/design-system",
  "/keystone/employees",
  `/keystone/employees/${PLACEHOLDER_ID}`,
  "/keystone/glossary",
  "/keystone/glossary/topics",
  `/keystone/glossary/${PLACEHOLDER_ID}`,
  "/keystone/homepage",
  "/keystone/learn/courses",
  "/keystone/learn/lessons",
  "/keystone/learn/progress",
  "/keystone/learn/quizzes",
  "/keystone/learn/videos",
  "/keystone/learn/videos/categories",
  "/keystone/market",
  "/keystone/market/provider",
  "/keystone/media",
  "/keystone/navigation",
  "/keystone/newsletter",
  // ADR-171: announcement emails. The parent carries the nested screens.
  "/keystone/announcements",
  "/keystone/profile",
  "/keystone/roles",
  "/keystone/settings",
  "/keystone/settings/email",
  "/keystone/settings/email/delivery",
  "/keystone/settings/email/newsletter",
  "/keystone/settings/email/log",
  "/keystone/settings/email/templates",
  // ADR-172: the email design editor, outside the tab layout like a template's.
  "/keystone/settings/email/designs/new",
  "/keystone/settings/social",
  "/keystone/social",
  "/keystone/theme",
  "/keystone/tools",
  "/keystone/users",
  "/keystone/website",
  "/keystone/website/pages",
  "/keystone/website/redirects",
];

/**
 * Every `/keystone/api` route handler, probed with the METHOD it actually
 * implements and a body a permitted caller would be served for.
 *
 * Probing `GET` on a POST-only handler would score a 405 and prove nothing, so
 * the method matters; and a body the schema rejects would score a 400, which
 * also proves nothing about authorization. Each of these is a request that
 * WOULD succeed for the right subject — which is what makes the refusal
 * meaningful.
 */
const ADMIN_HANDLERS: {
  path: string;
  method: "GET" | "POST";
  body?: unknown;
  /** A multipart upload, which is how the three upload handlers are called. */
  multipart?: Record<string, string | { name: string; mimeType: string; buffer: Buffer }>;
}[] = [
  { path: "/keystone/api/media?include=facets,recent", method: "GET" },
  { path: "/keystone/api/newsletter/export", method: "GET" },
  // ADR-189: the translation progress readout, `translations.view`.
  { path: "/keystone/api/translate/progress", method: "GET" },
  // ADR-128: the idle watcher's two reads. STAFF-only, no permission key —
  // a learner's session must not learn its own expiry through the admin.
  { path: "/keystone/api/session", method: "GET" },
  { path: "/keystone/api/session/activity", method: "GET" },
  // changes-65: the bell's own feed. Self-scoped, no permission key, STAFF-only.
  { path: "/keystone/api/notifications", method: "GET" },
  {
    // POST, not GET — the body is an unsaved draft (ADR-078 #8).
    path: "/keystone/api/email/preview",
    method: "POST",
    body: { key: "password_reset", locale: "en" },
  },
  {
    path: "/keystone/api/ai/run",
    method: "POST",
    body: { feature: "writing_assistant", action: "improve", input: { text: "probe" } },
  },
  {
    path: "/keystone/api/uploads/image",
    method: "POST",
    multipart: { purpose: "article", category: "news", file: PROBE_PNG },
  },
  {
    path: "/keystone/api/uploads/media",
    method: "POST",
    multipart: { purpose: "content", category: "general", file: PROBE_PNG },
  },
  {
    // The replace endpoint. The id is a placeholder: a learner must be refused
    // before the route asks whether the asset exists.
    path: `/keystone/api/uploads/media/${PLACEHOLDER_ID}`,
    method: "POST",
    multipart: { purpose: "content", category: "general", file: PROBE_PNG },
  },
];

test.describe("a learner session cannot reach the admin portal", () => {
  test.describe.configure({ mode: "serial" });

  // ONE sign-in for the whole file, not one per test.
  //
  // `beforeEach` was what this said, and with ~50 probed paths it meant ~50
  // credential round-trips — several minutes of a suite proving the same
  // session works over and over. Serial mode plus a context created here is
  // the shape that fits: the session under test is a single session, which is
  // also more faithful to the threat than fifty fresh ones.
  //
  // The context is built explicitly with an EMPTY storageState rather than
  // relying on this project having none. The runner applies a project's `use`
  // options to a context made this way — that is how `baseURL` reaches it —
  // so `storageState` would come along too if the project ever gained one.
  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    page = await context.newPage();

    // The LEARNER screen (ADR-052) — the public site names no /keystone path, and
    // a learner reaching the portal must not need to have visited one.
    await page.goto("/sign-in");
    await waitForHydration(page, "#signin-email");
    await page.getByLabel("Email", { exact: true }).fill(LEARNER_EMAIL);
    await page.getByLabel("Password", { exact: true }).fill(LEARNER_PASSWORD);
    await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/auth/sign-in/email")),
      // Scoped to `main`: the signed-out `VisitorCta` band above the footer
      // (ADR-094) offers its own "Sign in", so the bare role query is two
      // elements on this page — and one of them is a link to the page you are
      // already on.
      page.getByRole("main").getByRole("button", { name: "Sign in" }).click(),
    ]);

    // The probe is worthless without this: the whole point is a subject who IS
    // signed in. An assertion that /keystone refuses a session that does not
    // exist tests nothing.
    const session = await page.request.get("/api/auth/get-session");
    expect(session.status(), "the learner must hold a real session").toBe(200);
    expect(await session.text(), "…with a user on it").toContain(LEARNER_EMAIL);
  });

  test.afterAll(async () => {
    await context?.close();
  });

  // Re-asserted before each probe, cheaply: a page that signed the learner out
  // (or a session that expired mid-run) would make every remaining assertion
  // pass for the wrong reason.
  test.beforeEach(async () => {
    const session = await page.request.get("/api/auth/get-session");
    expect(await session.text(), "the learner's session went away mid-run").toContain(
      LEARNER_EMAIL,
    );
  });

  for (const path of ADMIN_PAGES) {
    test(`${path} turns the learner away`, async () => {
      const response = await page.goto(path);

      // The refusal is a 404 AT THE ADDRESS since ADR-146: the `(admin)`
      // layout calls `notFound()` for a non-STAFF subject rather than
      // redirecting, because a redirect names the staff entry point to whoever
      // asked. This asserted a redirect away from /keystone and failed on its
      // first path when that changed — and, the file being serial, took every
      // other probe down with it, so the launch gate ran nothing.
      //
      // Either refusal is accepted: a 404, or landing somewhere outside the
      // portal. What is never accepted is a 2xx that stays on /keystone.
      const pathname = new URL(page.url()).pathname;
      expect(
        response?.status() === 404 || !/^\/keystone\//.test(pathname),
        `${path} answered ${response?.status()} at ${pathname}`,
      ).toBe(true);

      // And nothing of the portal rendered on the way. `AdminShell`'s primary
      // navigation is the tell.
      await expect(page.getByRole("navigation", { name: "Admin" })).toHaveCount(0);
    });
  }

  for (const { path, method, body, multipart } of ADMIN_HANDLERS) {
    test(`${method} ${path} refuses the learner`, async () => {
      // `page.request` carries the page's cookies, so this is the learner's
      // own session asking — which is the threat, not a bare fetch.
      const response =
        method === "GET"
          ? await page.request.get(path)
          : await page.request.post(path, multipart ? { multipart } : { data: body ?? {} });

      // "Never 200" is the launch gate's own wording, and it is asserted as
      // written: any 2xx is a failure.
      expect(
        response.status(),
        `${method} ${path} answered ${response.status()} to a learner`,
      ).toBeGreaterThanOrEqual(400);

      // Belt and braces — a handler could answer 4xx and still have leaked a
      // body. Nothing shaped like data may come back.
      const text = await response.text();
      expect(text).not.toContain('"assets"');
      expect(text).not.toContain('"subscribers"');
    });
  }
});
