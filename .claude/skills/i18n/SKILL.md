# SKILL — Module 06: @repo/i18n

plan.md Module 06 + architecture doc §4. next-intl v4; ADR-007 (English
launch locale) written here when routing lands.

## Two problems, two solutions

- **Interface strings:** file-based catalogs in
  `packages/i18n/messages/{locale}.json`, type-safe keys generated from the
  English catalog (missing key = TS error).
- **Content:** DB translation tables (Module 01 schema) with per-locale
  slugs and `translationStatus` lifecycle.
- **Machine translation provider (ADR-160, ADR-186):** Google Cloud
  Translation Basic or DeepL, one at a time, chosen at Settings → Translation
  → Provider. Everything above the driver (`google.ts` / `deepl.ts` in
  `@repo/translate`) is provider-neutral: protected spans travel as
  `translate="no"`, which both honour in HTML mode. A new locale code must map
  to a DeepL target (`deeplTargetCode`, guarded by `deepl.test.ts`).

## Routing (single app, ADR-006)

`defineRouting` with `localePrefix: "as-needed"` (default locale unprefixed).
Wired through `apps/web/proxy.ts` — the matcher must NEVER locale-prefix
`/admin` or `/api`. Public routes live at `app/(public)/[locale]/`. Active
locale list is DB-seeded: enabling a locale is instant but dynamic until the
next build (named trade-off, keep it documented).

## Fallback chain (frozen)

requested locale → per-locale `fallbackCode` → default. **Arabic rule:** ar
falls back to a "not yet translated" notice, NOT to LTR English inside an RTL
layout — per-locale config, not a special case in code.

## Content lifecycle

`sourceHash` computed on source save; dependent translations flip OUTDATED on
source change; admin gets a queue. Message key convention:
`domain.component.purpose` (e.g. `theme.primary.label`).

## Required tests

Routing units (default unprefixed, `/ar/...` prefixed, unknown → 404, /admin
untouched); fallback resolution table incl. ar-no-fallback; sourceHash
lifecycle (edit EN → ES flips OUTDATED → retranslate → TRANSLATED); catalog
completeness (non-default missing keys = CI warning; default missing a used
key = CI error); RTL smoke suite (Part C) wired here. 80% floor.

## Translatable settings (ADR-165)

Settings are a translatable type like any other (`setting`, first in
`TRANSLATABLE_TYPES`), but their English lives in `settings.value`, not in a
row of their own translation table. So the type runs the engine's job
handler (`translationJobHandler`, with `lockSource` locking the `settings`
row and `acceptResult` holding back a result that lost a `{token}`) and
writes its walk, counts, estimate and review rows by hand, as articles do.
`afterWrite` drops the key's `settings:{group}` tag after the transaction
commits — the runner's per-batch revalidation covers `content` and
`navigation` only. The `legal` group is never machine-translated, and
activation refuses a language whose legal keys a person has not written.
Full rules: the settings skill, "Translatable settings".

## Arabic is enforced (ADR-166)

`ar` is in `ENFORCED_LOCALES` since 2026-09-28: a public key added to
`en.json` without its Arabic fails `check:catalog-completeness`. Write the
Arabic in the same PR. A plural needs all six Arabic categories (`zero one
two few many other`); keep every `{argument}` and tag the English has; keep
figures as ICU arguments, never digits typed into prose; keep brand and
product names in Latin script. A count that reads "{done} of {total}
lessons" is phrased neutrally ("الدروس: {done} من {total}"), because the
Arabic noun's form depends on the number.

## Phase 6: serving a second language (2026-09-29)

- **Every content type resolves through `pickTranslation`**, tools included
  since ADR-168. An untranslated tool keeps its calculator (its labels are
  catalog strings), takes its name from `tools.names.<key>` and is `noindex`.
  Never print a registry key as a title; `tools-fallback.test.ts` guards it.
- **A coded page that exists in every served locale declares hreflang** through
  `staticPageAlternates(locale, path)` (`app/_lib/seo.ts`); a listing's first
  page does too via `listingMetadata`. A content page uses `alternatesFor` over
  indexable translations only. `seo-metadata.test.ts` lists the static routes.
- **The E2E database serves Arabic** (`e2e-fixtures.ts` → `activateArabic`), so
  `e2e/public/rtl-smoke.spec.ts` (dir, lang, no sideways scroll at desktop and
  phone widths, axe) and every RTL case in the other public specs actually run.

## Languages are admin-managed; interface text has overrides (ADR-178)

- **`SUPPORTED_LOCALES` (`@repo/i18n/routing`) is the routable set** — 28
  languages; `routing.locales` and `LOCALE_DIRECTION` derive from it. The
  admin adds a `Locale` row from it at Settings → Translation → Languages
  (create / edit / delete, `locales.manage`); a code outside it is a code
  change. Delete is refused for the default, a live language, or one with
  any row in `LANGUAGE_CONTENT_TABLES` (`@repo/core` `languages.ts`;
  `languages.test.ts` fails when a new `*Translation` model is missing).
- **A catalog is FILE + `MessageOverride` rows.** Read it only through
  `loadMergedCatalog` / `getCatalog` (`catalog.ts`, tag `messages`): the
  request config, `publicCatalogGaps` and `catalogMessage` all do, so the
  page, the activation gate and emails agree. A language with no file
  (`CATALOG_FILES`) is all overrides. Never `import()` a catalog by a
  string-built path.
- **Interface text** (Settings → Translation → Interface text,
  `translations.update`) edits public keys only; a value must keep the
  English message's `{arguments}` and `<tags>` (`checkMessageShape`).
  "Translate missing with Google" (`translations.approve`) fills 200 keys a
  press through `translateCatalogMessages` and never overwrites a person's
  row.
- **Admin pickers read `getAuthoringLocales()`**, never `routing.locales`
  (which is now 28 codes).
- **The proxy only lets browser-language detection land on a SERVED
  language** (`intlServed` + `GET /api/locales`); otherwise `/` answers in
  the default language.

## Sync prepares a whole language in the background (ADR-189)

- **Sync covers interface text AND content**, for any non-default language,
  live or not: a `BACKFILL_LOCALE` walk plus one ITEM job with
  `entityType = "catalog"` (`INTERFACE_TEXT_JOB_TYPE`) that fills 200
  strings a pass and requeues itself. "Translate missing automatically"
  queues the same job; nothing translates inside a request.
- **The runner works for every non-default language row**; switching one off
  deletes its PENDING jobs (`cancelPendingLocaleJobs`). Saves still enqueue
  for live languages only.
- **Progress** is `loadTranslationProgress` behind
  `GET /keystone/api/translate/progress`, drawn by `TranslationProgressPanel`,
  which polls only while work is queued.
