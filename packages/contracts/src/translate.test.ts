import { describe, expect, it } from "vitest";

import {
  PAUSING_TRANSLATE_REASONS,
  TRANSIENT_TRANSLATE_REASONS,
  TRANSLATE_PROVIDER_KINDS,
  TRANSLATE_PROVIDER_LIST_PRICE,
  TRANSLATE_REASONS,
  translateSettingsSaveSchema,
  translateTestSchema,
  translatePrefillSchema,
  TRANSLATE_PREFILL_MAX_CHARS,
  localeActivationSchema,
  translationScopeSchema,
} from "./translate.ts";

describe("translateSettingsSaveSchema (ADR-160)", () => {
  const valid = {
    enabled: true,
    kind: "GOOGLE" as const,
    pricePerMillionChars: 20,
    monthlyCharBudget: 500_000,
  };

  it("accepts a save with or without a typed key", () => {
    expect(translateSettingsSaveSchema.parse(valid)).toEqual(valid);
    expect(translateSettingsSaveSchema.parse({ ...valid, apiKey: "  AIza  " }).apiKey).toBe("AIza");
  });

  it("takes null as no budget", () => {
    expect(
      translateSettingsSaveSchema.parse({ ...valid, monthlyCharBudget: null }).monthlyCharBudget,
    ).toBeNull();
  });

  it("refuses a negative or absurd price, and a zero or fractional budget", () => {
    for (const bad of [
      { ...valid, pricePerMillionChars: -1 },
      { ...valid, pricePerMillionChars: 2000 },
      { ...valid, monthlyCharBudget: 0 },
      { ...valid, monthlyCharBudget: 1.5 },
      { ...valid, apiKey: "x".repeat(201) },
      { ...valid, kind: "AZURE" },
      { enabled: true, pricePerMillionChars: 20, monthlyCharBudget: null },
    ]) {
      expect(translateSettingsSaveSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("has no field that could carry the stored key back out", () => {
    expect(Object.keys(translateSettingsSaveSchema.shape)).not.toContain("apiKeyCipher");
  });
});

describe("translateTestSchema", () => {
  it("accepts a blank test (the stored key) or a typed one, for a named provider", () => {
    expect(translateTestSchema.parse({ kind: "DEEPL" })).toEqual({ kind: "DEEPL" });
    expect(translateTestSchema.parse({ kind: "GOOGLE", apiKey: " k " })).toEqual({
      kind: "GOOGLE",
      apiKey: "k",
    });
    expect(translateTestSchema.safeParse({}).success).toBe(false);
  });
});

describe("the provider registry (ADR-186)", () => {
  it("lists a list price for every provider, inside the price field's bounds", () => {
    for (const kind of TRANSLATE_PROVIDER_KINDS) {
      const price = TRANSLATE_PROVIDER_LIST_PRICE[kind];
      expect(price).toBeGreaterThan(0);
      expect(translateSettingsSaveSchema.shape.pricePerMillionChars.safeParse(price).success).toBe(
        true,
      );
    }
  });
});

describe("the reason taxonomy", () => {
  it("classifies every transient and pausing reason from the one list", () => {
    for (const reason of [...TRANSIENT_TRANSLATE_REASONS, ...PAUSING_TRANSLATE_REASONS]) {
      expect(TRANSLATE_REASONS).toContain(reason);
    }
    expect(TRANSIENT_TRANSLATE_REASONS.some((r) => PAUSING_TRANSLATE_REASONS.includes(r))).toBe(
      false,
    );
  });
});

describe("translatePrefillSchema (plan §3)", () => {
  const base = {
    entity: { type: "article", id: "a1" },
    sourceLocale: "en",
    targetLocale: "es",
    texts: { title: "Hello" },
  };

  it("accepts plain and rich fields, defaulting rich to none", () => {
    expect(translatePrefillSchema.parse(base).html).toEqual({});
    expect(translatePrefillSchema.parse({ ...base, html: { body: "<p>x</p>" } }).html).toEqual({
      body: "<p>x</p>",
    });
  });

  it("refuses an entity type it has no permission rule for", () => {
    expect(
      translatePrefillSchema.safeParse({ ...base, entity: { type: "user", id: "u1" } }).success,
    ).toBe(false);
  });

  it("refuses an oversized field", () => {
    expect(
      translatePrefillSchema.safeParse({
        ...base,
        texts: { title: "x".repeat(TRANSLATE_PREFILL_MAX_CHARS + 1) },
      }).success,
    ).toBe(false);
  });
});

describe("localeActivationSchema and translationScopeSchema (ADR-163)", () => {
  it("accepts a locale code and a switch", () => {
    expect(localeActivationSchema.parse({ locale: "ar", active: true })).toEqual({
      locale: "ar",
      active: true,
    });
    expect(localeActivationSchema.parse({ locale: "pt-BR", active: false }).locale).toBe("pt-BR");
  });

  it("refuses anything that is not a locale code", () => {
    for (const locale of ["", "A", "../en", "en us", "english-language"]) {
      expect(localeActivationSchema.safeParse({ locale, active: true }).success).toBe(false);
    }
    expect(localeActivationSchema.safeParse({ locale: "es" }).success).toBe(false);
  });

  it("scopes to one locale or, with none, to every active one", () => {
    expect(translationScopeSchema.parse({})).toEqual({});
    expect(translationScopeSchema.parse({ locale: "es" })).toEqual({ locale: "es" });
    expect(translationScopeSchema.safeParse({ locale: "<es>" }).success).toBe(false);
  });
});
