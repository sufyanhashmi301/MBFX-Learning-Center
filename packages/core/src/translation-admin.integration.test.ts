// Phase 4's exit, on a real MariaDB with Google faked at the network edge
// (MSW): switching a language on backfills every news article with nobody
// pressing anything but the switch, two cron calls never translate the same
// job, a failure retries with backoff and surfaces, and the budget PAUSES the
// work rather than failing it (plan §6 Phase 4, ADR-162, ADR-163).
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { MariaDbContainer, type StartedMariaDbContainer } from "@testcontainers/mariadb";
import type { db as DbClient } from "@repo/db";
import type { Subject } from "@repo/rbac";
import { generateSecretKey } from "@repo/secrets";
import { fakeGoogleTranslate } from "@repo/translate/testing";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type * as AdminModule from "./translation-admin.ts";
import type * as ArticlesModule from "./articles.ts";
import type * as ArticleTranslationModule from "./article-translation.ts";
import type * as ArticleSourceModule from "./article-source.ts";
import type * as RunnerModule from "./translation-runner.ts";
import type * as TranslateModule from "@repo/translate";

const dbPackageRoot = fileURLToPath(new URL("../../db", import.meta.url));
const prismaCli = createRequire(import.meta.url).resolve("prisma/build/index.js");
const KEY = "AIza-test";
/** A complete catalog, standing in for the activation PR (ADR-163 #2). */
const complete = { catalogGaps: async () => [] };

let container: StartedMariaDbContainer;
let db: typeof DbClient;
let admin: typeof AdminModule;
let articles: typeof ArticlesModule;
let articleTranslation: typeof ArticleTranslationModule;
let articleSource: typeof ArticleSourceModule;
let runner: typeof RunnerModule;
let translate: typeof TranslateModule;
let editor: Subject;
let userId: string;
let categoryId: string;
const server = setupServer();
let google: ReturnType<typeof fakeGoogleTranslate>;

beforeAll(async () => {
  container = await new MariaDbContainer("mariadb:11.4")
    .withDatabase("mbfx_translation_admin")
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
  admin = await import("./translation-admin.ts");
  articles = await import("./articles.ts");
  articleTranslation = await import("./article-translation.ts");
  articleSource = await import("./article-source.ts");
  runner = await import("./translation-runner.ts");
  translate = await import("@repo/translate");
  server.listen({ onUnhandledRequest: "error" });

  const user = await db.user.create({
    data: {
      id: crypto.randomUUID(),
      email: "languages@x.com",
      name: "Admin",
      status: "ACTIVE",
      userType: "STAFF",
    },
  });
  userId = user.id;
  editor = {
    id: user.id,
    userType: "STAFF",
    roleKeys: [],
    maxRoleLevel: 90,
    allowed: new Set(["news.manage"]),
    denied: new Set(),
  };
  await db.locale.createMany({
    data: [
      {
        code: "en",
        name: "English",
        nativeName: "English",
        isDefault: true,
        isActive: true,
        sortOrder: 1,
      },
      // Seeded INACTIVE, as every non-English locale is (ADR-007).
      {
        code: "es",
        name: "Spanish",
        nativeName: "Español",
        isActive: false,
        sortOrder: 2,
        fallbackCode: "en",
      },
    ],
  });
  categoryId = await articles.createArticleCategory(editor, { name: "Market News" });

  server.use(fakeGoogleTranslate({ validKey: KEY }).handler);
  expect(
    await translate.saveTranslateSettings(user.id, {
      kind: "GOOGLE",
      enabled: true,
      apiKey: KEY,
      pricePerMillionChars: 20,
      monthlyCharBudget: null,
    }),
  ).toEqual({ ok: true });
  server.resetHandlers();
}, 180_000);

afterAll(async () => {
  server.close();
  await db?.$disconnect();
  await container?.stop();
});

beforeEach(() => {
  google = fakeGoogleTranslate({ validKey: KEY });
  server.use(google.handler);
});
afterEach(() => server.resetHandlers());

async function newPublishedArticle(title: string) {
  const id = await articles.createArticle(editor, { kind: "NEWS", categoryId });
  await articles.saveArticle(editor, {
    articleId: id,
    meta: {},
    translation: {
      articleId: id,
      locale: "en",
      title,
      excerpt: "A short summary",
      body: "<p>Deposit $10 today.</p>",
      keyTakeaways: ["One point"],
      faqItems: [{ question: "What is a pip?", answer: "<p>A small move.</p>" }],
    },
  });
  await articles.transitionArticle(editor, id, "PUBLISHED");
  return id;
}

async function resetLocale(active: boolean) {
  await db.locale.update({ where: { code: "es" }, data: { isActive: active } });
}

const spanishRows = () =>
  db.articleTranslation.findMany({ where: { locale: "es" }, orderBy: { articleId: "asc" } });

describe("activating a language (ADR-163 #2)", () => {
  it("refuses a locale whose public catalog is incomplete, and changes nothing", async () => {
    await resetLocale(false);
    const result = await admin.setLocaleActive(userId, { locale: "es", active: true });
    expect(result).toMatchObject({ ok: false, reason: "catalogIncomplete" });
    expect((result as { missingKeys?: number }).missingKeys).toBeGreaterThan(0);
    expect((await db.locale.findUniqueOrThrow({ where: { code: "es" } })).isActive).toBe(false);
    expect(await db.translationJob.count({ where: { kind: "BACKFILL_LOCALE" } })).toBe(0);
  });

  it("refuses the default locale and an unknown one", async () => {
    expect(await admin.setLocaleActive(userId, { locale: "en", active: false })).toEqual({
      ok: false,
      reason: "isDefault",
    });
    expect(await admin.setLocaleActive(userId, { locale: "fr", active: true })).toEqual({
      ok: false,
      reason: "notFound",
    });
  });

  it("backfills every news article unattended, then the estimate drops to zero", async () => {
    await resetLocale(false);
    await db.translationJob.deleteMany();
    // Written while Spanish is off: saving enqueues nothing for it.
    const ids = [
      await newPublishedArticle("Leverage explained"),
      await newPublishedArticle("Reading candlesticks"),
      await newPublishedArticle("What moves the dollar"),
    ];
    expect(await db.translationJob.count()).toBe(0);

    // The pre-flight estimate is what a run would send, counted the same way.
    let languages = await admin.loadLanguagesView();
    const expected = (
      await Promise.all(ids.map((id) => articleSource.loadArticleSource(db, id, "en")))
    ).reduce((sum, source) => sum + articleTranslation.articleSourceCharacters(source!), 0);
    const esRow = languages.rows.find((r) => r.code === "es")!;
    // The estimate spans every registered type (Phase 5): the three articles,
    // and the one article category this suite created in `beforeAll`.
    expect(esRow.estimate.characters).toBe(expected + "Market News".length);
    expect(esRow.estimate.costUsd).toBe(
      (((expected + "Market News".length) * 20) / 1_000_000).toFixed(6),
    );

    expect(await admin.setLocaleActive(userId, { locale: "es", active: true }, complete)).toEqual({
      ok: true,
      backfillQueued: true,
    });
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: "locales.activate" } });
    expect(audit).toMatchObject({ userId, entityType: "Locale", entityId: "es" });

    // One cron call: the backfill expands and its items run in the same drain —
    // the three articles and, since Phase 5, their category as well.
    const drained = await runner.drainTranslationQueue();
    expect(drained).toMatchObject({ backfillEnqueued: 4, done: 4, failed: 0, stoppedBy: "empty" });

    const rows = await spanishRows();
    expect(rows.map((r) => r.translationStatus)).toEqual([
      "MACHINE_TRANSLATED",
      "MACHINE_TRANSLATED",
      "MACHINE_TRANSLATED",
    ]);
    const overview = await admin.loadTranslationOverview();
    const es = overview.locales.find((l) => l.code === "es")!;
    expect(es).toMatchObject({
      isActive: true,
      coverage: { total: 4, machine: 4, missing: 0 },
      jobs: { pending: 0, running: 0, failed: 0, done: 4 },
      backfill: { status: "DONE", currentType: null },
    });
    expect(es.types.find((t) => t.entityType === "article")?.coverage).toMatchObject({
      total: 3,
      machine: 3,
      missing: 0,
    });

    languages = await admin.loadLanguagesView();
    expect(languages.rows.find((r) => r.code === "es")!.estimate.characters).toBe(0);
  });

  it("switching off keeps translations and cancels queued work (ADR-189 #4)", async () => {
    await resetLocale(true);
    const before = (await spanishRows()).length;
    await translate.enqueueTranslationJobs(
      (await spanishRows()).map((r) => ({
        entityType: "article",
        entityId: r.articleId,
        locale: "es",
      })),
    );
    expect(await admin.setLocaleActive(userId, { locale: "es", active: false })).toEqual({
      ok: true,
      backfillQueued: false,
    });
    expect(await db.translationJob.count({ where: { locale: "es", status: "PENDING" } })).toBe(0);
    const drained = await runner.drainTranslationQueue();
    expect(drained.claimed).toBe(0);
    expect(google.calls).toHaveLength(0);
    expect((await spanishRows()).length).toBe(before);
    expect(await db.auditLog.count({ where: { action: "locales.deactivate" } })).toBe(1);
  });
});

describe("sync, review and retry (ADR-163 #5)", () => {
  it("Sync re-walks: a person's row with an unknown hash is flagged for review", async () => {
    await resetLocale(true);
    const [first] = await spanishRows();
    await db.articleTranslation.update({
      where: { id: first!.id },
      data: { translationStatus: "TRANSLATED", sourceHash: null, title: "Revisado" },
    });

    expect(await admin.syncTranslations(userId, { locale: "es", mode: "missing" })).toEqual({
      ok: true,
      locales: ["es"],
      count: 1,
    });
    await runner.drainTranslationQueue();

    const row = await db.articleTranslation.findUniqueOrThrow({ where: { id: first!.id } });
    expect(row).toMatchObject({ translationStatus: "OUTDATED", title: "Revisado" });
    // ADR-159 #5: the machine rows are listed too — review is a queue of
    // everything no person has read, not only what went wrong.
    // Articles only: the suite's category is in the queue too (Phase 5).
    const queue = (await admin.loadTranslationReviewQueue({ locale: "es" })).filter(
      (row) => row.entityType === "article",
    );
    expect(queue.filter((r) => r.status === "MACHINE_TRANSLATED")).toHaveLength(
      (await spanishRows()).filter((r) => r.translationStatus === "MACHINE_TRANSLATED").length,
    );
    expect(queue.filter((r) => r.status !== "MACHINE_TRANSLATED")).toEqual([
      expect.objectContaining({
        entityType: "article",
        entityId: first!.articleId,
        locale: "es",
        status: "OUTDATED",
        title: "Revisado",
        sourceTitle: expect.any(String),
      }),
    ]);
    expect(await db.auditLog.count({ where: { action: "translations.sync" } })).toBe(1);
  });

  it("a reset re-translates machine rows in place; missing-only leaves them (ADR-191)", async () => {
    await resetLocale(true);
    const machine = (await spanishRows()).find((r) => r.translationStatus === "MACHINE_TRANSLATED");
    if (!machine) throw new Error("expected a machine row");
    await db.articleTranslation.update({
      where: { id: machine.id },
      data: { title: "Old machine words" },
    });
    const person = await db.articleTranslation.findFirstOrThrow({
      where: { locale: "es", translationStatus: { not: "MACHINE_TRANSLATED" } },
    });

    // Missing only: the machine row's English has not moved, so it stays.
    await admin.syncTranslations(userId, { locale: "es", mode: "missing" });
    await runner.drainTranslationQueue();
    expect(
      await db.articleTranslation.findUniqueOrThrow({ where: { id: machine.id } }),
    ).toMatchObject({ title: "Old machine words" });

    await admin.syncTranslations(userId, { locale: "es", mode: "reset" });
    // Marked in place: still served with its old words until the job runs.
    expect(
      await db.articleTranslation.findUniqueOrThrow({ where: { id: machine.id } }),
    ).toMatchObject({ title: "Old machine words", sourceHash: null });
    await runner.drainTranslationQueue();

    const redone = await db.articleTranslation.findUniqueOrThrow({ where: { id: machine.id } });
    expect(redone.title).not.toBe("Old machine words");
    expect(redone.translationStatus).toBe("MACHINE_TRANSLATED");
    expect(redone.sourceHash).not.toBeNull();
    const kept = await db.articleTranslation.findUniqueOrThrow({ where: { id: person.id } });
    expect(kept).toMatchObject({
      title: person.title,
      translationStatus: person.translationStatus,
    });
    await db.translationJob.deleteMany();
  });

  it("syncs a language that is not live, and refuses one that does not exist (ADR-189 #1)", async () => {
    await resetLocale(false);
    expect(await admin.syncTranslations(userId, { locale: "fr", mode: "missing" })).toEqual({
      ok: false,
      reason: "unknownLocale",
    });
    expect(await admin.syncTranslations(userId, { locale: "en", mode: "missing" })).toEqual({
      ok: false,
      reason: "unknownLocale",
    });
    expect(await admin.syncTranslations(userId, { mode: "missing" })).toEqual({
      ok: true,
      locales: ["es"],
      count: 1,
    });
    await db.translationJob.deleteMany();
  });

  it("a failure retries with backoff, surfaces as FAILED, and Retry re-arms it", async () => {
    await resetLocale(true);
    await db.translationJob.deleteMany();
    const id = await newPublishedArticle("Rejected by Google");
    await db.translationJob.deleteMany(); // the save's own job: we drive it by hand
    server.resetHandlers();
    // Every call a bad request: not transient, so the door does not retry it.
    server.use(
      fakeGoogleTranslate({
        validKey: KEY,
        failures: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [i, { status: 400 }])),
      }).handler,
    );
    await translate.enqueueTranslationJobs([{ entityType: "article", entityId: id, locale: "es" }]);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await runner.drainTranslationQueue();
      const job = await db.translationJob.findFirstOrThrow({ where: { entityId: id } });
      expect(job.attempts).toBe(attempt);
      if (attempt < 3) {
        expect(job).toMatchObject({ status: "PENDING", lastError: "bad_request" });
        expect(job.runAfter.getTime()).toBeGreaterThan(Date.now());
        await db.translationJob.update({ where: { id: job.id }, data: { runAfter: new Date(0) } });
      }
    }
    const overview = await admin.loadTranslationOverview();
    expect(overview.failed).toEqual([
      expect.objectContaining({ entityId: id, locale: "es", lastError: "bad_request" }),
    ]);

    expect(await admin.retryFailedTranslations(userId, { locale: "es" })).toMatchObject({
      ok: true,
      count: 1,
    });
    expect(await db.translationJob.findFirstOrThrow({ where: { entityId: id } })).toMatchObject({
      status: "PENDING",
      attempts: 0,
    });
    expect(await db.auditLog.count({ where: { action: "translations.retry" } })).toBe(1);
  });
});

describe("the cron runner (ADR-162 #3/#6, ADR-163 #7)", () => {
  it("two concurrent drains never translate the same job", async () => {
    await resetLocale(true);
    await db.translationJob.deleteMany();
    await db.translateUsage.deleteMany();
    const ids: string[] = [];
    for (let i = 0; i < 8; i += 1) ids.push(await newPublishedArticle(`Concurrent ${i}`));
    await db.translationJob.deleteMany();
    await db.articleTranslation.deleteMany({ where: { locale: "es", articleId: { in: ids } } });
    await translate.enqueueTranslationJobs(
      ids.map((entityId) => ({ entityType: "article", entityId, locale: "es" })),
    );

    const [a, b] = await Promise.all([
      runner.drainTranslationQueue(),
      runner.drainTranslationQueue(),
    ]);
    expect(a.done + b.done).toBe(ids.length);

    // Each article is one text request and one HTML request: a job run twice
    // would show up as four.
    const usage = await db.translateUsage.groupBy({
      by: ["entityId"],
      where: { entityId: { in: ids }, status: "OK" },
      _count: { _all: true },
    });
    expect(usage).toHaveLength(ids.length);
    expect(usage.every((u) => u._count._all === 2)).toBe(true);
  });

  it("the budget pauses the drain instead of failing a job", async () => {
    await resetLocale(true);
    await db.translationJob.deleteMany();
    const id = await newPublishedArticle("Over budget");
    await db.translationJob.deleteMany();
    const provider = await db.translateProvider.findFirstOrThrow();
    await db.translateProvider.update({
      where: { id: provider.id },
      data: { monthlyCharBudget: 1 },
    });
    try {
      await translate.enqueueTranslationJobs([
        { entityType: "article", entityId: id, locale: "es" },
      ]);
      const drained = await runner.drainTranslationQueue();
      expect(drained).toMatchObject({ paused: 1, failed: 0, stoppedBy: "paused" });
      const job = await db.translationJob.findFirstOrThrow({ where: { entityId: id } });
      expect(job).toMatchObject({ status: "PENDING", attempts: 0, lastError: "budget_exceeded" });
    } finally {
      await db.translateProvider.update({
        where: { id: provider.id },
        data: { monthlyCharBudget: null },
      });
    }
  });

  it("stops at the time budget", async () => {
    await resetLocale(true);
    await db.translationJob.deleteMany();
    const ids = [await newPublishedArticle("Tick one"), await newPublishedArticle("Tick two")];
    await db.translationJob.deleteMany();
    await translate.enqueueTranslationJobs(
      ids.map((entityId) => ({ entityType: "article", entityId, locale: "es" })),
    );
    let t = 0;
    const drained = await runner.drainTranslationQueue({ budgetMs: 1, now: () => (t += 10) });
    expect(drained).toMatchObject({ batches: 1, stoppedBy: "time" });
  });
});
