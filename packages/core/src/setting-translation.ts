// Machine translation of settings (ADR-165 #7).
//
// A setting runs the engine's own job handler — the protocol is not copied —
// with two differences the engine lets a type declare: its English is a
// `settings` row, so that row is what the write locks; and a result that lost
// a `{token}` is written NEEDS_REVIEW. The walk, the counts, the estimate and
// the review rows are written here by hand, as articles' are, because the
// engine derives them from an English row IN the translation table and a
// setting has none.
//
// Every registry key with words is walked and translated, the `legal` group
// included since ADR-190 ended ADR-165 #6's human-only rule.
import { TranslationStatus, db } from "@repo/db";
import {
  TRANSLATABLE_SETTINGS,
  missingSettingTokens,
  type TranslatableSetting,
} from "@repo/contracts";
import { invalidateSettingGroup } from "@repo/settings";

import {
  hasSettingText,
  hashSettingSource,
  loadSettingSource,
  loadSettingSources,
  type SettingSource,
} from "./setting-source.ts";
import type { ReviewRow, ReviewStatus, TranslatableType } from "./translatable-types.ts";
import { toCoverage } from "./translation-coverage.ts";
import {
  segmentCharacters,
  translationJobHandler,
  type Segment,
  type TranslatableEntity,
} from "./translation-engine.ts";
import { TRANSLATION_TABLES } from "./translation-queue.ts";

/**
 * The segments a setting sends: one plain text per field, fitted to the
 * registry's maximum so a machine result is one the editor's schema accepts.
 */
function settingSegments(source: SettingSource): Segment[] {
  const entry: TranslatableSetting = TRANSLATABLE_SETTINGS[source.key];
  return Object.entries(source.fields).map(([field, text]) => ({
    key: field,
    kind: "text" as const,
    text,
    max: entry.fields[field]?.max,
  }));
}

/** A source the machine may work on: one with some words in it. */
function machineSource(source: SettingSource | null): SettingSource | null {
  return source && hasSettingText(source) ? source : null;
}

const settingEntity: TranslatableEntity<SettingSource> = {
  entityType: "setting",
  ...TRANSLATION_TABLES.setting,
  parentTable: "settings",
  titleColumn: "label",
  updatedAtColumn: "updatedAt",
  // A job for an empty key finishes untranslated.
  loadSource: async (client, settingId) =>
    machineSource(await loadSettingSource(client, settingId)),
  hash: hashSettingSource,
  segments: settingSegments,
  async lockSource(tx, settingId) {
    await tx.$queryRawUnsafe(`SELECT id FROM settings WHERE id = ? FOR UPDATE`, settingId);
  },
  acceptResult: (segments, translated) =>
    segments.every(
      (s) =>
        s.text.trim() === "" || missingSettingTokens(s.text, translated[s.key] ?? "").length === 0,
    ),
  async write(tx, { entityId, locale, translated, status, hash }) {
    const value = { ...translated };
    await tx.settingTranslation.upsert({
      where: { settingId_locale: { settingId: entityId, locale } },
      update: { value, translationStatus: status, sourceHash: hash },
      create: { settingId: entityId, locale, value, translationStatus: status, sourceHash: hash },
    });
  },
  // The header and footer read settings under `settings:{group}`, which the
  // runner's per-batch revalidation (content, navigation) does not drop.
  afterWrite: (_settingId, source) => invalidateSettingGroup(source.group),
};

const REVIEW_STATUSES: readonly ReviewStatus[] = ["MACHINE_TRANSLATED", "OUTDATED", "NEEDS_REVIEW"];

export const settingTranslatable: TranslatableType = {
  entityType: "setting",
  handler: translationJobHandler(settingEntity),

  async page(after, take) {
    const sources = (await loadSettingSources(db))
      .filter((source) => machineSource(source) !== null)
      .map((source) => source.id)
      .filter((id) => after === null || id > after)
      .sort();
    return sources.slice(0, take);
  },

  // Every translatable key with words counts.
  async coverage(locale) {
    const sources = (await loadSettingSources(db)).filter(hasSettingText);
    const groups = await db.settingTranslation.groupBy({
      by: ["translationStatus"],
      where: { locale, settingId: { in: sources.map((s) => s.id) } },
      _count: { _all: true },
    });
    return toCoverage(
      sources.length,
      groups.map((g) => ({ status: g.translationStatus, count: g._count._all })),
    );
  },

  async estimate(locales) {
    const totals = new Map(locales.map((locale) => [locale, 0]));
    if (locales.length === 0) return totals;
    const sources = (await loadSettingSources(db)).flatMap((s) => {
      const source = machineSource(s);
      return source ? [source] : [];
    });
    const targets = await db.settingTranslation.findMany({
      where: { settingId: { in: sources.map((s) => s.id) }, locale: { in: [...locales] } },
      select: { settingId: true, locale: true, translationStatus: true, sourceHash: true },
    });
    const targetOf = new Map(targets.map((t) => [`${t.settingId}:${t.locale}`, t]));
    for (const source of sources) {
      const characters = segmentCharacters(settingSegments(source));
      const hash = hashSettingSource(source);
      for (const locale of locales) {
        const target = targetOf.get(`${source.id}:${locale}`);
        const wouldTranslate =
          !target ||
          (target.translationStatus === TranslationStatus.MACHINE_TRANSLATED &&
            target.sourceHash !== hash);
        if (wouldTranslate) totals.set(locale, (totals.get(locale) ?? 0) + characters);
      }
    }
    return totals;
  },

  async review({ locale, defaultLocale, take }): Promise<ReviewRow[]> {
    const rows = await db.settingTranslation.findMany({
      where: {
        translationStatus: { in: [...REVIEW_STATUSES] },
        locale: locale ?? { not: defaultLocale },
      },
      orderBy: { updatedAt: "desc" },
      take,
      select: {
        settingId: true,
        locale: true,
        translationStatus: true,
        updatedAt: true,
        setting: { select: { label: true } },
      },
    });
    return rows.map((row) => ({
      entityType: "setting",
      entityId: row.settingId,
      locale: row.locale,
      status: row.translationStatus as ReviewStatus,
      // Settings have a name, not a title; the admin label is English-only
      // (ADR-043 #2), so the row names the setting rather than its words.
      title: row.setting.label,
      sourceTitle: null,
      updatedAt: row.updatedAt,
    }));
  },
};
