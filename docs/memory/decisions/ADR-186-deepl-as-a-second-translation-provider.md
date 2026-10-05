# ADR-186 — DeepL is a second translation provider, chosen in the admin

- **Status:** Accepted
- **Date:** 2026-10-05
- **Module:** 06 (i18n), 09 (admin settings)
- **Amends:** ADR-160 #1, #4 and #10 (Google is no longer the only driver).
  Everything else in ADR-160 stands: one door, one reader of the sealed key,
  metering in the door, a fixed endpoint, the budget, the number check, the
  glossary substitution, and `translations.provider.manage` as the gate.

## Context

The owner asked to translate with the DeepL API instead of Google Cloud
Translation. ADR-160 named Google as the one driver. Everything above the
driver is provider-neutral, which is what makes a second one cheap:

- `translateSegments` takes strings and returns strings.
- The ICU and glossary protection sends what must not be translated as
  `<span translate="no">`. DeepL's HTML handling (`tag_handling=html`) skips
  an element carrying `translate="no"`, just as Google's does.
- The job queue, the budget, the review statuses and plural rebuilding never
  see the vendor.

DeepL's supported-language list (checked 2026-10-05) covers all 28 codes in
`SUPPORTED_LOCALES`, so the case for keeping Google as a fallback for missing
languages does not arise.

## Decision

1. **One provider at a time, chosen on the Provider tab.**
   `TranslateProvider.kind` (`GOOGLE | DEEPL`, default `GOOGLE`, so an
   existing install is unchanged). The row stays a singleton and
   `apiKeyCipher` keeps its one reader. The stored key belongs to the
   provider the row names. **Changing the provider needs a new key typed in
   the same save**, and clears the last test result. A Google key is never
   sent to DeepL, the rule ADR-120 set for AI keys of another kind.
2. **DeepL's endpoint is fixed in code too.** There are two hosts:
   `api.deepl.com` for paid keys and `api-free.deepl.com` for free keys. The
   key itself chooses between them (DeepL's free keys end in `:fx`). There is
   still no base URL setting, so ADR-160 #5's blast-radius argument holds
   unchanged: the harm is spend, under the same super_admin-only key. The
   key travels in the `Authorization: DeepL-Auth-Key …` header, never in the
   URL.
3. **Each driver states its own limits.** DeepL takes at most 50 texts per
   request and a 128 KiB body, against Google's 128 segments. `planBatches`
   reads the driver's limits rather than a package constant. The 30,000
   character piece size suits both.
4. **Codes are mapped in the driver.** Our codes stay plain ISO 639-1
   (`routing.ts`). DeepL wants upper case, and a regional variant for three
   targets: `en` → `EN-US`, `pt` → `PT-BR` (the larger audience), `zh` →
   `ZH-HANS` (our `zh` is Simplified). A source is the bare upper-case code.
5. **One error taxonomy.** DeepL's statuses map onto the existing reasons:
   403 → `auth_failed`, 456 → `quota_exceeded` (pauses, ADR-162 #6),
   429/529 → `rate_limited`, other 5xx → `provider_error`, 400/413 →
   `bad_request`. No new reason, and DeepL's own message never leaves the
   driver.
6. **Usage rows say which provider billed them.** `TranslateUsage.provider`
   is nullable: null for a refusal made before any provider was loaded. The
   migration backfills every existing call (OK or FAILED) to `GOOGLE`, which
   is what they were, and leaves past refusals null. The cost is still frozen at write time from the row's price. The
   form suggests each provider's list price when the provider changes ($20
   per million for Google Basic, $25 for DeepL API Pro). The admin still
   owns the figure.
7. **The admin copy stops saying "Google".** Strings about the pipeline
   (reasons, the review queue, the go-live checklist, interface-text fill)
   become provider-neutral. Strings that name the active service (the
   editors' "Translate from … with {provider}" and the Provider tab's own
   key label, hint and price hint) take the provider's name.
   `getAutoTranslateProvider()` returns the active kind (or null).
   `isAutoTranslateAvailable()` stays as the boolean over it.

## Consequences

- One migration: an enum, a column on `translate_provider`, a nullable
  column on `translate_usage` backfilled to `GOOGLE`.
- `@repo/translate/testing` gains `fakeDeepl` beside `fakeGoogleTranslate`.
  The suites that fake Google keep working, because the default kind is
  Google.
- `pnpm translate:catalog` goes through the door, so it uses whichever
  provider is chosen.

## Alternatives rejected

- **Both keys at once, with Google as a per-language fallback.** It is not
  needed while DeepL covers every supported code. It would also add a second
  sealed column and a routing rule to test. If a later language needs it,
  that is its own ADR.
- **DeepL's glossary resource.** ADR-160 #9's substitution already fixes a
  term to its human translation, for either provider.
- **`tag_handling_version: v2`.** DeepL's default (v1) is what the
  placeholder round-trip was tested against. Changing it is a measured
  change, not a default to flip blind.
