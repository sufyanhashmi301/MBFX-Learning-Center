// Translatable settings (ADR-165). The registry of which settings carry words a
// reader sees, and which of their fields those words are in. Every one of them
// is machine-translated when automatic translation is on (ADR-190, which ended
// ADR-165 #6's human-only `legal` group). Everything else about a setting — a switch, a
// URL, a phone number — is never translated and always comes from English.
//
// A stored translation is ALWAYS an object of fields (ADR-165 #3): the named
// fields of a JSON value, or the one field `value` for a key whose whole value
// is text.
import { z } from "zod";

import type { SettingKey, SettingValue } from "./settings.ts";

/** The field name a whole-value (string) key's text is stored under. */
export const WHOLE_VALUE_FIELD = "value";

export interface TranslatableSettingField {
  /** Characters a translation of this field may hold. */
  max: number;
  /** A paragraph (Textarea) rather than a line (Input). */
  multiline: boolean;
}

export interface TranslatableSetting {
  /** True when the setting's whole value is the text; false for JSON fields. */
  whole: boolean;
  fields: Readonly<Record<string, TranslatableSettingField>>;
}

/**
 * ORDER IS THE EDITOR'S ORDER: the footer's own reading order for the site
 * text, then the header strips.
 */
export const TRANSLATABLE_SETTINGS = {
  "site.description": {
    whole: true,
    fields: { [WHOLE_VALUE_FIELD]: { max: 2000, multiline: true } },
  },
  "legal.riskDisclaimer": {
    whole: true,
    fields: { [WHOLE_VALUE_FIELD]: { max: 5000, multiline: true } },
  },
  "legal.copyrightNotice": {
    whole: true,
    fields: { [WHOLE_VALUE_FIELD]: { max: 500, multiline: false } },
  },
  "header.announcementBar": {
    whole: false,
    fields: { text: { max: 300, multiline: false } },
  },
  "header.topBar": {
    whole: false,
    fields: { promoText: { max: 200, multiline: false } },
  },
  "header.cta": {
    whole: false,
    fields: { label: { max: 100, multiline: false } },
  },
} as const satisfies Partial<Record<SettingKey, TranslatableSetting>>;

export type TranslatableSettingKey = keyof typeof TRANSLATABLE_SETTINGS;

export const TRANSLATABLE_SETTING_KEYS = Object.keys(
  TRANSLATABLE_SETTINGS,
) as TranslatableSettingKey[];

export function isTranslatableSettingKey(key: string): key is TranslatableSettingKey {
  return key in TRANSLATABLE_SETTINGS;
}

/** A setting's translatable text, by field. */
export type SettingTextFields = Record<string, string>;

/**
 * The words of an English value, by field. A value of the wrong shape (a
 * missing row, a null) yields blank fields rather than throwing: there is
 * nothing to translate, which is not an error.
 */
export function settingTextFields(key: TranslatableSettingKey, value: unknown): SettingTextFields {
  const entry: TranslatableSetting = TRANSLATABLE_SETTINGS[key];
  const out: SettingTextFields = {};
  for (const field of Object.keys(entry.fields)) {
    const raw = entry.whole
      ? value
      : value !== null && typeof value === "object"
        ? (value as Record<string, unknown>)[field]
        : undefined;
    out[field] = typeof raw === "string" ? raw : "";
  }
  return out;
}

/** `{year}` and its kind: rendering-time tokens a translation must keep. */
const TOKEN = /\{[A-Za-z]+\}/g;

/** The tokens in `english` that `translated` does not carry. */
export function missingSettingTokens(english: string, translated: string): string[] {
  const have = new Set(translated.match(TOKEN) ?? []);
  return [...new Set(english.match(TOKEN) ?? [])].filter((token) => !have.has(token));
}

/**
 * The schema a translation of `key` is saved through, built from the English
 * it translates so it can require the English's tokens (ADR-165 #8). The form
 * and the service run the same one. Blank is allowed: a blank field is the
 * English (ADR-165 #4).
 */
export function settingTranslationSchema(key: TranslatableSettingKey, english: SettingTextFields) {
  const entry: TranslatableSetting = TRANSLATABLE_SETTINGS[key];
  const shape: Record<string, z.ZodType<string>> = {};
  for (const [field, spec] of Object.entries(entry.fields)) {
    const source = english[field] ?? "";
    shape[field] = z
      .string()
      .trim()
      .max(spec.max)
      .refine((text) => text === "" || missingSettingTokens(source, text).length === 0, {
        message: "missingToken",
        params: { code: "missingToken" },
      });
  }
  return z.object(shape).strict();
}

/** The shape stored in `SettingTranslation.value`, without the English. */
function storedTranslationSchema(key: TranslatableSettingKey) {
  const entry: TranslatableSetting = TRANSLATABLE_SETTINGS[key];
  const shape: Record<string, z.ZodType<string>> = {};
  for (const [field, spec] of Object.entries(entry.fields)) {
    shape[field] = z.string().max(spec.max);
  }
  return z.object(shape).partial();
}

/**
 * The English value with a translation's words laid over it (ADR-165 #4). A
 * blank or absent translated field is the English field; a translation that
 * fails its schema is ignored, because a malformed row must not take the
 * header down. Non-text fields always come from English.
 */
export function applySettingTranslation<K extends TranslatableSettingKey>(
  key: K,
  english: SettingValue<K>,
  translation: unknown,
): SettingValue<K> {
  if (translation === null || translation === undefined) return english;
  const parsed = storedTranslationSchema(key).safeParse(translation);
  if (!parsed.success) return english;
  const words = parsed.data as Partial<SettingTextFields>;
  const entry: TranslatableSetting = TRANSLATABLE_SETTINGS[key];

  if (entry.whole) {
    const text = words[WHOLE_VALUE_FIELD];
    return (text !== undefined && text.trim() !== "" ? text : english) as SettingValue<K>;
  }
  if (english === null || typeof english !== "object") return english;
  const merged: Record<string, unknown> = { ...(english as Record<string, unknown>) };
  for (const field of Object.keys(entry.fields)) {
    const text = words[field];
    if (text !== undefined && text.trim() !== "") merged[field] = text;
  }
  return merged as SettingValue<K>;
}

/** Settings → Translation → Site text: one key's translation, saved (ADR-165 #8). */
export const settingTranslationSaveSchema = z.object({
  locale: z.string().min(2).max(10),
  key: z.enum(TRANSLATABLE_SETTING_KEYS as [TranslatableSettingKey, ...TranslatableSettingKey[]]),
  fields: z.record(z.string(), z.string()),
});

export type SettingTranslationSaveInput = z.infer<typeof settingTranslationSaveSchema>;
