# ADR-190 — Legal site text is machine-translated, and no longer gates go-live

- **Status:** Accepted
- **Date:** 2026-10-06
- **Module:** 05 (settings), 06 (i18n), 09 (admin settings)
- **Supersedes:** ADR-165 #6 (the `legal` group is human-only) and #9
  (switching a language on is refused while a legal key has no translation).
  The rest of ADR-165, ADR-189 and ADR-163's catalog gate are unchanged.

## Context

ADR-165 split the six translatable settings in two: four (site description,
announcement bar, top bar, header button) were machine-translated, and the
two `legal` keys (risk disclaimer, copyright line) were never sent to the
provider. A person had to type them on Settings → Translation → Site text,
and a language could not go live until they had.

With automatic translation switched on, the owner expects ALL site text to
follow, the way content and interface text do since ADR-189. In practice the
two legal lines were the one manual step left between "Sync" and a live
language, and the owner chose to accept machine wording for them rather than
keep that step.

## Decision

1. **Every translatable setting is machine-translated.** The `machine` flag is
   removed from `TRANSLATABLE_SETTINGS` (`@repo/contracts`) rather than set to
   `true` on all six: a flag that is always true is a switch nobody can flip.
   An English save of a legal key queues it like any other key, and a language
   backfill (Sync, or switching a language on) walks it.
2. **A person's words still win.** The engine's protocol is unchanged: it
   writes only a missing or `MACHINE_TRANSLATED` row. A person's `TRANSLATED`
   row is flagged `OUTDATED` when the English moves on and is never
   overwritten; the seeded Arabic `NEEDS_REVIEW` legal rows stay as seeded.
   Site text remains editable, behind the same two keys.
3. **The `siteTextIncomplete` refusal is gone**, with `siteTextGaps` and the
   checklist's "Legal site text" item. Going live needs a complete public
   catalog (ADR-163 #2), nothing more. A legal key with no translation shows
   the English, the same fallback as every other setting.
4. **A machine-translated legal line is served and listed for review**, like
   every machine translation (Settings → Translation → Review). Settings are
   chrome (ADR-165 #5), so this changes no page's index directive.

## Consequences

- A language can be prepared and switched on with no manual translation step.
- The legal wording a reader sees in a non-English language may be a
  machine's until someone reviews it. That is the owner's accepted risk; the
  Review tab is where it is checked.
- The legal lines are now part of a backfill's character estimate.
- Existing installs: the next Sync (or English save of a legal key) translates
  any language whose legal rows are missing. Rows a person wrote are untouched.
