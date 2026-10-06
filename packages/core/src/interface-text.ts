// Settings → Translation → Interface text (ADR-178 #3–#5): the site's fixed
// public strings, language by language, with the English beside each one.
//
// The shipped text is the catalog FILES; what an admin changes is a
// `MessageOverride` row laid over them at request time (`@repo/i18n`
// `catalog.ts`). Only PUBLIC namespaces: the admin portal is English-only by
// design (ADR-043 #2), so an admin key is refused here, not just hidden.
//
// Callers have run `requirePermission()` (`translations.update` to edit,
// `translations.approve` to machine-fill, which spends) and parsed the input
// with `@repo/contracts`. The machine fill runs on the translation queue
// (ADR-189), with `interfaceTextJobHandler` as its handler.
import { db } from "@repo/db";
import {
  ADMIN_MESSAGE_NAMESPACES,
  catalogValueAt,
  checkMessageShape,
  flattenMessageKeys,
  invalidateMessages,
  loadCatalogFile,
  loadMergedCatalog,
  loadMessageOverrides,
  type Catalog,
  type MessageShapeProblem,
} from "@repo/i18n";
import {
  enqueueTranslationJobs,
  isAutoTranslateAvailable,
  planMessage,
  translateCatalogMessages,
  translateSegments,
  TranslateError,
  type ClaimedJob,
  type JobOutcome,
} from "@repo/translate";
import type {
  InterfaceTextFillInput,
  InterfaceTextResetInput,
  InterfaceTextSaveInput,
} from "@repo/contracts";

import { recordAudit } from "./index.ts";

/** Keys one pass of the background fill translates (ADR-178 #5, ADR-189 #3). */
export const INTERFACE_TEXT_FILL_LIMIT = 200;

/**
 * - `shipped`: the catalog file's text, untouched.
 * - `edited`: a person replaced it (or wrote it, for a key the file lacks).
 * - `machine`: Google wrote it and no person has saved it since.
 * - `missing`: nothing in this language; readers see the English.
 */
export type InterfaceTextState = "shipped" | "edited" | "machine" | "missing";

export interface InterfaceTextRow {
  key: string;
  /** The English a reader of the English site sees, overrides included. */
  english: string;
  /** This language's text, or null when missing. */
  value: string | null;
  state: InterfaceTextState;
}

export interface InterfaceTextNamespace {
  name: string;
  total: number;
  missing: number;
}

export interface InterfaceTextView {
  locale: string;
  isDefault: boolean;
  namespaces: InterfaceTextNamespace[];
  /** The namespace shown; null when there is none. */
  namespace: string | null;
  rows: InterfaceTextRow[];
}

const namespaceOf = (key: string) => key.split(".")[0] ?? "";
const isPublicKey = (key: string) => !ADMIN_MESSAGE_NAMESPACES.has(namespaceOf(key));

/** Every public key in the English FILE: the set of strings the code uses. */
function publicKeys(englishFile: Catalog): string[] {
  return flattenMessageKeys(englishFile).filter(
    (key) => isPublicKey(key) && typeof catalogValueAt(englishFile, key) === "string",
  );
}

async function defaultLocaleCode(): Promise<string> {
  return (
    (await db.locale.findFirst({ where: { isDefault: true }, select: { code: true } }))?.code ??
    "en"
  );
}

/** One language's interface text, one namespace at a time (3,000+ keys in all). */
export async function loadInterfaceText(
  locale: string,
  requestedNamespace?: string,
): Promise<InterfaceTextView> {
  const defaultLocale = await defaultLocaleCode();
  const isDefault = locale === defaultLocale;
  const [englishFile, englishMerged, localeFile, overrides] = await Promise.all([
    loadCatalogFile(defaultLocale),
    loadMergedCatalog(defaultLocale),
    loadCatalogFile(locale),
    loadMessageOverrides(locale),
  ]);
  const byKey = new Map(overrides.map((row) => [row.key, row]));

  const rows: InterfaceTextRow[] = publicKeys(englishFile).map((key) => {
    const override = byKey.get(key);
    const shipped = catalogValueAt(isDefault ? englishFile : localeFile, key);
    const english = catalogValueAt(isDefault ? englishFile : englishMerged, key);
    const value = override?.value ?? (typeof shipped === "string" ? shipped : null);
    const state: InterfaceTextState = override
      ? override.isMachine
        ? "machine"
        : "edited"
      : value === null
        ? "missing"
        : "shipped";
    return { key, english: typeof english === "string" ? english : "", value, state };
  });

  const counts = new Map<string, InterfaceTextNamespace>();
  for (const row of rows) {
    const name = namespaceOf(row.key);
    const entry = counts.get(name) ?? { name, total: 0, missing: 0 };
    entry.total += 1;
    if (row.state === "missing") entry.missing += 1;
    counts.set(name, entry);
  }
  const namespaces = [...counts.values()].sort((a, b) => a.name.localeCompare(b.name));
  const namespace =
    namespaces.find((n) => n.name === requestedNamespace)?.name ??
    namespaces.find((n) => n.missing > 0)?.name ??
    namespaces[0]?.name ??
    null;

  return {
    locale,
    isDefault,
    namespaces,
    namespace,
    rows: rows.filter((row) => namespaceOf(row.key) === namespace),
  };
}

export type InterfaceTextRefusal =
  "unknownLocale" | "unknownKey" | "adminKey" | MessageShapeProblem;

export type InterfaceTextSaveResult = { ok: true } | { ok: false; reason: InterfaceTextRefusal };

/**
 * Saves a person's text for one key. A value equal to the shipped text
 * removes the override instead, so the table holds only real changes.
 */
export async function saveInterfaceText(
  userId: string,
  input: InterfaceTextSaveInput,
): Promise<InterfaceTextSaveResult> {
  if (!isPublicKey(input.key)) return { ok: false, reason: "adminKey" };
  if ((await db.locale.count({ where: { code: input.locale } })) === 0) {
    return { ok: false, reason: "unknownLocale" };
  }
  const defaultLocale = await defaultLocaleCode();
  const english = catalogValueAt(await loadCatalogFile(defaultLocale), input.key);
  if (typeof english !== "string") return { ok: false, reason: "unknownKey" };
  const problem = checkMessageShape(english, input.value);
  if (problem) return { ok: false, reason: problem };

  const where = { locale_key: { locale: input.locale, key: input.key } };
  const before = await db.messageOverride.findUnique({ where, select: { value: true } });
  const shipped = catalogValueAt(await loadCatalogFile(input.locale), input.key);

  if (shipped === input.value) {
    await db.messageOverride.deleteMany({ where: { locale: input.locale, key: input.key } });
  } else {
    await db.messageOverride.upsert({
      where,
      create: {
        locale: input.locale,
        key: input.key,
        value: input.value,
        isMachine: false,
        updatedBy: userId,
      },
      update: { value: input.value, isMachine: false, redo: false, updatedBy: userId },
    });
  }
  await recordAudit({
    userId,
    action: "messages.update",
    entityType: "MessageOverride",
    entityId: `${input.locale}:${input.key}`,
    changes: { before: before?.value ?? null, after: input.value },
  });
  await invalidateMessages();
  return { ok: true };
}

/** Removes one override: the key goes back to its shipped text, or to missing. */
export async function resetInterfaceText(
  userId: string,
  input: InterfaceTextResetInput,
): Promise<{ ok: true }> {
  const { count } = await db.messageOverride.deleteMany({
    where: { locale: input.locale, key: input.key },
  });
  if (count > 0) {
    await recordAudit({
      userId,
      action: "messages.reset",
      entityType: "MessageOverride",
      entityId: `${input.locale}:${input.key}`,
    });
    await invalidateMessages();
  }
  return { ok: true };
}

// ─── Machine fill, on the translation queue (ADR-189) ─────────────────────

/**
 * Public strings missing in a language, split by whether the machine can take
 * them. A machine string a reset marked `redo` (ADR-191) counts as missing
 * too: it is work still to do, though it keeps its text meanwhile.
 */
async function missingInterfaceText(locale: string, defaultLocale: string) {
  const [englishFile, englishMerged, target, redoRows] = await Promise.all([
    loadCatalogFile(defaultLocale),
    loadMergedCatalog(defaultLocale),
    loadMergedCatalog(locale),
    db.messageOverride.findMany({
      where: { locale, isMachine: true, redo: true },
      select: { key: true },
    }),
  ]);
  const keys = publicKeys(englishFile);
  const redo = new Set(redoRows.map((row) => row.key));
  const missing = keys.filter(
    (key) => redo.has(key) || typeof catalogValueAt(target, key) !== "string",
  );
  // A message the pipeline cannot plan fails the same way on every pass, so
  // left in the queue it would sit at the front of every batch for ever.
  const machinable = missing.filter((key) => {
    try {
      planMessage(catalogValueAt(englishMerged, key) as string);
      return true;
    } catch {
      return false;
    }
  });
  return { total: keys.length, missing, machinable, englishMerged, redo };
}

export interface InterfaceTextCounts {
  /** Public strings the site uses. */
  total: number;
  /** Of those, how many have no text in this language. */
  missing: number;
  /** Of the missing, how many only a person can write. */
  manual: number;
}

/** How much of a language's interface text exists: the progress readout (ADR-189 #6). */
export async function countInterfaceText(locale: string): Promise<InterfaceTextCounts> {
  const defaultLocale = await defaultLocaleCode();
  if (locale === defaultLocale) return { total: 0, missing: 0, manual: 0 };
  const { total, missing, machinable } = await missingInterfaceText(locale, defaultLocale);
  return { total, missing: missing.length, manual: missing.length - machinable.length };
}

interface FillPass {
  translated: number;
  failed: number;
  /** Missing keys the machine can translate, still to do after this pass. */
  remaining: number;
}

/**
 * The queue's `entityType` for a language's interface text (ADR-189 #2): one
 * ITEM job per language, `entityId` = the locale code.
 */
export const INTERFACE_TEXT_JOB_TYPE = "catalog";

/**
 * One pass: up to `INTERFACE_TEXT_FILL_LIMIT` missing public keys, through
 * the ICU-safe pipeline `pnpm translate:catalog` uses and the one metered
 * door. Writes only keys that still have no row when it commits
 * (`skipDuplicates`), and rewrites a `redo` string only while it is still
 * the machine's, so a person's text saved meanwhile is never replaced.
 * A provider refusal propagates as its `TranslateError` for the queue to settle.
 */
async function fillInterfaceTextPass(locale: string, defaultLocale: string): Promise<FillPass> {
  const { machinable, englishMerged, redo } = await missingInterfaceText(locale, defaultLocale);
  const batch = machinable.slice(0, INTERFACE_TEXT_FILL_LIMIT);
  if (batch.length === 0) return { translated: 0, failed: 0, remaining: 0 };

  const source = Object.fromEntries(
    batch.map((key) => [key, catalogValueAt(englishMerged, key) as string]),
  );
  const result = await translateCatalogMessages(source, locale, (units) =>
    translateSegments(units, "html", {
      source: defaultLocale,
      target: locale,
      userId: null,
      entity: { type: INTERFACE_TEXT_JOB_TYPE, id: locale },
    }),
  );

  const translated = Object.entries(result.translated);
  if (translated.length > 0) {
    const fresh = translated.filter(([key]) => !redo.has(key));
    if (fresh.length > 0) {
      await db.messageOverride.createMany({
        data: fresh.map(([key, value]) => ({ locale, key, value, isMachine: true })),
        skipDuplicates: true,
      });
    }
    const redone = translated.filter(([key]) => redo.has(key));
    if (redone.length > 0) {
      // One statement for the whole batch: 200 round trips inside a
      // transaction outlived Prisma's 5 s limit. The WHERE keeps the rule —
      // a row a person saved meanwhile is no longer the machine's.
      await db.$executeRawUnsafe(
        `UPDATE message_overrides
            SET value = CASE \`key\` ${redone.map(() => "WHEN ? THEN ?").join(" ")} END,
                redo = FALSE, updatedAt = NOW(3)
          WHERE locale = ? AND isMachine = TRUE AND redo = TRUE
            AND \`key\` IN (${redone.map(() => "?").join(", ")})`,
        ...redone.flat(),
        locale,
        ...redone.map(([key]) => key),
      );
    }
    await invalidateMessages();
  }
  return {
    translated: translated.length,
    failed: result.failed.length,
    remaining: machinable.length - translated.length,
  };
}

/**
 * A Sync "reset" (ADR-191): marks every machine string of a language for
 * re-translation. Nothing is deleted, so the site keeps showing them until
 * the fill job replaces each one. A person's strings are not touched.
 */
export async function markInterfaceTextForRedo(locale: string): Promise<number> {
  const { count } = await db.messageOverride.updateMany({
    where: { locale, isMachine: true },
    data: { redo: true },
  });
  return count;
}

/** Queues (or re-arms) the background fill of one language's interface text. */
export async function enqueueInterfaceTextFill(locale: string): Promise<void> {
  await enqueueTranslationJobs([{ entityType: INTERFACE_TEXT_JOB_TYPE, entityId: locale, locale }]);
}

/**
 * The job handler (ADR-189 #3): one pass, then `requeue` while the machine
 * still has strings to do. A pass that wrote nothing while strings remain
 * throws, so the queue's backoff and FAILED state apply rather than a loop
 * that spends on the same strings for ever.
 */
export async function interfaceTextJobHandler(job: ClaimedJob): Promise<JobOutcome> {
  const row = await db.locale.findUnique({
    where: { code: job.locale },
    select: { isDefault: true },
  });
  if (!row || row.isDefault) return "done";
  const pass = await fillInterfaceTextPass(job.locale, await defaultLocaleCode());
  if (pass.remaining === 0) return "done";
  if (pass.translated === 0) {
    throw new TranslateError(
      "provider_error",
      `Interface text for ${job.locale}: ${pass.failed} strings came back unusable`,
    );
  }
  return "requeue";
}

export type InterfaceTextFillResult =
  | { ok: true; remaining: number; manual: number }
  | { ok: false; reason: "unknownLocale" | "isDefault" | "providerUnavailable" };

/**
 * "Translate missing automatically" (ADR-178 #5 as amended by ADR-189 #3):
 * queues the background fill and says how much it has to do. Nothing is
 * translated inside the request; the caller starts the queue in `after()`.
 */
export async function fillInterfaceText(
  userId: string,
  input: InterfaceTextFillInput,
): Promise<InterfaceTextFillResult> {
  const row = await db.locale.findUnique({
    where: { code: input.locale },
    select: { code: true, isDefault: true },
  });
  if (!row) return { ok: false, reason: "unknownLocale" };
  if (row.isDefault) return { ok: false, reason: "isDefault" };
  if (!(await isAutoTranslateAvailable())) return { ok: false, reason: "providerUnavailable" };

  const { missing, machinable } = await missingInterfaceText(row.code, await defaultLocaleCode());
  if (machinable.length > 0) await enqueueInterfaceTextFill(row.code);
  await recordAudit({
    userId,
    action: "messages.fill",
    entityType: "Locale",
    entityId: row.code,
    changes: { after: { queued: machinable.length } },
  });
  return { ok: true, remaining: machinable.length, manual: missing.length - machinable.length };
}
