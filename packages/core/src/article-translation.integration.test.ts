// Phase 3's exit, end to end on a real MariaDB with Google faked at the
// network edge (MSW): an English article is saved, the job translates it into
// Spanish, the public read path serves it `noindex`, a person's save makes it
// indexable, and an English edit refreshes a machine row but only flags a
// person's. Plus the races ADR-162 exists for.
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

import type * as ArticlesModule from "./articles.ts";
import type * as PublicArticlesModule from "./public-articles.ts";
import type * as RunnerModule from "./translation-runner.ts";
import type * as TranslateModule from "@repo/translate";

const dbPackageRoot = fileURLToPath(new URL("../../db", import.meta.url));
const prismaCli = createRequire(import.meta.url).resolve("prisma/build/index.js");
const KEY = "AIza-test";

let container: StartedMariaDbContainer;
let db: typeof DbClient;
let articles: typeof ArticlesModule;
let publicArticles: typeof PublicArticlesModule;
let runner: typeof RunnerModule;
let translate: typeof TranslateModule;
let editor: Subject;
let categoryId: string;
const server = setupServer();

beforeAll(async () => {
  container = await new MariaDbContainer("mariadb:11.4")
    .withDatabase("mbfx_article_translation")
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
  articles = await import("./articles.ts");
  publicArticles = await import("./public-articles.ts");
  runner = await import("./translation-runner.ts");
  translate = await import("@repo/translate");
  server.listen({ onUnhandledRequest: "error" });

  const user = await db.user.create({
    data: {
      id: crypto.randomUUID(),
      email: "translator@x.com",
      name: "Editor",
      status: "ACTIVE",
      userType: "STAFF",
    },
  });
  editor = {
    id: user.id,
    userType: "STAFF",
    roleKeys: [],
    maxRoleLevel: 60,
    allowed: new Set(["news.manage"]),
    denied: new Set(),
  };
  await db.locale.createMany({
    data: [
      {
        code: "en",
        name: "English",
        nativeName: "English",
        direction: "LTR",
        isDefault: true,
        isActive: true,
        sortOrder: 1,
      },
      // The test locale (plan §6 Phase 3): active in THIS database only.
      {
        code: "es",
        name: "Spanish",
        nativeName: "Español",
        direction: "LTR",
        isActive: true,
        sortOrder: 2,
        fallbackCode: "en",
      },
    ],
  });
  categoryId = await articles.createArticleCategory(editor, { name: "Market News" });

  // Switch Google on through the real settings service.
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
  server.use(fakeGoogleTranslate({ validKey: KEY }).handler);
});
afterEach(() => server.resetHandlers());

async function newPublishedArticle(title: string, body = "<p>Deposit $10 today.</p>") {
  const id = await articles.createArticle(editor, { kind: "NEWS", categoryId });
  await articles.saveArticle(editor, {
    articleId: id,
    meta: {},
    translation: {
      articleId: id,
      locale: "en",
      title,
      excerpt: "A short summary",
      body,
      keyTakeaways: ["One point", "Two points", "Three points"],
      faqItems: [{ question: "What is a pip?", answer: "<p>A small move.</p>" }],
    },
  });
  await articles.transitionArticle(editor, id, "PUBLISHED");
  return id;
}

const run = (id: string) => runner.runTranslationWork({ entity: { type: "article", id } });

const spanish = (articleId: string) =>
  db.articleTranslation.findUniqueOrThrow({
    where: { articleId_locale: { articleId, locale: "es" } },
    include: { faqItems: { orderBy: { sortOrder: "asc" } } },
  });

describe("the article loop", () => {
  it("translates a saved article into every active locale, reusing the English slug", async () => {
    const id = await newPublishedArticle("Leverage explained");
    const summary = await run(id);
    expect(summary).toMatchObject({ done: 1 });

    const es = await spanish(id);
    expect(es).toMatchObject({
      title: "[es] Leverage explained",
      slug: "leverage-explained",
      excerpt: "[es] A short summary",
      translationStatus: "MACHINE_TRANSLATED",
      translatedBy: null,
    });
    expect(es.body).toContain("[es]");
    expect(es.keyTakeaways).toEqual(["[es] One point", "[es] Two points", "[es] Three points"]);
    expect(es.faqItems.map((f) => f.question)).toEqual(["[es] What is a pip?"]);
    expect(es.sourceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("serves the machine translation noindex, and a person's save lifts it", async () => {
    const id = await newPublishedArticle("Reading candlesticks");
    await run(id);

    const machine = await publicArticles.loadArticleBySlug("es", "reading-candlesticks");
    expect(machine?.title).toBe("[es] Reading candlesticks");
    expect(machine?.noIndex).toBe(true);
    expect(machine?.alternates.map((a) => a.locale)).toEqual(["en"]);
    let sitemap = await publicArticles.loadArticleSitemapEntries();
    expect(sitemap.filter((e) => e.slug === "reading-candlesticks").map((e) => e.locale)).toEqual([
      "en",
    ]);

    await articles.saveArticleTranslation(editor, {
      articleId: id,
      locale: "es",
      title: "Leer velas japonesas",
      slug: "reading-candlesticks",
      body: "<p>Revisado por una persona. Deposit $10 today.</p>",
    });

    const human = await publicArticles.loadArticleBySlug("es", "reading-candlesticks");
    expect(human?.noIndex).toBe(false);
    expect(human?.alternates.map((a) => a.locale).sort()).toEqual(["en", "es"]);
    sitemap = await publicArticles.loadArticleSitemapEntries();
    expect(
      sitemap
        .filter((e) => e.slug === "reading-candlesticks")
        .map((e) => e.locale)
        .sort(),
    ).toEqual(["en", "es"]);
  });

  it("refreshes a machine row when the English changes, but only flags a person's", async () => {
    const machineId = await newPublishedArticle("Machine kept fresh");
    const humanId = await newPublishedArticle("Human kept safe");
    await run(machineId);
    await run(humanId);
    await articles.saveArticleTranslation(editor, {
      articleId: humanId,
      locale: "es",
      title: "Traducido por una persona",
      body: "<p>Mano humana. Deposit $10 today.</p>",
    });

    for (const id of [machineId, humanId]) {
      await articles.saveArticleTranslation(editor, {
        articleId: id,
        locale: "en",
        title: "Edited English title",
        slug: id === machineId ? "machine-kept-fresh" : "human-kept-safe",
        excerpt: "A short summary",
        body: "<p>Deposit $10 today, edited.</p>",
      });
      await run(id);
    }

    expect(await spanish(machineId)).toMatchObject({
      title: "[es] Edited English title",
      translationStatus: "MACHINE_TRANSLATED",
    });
    expect(await spanish(humanId)).toMatchObject({
      title: "Traducido por una persona",
      translationStatus: "OUTDATED",
    });
  });

  it("flags an EXCERPT edit too — the hash now covers every translatable field", async () => {
    const id = await newPublishedArticle("Excerpt matters");
    await run(id);
    await articles.saveArticleTranslation(editor, {
      articleId: id,
      locale: "es",
      title: "El extracto importa",
      body: "<p>Deposit $10 today.</p>",
    });
    await articles.quickUpdateArticle(editor, id, { title: "Excerpt matters (new title)" });
    expect((await spanish(id)).translationStatus).toBe("OUTDATED");
  });

  it("writes NEEDS_REVIEW when a figure changed in translation, and never overwrites it", async () => {
    server.resetHandlers();
    server.use(
      fakeGoogleTranslate({
        validKey: KEY,
        translate: (segment, target) => `[${target}] ${segment.replace("$10", "$100")}`,
      }).handler,
    );
    const id = await newPublishedArticle("Minimum deposit");
    await run(id);
    const es = await spanish(id);
    expect(es.translationStatus).toBe("NEEDS_REVIEW");

    // Not readable until a person looks at it.
    const view = await publicArticles.loadArticleBySlug("es", "minimum-deposit");
    expect(view?.noIndex).toBe(true);

    // A later run leaves the flagged row alone.
    await articles.quickUpdateArticle(editor, id, { title: "Minimum deposit (edited)" });
    await run(id);
    expect((await spanish(id)).title).toBe(es.title);
  });

  it("never writes over a person's translation saved while Google was working", async () => {
    const id = await newPublishedArticle("Race with a person");
    let personSave: Promise<void> | null = null;
    server.resetHandlers();
    server.use(
      fakeGoogleTranslate({
        validKey: KEY,
        // The editor saves Spanish once, while Google is still answering.
        translate: (segment, target) => {
          personSave ??= articles.saveArticleTranslation(editor, {
            articleId: id,
            locale: "es",
            title: "Escrito a mano",
            body: "<p>Deposit $10 today.</p>",
          });
          return `[${target}] ${segment}`;
        },
      }).handler,
    );
    await run(id);
    await personSave;
    expect(await spanish(id)).toMatchObject({
      title: "Escrito a mano",
      translationStatus: "TRANSLATED",
    });
  });

  it("does nothing for a single-language install", async () => {
    await db.locale.update({ where: { code: "es" }, data: { isActive: false } });
    try {
      const id = await newPublishedArticle("Only English here");
      expect(await db.translationJob.count({ where: { entityId: id } })).toBe(0);
    } finally {
      await db.locale.update({ where: { code: "es" }, data: { isActive: true } });
    }
  });

  it("does not translate a deleted article", async () => {
    const id = await newPublishedArticle("Deleted before translation");
    await articles.setArticleDeleted(editor, id, true);
    await run(id);
    expect(await db.articleTranslation.count({ where: { articleId: id, locale: "es" } })).toBe(0);
  });

  it("gives the Spanish row its own slug when the English one is taken in Spanish", async () => {
    const first = await newPublishedArticle("Taken slug");
    await run(first);
    // A person renames the first article's Spanish slug to what the second's
    // English slug will be.
    await articles.saveArticleTranslation(editor, {
      articleId: first,
      locale: "es",
      title: "Primero",
      slug: "collides-here",
      body: "<p>Deposit $10 today.</p>",
    });
    const second = await newPublishedArticle("Collides here");
    await run(second);
    expect((await spanish(second)).slug).toBe("collides-here-es");
  });

  it("leaves the job to retry when Google fails, and writes nothing", async () => {
    server.resetHandlers();
    server.use(
      fakeGoogleTranslate({ failures: { 0: { status: 400, reason: "invalid" } } }).handler,
    );
    const id = await newPublishedArticle("Google said no");
    const summary = await run(id);
    expect(summary).toMatchObject({ retrying: 1, done: 0 });
    expect(await db.articleTranslation.count({ where: { articleId: id, locale: "es" } })).toBe(0);
    const job = await db.translationJob.findFirstOrThrow({ where: { entityId: id } });
    expect(job).toMatchObject({ status: "PENDING", attempts: 1, lastError: "bad_request" });
  });
});
