# ADR-188 — The admin offers five languages: en, ar, ur, hi, zh

- **Status:** Accepted
- **Date:** 2026-10-05
- **Module:** 06 (i18n), 09 (admin settings)
- **Amends:** ADR-178 #1 (an admin can add any of the 28 `SUPPORTED_LOCALES`).
  ADR-178's routing role for the registry, and everything else in it, stands.

## Context

The owner decided the site's languages are English, Arabic, Urdu, Hindi and
Chinese (Simplified), and that every other language should be hidden.

`SUPPORTED_LOCALES` has two jobs:

- **The static routing superset.** next-intl recognises `/es` as a locale
  prefix, so an inactive locale answers a clean 404 rather than falling
  through `[...slug]` (ADR-091).
- **The list an admin may add from** (ADR-178 #1).

Only the second job is what the owner sees. Cutting the registry itself
would also cut routing and break about forty test files that use `es` as
their second language, for no change a reader could see: an inactive locale
is already absent from the public site.

## Decision

1. **`OFFERED_LOCALE_CODES`** (`@repo/i18n/routing`) is `en, ar, ur, hi, zh`,
   each a `SUPPORTED_LOCALES` code (`routing.test.ts`).
2. **Settings → Translation → Languages → Add** lists only offered codes that
   have no row yet. `createLocale` refuses any other code as `unsupported`.
   The form is UX; the service is the gate.
3. **The seed** creates `ur`, `ar`, `hi` and `zh` rows, switched off. It no
   longer creates `es`, so a deleted Spanish row stays deleted across
   deploys (the seed runs on every deploy, ADR-183).
4. **Existing rows outside the set are not deleted by code.** A language row
   can hold people's translations. The Languages tab's Delete, with its
   guards (not default, not live, no content), removes them. Until then, an
   existing row still lists, honestly, and still cannot go live without a
   complete catalog.
5. **Going live is unchanged** (ADR-163). Urdu, Hindi and Chinese each need
   all public interface text (Interface text, by hand or "Translate missing
   automatically") and the legal site text, then the Live switch.

## Consequences

- `routing.locales` still lists 28 codes, so `/es` and `/fr` answer 404.
- Offering a sixth language is a one-line change to `OFFERED_LOCALE_CODES`.
