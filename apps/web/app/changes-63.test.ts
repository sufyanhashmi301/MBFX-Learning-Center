// changes-63 — the two items this change-set added to changes-62's list.
//
// #8: React hydration error #418 on /keystone/profile. Cloudflare's Email
// Address Obfuscation rewrote the address in a STREAMED segment, which the
// admin layout's `<EmailOff>` markers never bracketed.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import nextConfig from "../next.config.ts";

const APP = resolve(process.cwd(), "app");
const ACCOUNT = resolve(APP, "(public)/[locale]/account/_components");

function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("#8 — Cloudflare never rewrites an address the admin streams", () => {
  it("sends no-transform on every /keystone response, keeping Next's dynamic value", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const admin = rules.find((rule) => rule.source === "/keystone/:path*");
    expect(admin).toBeDefined();
    const value = admin!.headers.find((h) => h.key === "Cache-Control")?.value ?? "";
    // `no-transform` is what Cloudflare reads; the rest is what Next would
    // have sent for a dynamic page and must not be lost by setting it first.
    expect(value.split(/,\s*/)).toEqual([
      "private",
      "no-cache",
      "no-store",
      "max-age=0",
      "must-revalidate",
      "no-transform",
    ]);
  });

  it("sets the header on no public path", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    for (const rule of rules) {
      if (rule.headers.some((h) => h.key === "Cache-Control")) {
        expect(rule.source.startsWith("/keystone")).toBe(true);
      }
    }
  });

  it("brackets the learner's address inside the account pages' streamed body", () => {
    expect(code(resolve(ACCOUNT, "account-masthead.tsx"))).toMatch(
      /<EmailOff>\s*<p[^>]*>\{profile\.email\}<\/p>\s*<\/EmailOff>/,
    );
    expect(code(resolve(ACCOUNT, "profile-content.tsx"))).toMatch(
      /<EmailOff>\s*<EmailVerificationPanel[\s\S]*?\/>\s*<\/EmailOff>/,
    );
  });
});
