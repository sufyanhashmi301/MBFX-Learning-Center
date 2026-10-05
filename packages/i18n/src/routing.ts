// @repo/i18n — next-intl routing config (Module 06, MONOREPO_CONFIG.md §6).
//
// `locales` is the STATIC superset next-intl's proxy middleware and
// generateStaticParams need at build/request time — next-intl has no
// mechanism to read a dynamic list per request. It is derived from
// `SUPPORTED_LOCALES` below, the registry of every language the site CAN
// route (ADR-178 #1). The DB-driven `Locale` table is the runtime source of
// truth for which of them EXIST (an admin adds a row from this registry) and
// which are ACTIVE (`isActive`) — see locales.ts. A language outside the
// registry still needs a code change and a rebuild: next-intl can't route a
// prefix it doesn't know about.
import { defineRouting } from "next-intl/routing";

/**
 * Every language the site can route (ADR-178 #1). Data about each language
 * that must be known BEFORE any database read: `direction` decides
 * `<html dir>`, and the names prefill the admin's "Add language" form. The
 * admin creates `Locale` rows from this list; it never types a code.
 *
 * Plain ISO 639-1 codes only, each one Google Cloud Translation accepts as a
 * target, because the code is also what the translation queue sends. A code
 * here is a URL prefix, so it must never equal a coded first segment
 * (`routing.test.ts`). The first four are the seeded rows.
 */
export const SUPPORTED_LOCALES = [
  { code: "en", name: "English", nativeName: "English", direction: "ltr" },
  { code: "es", name: "Spanish", nativeName: "Español", direction: "ltr" },
  { code: "ar", name: "Arabic", nativeName: "العربية", direction: "rtl" },
  { code: "ur", name: "Urdu", nativeName: "اردو", direction: "rtl" },
  { code: "fr", name: "French", nativeName: "Français", direction: "ltr" },
  { code: "de", name: "German", nativeName: "Deutsch", direction: "ltr" },
  { code: "it", name: "Italian", nativeName: "Italiano", direction: "ltr" },
  { code: "pt", name: "Portuguese", nativeName: "Português", direction: "ltr" },
  { code: "nl", name: "Dutch", nativeName: "Nederlands", direction: "ltr" },
  { code: "pl", name: "Polish", nativeName: "Polski", direction: "ltr" },
  { code: "ro", name: "Romanian", nativeName: "Română", direction: "ltr" },
  { code: "sv", name: "Swedish", nativeName: "Svenska", direction: "ltr" },
  { code: "el", name: "Greek", nativeName: "Ελληνικά", direction: "ltr" },
  { code: "ru", name: "Russian", nativeName: "Русский", direction: "ltr" },
  { code: "uk", name: "Ukrainian", nativeName: "Українська", direction: "ltr" },
  { code: "tr", name: "Turkish", nativeName: "Türkçe", direction: "ltr" },
  { code: "fa", name: "Persian", nativeName: "فارسی", direction: "rtl" },
  { code: "he", name: "Hebrew", nativeName: "עברית", direction: "rtl" },
  { code: "hi", name: "Hindi", nativeName: "हिन्दी", direction: "ltr" },
  { code: "bn", name: "Bengali", nativeName: "বাংলা", direction: "ltr" },
  { code: "id", name: "Indonesian", nativeName: "Bahasa Indonesia", direction: "ltr" },
  { code: "ms", name: "Malay", nativeName: "Bahasa Melayu", direction: "ltr" },
  { code: "th", name: "Thai", nativeName: "ไทย", direction: "ltr" },
  { code: "vi", name: "Vietnamese", nativeName: "Tiếng Việt", direction: "ltr" },
  { code: "zh", name: "Chinese (Simplified)", nativeName: "简体中文", direction: "ltr" },
  { code: "ja", name: "Japanese", nativeName: "日本語", direction: "ltr" },
  { code: "ko", name: "Korean", nativeName: "한국어", direction: "ltr" },
  { code: "sw", name: "Swahili", nativeName: "Kiswahili", direction: "ltr" },
] as const satisfies ReadonlyArray<{
  code: string;
  name: string;
  nativeName: string;
  direction: "ltr" | "rtl";
}>;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/**
 * The languages an admin may ADD (ADR-188): the owner's set, English,
 * Arabic, Urdu, Hindi and Chinese (Simplified). Every other registry code
 * stays routable, so an inactive one still answers a clean 404, but cannot
 * be created in Settings → Translation → Languages, and `createLocale`
 * refuses it. A sixth language is a line here.
 */
export const OFFERED_LOCALE_CODES = ["en", "ar", "ur", "hi", "zh"] as const;

/** Whether an admin may add this language (ADR-188). */
export function isOfferedLocale(code: string): boolean {
  return (OFFERED_LOCALE_CODES as readonly string[]).includes(code);
}

export const routing = defineRouting({
  locales: SUPPORTED_LOCALES.map((locale) => locale.code),
  defaultLocale: "en",
  // Default locale has no prefix: "/" not "/en" — keeps the highest-traffic
  // path stable and avoids a redirect hop.
  localePrefix: "as-needed",
  // No `Link: <…>; rel="alternate"` RESPONSE header (changes-49). next-intl
  // builds it from the Host the server sees, which behind the reverse proxy
  // is `localhost:3003`, so production advertised five hreflang URLs on a
  // private origin — and for every locale in this STATIC list, the inactive
  // ones included. The page metadata already emits hreflang for the
  // SERVABLE locales only (`alternatesFor`, apps/web/app/_lib/seo.ts), from
  // `siteUrl()`, which is the one place the public origin is spelled.
  alternateLinks: false,
  // `Secure` in production (changes-49): the cookie remembers a reader's
  // language and has no business travelling over plain HTTP. Off in dev,
  // where `http://localhost` would otherwise drop it.
  localeCookie: {
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  },
});

export type AppLocale = (typeof routing.locales)[number];

/**
 * `<html dir>` per routable locale, needed synchronously by the public root
 * layout (architecture doc §4.3) before any DB call is possible. Derived from
 * the registry, so a language cannot be routable without a direction.
 * `Locale.direction` in the database is written from the same registry when
 * an admin adds the row, and is not editable (ADR-178 #2).
 */
export const LOCALE_DIRECTION = Object.fromEntries(
  SUPPORTED_LOCALES.map((locale) => [locale.code, locale.direction]),
) as Record<AppLocale, "ltr" | "rtl">;

/** The registry entry for a code, or undefined when the site cannot route it. */
export function supportedLocale(code: string): SupportedLocale | undefined {
  return SUPPORTED_LOCALES.find((locale) => locale.code === code);
}
