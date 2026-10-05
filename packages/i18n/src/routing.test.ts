import { describe, expect, it } from "vitest";
import {
  isOfferedLocale,
  LOCALE_DIRECTION,
  OFFERED_LOCALE_CODES,
  routing,
  SUPPORTED_LOCALES,
  supportedLocale,
} from "./routing.ts";

describe("SUPPORTED_LOCALES (ADR-178 #1)", () => {
  it("is what next-intl routes, with a direction for every code", () => {
    expect([...routing.locales]).toEqual(SUPPORTED_LOCALES.map((l) => l.code));
    for (const { code, direction } of SUPPORTED_LOCALES) {
      expect(LOCALE_DIRECTION[code]).toBe(direction);
    }
  });

  it("has unique codes, plain ISO 639-1, the default first", () => {
    const codes = SUPPORTED_LOCALES.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.every((c) => /^[a-z]{2}$/.test(c))).toBe(true);
    expect(codes[0]).toBe(routing.defaultLocale);
  });

  it("looks a code up", () => {
    expect(supportedLocale("fa")?.direction).toBe("rtl");
    expect(supportedLocale("xx")).toBeUndefined();
  });
});

describe("OFFERED_LOCALE_CODES (ADR-188)", () => {
  it("is the owner's five, each one the site can route, the default included", () => {
    expect([...OFFERED_LOCALE_CODES]).toEqual(["en", "ar", "ur", "hi", "zh"]);
    for (const code of OFFERED_LOCALE_CODES) {
      expect(supportedLocale(code), code).toBeDefined();
    }
    expect(isOfferedLocale(routing.defaultLocale)).toBe(true);
  });

  it("hides every other registry language from the admin", () => {
    expect(isOfferedLocale("es")).toBe(false);
    expect(isOfferedLocale("fr")).toBe(false);
    expect(isOfferedLocale("xx")).toBe(false);
  });
});
