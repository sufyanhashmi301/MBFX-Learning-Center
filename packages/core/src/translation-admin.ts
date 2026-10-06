// Settings → Translation's dashboard, Languages and Review tabs (ADR-163).
//
// The callers have already run `requirePermission()` for their key and parsed
// the input with the `@repo/contracts` schema; these are the services behind
// them. Every mutation here writes ONE audit row (security.md #5, plan §5:
// "one row per sync, not per job"), and none of them translates inside the
// request — the queue does the work (ADR-162 #7).
import { db } from "@repo/db";
import { invalidateActiveLocales, publicCatalogGaps } from "@repo/i18n";
import { isOfferedLocale, SUPPORTED_LOCALES } from "@repo/i18n/routing";
import {
  cancelPendingLocaleJobs,
  countJobs,
  enqueueLocaleBackfill,
  isAutoTranslateAvailable,
  loadPausedLocales,
  listFailedJobs,
  loadBackfillStates,
  loadTranslateSettings,
  retryFailedJobs,
  type FailedJob,
  type JobStatusName,
  type PeriodUsage,
} from "@repo/translate";
import type {
  LocaleActivationInput,
  TranslationScopeInput,
  TranslationSyncInput,
} from "@repo/contracts";

import { recordAudit } from "./index.ts";
import {
  countInterfaceText,
  enqueueInterfaceTextFill,
  markInterfaceTextForRedo,
} from "./interface-text.ts";
import { countContentByLocale } from "./languages.ts";
import { TRANSLATABLE_TYPES, type ReviewRow } from "./translatable-types.ts";
import { addCoverage, emptyCoverage, type CoverageCounts } from "./translation-coverage.ts";
import { markMachineTranslationsForRedo } from "./translation-queue.ts";

async function defaultLocaleCode(): Promise<string> {
  return (
    (await db.locale.findFirst({ where: { isDefault: true }, select: { code: true } }))?.code ??
    "en"
  );
}

/** Non-default locale rows in display order. */
async function targetLocaleRows() {
  return db.locale.findMany({
    where: { isDefault: false },
    orderBy: { sortOrder: "asc" },
    select: {
      code: true,
      name: true,
      nativeName: true,
      isActive: true,
      direction: true,
      flagEmoji: true,
      fallbackCode: true,
      sortOrder: true,
    },
  });
}

// ─── Overview ─────────────────────────────────────────────────────────────

export interface JobTotals {
  pending: number;
  running: number;
  failed: number;
  done: number;
}

export interface LocaleOverview {
  code: string;
  name: string;
  nativeName: string;
  isActive: boolean;
  coverage: CoverageCounts;
  types: Array<{ entityType: string; coverage: CoverageCounts }>;
  /** ITEM jobs only: the backfill's progress is read from these (ADR-162 #9). */
  jobs: JobTotals;
  backfill: {
    status: JobStatusName;
    currentType: string | null;
    lastError: string | null;
    updatedAt: string;
  } | null;
}

export interface FailedJobView {
  id: string;
  kind: FailedJob["kind"];
  entityType: string;
  entityId: string;
  locale: string;
  lastError: string | null;
  attempts: number;
  updatedAt: string;
}

export interface TranslationOverview {
  defaultLocale: string;
  enabled: boolean;
  usage: PeriodUsage;
  monthlyCharBudget: number | null;
  pricePerMillionChars: number;
  locales: LocaleOverview[];
  failed: FailedJobView[];
}

export async function loadTranslationOverview(): Promise<TranslationOverview> {
  const defaultLocale = await defaultLocaleCode();
  const [locales, settings, jobCounts, backfills, failed] = await Promise.all([
    targetLocaleRows(),
    loadTranslateSettings(),
    countJobs(),
    loadBackfillStates(),
    listFailedJobs({ take: 25 }),
  ]);

  const overview: LocaleOverview[] = [];
  for (const locale of locales) {
    const types = await Promise.all(
      TRANSLATABLE_TYPES.map(async (type) => ({
        entityType: type.entityType,
        coverage: await type.coverage(locale.code, defaultLocale),
      })),
    );
    const coverage = emptyCoverage();
    for (const type of types) addCoverage(coverage, type.coverage);

    const jobs: JobTotals = { pending: 0, running: 0, failed: 0, done: 0 };
    for (const row of jobCounts) {
      if (row.locale !== locale.code || row.kind !== "ITEM") continue;
      jobs[row.status.toLowerCase() as keyof JobTotals] += row.count;
    }
    const backfill = backfills.find((b) => b.locale === locale.code);

    overview.push({
      code: locale.code,
      name: locale.name,
      nativeName: locale.nativeName,
      isActive: locale.isActive,
      coverage,
      types,
      jobs,
      backfill: backfill
        ? {
            status: backfill.status,
            currentType: backfill.currentType,
            lastError: backfill.lastError,
            updatedAt: backfill.updatedAt.toISOString(),
          }
        : null,
    });
  }

  return {
    defaultLocale,
    enabled: settings.enabled,
    usage: settings.usage,
    monthlyCharBudget: settings.monthlyCharBudget,
    pricePerMillionChars: settings.pricePerMillionChars,
    locales: overview,
    failed: failed.map((job) => ({ ...job, updatedAt: job.updatedAt.toISOString() })),
  };
}

// ─── Review queue ─────────────────────────────────────────────────────────

export interface ReviewRowView extends Omit<ReviewRow, "updatedAt"> {
  updatedAt: string | null;
}

/** Machine, stale and flagged translations across every type, newest first. */
export async function loadTranslationReviewQueue(
  options: { locale?: string; take?: number } = {},
): Promise<ReviewRowView[]> {
  const defaultLocale = await defaultLocaleCode();
  const take = Math.min(options.take ?? 100, 500);
  const rows = (
    await Promise.all(
      TRANSLATABLE_TYPES.map((type) =>
        type.review({ locale: options.locale, defaultLocale, take }),
      ),
    )
  ).flat();
  return rows
    .sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0))
    .slice(0, take)
    .map((row) => ({ ...row, updatedAt: row.updatedAt?.toISOString() ?? null }));
}

// ─── Languages ────────────────────────────────────────────────────────────

/** Why a locale cannot be switched on (ADR-163 #2). */
export type LocaleActivationRefusal = "notFound" | "isDefault" | "unroutable" | "catalogIncomplete";

export interface LanguageRow {
  code: string;
  name: string;
  nativeName: string;
  direction: "LTR" | "RTL";
  isActive: boolean;
  flagEmoji: string | null;
  fallbackCode: string | null;
  sortOrder: number;
  /** Content translations written in this language; above zero, it cannot be deleted. */
  contentRows: number;
  /** Public catalog keys missing, or null when next-intl cannot route the code. */
  catalogGaps: number | null;
  /** Why activation would be refused, or null when it may go ahead. */
  refusal: LocaleActivationRefusal | null;
  /** What a backfill would send now (ADR-163 #3). Estimated. */
  estimate: { characters: number; costUsd: string };
}

export interface LanguagesView {
  defaultLocale: string;
  enabled: boolean;
  pricePerMillionChars: number;
  monthlyCharBudget: number | null;
  usage: PeriodUsage;
  /** Characters left this month, or null when there is no cap. */
  remainingCharacters: number | null;
  rows: LanguageRow[];
  /** Registry languages with no row yet: what "Add language" offers (ADR-178 #2). */
  available: Array<{ code: string; name: string; nativeName: string; direction: "LTR" | "RTL" }>;
  /** Every language row, the default included: the fallback choices. */
  all: Array<{ code: string; name: string }>;
}

/** Characters × USD per million, as a six-decimal string. Estimated (ADR-100). */
export function estimateCostUsd(characters: number, pricePerMillionChars: number): string {
  return ((characters * pricePerMillionChars) / 1_000_000).toFixed(6);
}

function refusalFor(gaps: number | null): LocaleActivationRefusal | null {
  if (gaps === null) return "unroutable";
  if (gaps > 0) return "catalogIncomplete";
  return null;
}

/** Characters a backfill would send, per locale, summed over every type. */
async function estimateBackfill(
  locales: readonly string[],
  defaultLocale: string,
): Promise<Map<string, number>> {
  const totals = new Map(locales.map((locale) => [locale, 0]));
  for (const type of TRANSLATABLE_TYPES) {
    const perType = await type.estimate(locales, defaultLocale);
    for (const [locale, characters] of perType) {
      totals.set(locale, (totals.get(locale) ?? 0) + characters);
    }
  }
  return totals;
}

export async function loadLanguagesView(): Promise<LanguagesView> {
  const defaultLocale = await defaultLocaleCode();
  const [locales, settings] = await Promise.all([targetLocaleRows(), loadTranslateSettings()]);
  const [gaps, estimates, contentRows, all] = await Promise.all([
    Promise.all(locales.map((locale) => publicCatalogGaps(locale.code))),
    estimateBackfill(
      locales.map((l) => l.code),
      defaultLocale,
    ),
    countContentByLocale(),
    db.locale.findMany({ orderBy: { sortOrder: "asc" }, select: { code: true, name: true } }),
  ]);
  const existing = new Set(all.map((row) => row.code));

  return {
    defaultLocale,
    enabled: settings.enabled,
    pricePerMillionChars: settings.pricePerMillionChars,
    monthlyCharBudget: settings.monthlyCharBudget,
    usage: settings.usage,
    remainingCharacters:
      settings.monthlyCharBudget === null
        ? null
        : Math.max(0, settings.monthlyCharBudget - settings.usage.characters),
    rows: locales.map((locale, index) => {
      const missing = gaps[index] ?? null;
      const characters = estimates.get(locale.code) ?? 0;
      return {
        code: locale.code,
        name: locale.name,
        nativeName: locale.nativeName,
        direction: locale.direction,
        isActive: locale.isActive,
        flagEmoji: locale.flagEmoji,
        fallbackCode: locale.fallbackCode,
        sortOrder: locale.sortOrder,
        contentRows: contentRows.get(locale.code) ?? 0,
        catalogGaps: missing === null ? null : missing.length,
        refusal: refusalFor(missing === null ? null : missing.length),
        estimate: {
          characters,
          costUsd: estimateCostUsd(characters, settings.pricePerMillionChars),
        },
      };
    }),
    // Only the languages the owner offers (ADR-188), minus those already added.
    available: SUPPORTED_LOCALES.filter(
      (locale) => isOfferedLocale(locale.code) && !existing.has(locale.code),
    ).map((locale) => ({
      code: locale.code,
      name: locale.name,
      nativeName: locale.nativeName,
      direction: locale.direction === "rtl" ? ("RTL" as const) : ("LTR" as const),
    })),
    all,
  };
}

export type LocaleActivationResult =
  | { ok: true; backfillQueued: boolean }
  | { ok: false; reason: LocaleActivationRefusal; missingKeys?: number };

/**
 * Switches a locale on or off (ADR-163 #2/#4). On: refused unless it can be
 * served properly, then one backfill job. Off: always allowed for a
 * non-default locale; its translations stay, and queued jobs finish as no-ops.
 */
export async function setLocaleActive(
  userId: string,
  input: LocaleActivationInput,
  // Injectable so the SUCCESS branch is testable: no non-English catalog in
  // the repo is complete yet, which is exactly what the real check reports.
  // The CI script makes its `enforced` set injectable for the mirror reason.
  deps: { catalogGaps?: (locale: string) => Promise<string[] | null> } = {},
): Promise<LocaleActivationResult> {
  const catalogGaps = deps.catalogGaps ?? publicCatalogGaps;
  const row = await db.locale.findUnique({
    where: { code: input.locale },
    select: { code: true, isActive: true, isDefault: true },
  });
  if (!row) return { ok: false, reason: "notFound" };
  if (row.isDefault) return { ok: false, reason: "isDefault" };

  if (input.active) {
    const gaps = await catalogGaps(row.code);
    const refusal = refusalFor(gaps === null ? null : gaps.length);
    if (refusal) {
      return {
        ok: false,
        reason: refusal,
        ...(gaps && gaps.length > 0 ? { missingKeys: gaps.length } : {}),
      };
    }
  }

  if (row.isActive !== input.active) {
    await db.locale.update({ where: { code: row.code }, data: { isActive: input.active } });
    await recordAudit({
      userId,
      action: input.active ? "locales.activate" : "locales.deactivate",
      entityType: "Locale",
      entityId: row.code,
      changes: { before: { isActive: row.isActive }, after: { isActive: input.active } },
    });
    await invalidateActiveLocales();
  }

  // Also on a repeat "on": the backfill is idempotent, and a locale switched
  // on by the seed or by hand has never had one. Off stops spending: the
  // runner works for any non-default language now (ADR-189 #4), so the
  // language's queued work is deleted rather than left to be skipped.
  if (input.active) await enqueueLocaleBackfill(row.code);
  else await cancelPendingLocaleJobs(row.code);
  return { ok: true, backfillQueued: input.active };
}

// ─── Sync and retry (ADR-163 #5, ADR-189) ─────────────────────────────────

export type TranslationScopeResult =
  | { ok: true; locales: string[]; count: number }
  | { ok: false; reason: "unknownLocale" | "noLocale" | "providerUnavailable" };

/**
 * The languages a scoped action applies to: one named language, or every one
 * that is not the default — live or not (ADR-189 #1). Null for a code that is
 * not a non-default language row.
 */
async function scopeLocales(input: TranslationScopeInput): Promise<string[] | null> {
  const targets = (await targetLocaleRows()).map((row) => row.code);
  if (!input.locale) return targets;
  return targets.includes(input.locale) ? [input.locale] : null;
}

/**
 * Sync (ADR-189 #1/#2): for each language in scope, re-walk every content
 * item AND queue the interface-text fill. Nothing is translated here; the
 * caller starts the queue in `after()` and the cron continues it.
 *
 * `reset` (ADR-191) first marks every machine translation and machine
 * interface string in scope for re-translation in place. A person's
 * translations are kept in both modes.
 */
export async function syncTranslations(
  userId: string,
  input: TranslationSyncInput,
): Promise<TranslationScopeResult> {
  const locales = await scopeLocales(input);
  if (!locales) return { ok: false, reason: "unknownLocale" };
  if (locales.length === 0) return { ok: false, reason: "noLocale" };
  if (!(await isAutoTranslateAvailable())) return { ok: false, reason: "providerUnavailable" };
  let redo = 0;
  for (const locale of locales) {
    if (input.mode === "reset") {
      redo += await markMachineTranslationsForRedo(locale);
      redo += await markInterfaceTextForRedo(locale);
    }
    await enqueueLocaleBackfill(locale);
    await enqueueInterfaceTextFill(locale);
  }
  await recordAudit({
    userId,
    action: "translations.sync",
    entityType: "TranslationJob",
    entityId: input.locale ?? "*",
    changes: { after: { locales, mode: input.mode, ...(input.mode === "reset" ? { redo } : {}) } },
  });
  return { ok: true, locales, count: locales.length };
}

/** Retry: re-arm FAILED jobs in the scope — any locale's, active or not. */
export async function retryFailedTranslations(
  userId: string,
  input: TranslationScopeInput,
): Promise<TranslationScopeResult> {
  const count = await retryFailedJobs(input.locale);
  await recordAudit({
    userId,
    action: "translations.retry",
    entityType: "TranslationJob",
    entityId: input.locale ?? "*",
    changes: { after: { count } },
  });
  return { ok: true, locales: input.locale ? [input.locale] : [], count };
}

// ─── Progress (ADR-189 #6) ────────────────────────────────────────────────

export interface TranslationProgress {
  code: string;
  name: string;
  isActive: boolean;
  /** Public interface strings: written in this language, of all of them. */
  interfaceText: { done: number; total: number; manual: number };
  /** Translatable content items with a translation, of all of them. */
  content: { done: number; total: number };
  /** Jobs waiting or running, interface text and backfill walk included. */
  queued: number;
  failed: number;
  /** A pausing reason (budget, quota) holding the queued work back, or null. */
  pausedBy: string | null;
}

/**
 * The progress readout for every non-default language, or one. Uncached and
 * cheap enough to poll every few seconds while work is queued: a count query
 * per translatable type, one catalog merge, one grouped job count.
 */
export async function loadTranslationProgress(
  options: { locale?: string } = {},
): Promise<TranslationProgress[]> {
  const defaultLocale = await defaultLocaleCode();
  const rows = (await targetLocaleRows()).filter(
    (row) => !options.locale || row.code === options.locale,
  );
  const [jobCounts, paused] = await Promise.all([countJobs(), loadPausedLocales()]);

  return Promise.all(
    rows.map(async (row) => {
      const [text, coverages] = await Promise.all([
        countInterfaceText(row.code),
        Promise.all(TRANSLATABLE_TYPES.map((type) => type.coverage(row.code, defaultLocale))),
      ]);
      const coverage = emptyCoverage();
      for (const entry of coverages) addCoverage(coverage, entry);

      let queued = 0;
      let failed = 0;
      for (const count of jobCounts) {
        if (count.locale !== row.code) continue;
        if (count.status === "PENDING" || count.status === "RUNNING") queued += count.count;
        if (count.status === "FAILED") failed += count.count;
      }
      return {
        code: row.code,
        name: row.name,
        isActive: row.isActive,
        interfaceText: {
          done: text.total - text.missing,
          total: text.total,
          manual: text.manual,
        },
        content: { done: coverage.total - coverage.missing, total: coverage.total },
        queued,
        failed,
        pausedBy: queued > 0 ? (paused.get(row.code) ?? null) : null,
      };
    }),
  );
}

/** The housekeeping sweep's translation half (ADR-162 #10). */
export { purgeTranslationRows } from "@repo/translate";
