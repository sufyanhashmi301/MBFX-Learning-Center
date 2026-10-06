# SKILL — Module 05: @repo/settings + feature flags

plan.md Module 05 + architecture doc §3. Cache per ADR-004, tags
`settings:{group}` (frozen).

## Requirements

- Typed reader: `getPublicSettings(group)` / `getSetting(key)`, cached with
  `"use cache"` + `cacheTag`. Writes via server action guarded by
  `settings.update`, writing audit rows and revalidating the group tag.
- Zod schema per setting key in `@repo/contracts` — a value is validated
  against its declared type (no number into an image slot).
- **`isPublic` strictly enforced:** non-public settings never serialize to
  client components. Lint rule + RSC-payload leak test.
- Feature flags: `{enabled, visibility: public|authenticated|premium|admin}`;
  `isFeatureVisible(key, subject|null)`; disabled features 404 (not blank)
  via route guards; flags feed navigation building (Module 08).
- Seeded keys must cover plan A6 additions: header settings (logo variant per
  mode, CTA, sticky, announcement bar), footer settings (column layout,
  copyright with `{year}`, risk disclaimer as translatable `legal` setting),
  homepage/layout section config.
- **The newsletter toggle is four keys in `email`, not one in `layout`**
  (ADR-080 #5, changes-21 F7). `footer.newsletterEnabled` was DELETED: it
  conflated "does signup exist" with "is it in the footer", and it sat in the
  `layout` group ADR-038 paused in admin, so nobody could reach it. The
  replacement splits the two questions — the `newsletter` **flag** decides
  whether signup exists at all, and the four `newsletter.placements.*` keys
  decide where the form is drawn. Every render site reads BOTH, and
  `apps/web/app/newsletter-signup.test.ts` fails on one that reads only one or
  that still names the deleted key. A fifth placement means a source in
  `NEWSLETTER_SOURCES`, a sibling setting key and a render site, together.
- Secrets never in settings — env vars referenced by name.

## Required tests

Typed reads + defaults for missing keys; write → read-after-invalidate
consistency; **isPublic leak test** (server-render harness asserts admin-only
keys absent from public RSC payload); flag matrix truth table
(enabled × visibility × subject); audit row on every write. 80% floor.

## DoD

- [x] `@repo/contracts`: Zod schema per setting key (`SETTINGS_SCHEMAS`) +
      `SETTING_GROUPS` map (`packages/contracts/src/settings.ts`).
- [x] `@repo/settings`: typed reader (`loadSetting`/`getSetting`,
      `loadPublicSettings`/`getPublicSettings`), writer (`updateSetting`),
      feature-flag reader + evaluator (`loadFeatureFlag`/`getFeatureFlag`,
      `evaluateVisibility`/`isFlagVisible`/`isFeatureVisible`).
- [x] `isPublic` enforced structurally: `loadPublicSettings` scopes
      `isPublic: true` in the Prisma query itself, not a post-hoc filter —
      proved by the leak test in `settings.integration.test.ts`. A
      file-glob lint rule is deferred: no `app/(public)` page exists yet to
      target (Module 12), matching architecture.md #5's own admin/public
      import-boundary deferral for the same reason. Revisit when Module 12
      lands.
- [x] 80% coverage floor met (`packages/settings/vitest.config.ts` — 100%
      stmts/funcs/lines, 85.7% branches).
- [x] ADR-012: `PREMIUM` visibility defaults to staff-only until an
      entitlement model exists.
- [ ] Server Action wiring (`requirePermission("settings.update")` →
      `updateSetting()` → `recordAudit()`) — the package exposes each piece
      (`@repo/settings`, `@repo/rbac`, `@repo/core`) and
      `settings.integration.test.ts` proves the composition works
      end-to-end, but the actual Next.js Server Action lands with the admin
      settings screen (Module 09).

## Registry

Reader/writer live in `packages/settings/src/index.ts`. Schema + group map
live in `packages/contracts/src/settings.ts` (`SETTINGS_SCHEMAS`,
`SETTING_GROUPS`) — 23 keys across four groups (`general`, `seo`, `layout`,
`legal`), matching `packages/db/prisma/seed.ts`'s `SETTINGS` array exactly.
Adding a setting means updating three places by hand: the seed row, the Zod
schema, and the group map — `SETTING_GROUPS` registry-completeness test in
`packages/settings/src/index.test.ts` fails loudly if the schema and group
map drift apart from each other (it does not check the seed file itself).

Feature flags: `packages/db/prisma/schema.prisma`'s `FeatureFlag` model,
seeded via `FEATURE_FLAGS` in `seed.ts` (16 keys). No typed registry the way
settings has one — a flag's `key` is just a string; `isFeatureVisible(key,
subject)` returns `false` for an unseeded key rather than throwing, since
it's called from render paths (navigation, page guards) where a typo
should silently hide a feature, not 500 the page.

Cache tags: `settings:{group}` (architecture.md #12, frozen) for settings;
`feature-flags` (not in the original frozen list — minted here, single tag
for all flags since there's no per-group flag read path yet) for flags.

## `SettingType.DOCUMENT` (changes-33, ADR-110)

A ninth type, and today it holds the three legal documents. Its value is a
site-relative PATH: `/legal/terms.pdf` on a seeded install,
`/uploads/<key>` once an admin uploads a replacement. External URLs are
refused by `legalDocumentValueSchema`, which carries `internalPathSchema`'s
negative lookahead — `//evil.example` passes every naive `startsWith("/")`.

**Not a widened `IMAGE`.** The two render different controls and accept
different bytes: an image field's whole affordance is the PREVIEW, and a
thumbnail of page one of a forty-page agreement tells an admin nothing.
`DocumentPickerField` shows the filename and a way to open it.

**It has no upload of its own.** The `MediaPickerDialog` it opens already
uploads; a second path would be a second set of size limits, a second error
surface and a second place for the category to be wrong.

`legal.companyRegistration` and `legal.registeredAddress` landed beside them
as their own keys rather than as sentences inside `legal.riskDisclaimer`: the
footer prints them as separate lines, a translator handles an address
differently from a paragraph of risk prose, and both may legitimately be
empty — in which case neither line renders.

## `site.faviconUrl` is gone (changes-36)

Seeded in Module 05, typed in `@repo/contracts`, grouped under General,
rendered as an IMAGE field — and **read by nothing**. The favicon has been a
`BrandAsset` since ADR-017: Theme → Logos & Favicons writes it,
`faviconIcons()` reads it in both root layouts. An admin could upload a file
there, press Save, see it succeed, and change no page on the site.

code-style.md #28, the same rule ADR-090 wrote for `seo.robotsIndex`. Deleted
from the seed, the schema, the group map, and from existing databases —
unconditionally, which is safe in the way overwriting a VALUE is not: the key
is gone from the registry, so nothing can read it either way.

`20260916150000_settings_cleanup_changes36` also moves `footer.menuColumns` to
its five-column value, bounded to a row still holding the previous seeded
three (ADR-108's migration is the template).

## Translatable settings (ADR-165)

`Setting.isTranslatable` was seeded false and read by nothing from Module 01
to 2026-09-28. Six keys now carry words a reader sees in their language:
`site.description`, `legal.riskDisclaimer`, `legal.copyrightNotice`, and the
text fields of `header.announcementBar` / `header.topBar` / `header.cta`.

- **The registry is code.** `TRANSLATABLE_SETTINGS` (`@repo/contracts`) names
  each key, WHICH FIELDS are words (`value` for a whole-string key), each
  field's maximum, and whether the machine may translate it. The column is
  written from it (seed + migration) and read by nothing; `@repo/db` keeps a
  copy of the key list for the seed, held equal by `src/index.test.ts` here.
- **`SettingTranslation` holds only words**, always as an object of fields.
  A URL, a switch or a phone number is never there — the reader ignores one
  if a row carries it — so a translation cannot repoint the header button.
- **Read with `getLocalizedSetting(key, locale)`**, typed to registry keys,
  cached under the key's existing `settings:{group}` tag. Blank, missing or
  malformed ⇒ the English. `apps/web/app/translatable-settings.test.ts` fails
  on a public `getSetting("<registry key>")`, and on a registry key nothing
  renders through the localized reader (code-style.md #28).
- **Every key is machine-translated, `legal` included (ADR-190, superseding
  ADR-165 #6/#9).** There is no `machine` flag and no go-live gate on site
  text. A person corrects any of them at Settings → Translation → Site text,
  behind `settings.update` AND `translations.update`, and the machine never
  overwrites a person's row.
- **Excluded on purpose**: `site.name` (brand), `site.tagline` (read by
  nothing — delete it or wire it before translating it), `seo.titleTemplate`,
  the two legal identity lines (ADR-110), the `email` group.
- Adding a key: a registry entry, the `@repo/db` list entry the test demands,
  its public call site moved to `getLocalizedSetting`, a field label under
  `admin.translate.siteText.fields` if the field name is new.

## `site.reviewsUrl` is gone (changes-53, ADR-169)

The reviews band's one Trustpilot link became a table, `review_platforms`, one
row per `REVIEW_PLATFORM_KEYS` entry (switch, order, public identifier,
optional https override). It is edited at Settings → General → **Reviews**, a
keyless tab with its own form and action (the reCAPTCHA precedent), under
`settings.update`, cached under the old key's `settings:general` tag.
`20260929150000_review_platforms_changes53_adr169` carried a non-empty value
into the Trustpilot row's custom link (switched on) and deleted the setting
row; the key is gone from the schema, the group map, the seed and
`seed-live/defaults.json`. Not a setting because each platform has four
values, and a JSON blob in one setting would have had no per-field
validation or error paths.
