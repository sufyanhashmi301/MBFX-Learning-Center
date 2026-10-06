# ADR-191 — Sync a language "missing only" or "reset", from every translation tab

- **Status:** Accepted
- **Date:** 2026-10-06
- **Module:** 06 (i18n), 09 (admin settings)
- **Extends:** ADR-189 (Sync translates a whole language in the background).
  ADR-161's rule that a person's translation is never overwritten is
  unchanged.

## Context

ADR-189's Sync translates what is missing, plus machine translations whose
English changed. The owner asked for two more things:

1. A way to **redo** a language — for example after switching provider from
   Google to DeepL (ADR-186), when every machine translation is up to date by
   hash but was written by the other service.
2. Sync **per language in more places**: on each Overview progress card, on
   Interface text, and on each Languages row, not only in the Overview table's
   row menu.

## Decision

1. **Sync takes a mode**, `missing` (the ADR-189 behaviour, and the default)
   or `reset` (`translationSyncSchema`, `TRANSLATION_SYNC_MODES` in
   `@repo/contracts`). Retry and the progress read keep the bare scope.
2. **Reset redoes the MACHINE's work only** (owner's choice). A person's
   translation — any status but `MACHINE_TRANSLATED` for content, any
   override with `isMachine = false` for interface text — is kept, as before.
3. **Reset re-translates in place; nothing is deleted.** Pages keep their
   current text until the new one lands.
   - Content: `markMachineTranslationsForRedo(locale)` sets `sourceHash` to
     NULL on every `MACHINE_TRANSLATED` row of every `TRANSLATION_TABLES`
     table. Every job handler skips a machine row only while its hash
     matches, so the backfill that follows re-translates each one. No new
     column: an unknown hash already means "not known to be current"
     (ADR-161 #4).
   - Interface text has no hash, so `MessageOverride` gains **`redo`**
     (migration `20261006120000_message_override_redo_adr191`).
     `markInterfaceTextForRedo(locale)` sets it on the language's machine
     strings. The fill job counts a `redo` string as still to do and rewrites
     it with one conditional `UPDATE` (`isMachine AND redo`), so a person's
     save in the meantime (which clears both flags) wins. While a reset runs,
     the Interface text bar drops and refills; the content bar does not
     (coverage counts rows), and the card's queue count shows the work.
4. **One dialog everywhere.** `SyncDialog` / `SyncButton`
   (`settings/translation/(tabs)/sync-dialog.tsx`) asks for the mode and
   confirms the spend. It is drawn on each Overview progress card, the
   Overview table's row menu, "Sync all languages", the Interface text
   progress card and each Languages row. Each is shown only to a holder of
   `translations.approve`, which the action re-checks. The audit row records
   the mode, and for a reset the number of rows marked.

## Consequences

- Switching provider and then pressing Reset re-translates a language with the
  new service and never touches the words a person wrote.
- A reset spends roughly a full backfill's characters. The dialog says so;
  the monthly budget still pauses work at the cap.
- The confirmation strings moved from `admin.translate.overview.sync*` to the
  new `admin.translate.sync` namespace.
