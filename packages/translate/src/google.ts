// Google Cloud Translation Basic (v2), ADR-160. One of two drivers since
// ADR-186; `deepl.ts` is the other.
//
// A plain `fetch`, no SDK: the v2 surface is one POST, and a vendor SDK would
// bring an auth stack for the service-account credential this edition does
// not use. Tests fake the endpoint with MSW (testing.md: mocks at the network
// edge only).
//
// Two rules this file keeps:
//
//   1. **The key goes in a header, never the URL.** `X-goog-api-key` rather
//      than `?key=`, so it cannot land in an access log, a proxy log or an
//      error trace that prints the request URL.
//   2. **Google's message never leaves.** Every failure becomes a
//      `TranslateError` with a taxonomy reason; the raw body is dropped.
import { MAX_CHARS_PER_REQUEST, MAX_SEGMENTS_PER_REQUEST } from "./batch.ts";
import type { TranslateDriver } from "./driver.ts";
import { TranslateError } from "./errors.ts";

/** Fixed in code: there is deliberately no base URL setting (ADR-160 #5). */
export const GOOGLE_TRANSLATE_ENDPOINT = "https://translation.googleapis.com/language/translate/v2";

interface GoogleErrorBody {
  error?: {
    code?: number;
    status?: string;
    errors?: Array<{ reason?: string }>;
    details?: Array<{ reason?: string }>;
  };
}

// Google puts the precise cause in one of two places depending on the
// failure: the legacy `errors[].reason` or the newer `details[].reason`.
const AUTH_REASONS = new Set([
  "API_KEY_INVALID",
  "API_KEY_SERVICE_BLOCKED",
  "API_KEY_IP_ADDRESS_BLOCKED",
  "API_KEY_HTTP_REFERRER_BLOCKED",
  "SERVICE_DISABLED",
  "keyInvalid",
  "accessNotConfigured",
  "forbidden",
]);
const QUOTA_REASONS = new Set(["dailyLimitExceeded", "quotaExceeded", "RATE_LIMIT_EXCEEDED"]);
const RATE_REASONS = new Set(["userRateLimitExceeded", "rateLimitExceeded"]);

/** Maps an HTTP failure to a reason. Exported for its tests. */
export function classifyGoogleError(status: number, body: GoogleErrorBody | null): TranslateError {
  const reasons = [
    ...(body?.error?.errors ?? []).map((e) => e.reason),
    ...(body?.error?.details ?? []).map((d) => d.reason),
  ].filter((r): r is string => typeof r === "string");
  const message = `Google Translate answered ${status}`;

  if (reasons.some((r) => AUTH_REASONS.has(r))) return new TranslateError("auth_failed", message);
  if (reasons.some((r) => RATE_REASONS.has(r))) return new TranslateError("rate_limited", message);
  if (reasons.some((r) => QUOTA_REASONS.has(r)))
    return new TranslateError("quota_exceeded", message);
  if (status === 401 || status === 403) return new TranslateError("auth_failed", message);
  if (status === 429) return new TranslateError("rate_limited", message);
  if (status >= 500) return new TranslateError("provider_error", message);
  return new TranslateError("bad_request", message);
}

export function googleTranslateDriver(apiKey: string): TranslateDriver {
  return {
    limits: { maxSegments: MAX_SEGMENTS_PER_REQUEST, maxChars: MAX_CHARS_PER_REQUEST },
    async translate(request, signal) {
      let response: Response;
      try {
        response = await fetch(GOOGLE_TRANSLATE_ENDPOINT, {
          method: "POST",
          headers: {
            "content-type": "application/json; charset=utf-8",
            "x-goog-api-key": apiKey,
          },
          body: JSON.stringify({
            q: request.segments,
            source: request.source,
            target: request.target,
            format: request.format,
          }),
          signal,
        });
      } catch (error) {
        if ((error as Error).name === "AbortError") throw error;
        throw new TranslateError("network_error", "Google Translate could not be reached");
      }

      const body = (await response.json().catch(() => null)) as
        | (GoogleErrorBody & { data?: { translations?: Array<{ translatedText?: unknown }> } })
        | null;

      if (!response.ok) throw classifyGoogleError(response.status, body);

      const translations = body?.data?.translations;
      if (
        !Array.isArray(translations) ||
        translations.length !== request.segments.length ||
        translations.some((t) => typeof t.translatedText !== "string")
      ) {
        // A 200 whose shape we cannot trust is not a translation.
        throw new TranslateError("network_error", "Google Translate answer was unreadable");
      }
      return translations.map((t) => t.translatedText as string);
    },
  };
}
