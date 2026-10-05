// The DeepL driver against a faked endpoint (MSW), ADR-186. These pin what
// the driver sends and what it does with each answer; the real endpoint's
// behaviour rests on DeepL's documentation until a key is available.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { planBatches } from "./batch.ts";
import {
  classifyDeeplError,
  DEEPL_FREE_ENDPOINT,
  DEEPL_MAX_TEXTS_PER_REQUEST,
  DEEPL_PRO_ENDPOINT,
  deeplEndpointFor,
  deeplSourceCode,
  deeplTargetCode,
  deeplTranslateDriver,
} from "./deepl.ts";
import { TranslateError } from "./errors.ts";
import { fakeDeepl } from "./testing.ts";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// The routable codes, read from `@repo/i18n`'s registry as text: this package
// does not depend on `@repo/i18n`, and a test is no reason to start.
const ROUTING = fileURLToPath(new URL("../../i18n/src/routing.ts", import.meta.url));
const SUPPORTED_LOCALE_CODES = [
  ...readFileSync(ROUTING, "utf8").matchAll(/\{ code: "([a-z-]+)", name:/g),
].map((match) => match[1]!);

const PRO_KEY = "deepl-pro-key";
const FREE_KEY = "deepl-free-key:fx";

const request = {
  segments: ["Hello", "World"],
  source: "en",
  target: "es",
  format: "text" as const,
};

async function reasonFor(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TranslateError) return error.reason;
    throw error;
  }
  return "no error";
}

describe("which host the key chooses", () => {
  it("sends a free key (`:fx`) to the free host and every other key to Pro", () => {
    expect(deeplEndpointFor(FREE_KEY)).toBe(DEEPL_FREE_ENDPOINT);
    expect(deeplEndpointFor(` ${FREE_KEY} `)).toBe(DEEPL_FREE_ENDPOINT);
    expect(deeplEndpointFor(PRO_KEY)).toBe(DEEPL_PRO_ENDPOINT);
  });

  it("calls that host, with the key in the Authorization header and not the URL", async () => {
    const fake = fakeDeepl({ validKey: FREE_KEY });
    server.use(...fake.handlers);

    await deeplTranslateDriver(FREE_KEY).translate(request);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.url).toBe(DEEPL_FREE_ENDPOINT);
    expect(fake.calls[0]?.authorization).toBe(`DeepL-Auth-Key ${FREE_KEY}`);
    expect(fake.calls[0]?.url).not.toContain(FREE_KEY);
  });
});

describe("language codes (ADR-186 #4)", () => {
  it("upper-cases a plain code and names the variant DeepL needs as a target", () => {
    expect(deeplTargetCode("ar")).toBe("AR");
    expect(deeplTargetCode("ur")).toBe("UR");
    expect(deeplTargetCode("en")).toBe("EN-US");
    expect(deeplTargetCode("pt")).toBe("PT-BR");
    expect(deeplTargetCode("zh")).toBe("ZH-HANS");
  });

  it("sends a source as the bare language", () => {
    expect(deeplSourceCode("en")).toBe("EN");
    expect(deeplSourceCode("pt-BR")).toBe("PT");
  });

  it("maps every routable locale to a code DeepL lists as a target", () => {
    expect(SUPPORTED_LOCALE_CODES.length).toBeGreaterThanOrEqual(28);
    for (const code of SUPPORTED_LOCALE_CODES) {
      expect(DEEPL_TARGETS, code).toContain(deeplTargetCode(code));
    }
  });
});

describe("the request", () => {
  it('asks for HTML handling on an HTML body, so translate="no" spans are kept', async () => {
    const fake = fakeDeepl();
    server.use(...fake.handlers);
    const driver = deeplTranslateDriver(PRO_KEY);

    await driver.translate({ ...request, format: "html", segments: ["<p>Hi</p>"] });
    await driver.translate(request);

    expect(fake.calls[0]?.body).toMatchObject({
      text: ["<p>Hi</p>"],
      source_lang: "EN",
      target_lang: "ES",
      tag_handling: "html",
    });
    expect(fake.calls[1]?.body).not.toHaveProperty("tag_handling");
  });

  it("returns the answers in order", async () => {
    server.use(...fakeDeepl().handlers);
    await expect(deeplTranslateDriver(PRO_KEY).translate(request)).resolves.toEqual([
      "[ES] Hello",
      "[ES] World",
    ]);
  });

  it("declares DeepL's own batch limit, which the door batches by", () => {
    const { limits } = deeplTranslateDriver(PRO_KEY);
    expect(limits.maxSegments).toBe(DEEPL_MAX_TEXTS_PER_REQUEST);
    const batches = planBatches(
      Array.from({ length: 120 }, () => "x"),
      limits,
    );
    expect(batches.map((b) => b.length)).toEqual([50, 50, 20]);
  });
});

describe("failures (ADR-186 #5)", () => {
  it.each([
    [403, "auth_failed"],
    [456, "quota_exceeded"],
    [429, "rate_limited"],
    [529, "rate_limited"],
    [500, "provider_error"],
    [503, "provider_error"],
    [400, "bad_request"],
    [413, "bad_request"],
  ])("maps %i to %s", (status, reason) => {
    expect(classifyDeeplError(status).reason).toBe(reason);
  });

  it("answers a wrong key with auth_failed, and never repeats DeepL's message", async () => {
    server.use(...fakeDeepl({ validKey: PRO_KEY }).handlers);
    try {
      await deeplTranslateDriver("wrong").translate(request);
      expect.unreachable();
    } catch (error) {
      expect((error as TranslateError).reason).toBe("auth_failed");
      expect((error as Error).message).not.toContain("Wrong endpoint");
    }
  });

  it("treats an unreadable 200 as a failure, not a translation", async () => {
    server.use(
      http.post(DEEPL_PRO_ENDPOINT, () => HttpResponse.json({ translations: [{ text: "one" }] })),
    );
    expect(await reasonFor(deeplTranslateDriver(PRO_KEY).translate(request))).toBe("network_error");
  });

  it("reports an unreachable host as network_error", async () => {
    server.use(http.post(DEEPL_PRO_ENDPOINT, () => HttpResponse.error()));
    expect(await reasonFor(deeplTranslateDriver(PRO_KEY).translate(request))).toBe("network_error");
  });
});

/**
 * DeepL's documented target codes for the languages we route, as listed on
 * 2026-10-05 (developers.deepl.com, "Supported languages"). A new locale in
 * `routing.ts` whose mapped code is missing here fails above, which is the
 * prompt to check DeepL's list before switching it on.
 */
const DEEPL_TARGETS = [
  "AR",
  "BN",
  "DE",
  "EL",
  "EN-US",
  "ES",
  "FA",
  "FR",
  "HE",
  "HI",
  "ID",
  "IT",
  "JA",
  "KO",
  "MS",
  "NL",
  "PL",
  "PT-BR",
  "RO",
  "RU",
  "SV",
  "SW",
  "TH",
  "TR",
  "UK",
  "UR",
  "VI",
  "ZH-HANS",
];
