// Fake Google Cloud Translation Basic (v2) and DeepL endpoints, for tests (MSW —
// testing.md reserves mocks for the network edge, and this IS that edge).
//
// Exported as `@repo/translate/testing` so a later suite in `@repo/core` (the
// enqueue and job runner, ADR-162) fakes the same endpoint the same way. It
// carries no logic of its own beyond the fake's answer, which is why the
// coverage floor excludes it.
//
// The fake "translates" by prefixing `[target] ` to each segment, so a test
// can see which language a string went to and that markup survived.
import { http, HttpResponse } from "msw";

import { DEEPL_FREE_ENDPOINT, DEEPL_PRO_ENDPOINT } from "./deepl.ts";
import { GOOGLE_TRANSLATE_ENDPOINT } from "./google.ts";

export { DEEPL_FREE_ENDPOINT, DEEPL_PRO_ENDPOINT, GOOGLE_TRANSLATE_ENDPOINT };

export interface FakeGoogleCall {
  url: string;
  apiKey: string | null;
  body: { q: string[]; source: string; target: string; format: string };
}

export interface FakeGoogleOptions {
  /** Only this key is accepted; anything else is answered as Google answers a bad key. */
  validKey?: string;
  /** Answer the Nth call (0-based) with this HTTP failure instead. */
  failures?: Record<number, { status: number; reason?: string; detailReason?: string }>;
  /** Replace the default "[target] text" translation. */
  translate?: (segment: string, target: string, format: string) => string;
}

export function fakeGoogleTranslate(options: FakeGoogleOptions = {}) {
  const calls: FakeGoogleCall[] = [];
  const handler = http.post(GOOGLE_TRANSLATE_ENDPOINT, async ({ request }) => {
    const index = calls.length;
    const body = (await request.json()) as FakeGoogleCall["body"];
    const apiKey = request.headers.get("x-goog-api-key");
    calls.push({ url: request.url, apiKey, body });

    const failure = options.failures?.[index];
    if (failure) {
      return HttpResponse.json(
        {
          error: {
            code: failure.status,
            message: "fake failure",
            errors: failure.reason ? [{ reason: failure.reason }] : [],
            details: failure.detailReason ? [{ reason: failure.detailReason }] : [],
          },
        },
        { status: failure.status },
      );
    }
    if (options.validKey !== undefined && apiKey !== options.validKey) {
      return HttpResponse.json(
        {
          error: {
            code: 400,
            message: "API key not valid. Please pass a valid API key.",
            status: "INVALID_ARGUMENT",
            details: [{ reason: "API_KEY_INVALID" }],
          },
        },
        { status: 400 },
      );
    }
    const translate =
      options.translate ?? ((segment: string, target: string) => `[${target}] ${segment}`);
    return HttpResponse.json({
      data: {
        translations: body.q.map((segment) => ({
          translatedText: translate(segment, body.target, body.format),
        })),
      },
    });
  });
  return { handler, calls };
}

export interface FakeDeeplCall {
  url: string;
  authorization: string | null;
  body: { text: string[]; source_lang?: string; target_lang: string; tag_handling?: string };
}

export interface FakeDeeplOptions {
  /** Only this key is accepted; anything else is answered 403, as DeepL does. */
  validKey?: string;
  /** Answer the Nth call (0-based) with this HTTP status instead. */
  failures?: Record<number, number>;
  /** Replace the default "[TARGET_LANG] text" translation. */
  translate?: (text: string, targetLang: string, tagHandling: string | undefined) => string;
}

/**
 * A fake DeepL API (ADR-186), answering on BOTH hosts so a test sees which
 * one the key chose. Translates by prefixing DeepL's own target code
 * (`[ES] `, `[PT-BR] `), so a test can also see the code mapping.
 */
export function fakeDeepl(options: FakeDeeplOptions = {}) {
  const calls: FakeDeeplCall[] = [];
  const respond = async ({ request }: { request: Request }) => {
    const index = calls.length;
    const body = (await request.json()) as FakeDeeplCall["body"];
    const authorization = request.headers.get("authorization");
    calls.push({ url: request.url, authorization, body });

    const failure = options.failures?.[index];
    if (failure) return HttpResponse.json({ message: "fake failure" }, { status: failure });
    if (options.validKey !== undefined && authorization !== `DeepL-Auth-Key ${options.validKey}`) {
      return HttpResponse.json({ message: "Wrong endpoint" }, { status: 403 });
    }
    const translate =
      options.translate ?? ((text: string, targetLang: string) => `[${targetLang}] ${text}`);
    return HttpResponse.json({
      translations: body.text.map((text) => ({
        detected_source_language: body.source_lang ?? "EN",
        text: translate(text, body.target_lang, body.tag_handling),
      })),
    });
  };
  return {
    handlers: [http.post(DEEPL_PRO_ENDPOINT, respond), http.post(DEEPL_FREE_ENDPOINT, respond)],
    calls,
  };
}
