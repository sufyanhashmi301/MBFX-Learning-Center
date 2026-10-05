// DeepL API (v2) — the second driver (ADR-186).
//
// A plain `fetch`, no SDK, for the reason `google.ts` gives: the surface is one
// POST. Tests fake both hosts with MSW (`fakeDeepl` in `testing.ts`).
//
// The rules `google.ts` keeps, kept here:
//
//   1. **The endpoint is fixed in code.** There are two hosts, and the KEY
//      picks between them: DeepL's free keys end in `:fx` and only work on
//      `api-free.deepl.com`. There is no base URL setting (ADR-160 #5).
//   2. **The key goes in a header, never the URL** (`Authorization:
//      DeepL-Auth-Key …`).
//   3. **DeepL's message never leaves.** Every failure becomes a
//      `TranslateError` with a taxonomy reason; the body is dropped unread.
import type { TranslateDriver } from "./driver.ts";
import { TranslateError } from "./errors.ts";

export const DEEPL_PRO_ENDPOINT = "https://api.deepl.com/v2/translate";
export const DEEPL_FREE_ENDPOINT = "https://api-free.deepl.com/v2/translate";

/**
 * DeepL's documented per-request caps: 50 texts and a 128 KiB body. 30,000
 * characters keeps an HTML batch inside the body cap once it is JSON-escaped,
 * even for a source in a script that takes two or three bytes a character.
 */
export const DEEPL_MAX_TEXTS_PER_REQUEST = 50;
export const DEEPL_MAX_CHARS_PER_REQUEST = 30_000;

/** A free-tier key ends in `:fx` and is only accepted by the free host. */
export function deeplEndpointFor(apiKey: string): string {
  return apiKey.trim().endsWith(":fx") ? DEEPL_FREE_ENDPOINT : DEEPL_PRO_ENDPOINT;
}

/**
 * Targets for which DeepL needs a regional variant (ADR-186 #4). Our `pt` is
 * sent as Brazilian (the larger audience), our `zh` is Simplified by
 * definition (`routing.ts`), and English must name a variant as a target.
 */
const TARGET_VARIANTS: Record<string, string> = {
  en: "EN-US",
  pt: "PT-BR",
  zh: "ZH-HANS",
};

/** Our locale code as DeepL's `target_lang`. */
export function deeplTargetCode(locale: string): string {
  const base = locale.toLowerCase().split("-")[0] ?? locale;
  return TARGET_VARIANTS[base] ?? base.toUpperCase();
}

/** Our locale code as DeepL's `source_lang`: the bare language, no variant. */
export function deeplSourceCode(locale: string): string {
  return (locale.split("-")[0] ?? locale).toUpperCase();
}

/** Maps an HTTP failure to a reason (ADR-186 #5). Exported for its tests. */
export function classifyDeeplError(status: number): TranslateError {
  const message = `DeepL answered ${status}`;
  if (status === 401 || status === 403) return new TranslateError("auth_failed", message);
  // 456: the account's character quota is used up. Pauses work (ADR-162 #6).
  if (status === 456) return new TranslateError("quota_exceeded", message);
  // 529 is DeepL's "too many requests" alongside the standard 429.
  if (status === 429 || status === 529) return new TranslateError("rate_limited", message);
  if (status >= 500) return new TranslateError("provider_error", message);
  return new TranslateError("bad_request", message);
}

export function deeplTranslateDriver(apiKey: string): TranslateDriver {
  const endpoint = deeplEndpointFor(apiKey);
  return {
    limits: { maxSegments: DEEPL_MAX_TEXTS_PER_REQUEST, maxChars: DEEPL_MAX_CHARS_PER_REQUEST },
    async translate(request, signal) {
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json; charset=utf-8",
            authorization: `DeepL-Auth-Key ${apiKey.trim()}`,
          },
          body: JSON.stringify({
            text: request.segments,
            source_lang: deeplSourceCode(request.source),
            target_lang: deeplTargetCode(request.target),
            // HTML mode is what makes DeepL skip `translate="no"` elements,
            // which carry the ICU arguments and glossary terms (ADR-160 #9).
            ...(request.format === "html" ? { tag_handling: "html" } : {}),
          }),
          signal,
        });
      } catch (error) {
        if ((error as Error).name === "AbortError") throw error;
        throw new TranslateError("network_error", "DeepL could not be reached");
      }

      if (!response.ok) throw classifyDeeplError(response.status);

      const body = (await response.json().catch(() => null)) as {
        translations?: Array<{ text?: unknown }>;
      } | null;
      const translations = body?.translations;
      if (
        !Array.isArray(translations) ||
        translations.length !== request.segments.length ||
        translations.some((t) => typeof t.text !== "string")
      ) {
        // A 200 whose shape we cannot trust is not a translation.
        throw new TranslateError("network_error", "DeepL answer was unreadable");
      }
      return translations.map((t) => t.text as string);
    },
  };
}
