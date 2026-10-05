// changes-65 — the notification bell went stale.
//
// The bell is drawn by the admin LAYOUT, and Next does not re-render a layout
// on a client navigation, so the count the shell rendered on the first load
// stayed until a hard reload. The bell now re-reads its own feed after each
// navigation and when it is opened, from a self-scoped GET.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const KEYSTONE = resolve(__dirname, "(admin)/keystone");
const read = (rel: string) => readFileSync(resolve(KEYSTONE, rel), "utf8");

describe("changes-65 — the bell refreshes itself", () => {
  const bell = read("_components/notification-bell.tsx");
  const route = read("api/notifications/route.ts");

  it("re-reads the feed when the path changes and when the menu opens", () => {
    expect(bell).toContain('"/keystone/api/notifications"');
    expect(bell).toMatch(/usePathname\(\)/);
    expect(bell).toMatch(/onOpenChange=\{\(open\) => \{\s*if \(open\) void refresh\(\);/);
  });

  it("never polls on a timer — a request is session activity (ADR-105)", () => {
    expect(bell).not.toMatch(/setInterval|setTimeout/);
  });

  it("no longer leans on router.refresh, which a layout ignores for its own props", () => {
    expect(bell).not.toContain("router.refresh");
  });

  it("the endpoint is STAFF-checked and reads only the caller's own rows", () => {
    expect(route).toContain("requireStaffSubject()");
    expect(route).toMatch(/loadNotificationFeed\(subjectId\)/);
    expect(route).toContain('"private, no-store"');
  });

  it("the shell and the endpoint word rows through one loader", () => {
    expect(read("_components/admin-shell.tsx")).toContain("loadNotificationFeed(subject.id)");
  });
});

describe("changes-65 / ADR-187 — the home page is prerendered whole", () => {
  const band = readFileSync(
    resolve(__dirname, "(public)/[locale]/_sections/promotions.tsx"),
    "utf8",
  );
  const core = readFileSync(resolve(__dirname, "../../../packages/core/src/promotions.ts"), "utf8");

  it("the band does not opt out of the prerender", () => {
    expect(band).not.toMatch(/await connection\(\)/);
    expect(band).toContain("getLivePromotionsForBand(");
  });

  it("the band's cache is not short-lived — expire of at least five minutes", () => {
    const body = core.slice(core.indexOf("export async function getLivePromotionsForBand"));
    const life = body.match(/cacheLife\(\{ stale: (\d+), revalidate: (\d+), expire: (\d+) \}\)/);
    expect(life).not.toBeNull();
    const [, stale, revalidate, expire] = life!.map(Number);
    expect(expire).toBeGreaterThanOrEqual(300);
    expect(stale).toBeGreaterThanOrEqual(30);
    expect(revalidate).toBeGreaterThan(0);
    expect(body.slice(0, 400)).toContain('cacheTag("content")');
  });
});

describe("changes-65 — a guest's browser logs no 401 on /learn", () => {
  // The cross-browser pass found `401 /api/learn/progress` in the console of
  // every signed-out visit to /learn, in every engine.
  const learn = resolve(__dirname, "(public)/[locale]/learn");
  const provider = readFileSync(resolve(learn, "_components/progress-provider.tsx"), "utf8");
  const dashboard = provider.slice(provider.indexOf("export function useLearnerDashboard"));
  const quiz = readFileSync(resolve(learn, "_lib/use-quiz-results.ts"), "utf8");

  it.each([
    ["useLearnerDashboard", dashboard],
    ["useQuizResults", quiz],
  ])("%s asks only once a learner is signed in", (_name, src) => {
    expect(src).toContain('const signedIn = session.status === "learner"');
    expect(src).toContain("if (!settled || !signedIn) return;");
    expect(src).toMatch(/if \(settled && !signedIn\) return \{ status: "guest"/);
    expect(src).toContain("[settled, signedIn]");
  });
});
