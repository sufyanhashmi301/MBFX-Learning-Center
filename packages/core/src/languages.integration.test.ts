// ADR-178 on a real MariaDB, with Google faked at the network edge (MSW):
// languages are created from the registry, edited, and deleted only when
// nothing written in them would be lost; interface text is saved, reset and
// machine-filled as overrides, and the activation gate counts them.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { MariaDbContainer, type StartedMariaDbContainer } from "@testcontainers/mariadb";
import type { db as DbClient } from "@repo/db";
import { generateSecretKey } from "@repo/secrets";
import { fakeGoogleTranslate } from "@repo/translate/testing";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type * as LanguagesModule from "./languages.ts";
import type * as InterfaceTextModule from "./interface-text.ts";
import type * as AdminModule from "./translation-admin.ts";
import type * as RunnerModule from "./translation-runner.ts";
import type * as I18nModule from "@repo/i18n";
import type * as TranslateModule from "@repo/translate";

const dbPackageRoot = fileURLToPath(new URL("../../db", import.meta.url));
const prismaCli = createRequire(import.meta.url).resolve("prisma/build/index.js");
const KEY = "AIza-test";

let container: StartedMariaDbContainer;
let db: typeof DbClient;
let languages: typeof LanguagesModule;
let text: typeof InterfaceTextModule;
let admin: typeof AdminModule;
let runner: typeof RunnerModule;
let i18n: typeof I18nModule;
let translate: typeof TranslateModule;
let userId: string;
const server = setupServer();

const hindi = {
  code: "hi",
  name: "Hindi",
  nativeName: "हिन्दी",
  flagEmoji: "",
  fallbackCode: "en",
  sortOrder: 5,
};

beforeAll(async () => {
  container = await new MariaDbContainer("mariadb:11.4")
    .withDatabase("mbfx_languages")
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
  languages = await import("./languages.ts");
  text = await import("./interface-text.ts");
  admin = await import("./translation-admin.ts");
  runner = await import("./translation-runner.ts");
  i18n = await import("@repo/i18n");
  translate = await import("@repo/translate");
  server.listen({ onUnhandledRequest: "error" });

  const user = await db.user.create({
    data: {
      id: crypto.randomUUID(),
      email: "languages-crud@x.com",
      name: "Admin",
      status: "ACTIVE",
      userType: "STAFF",
    },
  });
  userId = user.id;
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
      { code: "es", name: "Spanish", nativeName: "Español", isActive: false, sortOrder: 2 },
    ],
  });

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

afterEach(() => server.resetHandlers());

describe("language CRUD (ADR-178 #2)", () => {
  it("adds a registry language switched off, with the registry's direction", async () => {
    expect(await languages.createLocale(userId, hindi)).toEqual({ ok: true });
    const row = await db.locale.findUniqueOrThrow({ where: { code: "hi" } });
    expect(row).toMatchObject({ isActive: false, isDefault: false, direction: "LTR" });
    expect(row.flagEmoji).toBeNull();

    expect(
      await languages.createLocale(userId, {
        ...hindi,
        code: "ur",
        name: "Urdu",
        fallbackCode: null,
      }),
    ).toEqual({ ok: true });
    expect((await db.locale.findUniqueOrThrow({ where: { code: "ur" } })).direction).toBe("RTL");
  });

  it("refuses a code outside the registry, a duplicate, and a bad fallback", async () => {
    expect(await languages.createLocale(userId, { ...hindi, code: "xx" })).toEqual({
      ok: false,
      reason: "unsupported",
    });
    // ADR-188: routable but not one of the owner's five.
    expect(await languages.createLocale(userId, { ...hindi, code: "fr" })).toEqual({
      ok: false,
      reason: "unsupported",
    });
    expect(await db.locale.count({ where: { code: "fr" } })).toBe(0);
    expect(await languages.createLocale(userId, hindi)).toEqual({
      ok: false,
      reason: "exists",
    });
    expect(
      await languages.createLocale(userId, { ...hindi, code: "zh", fallbackCode: "pt" }),
    ).toEqual({ ok: false, reason: "invalidFallback" });
    expect(await languages.updateLocale(userId, { ...hindi, fallbackCode: "hi" })).toEqual({
      ok: false,
      reason: "invalidFallback",
    });
  });

  it("edits names, flag, fallback and order, and audits it", async () => {
    expect(
      await languages.updateLocale(userId, {
        ...hindi,
        nativeName: "हिंदी",
        flagEmoji: "🇮🇳",
        fallbackCode: null,
        sortOrder: 9,
      }),
    ).toEqual({ ok: true });
    expect(await db.locale.findUniqueOrThrow({ where: { code: "hi" } })).toMatchObject({
      nativeName: "हिंदी",
      flagEmoji: "🇮🇳",
      fallbackCode: null,
      sortOrder: 9,
    });
    expect(await db.auditLog.count({ where: { action: "locales.update", entityId: "hi" } })).toBe(
      1,
    );
  });

  it("refuses to delete the default, a live language, or one with content", async () => {
    expect(await languages.deleteLocale(userId, { locale: "en" })).toEqual({
      ok: false,
      reason: "isDefault",
    });
    expect(await languages.deleteLocale(userId, { locale: "pt" })).toEqual({
      ok: false,
      reason: "notFound",
    });

    await db.locale.update({ where: { code: "ur" }, data: { isActive: true } });
    expect(await languages.deleteLocale(userId, { locale: "ur" })).toEqual({
      ok: false,
      reason: "isActive",
    });
    await db.locale.update({ where: { code: "ur" }, data: { isActive: false } });

    const setting = await db.setting.findFirst({ select: { id: true } });
    const settingId =
      setting?.id ??
      (
        await db.setting.create({
          data: { key: "test.words", groupName: "general", label: "Words", value: "Hello" },
        })
      ).id;
    await db.settingTranslation.create({ data: { settingId, locale: "ur", value: "سلام" } });
    expect(await languages.deleteLocale(userId, { locale: "ur" })).toEqual({
      ok: false,
      reason: "hasContent",
      contentRows: 1,
    });
    expect((await languages.countContentByLocale()).get("ur")).toBe(1);
    expect(await db.locale.count({ where: { code: "ur" } })).toBe(1);
  });

  it("deletes a language with its overrides and clears fallbacks that pointed at it", async () => {
    await languages.createLocale(userId, {
      ...hindi,
      code: "zh",
      name: "Chinese (Simplified)",
      nativeName: "简体中文",
      fallbackCode: null,
    });
    await db.locale.update({ where: { code: "es" }, data: { fallbackCode: "zh" } });
    await db.messageOverride.create({
      data: { locale: "zh", key: "learn.difficulty.BEGINNER", value: "Anfänger" },
    });

    expect(await languages.deleteLocale(userId, { locale: "zh" })).toEqual({ ok: true });
    expect(await db.locale.count({ where: { code: "zh" } })).toBe(0);
    expect(await db.messageOverride.count({ where: { locale: "zh" } })).toBe(0);
    expect((await db.locale.findUniqueOrThrow({ where: { code: "es" } })).fallbackCode).toBeNull();
    expect(await db.auditLog.count({ where: { action: "locales.delete", entityId: "zh" } })).toBe(
      1,
    );
  });

  it("lists what can still be added, and every row as a fallback choice", async () => {
    const view = await admin.loadLanguagesView();
    expect(view.available.map((l) => l.code)).toContain("zh");
    // ADR-188: only the offered languages are ever listed to add.
    expect(view.available.map((l) => l.code)).not.toContain("fr");
    expect(view.available.every((l) => ["en", "ar", "ur", "hi", "zh"].includes(l.code))).toBe(true);
    expect(view.available.map((l) => l.code)).not.toContain("hi");
    expect(view.all.map((l) => l.code)).toEqual(expect.arrayContaining(["en", "es", "hi", "ur"]));
    expect(view.rows.find((r) => r.code === "ur")?.contentRows).toBe(1);
  });
});

describe("interface text (ADR-178 #3–#5)", () => {
  const KEY_BEGINNER = "learn.difficulty.BEGINNER";

  it("refuses an admin key, an unknown key, an unknown language and a broken message", async () => {
    const save = (locale: string, key: string, value: string) =>
      text.saveInterfaceText(userId, { locale, key, value });
    expect(await save("hi", "admin.save", "Enregistrer")).toEqual({
      ok: false,
      reason: "adminKey",
    });
    expect(await save("hi", "learn.nope.never", "x")).toEqual({
      ok: false,
      reason: "unknownKey",
    });
    expect(await save("pt", KEY_BEGINNER, "Iniciante")).toEqual({
      ok: false,
      reason: "unknownLocale",
    });
    expect(await save("hi", KEY_BEGINNER, "Débutant {")).toEqual({
      ok: false,
      reason: "invalidSyntax",
    });
    expect(await db.messageOverride.count({ where: { locale: "hi" } })).toBe(0);
  });

  it("saves, shows and resets one string, and the gate counts it", async () => {
    const before = await i18n.publicCatalogGaps("hi");
    expect(
      await text.saveInterfaceText(userId, { locale: "hi", key: KEY_BEGINNER, value: "Débutant" }),
    ).toEqual({ ok: true });
    expect((await i18n.publicCatalogGaps("hi"))!.length).toBe(before!.length - 1);
    expect(await i18n.catalogMessage("hi", KEY_BEGINNER)).toBe("Débutant");

    const view = await text.loadInterfaceText("hi", "learn");
    expect(view.namespace).toBe("learn");
    expect(view.rows.find((r) => r.key === KEY_BEGINNER)).toEqual({
      key: KEY_BEGINNER,
      english: "Beginner",
      value: "Débutant",
      state: "edited",
    });
    expect(view.rows.every((r) => r.key.startsWith("learn."))).toBe(true);
    expect(view.namespaces.some((n) => n.name === "admin" || n.name === "cms")).toBe(false);

    await text.resetInterfaceText(userId, { locale: "hi", key: KEY_BEGINNER });
    expect(await i18n.catalogMessage("hi", KEY_BEGINNER)).toBe("Beginner");
  });

  it("an English edit equal to the shipped text stores nothing", async () => {
    await text.saveInterfaceText(userId, { locale: "en", key: KEY_BEGINNER, value: "Starter" });
    expect(await i18n.catalogMessage("en", KEY_BEGINNER)).toBe("Starter");
    await text.saveInterfaceText(userId, { locale: "en", key: KEY_BEGINNER, value: "Beginner" });
    expect(await db.messageOverride.count({ where: { locale: "en" } })).toBe(0);
  });

  it("queues the fill and the queue finishes it, for an off language, keeping a person's text", async () => {
    await text.saveInterfaceText(userId, {
      locale: "hi",
      key: KEY_BEGINNER,
      value: "Débutant",
    });
    expect((await db.locale.findUniqueOrThrow({ where: { code: "hi" } })).isActive).toBe(false);
    const google = fakeGoogleTranslate({ validKey: KEY });
    server.use(google.handler);

    // ADR-189 #3: the press translates nothing, it queues one job.
    const queued = await text.fillInterfaceText(userId, { locale: "hi" });
    if (!queued.ok) throw new Error(queued.reason);
    expect(queued.remaining).toBeGreaterThan(text.INTERFACE_TEXT_FILL_LIMIT);
    expect(google.calls).toHaveLength(0);
    expect(
      await db.translationJob.findMany({
        where: { entityType: text.INTERFACE_TEXT_JOB_TYPE },
        select: { entityId: true, locale: true, status: true },
      }),
    ).toEqual([{ entityId: "hi", locale: "hi", status: "PENDING" }]);

    // One drain requeues the job pass after pass until nothing is missing.
    await runner.drainTranslationQueue();
    const counts = await text.countInterfaceText("hi");
    expect(counts.missing).toBe(counts.manual);
    expect(
      await db.translationJob.findFirstOrThrow({
        where: { entityType: text.INTERFACE_TEXT_JOB_TYPE },
      }),
    ).toMatchObject({ status: "DONE" });
    expect(await db.messageOverride.count({ where: { locale: "hi", isMachine: true } })).toBe(
      queued.remaining,
    );
    expect(await i18n.catalogMessage("hi", KEY_BEGINNER)).toBe("Débutant");

    // Nothing left: a second press queues nothing.
    const again = await text.fillInterfaceText(userId, { locale: "hi" });
    expect(again).toEqual({ ok: true, remaining: 0, manual: counts.manual });

    expect(await text.fillInterfaceText(userId, { locale: "en" })).toEqual({
      ok: false,
      reason: "isDefault",
    });
  });

  it("a reset Sync re-translates the machine's strings in place and keeps a person's (ADR-191)", async () => {
    await db.translationJob.deleteMany();
    const machine = await db.messageOverride.findFirstOrThrow({
      where: { locale: "hi", isMachine: true },
    });
    await db.messageOverride.update({ where: { id: machine.id }, data: { value: "stale" } });
    const google = fakeGoogleTranslate({ validKey: KEY });
    server.use(google.handler);

    expect(await admin.syncTranslations(userId, { locale: "hi", mode: "reset" })).toEqual({
      ok: true,
      locales: ["hi"],
      count: 1,
    });
    // Marked, not deleted: the old text is served until the new one lands.
    expect(await db.messageOverride.findUniqueOrThrow({ where: { id: machine.id } })).toMatchObject(
      { value: "stale", redo: true },
    );
    const before = await text.countInterfaceText("hi");
    expect(before.missing).toBeGreaterThan(before.manual);

    await runner.drainTranslationQueue();
    const after = await db.messageOverride.findUniqueOrThrow({ where: { id: machine.id } });
    expect(after).toMatchObject({ isMachine: true, redo: false });
    expect(after.value).not.toBe("stale");
    expect(await db.messageOverride.count({ where: { locale: "hi", redo: true } })).toBe(0);
    expect(await i18n.catalogMessage("hi", KEY_BEGINNER)).toBe("Débutant");
    expect(
      await db.auditLog.findFirst({
        where: { action: "translations.sync", entityId: "hi" },
        orderBy: { createdAt: "desc" },
      }),
    ).toMatchObject({ changes: { after: { mode: "reset" } } });
    await db.translationJob.deleteMany();
  });

  it("Sync queues interface text and content for an off language; switching off cancels", async () => {
    await db.translationJob.deleteMany();
    expect(await admin.syncTranslations(userId, { locale: "zz", mode: "missing" })).toEqual({
      ok: false,
      reason: "unknownLocale",
    });
    expect(await admin.syncTranslations(userId, { locale: "es", mode: "missing" })).toEqual({
      ok: true,
      locales: ["es"],
      count: 1,
    });
    const jobs = await db.translationJob.findMany({
      where: { locale: "es" },
      select: { kind: true, entityType: true },
      orderBy: { kind: "asc" },
    });
    expect(jobs).toEqual([
      { kind: "ITEM", entityType: text.INTERFACE_TEXT_JOB_TYPE },
      { kind: "BACKFILL_LOCALE", entityType: translate.BACKFILL_WILDCARD },
    ]);

    const [progress] = await admin.loadTranslationProgress({ locale: "es" });
    expect(progress).toMatchObject({ code: "es", isActive: false, queued: 2, failed: 0 });
    expect(progress!.interfaceText.total).toBeGreaterThan(0);

    // ADR-189 #4: off stops spending by deleting the queued work.
    await admin.setLocaleActive(userId, { locale: "es", active: false });
    expect(await db.translationJob.count({ where: { locale: "es" } })).toBe(0);
  });
});
