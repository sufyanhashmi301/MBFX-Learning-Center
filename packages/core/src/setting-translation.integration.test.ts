// ADR-165 on a real MariaDB with Google faked (MSW): a key is translated after
// an English save and read back merged over the English; a `legal` key is
// translated like any other, by a save and by a backfill (ADR-190); a person's
// save is TRANSLATED and flagged only when the WORDS move on; a result that
// lost `{year}` is held for review; and a missing disclaimer no longer keeps a
// language from being switched on.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  startTranslationTestDb,
  useFakeGoogle,
  type TranslationTestContext,
} from "./test-utils/translation-container.ts";
import type * as SiteTextModule from "./site-text.ts";
import type * as RunnerModule from "./translation-runner.ts";
import type * as AdminModule from "./translation-admin.ts";
import type * as SettingTranslationModule from "./setting-translation.ts";
import type * as SettingsModule from "@repo/settings";

let ctx: TranslationTestContext;
let siteText: typeof SiteTextModule;
let runner: typeof RunnerModule;
let admin: typeof AdminModule;
let settingType: typeof SettingTranslationModule;
let settings: typeof SettingsModule;

const DISCLAIMER = "Trading CFDs involves a high level of risk. Registration 2023-00532.";
const COPYRIGHT = "© {year} MBFX Global Limited. All rights reserved.";

async function setEnglish(key: string, value: unknown) {
  await ctx.db.setting.update({ where: { key }, data: { value: value as never } });
}

async function rowOf(key: string, locale: string) {
  const setting = await ctx.db.setting.findUniqueOrThrow({ where: { key } });
  return ctx.db.settingTranslation.findUnique({
    where: { settingId_locale: { settingId: setting.id, locale } },
  });
}

/** An English save as the admin action makes it: sweep, enqueue, drain. */
async function saveEnglish(key: string, value: unknown) {
  await setEnglish(key, value);
  const ids = await siteText.afterSettingsSaved([key]);
  for (const id of ids) await runner.runTranslationWork({ entity: { type: "setting", id } });
}

beforeAll(async () => {
  ctx = await startTranslationTestDb("mbfx_setting_translation", []);
  siteText = await import("./site-text.ts");
  runner = await import("./translation-runner.ts");
  admin = await import("./translation-admin.ts");
  settingType = await import("./setting-translation.ts");
  settings = await import("@repo/settings");

  const rows: Array<[string, string, unknown, string]> = [
    ["general", "site.description", "Free forex education.", "TEXT"],
    ["legal", "legal.riskDisclaimer", DISCLAIMER, "TEXT"],
    ["legal", "legal.copyrightNotice", COPYRIGHT, "STRING"],
    ["layout", "header.cta", { enabled: true, label: "Get Started", url: "/sign-up" }, "JSON"],
    ["layout", "header.announcementBar", { enabled: false, text: "", dismissible: true }, "JSON"],
    ["layout", "header.topBar", { enabled: false, phone: "", promoText: "", promoUrl: "" }, "JSON"],
  ];
  for (const [groupName, key, value, type] of rows) {
    await ctx.db.setting.create({
      data: {
        groupName,
        key,
        value: value as never,
        type: type as never,
        label: key,
        isPublic: true,
        isTranslatable: true,
      },
    });
  }
  await ctx.db.locale.create({
    data: {
      code: "ar",
      name: "Arabic",
      nativeName: "العربية",
      direction: "RTL",
      isActive: false,
      sortOrder: 3,
      fallbackCode: "en",
    },
  });
}, 180_000);

afterAll(async () => {
  await ctx?.stop();
});

beforeEach(() => {
  useFakeGoogle(ctx.server);
});

describe("a machine key", () => {
  it("is translated after an English save, and read back over the English", async () => {
    const google = useFakeGoogle(ctx.server);
    await saveEnglish("header.cta", { enabled: true, label: "Open an account", url: "/sign-up" });

    const es = await rowOf("header.cta", "es");
    expect(es).toMatchObject({ translationStatus: "MACHINE_TRANSLATED" });
    // Only the words were stored — and only the words were sent.
    expect(es?.value).toEqual({ label: "[es] Open an account" });
    expect(google.calls.flatMap((c) => c.body.q)).toEqual(["Open an account"]);

    expect(await settings.loadLocalizedSetting("header.cta", "es")).toEqual({
      enabled: true,
      label: "[es] Open an account",
      url: "/sign-up",
    });
  });

  it("an empty value is not sent at all", async () => {
    const google = useFakeGoogle(ctx.server);
    await saveEnglish("header.announcementBar", { enabled: false, text: "", dismissible: true });
    expect(google.calls).toHaveLength(0);
    expect(await rowOf("header.announcementBar", "es")).toBeNull();
  });

  it("a result that lost {year} is written NEEDS_REVIEW (ADR-165 #8)", async () => {
    useFakeGoogle(ctx.server, {
      translate: (segment, target) => `[${target}] ${segment.replace("{year}", "")}`,
    });
    await saveEnglish("site.description", "Teaching traders since {year}.");
    expect(await rowOf("site.description", "es")).toMatchObject({
      translationStatus: "NEEDS_REVIEW",
    });
  });
});

describe("a person's translation", () => {
  it("is TRANSLATED, survives the job, and is flagged only when the WORDS move on", async () => {
    await saveEnglish("header.cta", { enabled: true, label: "Get Started", url: "/sign-up" });
    const saved = await siteText.saveSettingTranslation(ctx.editor.id, {
      locale: "es",
      key: "header.cta",
      fields: { label: "Empieza ya" },
    });
    expect(saved).toEqual({ ok: true, status: "TRANSLATED" });

    // A URL or a switch is not words: nothing is stale.
    const google = useFakeGoogle(ctx.server);
    await saveEnglish("header.cta", { enabled: false, label: "Get Started", url: "/learn" });
    expect(await rowOf("header.cta", "es")).toMatchObject({ translationStatus: "TRANSLATED" });
    expect(google.calls).toHaveLength(0);

    // New words: the person's row is flagged and never overwritten.
    await saveEnglish("header.cta", { enabled: false, label: "Start learning", url: "/learn" });
    const es = await rowOf("header.cta", "es");
    expect(es).toMatchObject({ translationStatus: "OUTDATED", value: { label: "Empieza ya" } });
    expect(google.calls).toHaveLength(0);
  });

  it("refuses one that dropped {year}, and a blank save removes the row", async () => {
    await expect(
      siteText.saveSettingTranslation(ctx.editor.id, {
        locale: "es",
        key: "legal.copyrightNotice",
        fields: { value: "© MBFX Global Limited." },
      }),
    ).rejects.toThrow();

    await siteText.saveSettingTranslation(ctx.editor.id, {
      locale: "es",
      key: "legal.copyrightNotice",
      fields: { value: "© {year} MBFX Global Limited. Todos los derechos reservados." },
    });
    expect(await rowOf("legal.copyrightNotice", "es")).not.toBeNull();
    expect(
      await siteText.saveSettingTranslation(ctx.editor.id, {
        locale: "es",
        key: "legal.copyrightNotice",
        fields: { value: "" },
      }),
    ).toEqual({ ok: true, status: null });
    expect(await rowOf("legal.copyrightNotice", "es")).toBeNull();
  });

  it("writes an audit row, and refuses the default locale", async () => {
    await siteText.saveSettingTranslation(ctx.editor.id, {
      locale: "es",
      key: "site.description",
      // The English carries {year} since the NEEDS_REVIEW test above.
      fields: { value: "Enseñando a operar desde {year}." },
    });
    expect(
      await ctx.db.auditLog.count({
        where: { action: "settings.translate", entityId: "site.description:es" },
      }),
    ).toBe(1);
    expect(
      await siteText.saveSettingTranslation(ctx.editor.id, {
        locale: "en",
        key: "site.description",
        fields: { value: "x" },
      }),
    ).toEqual({ ok: false, reason: "isDefault" });
  });
});

describe("the legal group is machine-translated (ADR-190)", () => {
  it("is translated after an English save, like every other key", async () => {
    const google = useFakeGoogle(ctx.server);
    await saveEnglish("legal.riskDisclaimer", DISCLAIMER);
    expect(google.calls.flatMap((c) => c.body.q)).toContain(DISCLAIMER);
    expect(await rowOf("legal.riskDisclaimer", "es")).toMatchObject({
      translationStatus: "MACHINE_TRANSLATED",
      value: { value: `[es] ${DISCLAIMER}` },
    });
  });

  it("but a person's disclaimer is flagged when the English changes, never overwritten", async () => {
    await siteText.saveSettingTranslation(ctx.editor.id, {
      locale: "es",
      key: "legal.riskDisclaimer",
      fields: { value: "Operar con CFD implica un alto riesgo. Registro 2023-00532." },
    });
    const google = useFakeGoogle(ctx.server);
    await saveEnglish("legal.riskDisclaimer", `${DISCLAIMER} Updated.`);
    expect(await rowOf("legal.riskDisclaimer", "es")).toMatchObject({
      translationStatus: "OUTDATED",
      value: { value: "Operar con CFD implica un alto riesgo. Registro 2023-00532." },
    });
    expect(google.calls).toHaveLength(0);
  });
});

describe("switching a language on (ADR-190)", () => {
  const completeCatalog = { catalogGaps: async () => [] as string[] };

  it("is not refused for legal text no person wrote, and its backfill translates it", async () => {
    expect(await rowOf("legal.riskDisclaimer", "ar")).toBeNull();
    expect(
      await admin.setLocaleActive(ctx.editor.id, { locale: "ar", active: true }, completeCatalog),
    ).toEqual({ ok: true, backfillQueued: true });

    const google = useFakeGoogle(ctx.server);
    await runner.drainTranslationQueue();
    const sent = google.calls.flatMap((c) => c.body.q);
    expect(sent).toContain(COPYRIGHT);
    expect(await rowOf("legal.riskDisclaimer", "ar")).toMatchObject({
      translationStatus: "MACHINE_TRANSLATED",
    });
    expect(await rowOf("legal.copyrightNotice", "ar")).toMatchObject({
      translationStatus: "MACHINE_TRANSLATED",
      value: { value: `[ar] ${COPYRIGHT}` },
    });
    await admin.setLocaleActive(ctx.editor.id, { locale: "ar", active: false });
  });
});

describe("the dashboard", () => {
  it("counts every key with words, and lists machine rows for review", async () => {
    const coverage = await settingType.settingTranslatable.coverage("es", "en");
    // cta, description, disclaimer, copyright have words; the two bars do not.
    expect(coverage.total).toBe(4);

    const review = await settingType.settingTranslatable.review({
      locale: "es",
      defaultLocale: "en",
      take: 50,
    });
    expect(review.map((r) => r.title)).toContain("legal.riskDisclaimer");
    expect(review.every((r) => r.entityType === "setting")).toBe(true);
  });

  it("estimates every key with words a backfill would send, legal ones included", async () => {
    // A language with no rows yet, so nothing is skipped as already translated.
    const estimate = await settingType.settingTranslatable.estimate(["fr"], "en");
    const keys = [
      "header.cta",
      "site.description",
      "legal.riskDisclaimer",
      "legal.copyrightNotice",
    ];
    const rows = await ctx.db.setting.findMany({ where: { key: { in: keys } } });
    const words = rows.reduce((sum, row) => {
      const value = row.value as string | { label: string };
      return sum + (typeof value === "string" ? value : value.label).length;
    }, 0);
    expect(estimate.get("fr")).toBe(words);
  });
});
