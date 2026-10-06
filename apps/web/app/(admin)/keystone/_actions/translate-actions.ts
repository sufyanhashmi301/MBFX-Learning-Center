"use server";

// Settings → Translation (ADR-160, ADR-163). The provider's service is
// `@repo/translate`'s, the domain package that owns the provider row — the
// same split as `captcha-actions.ts` calling `@repo/auth`; the languages,
// Sync and Retry services are `@repo/core`'s.
import { after } from "next/server";
import {
  createLocale,
  deleteLocale,
  fillInterfaceText,
  prefillTranslation,
  resetInterfaceText,
  saveInterfaceText,
  updateLocale,
  type InterfaceTextFillResult,
  type InterfaceTextSaveResult,
  type LocaleDeleteResult,
  type LocaleSaveResult,
  drainTranslationQueue,
  retryFailedTranslations,
  runTranslationWork,
  saveSettingTranslation,
  setLocaleActive,
  syncTranslations,
  type LocaleActivationResult,
  type PrefillResult,
  type SaveSettingTranslationResult,
  type TranslationScopeResult,
} from "@repo/core";
import {
  interfaceTextFillSchema,
  interfaceTextResetSchema,
  interfaceTextSaveSchema,
  localeActivationSchema,
  localeDeleteSchema,
  localeSaveSchema,
  settingTranslationSaveSchema,
  translationScopeSchema,
  translationSyncSchema,
  translatePrefillSchema,
  translateSettingsSaveSchema,
  translateTestSchema,
  type TranslateReason,
} from "@repo/contracts";
import { can, requireAnyPermission, requirePermission } from "@repo/rbac";
import {
  reasonOf,
  saveTranslateSettings,
  testTranslateConnection,
  type TranslateSettingsResult,
} from "@repo/translate";

/**
 * The key an editor needs to SAVE each entity type — and so the key its
 * prefill needs. A prefill fills a form; it must not be a way for someone who
 * cannot edit an article to spend the translation budget on it.
 */
const PREFILL_PERMISSIONS: Record<"article" | "promotion", readonly string[]> = {
  article: ["analysis.update", "news.manage"],
  promotion: ["promotions.update"],
};

/**
 * `translations.provider.manage`, super_admin only (ADR-160 #5): whoever can
 * change the key and the budget decides what the site spends.
 */
export async function saveTranslateSettingsAction(
  input: unknown,
): Promise<TranslateSettingsResult> {
  const subject = await requirePermission("translations.provider.manage");
  const parsed = translateSettingsSaveSchema.parse(input);
  return saveTranslateSettings(subject.id, parsed);
}

/** "Test connection" — a mutation, because it records the result and audits. */
export async function testTranslateConnectionAction(
  input: unknown,
): Promise<TranslateSettingsResult> {
  const subject = await requirePermission("translations.provider.manage");
  const parsed = translateTestSchema.parse(input);
  return testTranslateConnection(subject.id, parsed);
}

export type PrefillActionResult =
  ({ ok: true } & PrefillResult) | { ok: false; reason: TranslateReason };

/**
 * "Translate with Google" in an editor (plan §3). Writes nothing: the form is
 * filled and the editor's own Save stores it. A refusal comes back as a
 * reason for the editor to name, never Google's message.
 */
export async function prefillTranslationAction(input: unknown): Promise<PrefillActionResult> {
  // security.md #1: the gate comes first — any key that can prefill SOMETHING
  // — then the parse, then the key for THIS entity's type.
  const subject = await requireAnyPermission([
    ...new Set(Object.values(PREFILL_PERMISSIONS).flat()),
  ]);
  const parsed = translatePrefillSchema.parse(input);
  if (!PREFILL_PERMISSIONS[parsed.entity.type].some((key) => can(subject, key))) {
    throw new Error("Forbidden");
  }
  try {
    return { ok: true, ...(await prefillTranslation(subject.id, parsed)) };
  } catch (error) {
    return { ok: false, reason: reasonOf(error) };
  }
}

/**
 * One queue tick after the response (ADR-163 #5): the backfill starts
 * expanding and the first batch runs without waiting for the cron, which does
 * the rest. Nothing is translated before the admin gets their answer.
 */
function kickQueue(): void {
  after(() => runTranslationWork({ backfill: true }));
}

/**
 * A whole drain after the response (ADR-189 #5), for the actions whose point
 * is "translate this now": Sync, Retry and the interface-text fill. It runs
 * for the cron's own budget and stops early when the queue empties; the cron
 * picks up whatever is left. A second runner is safe, claims are atomic.
 */
function drainQueue(): void {
  after(async () => {
    await drainTranslationQueue();
  });
}

/**
 * Languages tab: switch a locale on or off (ADR-163 #2/#4). `locales.manage`;
 * the service refuses a locale that cannot be served properly and says why.
 */
export async function setLocaleActiveAction(input: unknown): Promise<LocaleActivationResult> {
  const subject = await requirePermission("locales.manage");
  const parsed = localeActivationSchema.parse(input);
  const result = await setLocaleActive(subject.id, parsed);
  if (result.ok && result.backfillQueued) kickQueue();
  return result;
}

/**
 * Sync one language, or every one that is not the default, live or not —
 * interface text and content alike (ADR-189 #1/#2) — missing only or reset
 * (ADR-191). Drawn on Overview, Interface text and Languages.
 */
export async function syncTranslationsAction(input: unknown): Promise<TranslationScopeResult> {
  const subject = await requirePermission("translations.approve");
  const parsed = translationSyncSchema.parse(input);
  const result = await syncTranslations(subject.id, parsed);
  if (result.ok) drainQueue();
  return result;
}

/** Overview: re-arm failed jobs, for one locale or all (ADR-163 #5). */
export async function retryFailedTranslationsAction(
  input: unknown,
): Promise<TranslationScopeResult> {
  const subject = await requirePermission("translations.approve");
  const parsed = translationScopeSchema.parse(input);
  const result = await retryFailedTranslations(subject.id, parsed);
  if (result.ok && result.count > 0) drainQueue();
  return result;
}

/**
 * Site text: one translatable setting's words in one language (ADR-165 #8).
 * `settings.update` first — the English it restates needs it — and then
 * `translations.update`, because it is translation work.
 */
export async function saveSettingTranslationAction(
  input: unknown,
): Promise<SaveSettingTranslationResult> {
  const subject = await requirePermission("settings.update");
  if (!can(subject, "translations.update")) throw new Error("Forbidden");
  const parsed = settingTranslationSaveSchema.parse(input);
  return saveSettingTranslation(subject.id, parsed);
}

// ─── Languages: create, edit, delete (ADR-178 #2) ─────────────────────────

/** Languages tab, Add: a registry language, switched off. `locales.manage`. */
export async function createLocaleAction(input: unknown): Promise<LocaleSaveResult> {
  const subject = await requirePermission("locales.manage");
  const parsed = localeSaveSchema.parse(input);
  return createLocale(subject.id, parsed);
}

/** Languages tab, Edit: names, flag, fallback and order. `locales.manage`. */
export async function updateLocaleAction(input: unknown): Promise<LocaleSaveResult> {
  const subject = await requirePermission("locales.manage");
  const parsed = localeSaveSchema.parse(input);
  return updateLocale(subject.id, parsed);
}

/**
 * Languages tab, Delete. `locales.manage`; the service refuses the default,
 * a live language and one with content, and says which.
 */
export async function deleteLocaleAction(input: unknown): Promise<LocaleDeleteResult> {
  const subject = await requirePermission("locales.manage");
  const parsed = localeDeleteSchema.parse(input);
  return deleteLocale(subject.id, parsed);
}

// ─── Interface text (ADR-178 #3–#5) ───────────────────────────────────────

/** Interface text, Save one string. `translations.update`. */
export async function saveInterfaceTextAction(input: unknown): Promise<InterfaceTextSaveResult> {
  const subject = await requirePermission("translations.update");
  const parsed = interfaceTextSaveSchema.parse(input);
  return saveInterfaceText(subject.id, parsed);
}

/** Interface text, Reset one string to its shipped text. `translations.update`. */
export async function resetInterfaceTextAction(input: unknown): Promise<{ ok: true }> {
  const subject = await requirePermission("translations.update");
  const parsed = interfaceTextResetSchema.parse(input);
  return resetInterfaceText(subject.id, parsed);
}

/**
 * Interface text, "Translate missing automatically". `translations.approve`,
 * the key Sync uses, because it spends the translation budget. Queues the
 * language's fill and drains in the background (ADR-189 #3).
 */
export async function fillInterfaceTextAction(input: unknown): Promise<InterfaceTextFillResult> {
  const subject = await requirePermission("translations.approve");
  const parsed = interfaceTextFillSchema.parse(input);
  const result = await fillInterfaceText(subject.id, parsed);
  if (result.ok && result.remaining > 0) drainQueue();
  return result;
}
