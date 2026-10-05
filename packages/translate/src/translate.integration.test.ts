// Real MariaDB (testing.md: "Mocking Prisma hides FK and constraint bugs"),
// with Google faked at the network edge (MSW).
//
// What is settled here and nowhere else, because each is about what the
// DATABASE ends up holding:
//
//  1. Every outcome of the door writes a usage row — success, failure and
//     refusal — and only a success is billed to the budget month, atomically.
//  2. **No text is stored.** The written rows are scanned for the input.
//  3. The key is sealed at rest, never echoed by the view, never audited.
//  4. Switching on is proved: a key that fails the test is not enabled.
//  5. The budget refuses BEFORE Google is called.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { MariaDbContainer, type StartedMariaDbContainer } from "@testcontainers/mariadb";
import type { db as DbClient } from "@repo/db";
import { generateSecretKey } from "@repo/secrets";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fakeDeepl, fakeGoogleTranslate } from "./testing.ts";

// Types only: the modules are loaded after DATABASE_URL points at the
// container, so a static import would build a client against the wrong URL.
import type * as IndexModule from "./index.ts";

const dbPackageRoot = fileURLToPath(new URL("../../db", import.meta.url));
const prismaCli = createRequire(import.meta.url).resolve("prisma/build/index.js");

const VALID_KEY = "AIza-valid-test-key";
const ACTOR = "translate-admin";
const NO_WAIT = { retryDelaysMs: [0, 0] };

let container: StartedMariaDbContainer;
let db: typeof DbClient;
let t: typeof IndexModule;
const server = setupServer();

beforeAll(async () => {
  container = await new MariaDbContainer("mariadb:11.4")
    .withDatabase("mbfx_translate_test")
    .withUsername("test")
    .withUserPassword("test")
    .start();
  const url = container.getConnectionUri().replace(/^mariadb:/, "mysql:");
  execFileSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: dbPackageRoot,
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
  process.env.DATABASE_URL = url;
  process.env.TRANSLATE_SECRET_KEY = generateSecretKey();
  db = (await import("@repo/db")).db;
  t = await import("./index.ts");
  server.listen({ onUnhandledRequest: "error" });
}, 180_000);

afterAll(async () => {
  server.close();
  await db?.$disconnect();
  await container?.stop();
});

afterEach(() => server.resetHandlers());

beforeEach(async () => {
  await db.translateUsage.deleteMany();
  await db.translateUsagePeriod.deleteMany();
  await db.translateProvider.deleteMany();
  await db.auditLog.deleteMany();
  await db.user.upsert({
    where: { id: ACTOR },
    update: {},
    create: { id: ACTOR, name: "Translator", email: "translator@example.test" },
  });
});

/** Saves an enabled provider through the real service, with the fake answering. */
async function enableProvider(extra: { monthlyCharBudget?: number | null } = {}) {
  const fake = fakeGoogleTranslate({ validKey: VALID_KEY });
  server.use(fake.handler);
  const result = await t.saveTranslateSettings(ACTOR, {
    kind: "GOOGLE",
    enabled: true,
    apiKey: VALID_KEY,
    pricePerMillionChars: 20,
    monthlyCharBudget: extra.monthlyCharBudget ?? null,
  });
  expect(result).toEqual({ ok: true });
  server.resetHandlers();
  await db.translateUsage.deleteMany();
  await db.translateUsagePeriod.deleteMany();
}

describe("the door", () => {
  it("refuses when nothing is configured, and says so in the log", async () => {
    const fake = fakeGoogleTranslate();
    server.use(fake.handler);

    await expect(t.translateTexts(["Hello"], { source: "en", target: "ar" })).rejects.toMatchObject(
      { reason: "not_configured" },
    );

    expect(fake.calls).toHaveLength(0);
    const rows = await db.translateUsage.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "REFUSED", reason: "not_configured", characters: 0 });
  });

  it("translates, meters each request, bills the month, and stores no text", async () => {
    await enableProvider();
    const fake = fakeGoogleTranslate({ validKey: VALID_KEY });
    server.use(fake.handler);

    const answers = await t.translateTexts(["Minimum deposit", "", "Leverage"], {
      source: "en",
      target: "ar",
      userId: ACTOR,
      entity: { type: "article", id: "a-1" },
    });

    expect(answers).toEqual(["[ar] Minimum deposit", "", "[ar] Leverage"]);
    // Blank segments are never sent.
    expect(fake.calls[0]?.body.q).toEqual(["Minimum deposit", "Leverage"]);

    const [row] = await db.translateUsage.findMany();
    expect(row).toMatchObject({
      status: "OK",
      format: "TEXT",
      segments: 2,
      characters: "Minimum deposit".length + "Leverage".length,
      entityType: "article",
      entityId: "a-1",
      userId: ACTOR,
    });
    // 23 characters at $20 per million.
    expect(row?.costUsd.toFixed(6)).toBe("0.000460");

    const usage = await t.getPeriodUsage();
    expect(usage).toMatchObject({ characters: 23, requests: 1, costUsd: "0.000460" });

    const written = JSON.stringify(await db.translateUsage.findMany());
    expect(written).not.toContain("Minimum deposit");
    expect(written).not.toContain("Leverage");
  });

  it("adds two requests finishing together without losing one", async () => {
    await enableProvider();
    server.use(fakeGoogleTranslate({ validKey: VALID_KEY }).handler);

    await Promise.all([
      t.translateTexts(["one"], { source: "en", target: "ar" }),
      t.translateTexts(["two"], { source: "en", target: "ar" }),
      t.translateTexts(["three"], { source: "en", target: "ar" }),
    ]);

    expect(await t.getPeriodUsage()).toMatchObject({ requests: 3, characters: 11 });
  });

  it("refuses over budget before Google is called", async () => {
    await enableProvider({ monthlyCharBudget: 10 });
    const fake = fakeGoogleTranslate({ validKey: VALID_KEY });
    server.use(fake.handler);

    await t.translateTexts(["123456"], { source: "en", target: "ar" });
    await expect(
      t.translateTexts(["123456"], { source: "en", target: "ar" }),
    ).rejects.toMatchObject({ reason: "budget_exceeded" });

    expect(fake.calls).toHaveLength(1);
    const refused = await db.translateUsage.findMany({ where: { status: "REFUSED" } });
    expect(refused).toHaveLength(1);
    expect(refused[0]?.reason).toBe("budget_exceeded");
  });

  it("retries a transient failure and records one success", async () => {
    await enableProvider();
    const fake = fakeGoogleTranslate({ validKey: VALID_KEY, failures: { 0: { status: 503 } } });
    server.use(fake.handler);

    const answers = await t.translateTexts(["Hi"], { source: "en", target: "es", ...NO_WAIT });

    expect(answers).toEqual(["[es] Hi"]);
    expect(fake.calls).toHaveLength(2);
    const rows = await db.translateUsage.findMany();
    expect(rows.map((r) => r.status)).toEqual(["OK"]);
  });

  it("records a failure it cannot retry, and does not bill it", async () => {
    await enableProvider();
    server.use(
      fakeGoogleTranslate({ failures: { 0: { status: 403, reason: "dailyLimitExceeded" } } })
        .handler,
    );

    await expect(
      t.translateTexts(["Hi"], { source: "en", target: "es", ...NO_WAIT }),
    ).rejects.toMatchObject({ reason: "quota_exceeded" });

    const [row] = await db.translateUsage.findMany();
    expect(row).toMatchObject({ status: "FAILED", reason: "quota_exceeded" });
    expect(row?.costUsd.toFixed(6)).toBe("0.000000");
    expect((await t.getPeriodUsage()).requests).toBe(0);
  });

  it("gives up on a transient failure after its retries", async () => {
    await enableProvider();
    const fake = fakeGoogleTranslate({
      failures: { 0: { status: 503 }, 1: { status: 503 }, 2: { status: 503 } },
    });
    server.use(fake.handler);

    await expect(
      t.translateTexts(["Hi"], { source: "en", target: "es", ...NO_WAIT }),
    ).rejects.toMatchObject({ reason: "provider_error" });
    expect(fake.calls).toHaveLength(3);
  });

  it("translates HTML with the glossary's own terms and strips the wrappers", async () => {
    await enableProvider();
    const fake = fakeGoogleTranslate({ validKey: VALID_KEY });
    server.use(fake.handler);

    const html = await t.translateHtml("<p>A pip is small.</p>", {
      source: "en",
      target: "ar",
      glossary: [{ source: "pip", target: "النقطة" }],
    });

    expect(fake.calls[0]?.body.format).toBe("html");
    expect(fake.calls[0]?.body.q[0]).toContain('translate="no"');
    expect(html).toBe("[ar] <p>A النقطة is small.</p>");
    expect(html).not.toContain("data-mt-keep");
  });

  it("translates several bodies in one request and returns them in order", async () => {
    await enableProvider();
    const fake = fakeGoogleTranslate({ validKey: VALID_KEY });
    server.use(fake.handler);

    const [body, empty, answer] = await t.translateHtmlMany(["<p>Body</p>", "", "<p>Answer</p>"], {
      source: "en",
      target: "es",
    });

    expect(fake.calls).toHaveLength(1);
    expect([body, empty, answer]).toEqual(["[es] <p>Body</p>", "", "[es] <p>Answer</p>"]);
  });

  it("refuses with seal_unavailable when the sealing key changes", async () => {
    await enableProvider();
    const original = process.env.TRANSLATE_SECRET_KEY;
    process.env.TRANSLATE_SECRET_KEY = generateSecretKey();
    try {
      await expect(t.translateTexts(["Hi"], { source: "en", target: "es" })).rejects.toMatchObject({
        reason: "seal_unavailable",
      });
    } finally {
      process.env.TRANSLATE_SECRET_KEY = original;
    }
  });
});

describe("Settings → Translation", () => {
  it("does not switch on with a key that fails the test", async () => {
    server.use(fakeGoogleTranslate({ validKey: VALID_KEY }).handler);

    const result = await t.saveTranslateSettings(ACTOR, {
      kind: "GOOGLE",
      enabled: true,
      apiKey: "wrong",
      pricePerMillionChars: 20,
      monthlyCharBudget: null,
    });

    expect(result).toEqual({ ok: false, reason: "auth_failed" });
    expect(await db.translateProvider.count()).toBe(0);
  });

  it("will not switch on with no key at all", async () => {
    expect(
      await t.saveTranslateSettings(ACTOR, {
        kind: "GOOGLE",
        enabled: true,
        pricePerMillionChars: 20,
        monthlyCharBudget: null,
      }),
    ).toEqual({ ok: false, reason: "keyRequired" });
  });

  it("seals the key, keeps it out of the view and the audit log", async () => {
    await enableProvider({ monthlyCharBudget: 500_000 });

    const raw = await db.translateProvider.findUniqueOrThrow({ where: { id: "default" } });
    expect(raw.apiKeyCipher).toBeTruthy();
    expect(raw.apiKeyCipher).not.toContain(VALID_KEY);

    const view = await t.loadTranslateSettings();
    expect(view).toMatchObject({
      enabled: true,
      hasApiKey: true,
      monthlyCharBudget: 500_000,
      pricePerMillionChars: 20,
      lastTestResult: "ok",
      sealKeyPresent: true,
    });
    expect(JSON.stringify(view)).not.toContain(VALID_KEY);

    const audit = await db.auditLog.findMany({ where: { action: "settings.translate.update" } });
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(VALID_KEY);
    expect(audit[0]?.changes).toMatchObject({ apiKeyChanged: true });
  });

  it("keeps the saved key when the field is left blank", async () => {
    await enableProvider();
    const before = await db.translateProvider.findUniqueOrThrow({ where: { id: "default" } });

    expect(
      await t.saveTranslateSettings(ACTOR, {
        kind: "GOOGLE",
        enabled: false,
        pricePerMillionChars: 25,
        monthlyCharBudget: null,
      }),
    ).toEqual({ ok: true });

    const after = await db.translateProvider.findUniqueOrThrow({ where: { id: "default" } });
    expect(after.apiKeyCipher).toBe(before.apiKeyCipher);
    expect(after.enabled).toBe(false);
    expect(after.pricePerMillionChars.toFixed(2)).toBe("25.00");
  });

  it("refuses to store a key when TRANSLATE_SECRET_KEY is missing", async () => {
    const original = process.env.TRANSLATE_SECRET_KEY;
    delete process.env.TRANSLATE_SECRET_KEY;
    try {
      expect(
        await t.saveTranslateSettings(ACTOR, {
          kind: "GOOGLE",
          enabled: false,
          apiKey: VALID_KEY,
          pricePerMillionChars: 20,
          monthlyCharBudget: null,
        }),
      ).toEqual({ ok: false, reason: "sealKeyMissing" });
    } finally {
      process.env.TRANSLATE_SECRET_KEY = original;
    }
  });

  it("tests the stored key and records the result; a typed key's result is not kept", async () => {
    await enableProvider();
    server.use(fakeGoogleTranslate({ validKey: VALID_KEY }).handler);

    expect(await t.testTranslateConnection(ACTOR, { kind: "GOOGLE" })).toEqual({ ok: true });
    expect(await t.testTranslateConnection(ACTOR, { kind: "GOOGLE", apiKey: "typo" })).toEqual({
      ok: false,
      reason: "auth_failed",
    });

    const row = await db.translateProvider.findUniqueOrThrow({ where: { id: "default" } });
    expect(row.lastTestResult).toBe("ok");
    const audits = await db.auditLog.findMany({ where: { action: "settings.translate.test" } });
    expect(audits).toHaveLength(2);
    expect(JSON.stringify(audits)).not.toContain("typo");
  });

  it("asks for a key when there is none to test", async () => {
    expect(await t.testTranslateConnection(ACTOR, { kind: "GOOGLE" })).toEqual({
      ok: false,
      reason: "keyRequired",
    });
  });
});

describe("DeepL as the provider (ADR-186)", () => {
  const DEEPL_KEY = "deepl-test-key:fx";

  async function switchToDeepl() {
    const fake = fakeDeepl({ validKey: DEEPL_KEY });
    server.use(...fake.handlers);
    const result = await t.saveTranslateSettings(ACTOR, {
      kind: "DEEPL",
      enabled: true,
      apiKey: DEEPL_KEY,
      pricePerMillionChars: 25,
      monthlyCharBudget: null,
    });
    expect(result).toEqual({ ok: true });
    await db.translateUsage.deleteMany();
    await db.translateUsagePeriod.deleteMany();
    return fake;
  }

  it("will not change provider without a new key, so a Google key never reaches DeepL", async () => {
    await enableProvider();
    const fake = fakeDeepl();
    server.use(...fake.handlers);

    expect(
      await t.saveTranslateSettings(ACTOR, {
        kind: "DEEPL",
        enabled: true,
        pricePerMillionChars: 25,
        monthlyCharBudget: null,
      }),
    ).toEqual({ ok: false, reason: "keyRequired" });
    expect(await t.testTranslateConnection(ACTOR, { kind: "DEEPL" })).toEqual({
      ok: false,
      reason: "keyRequired",
    });

    expect(fake.calls).toHaveLength(0);
    const row = await db.translateProvider.findUniqueOrThrow({ where: { id: "default" } });
    expect(row.kind).toBe("GOOGLE");
  });

  it("switches with a key that passes DeepL's test, and translates through DeepL from then on", async () => {
    await enableProvider();
    const fake = await switchToDeepl();
    const google = fakeGoogleTranslate();
    server.use(google.handler);

    await expect(
      t.translateTexts(["Hello"], { source: "en", target: "pt", ...NO_WAIT }),
    ).resolves.toEqual(["[PT-BR] Hello"]);

    expect(google.calls).toHaveLength(0);
    expect(fake.calls.at(-1)?.body).toMatchObject({ source_lang: "EN", target_lang: "PT-BR" });
    const view = await t.loadTranslateSettings();
    expect(view).toMatchObject({ kind: "DEEPL", enabled: true, hasApiKey: true });
    expect(JSON.stringify(view)).not.toContain(DEEPL_KEY);
    expect(await t.getAutoTranslateProvider()).toBe("DEEPL");

    const usage = await db.translateUsage.findMany();
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ status: "OK", provider: "DEEPL", characters: 5 });

    const audit = await db.auditLog.findMany({
      where: { action: "settings.translate.update" },
      orderBy: { createdAt: "asc" },
    });
    expect(audit.at(-1)?.changes).toMatchObject({
      before: { kind: "GOOGLE" },
      after: { kind: "DEEPL" },
      apiKeyChanged: true,
    });
    expect(JSON.stringify(audit)).not.toContain(DEEPL_KEY);
  });

  it("refuses the switch when DeepL rejects the key, and keeps Google", async () => {
    await enableProvider();
    server.use(...fakeDeepl({ validKey: DEEPL_KEY }).handlers);

    expect(
      await t.saveTranslateSettings(ACTOR, {
        kind: "DEEPL",
        enabled: true,
        apiKey: "not-the-key",
        pricePerMillionChars: 25,
        monthlyCharBudget: null,
      }),
    ).toEqual({ ok: false, reason: "auth_failed" });
    const row = await db.translateProvider.findUniqueOrThrow({ where: { id: "default" } });
    expect(row.kind).toBe("GOOGLE");
  });

  it("pauses on DeepL's quota answer rather than failing", async () => {
    await enableProvider();
    await switchToDeepl();
    server.use(...fakeDeepl({ validKey: DEEPL_KEY, failures: { 0: 456 } }).handlers);

    await expect(
      t.translateTexts(["Hello"], { source: "en", target: "ar", ...NO_WAIT }),
    ).rejects.toMatchObject({ reason: "quota_exceeded" });
    expect(t.isPausing(new t.TranslateError("quota_exceeded", ""))).toBe(true);
    const usage = await db.translateUsage.findMany();
    expect(usage[0]).toMatchObject({ status: "FAILED", provider: "DEEPL" });
  });
});

// Phase 2 (ADR-161 #7, ADR-162 #1): the schema facts the job runner will
// rely on, pinned against a real database before any code depends on them.
describe("the translation schema", () => {
  beforeEach(async () => {
    await db.translationJob.deleteMany();
    await db.articleTag.deleteMany();
  });

  it("gives a row written without a status TRANSLATED and an unknown hash", async () => {
    const tag = await db.articleTag.create({
      data: { translations: { create: { locale: "ar", name: "الرافعة", slug: "leverage-ar" } } },
      include: { translations: true },
    });
    expect(tag.translations[0]).toMatchObject({
      translationStatus: "TRANSLATED",
      sourceHash: null,
    });
  });

  it("refuses a second backfill of the same locale, because '*' is not NULL", async () => {
    const job = { kind: "BACKFILL_LOCALE" as const, entityType: "*", entityId: "*", locale: "ar" };
    await db.translationJob.create({ data: job });
    await expect(db.translationJob.create({ data: job })).rejects.toThrow();
    expect(await db.translationJob.count()).toBe(1);
  });

  it("keeps one row per entity and locale, and upsert re-arms a finished job", async () => {
    const key = { kind: "ITEM" as const, entityType: "article", entityId: "a1", locale: "ar" };
    await db.translationJob.create({ data: { ...key, status: "DONE", attempts: 2 } });
    await db.translationJob.upsert({
      where: { kind_entityType_entityId_locale: key },
      update: { status: "PENDING", attempts: 0, runAfter: new Date() },
      create: key,
    });
    const rows = await db.translationJob.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "PENDING", attempts: 0, claimToken: null });
  });
});
