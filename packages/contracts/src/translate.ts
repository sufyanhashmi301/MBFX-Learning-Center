// Automatic translation (ADR-160): the names `@repo/translate` and the
// Settings → Translation screen both have to agree on.
//
// The provider is Google Cloud Translation Basic (v2) or DeepL (ADR-186). Its
// API key is DATA an admin enters, sealed under TRANSLATE_SECRET_KEY and read
// by `@repo/translate` alone (security.md #10). Nothing here carries the key
// back out: the save schema accepts one, and no view schema has a field for it.
import { z } from "zod";

/** The services that can translate (ADR-186). Mirrors the Prisma enum. */
export const TRANSLATE_PROVIDER_KINDS = ["GOOGLE", "DEEPL"] as const;

export type TranslateProviderKindName = (typeof TRANSLATE_PROVIDER_KINDS)[number];

/**
 * Each provider's list price in USD per million characters, as checked on
 * 2026-10-05: Google Basic $20, DeepL API Pro $25. Only a suggestion the form
 * fills in when the provider changes; the admin's figure is what is stored.
 */
export const TRANSLATE_PROVIDER_LIST_PRICE: Record<TranslateProviderKindName, number> = {
  GOOGLE: 20,
  DEEPL: 25,
};

/**
 * Why a translation did not happen. A machine-readable taxonomy, stored in
 * usage rows and shown through catalog strings, so the provider's own message
 * (which can quote the request back) never reaches a screen or a table.
 */
export const TRANSLATE_REASONS = [
  /** No provider row, no key, or switched off. */
  "not_configured",
  /** TRANSLATE_SECRET_KEY is missing or the stored seal will not open. */
  "seal_unavailable",
  /** The provider refused the key. */
  "auth_failed",
  /** The provider account's quota is used up. */
  "quota_exceeded",
  /** Too many requests right now; worth retrying later. */
  "rate_limited",
  /** Our own monthly character budget is reached (ADR-160 #6). */
  "budget_exceeded",
  /** The provider rejected the request itself (bad language code, too large). */
  "bad_request",
  /** The provider answered with a server error. */
  "provider_error",
  /** The provider could not be reached, or the answer could not be read. */
  "network_error",
  /**
   * Our own code failed while handling a job — a bug, not Google. Kept apart
   * from `network_error` so a failure list never sends someone to check
   * Google's status for a fault that is ours.
   */
  "internal_error",
] as const;

export type TranslateReason = (typeof TRANSLATE_REASONS)[number];

/** Reasons a later attempt can succeed without anyone changing anything. */
export const TRANSIENT_TRANSLATE_REASONS: readonly TranslateReason[] = [
  "rate_limited",
  "provider_error",
  "network_error",
];

/** Reasons that PAUSE work rather than fail it (ADR-162 #6). */
export const PAUSING_TRANSLATE_REASONS: readonly TranslateReason[] = [
  "quota_exceeded",
  "budget_exceeded",
];

/** Upper bound on the price field: a typo of 2000 for 20 is refused. */
export const TRANSLATE_MAX_PRICE_PER_MILLION = 1000;

/** Upper bound on the monthly budget: two billion characters. */
export const TRANSLATE_MAX_MONTHLY_CHARS = 2_000_000_000;

/**
 * The Settings → Translation save.
 *
 * `apiKey` is optional and write-only: blank means "keep the saved one" (the
 * SMTP password's rule, ADR-078). `monthlyCharBudget` null means no cap.
 */
export const translateSettingsSaveSchema = z.object({
  enabled: z.boolean(),
  /** The service. Changing it needs `apiKey` too (ADR-186 #1), which the service checks. */
  kind: z.enum(TRANSLATE_PROVIDER_KINDS),
  apiKey: z.string().trim().max(200).optional(),
  pricePerMillionChars: z.number().min(0).max(TRANSLATE_MAX_PRICE_PER_MILLION),
  monthlyCharBudget: z.number().int().min(1).max(TRANSLATE_MAX_MONTHLY_CHARS).nullable(),
});

export type TranslateSettingsSaveInput = z.infer<typeof translateSettingsSaveSchema>;

/**
 * "Test connection": a typed key, or the saved one when blank. `kind` is the
 * provider the form shows; a stored key is only ever tested against its own.
 */
export const translateTestSchema = z.object({
  kind: z.enum(TRANSLATE_PROVIDER_KINDS),
  apiKey: z.string().trim().max(200).optional(),
});

export type TranslateTestInput = z.infer<typeof translateTestSchema>;

/** A locale code as the Locale table stores it. */
const localeCodeSchema = z
  .string()
  .trim()
  .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/);

/**
 * Languages tab (ADR-163 #2): switch a locale on or off. The service decides
 * whether it may be switched on; this only says what was asked.
 */
export const localeActivationSchema = z.object({
  locale: localeCodeSchema,
  active: z.boolean(),
});

export type LocaleActivationInput = z.infer<typeof localeActivationSchema>;

/**
 * Languages tab, Add and Edit (ADR-178 #2). The code must be one the site can
 * route — the SERVICE checks it against `SUPPORTED_LOCALES`, which lives in
 * `@repo/i18n` and so cannot be imported here. Direction is not an input: it
 * comes from the same registry.
 */
export const localeSaveSchema = z.object({
  code: localeCodeSchema,
  name: z.string().trim().min(1).max(100),
  nativeName: z.string().trim().min(1).max(100),
  flagEmoji: z.string().trim().max(10),
  fallbackCode: localeCodeSchema.nullable(),
  sortOrder: z.number().int().min(0).max(9999),
});

export type LocaleSaveInput = z.infer<typeof localeSaveSchema>;

/** Languages tab, Delete (ADR-178 #2). */
export const localeDeleteSchema = z.object({ locale: localeCodeSchema });

export type LocaleDeleteInput = z.infer<typeof localeDeleteSchema>;

/** A catalog key: dotted segments of letters, digits, `_` and `-`. */
const messageKeySchema = z
  .string()
  .trim()
  .max(191)
  .regex(/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$/);

/** Longest interface string an admin may save. The longest shipped is ~1,200. */
export const INTERFACE_TEXT_MAX_CHARS = 5000;

/**
 * Interface text, Save (ADR-178 #4). The service refuses an admin key and a
 * value whose arguments or tags differ from the English one.
 */
export const interfaceTextSaveSchema = z.object({
  locale: localeCodeSchema,
  key: messageKeySchema,
  value: z.string().trim().min(1).max(INTERFACE_TEXT_MAX_CHARS),
});

export type InterfaceTextSaveInput = z.infer<typeof interfaceTextSaveSchema>;

/** Interface text, Reset: remove one override. */
export const interfaceTextResetSchema = z.object({
  locale: localeCodeSchema,
  key: messageKeySchema,
});

export type InterfaceTextResetInput = z.infer<typeof interfaceTextResetSchema>;

/** Interface text, "Translate missing automatically" (ADR-178 #5). */
export const interfaceTextFillSchema = z.object({ locale: localeCodeSchema });

export type InterfaceTextFillInput = z.infer<typeof interfaceTextFillSchema>;

/**
 * Sync and Retry failed (ADR-163 #5): one locale, or — with no locale — every
 * active one.
 */
export const translationScopeSchema = z.object({
  locale: localeCodeSchema.optional(),
});

export type TranslationScopeInput = z.infer<typeof translationScopeSchema>;

/** Editor prefill: at most this many characters of source per request. */
export const TRANSLATE_PREFILL_MAX_CHARS = 100_000;

/**
 * Plan §3 "Editor flow": the source locale's CURRENT form text, sent to Google
 * to fill another locale's form. Writes nothing — the admin's Save does.
 * `entity` names what the text belongs to, for the permission check and the
 * usage log; the only type so far is `article` (Phase 5 adds the rest).
 */
export const translatePrefillSchema = z.object({
  entity: z.object({ type: z.enum(["article", "promotion"]), id: z.string().min(1).max(191) }),
  sourceLocale: z.string().min(2).max(10),
  targetLocale: z.string().min(2).max(10),
  /** Plain-text fields by name. Never a slug. */
  texts: z.record(z.string().max(60), z.string().max(TRANSLATE_PREFILL_MAX_CHARS)),
  /** Rich-text (HTML) fields by name. Sanitized on the way back. */
  html: z.record(z.string().max(60), z.string().max(TRANSLATE_PREFILL_MAX_CHARS)).default({}),
});

export type TranslatePrefillInput = z.infer<typeof translatePrefillSchema>;
