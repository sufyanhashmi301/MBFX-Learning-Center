import { describe, expect, it } from "vitest";

import { validateFields } from "./field-issues.ts";
import { SETTINGS_SCHEMAS } from "./settings.ts";
import {
  TRANSLATABLE_SETTINGS,
  TRANSLATABLE_SETTING_KEYS,
  WHOLE_VALUE_FIELD,
  applySettingTranslation,
  isTranslatableSettingKey,
  missingSettingTokens,
  settingTextFields,
  settingTranslationSaveSchema,
  settingTranslationSchema,
  type TranslatableSetting,
} from "./settings-translation.ts";

describe("TRANSLATABLE_SETTINGS (ADR-165)", () => {
  it("names only real setting keys", () => {
    for (const key of TRANSLATABLE_SETTING_KEYS) {
      expect(key in SETTINGS_SCHEMAS).toBe(true);
    }
  });

  it("never lists a key #2 excludes", () => {
    for (const key of [
      "site.name",
      "site.tagline",
      "seo.titleTemplate",
      "legal.companyRegistration",
      "legal.registeredAddress",
      "email.footerText",
    ]) {
      expect(isTranslatableSettingKey(key)).toBe(false);
    }
  });

  it("stores a whole-value key under `value`, and a JSON key under real schema fields", () => {
    for (const key of TRANSLATABLE_SETTING_KEYS) {
      const entry: TranslatableSetting = TRANSLATABLE_SETTINGS[key];
      const fields = Object.keys(entry.fields);
      if (entry.whole) {
        expect(fields).toEqual([WHOLE_VALUE_FIELD]);
      } else {
        const shape = (SETTINGS_SCHEMAS[key] as unknown as { shape: Record<string, unknown> })
          .shape;
        for (const field of fields) expect(field in shape).toBe(true);
      }
    }
  });
});

describe("settingTextFields", () => {
  it("reads a string key's whole value and a JSON key's named fields only", () => {
    expect(settingTextFields("site.description", "Learn forex")).toEqual({ value: "Learn forex" });
    expect(
      settingTextFields("header.cta", { enabled: true, label: "Start", url: "/sign-up" }),
    ).toEqual({ label: "Start" });
  });

  it("yields blank fields for a missing value", () => {
    expect(settingTextFields("header.cta", null)).toEqual({ label: "" });
    expect(settingTextFields("site.description", null)).toEqual({ value: "" });
  });
});

describe("applySettingTranslation", () => {
  const cta = { enabled: true, label: "Get Started", url: "/sign-up" };

  it("lays translated words over the English and keeps every other field", () => {
    expect(applySettingTranslation("header.cta", cta, { label: "Empezar" })).toEqual({
      enabled: true,
      label: "Empezar",
      url: "/sign-up",
    });
  });

  it("cannot change a switch or a URL: non-text fields in a stored row are ignored", () => {
    const merged = applySettingTranslation("header.cta", cta, {
      label: "Empezar",
      url: "https://evil.example",
      enabled: false,
    });
    expect(merged).toEqual({ enabled: true, label: "Empezar", url: "/sign-up" });
  });

  it("falls back to English for a blank field, a missing row and a malformed row", () => {
    expect(applySettingTranslation("header.cta", cta, { label: "  " })).toEqual(cta);
    expect(applySettingTranslation("header.cta", cta, null)).toEqual(cta);
    expect(applySettingTranslation("header.cta", cta, { label: 42 })).toEqual(cta);
    expect(applySettingTranslation("header.cta", cta, "Empezar")).toEqual(cta);
  });

  it("translates a whole-value key", () => {
    expect(applySettingTranslation("site.description", "English", { value: "Español" })).toBe(
      "Español",
    );
    expect(applySettingTranslation("site.description", "English", { value: "" })).toBe("English");
  });
});

describe("tokens", () => {
  it("names the tokens a translation dropped", () => {
    expect(missingSettingTokens("© {year} MBFX", "© MBFX")).toEqual(["{year}"]);
    expect(missingSettingTokens("© {year} MBFX", "© {year} MBFX")).toEqual([]);
    expect(missingSettingTokens("no tokens", "ninguno")).toEqual([]);
  });

  it("the save schema refuses a translation that lost {year}, and allows blank", () => {
    const schema = settingTranslationSchema("legal.copyrightNotice", {
      value: "© {year} MBFX Global Limited.",
    });
    expect(schema.safeParse({ value: "© MBFX Global Limited." }).success).toBe(false);
    expect(schema.safeParse({ value: "© {year} MBFX Global Limited." }).success).toBe(true);
    expect(schema.safeParse({ value: "" }).success).toBe(true);
    // The form names what to fix, not a generic "invalid" (field-issues.ts).
    expect(validateFields(schema, { value: "© MBFX Global Limited." })).toEqual({
      value: { code: "missingToken" },
    });
  });

  it("the save schema refuses a field the registry does not name, and an over-long one", () => {
    const schema = settingTranslationSchema("header.cta", { label: "Start" });
    expect(schema.safeParse({ label: "Empezar", url: "/x" }).success).toBe(false);
    expect(schema.safeParse({ label: "x".repeat(101) }).success).toBe(false);
  });
});

describe("settingTranslationSaveSchema", () => {
  it("accepts a registry key and refuses any other", () => {
    expect(
      settingTranslationSaveSchema.safeParse({
        locale: "es",
        key: "header.cta",
        fields: { label: "Empezar" },
      }).success,
    ).toBe(true);
    expect(
      settingTranslationSaveSchema.safeParse({ locale: "es", key: "site.name", fields: {} })
        .success,
    ).toBe(false);
  });
});
