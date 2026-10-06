# ADR-189 — Sync translates a whole language in the background, before it is live

- **Status:** Accepted
- **Date:** 2026-10-06
- **Module:** 06 (i18n), 09 (admin settings)
- **Amends:** ADR-163 #4 (a job for an inactive locale finishes without
  translating) and #5 (Sync is for a live language only); ADR-178 #5
  ("Translate missing" fills 200 interface strings a press, in the request).
  ADR-162's queue mechanics, ADR-163's go-live gate and ADR-165's
  human-only `legal` group are unchanged.

## Context

The owner switched on automatic translation (DeepL) and added Hindi, Urdu
and Chinese (ADR-188). To make one of them live they had to:

1. press "Translate missing automatically" on Interface text about eight
   times (1,448 public strings, 200 a press, each press holding the request
   open while the provider answered);
2. switch the language on, which is REFUSED until step 1 is complete
   (ADR-163 #2);
3. only then get its content (articles, courses, glossary, menus, settings
   …) translated, because Sync refused an inactive language and the runner
   skipped every job for one.

So content could not be prepared before go-live, the static half could not be
done in one action, and nothing showed how far either had got. The owner
asked for one Sync that translates every interface string AND every piece of
content in the background, with its progress shown.

## Decision

1. **Sync works for any language that is not the default**, live or not.
   "Sync all languages" covers every non-default language row. Preparing a
   language before it goes live is the point: the go-live gate (ADR-163 #2)
   still refuses until the interface text and the human-only site text are
   complete, so a Sync never makes a language public by itself.
2. **Sync queues two kinds of work per language**: the existing
   `BACKFILL_LOCALE` walk over every `TRANSLATABLE_TYPES` entry (content and
   the non-`legal` translatable settings), and ONE interface-text job — an
   `ITEM` job with `entityType = "catalog"` and `entityId = locale`. No new
   enum member and no migration: the queue already dispatches by
   `entityType`, and an ITEM's `requeue` outcome is exactly "more to do".
3. **The interface-text job translates `INTERFACE_TEXT_FILL_LIMIT` (200)
   missing strings per pass and requeues itself** until no machine-translatable
   string is missing. It writes only keys with no row (`skipDuplicates`), so a
   person's text is never replaced — the rule ADR-178 #5 set for the press. A
   pass that translated nothing while strings remain throws, so the queue's
   backoff and FAILED state apply instead of an endless requeue. Strings the
   ICU pipeline cannot take are left for a person, as before.
   "Translate missing automatically" on Interface text now queues this job
   instead of translating inside the request.
4. **Work runs for any non-default language that still has a row.** The
   runner's locale check (ADR-163 #4) becomes "is a translation target":
   a non-default language that exists. Switching a language OFF deletes its
   PENDING jobs instead, which keeps ADR-163 #4's promise — switching off
   stops spending — without skipping work a person explicitly asked for.
   A save still enqueues for LIVE languages only (ADR-161 is unchanged), so
   an off language is only ever worked on because someone pressed Sync; and
   switching it on backfills again, which catches up anything saved since.
5. **The work starts at once.** The action drains the queue in `after()` for
   the cron's own budget (`CRON_DRAIN_BUDGET_MS`) instead of one tick; the
   5-minute cron continues it. Two runners share the queue safely (ADR-162 #3).
6. **Progress is a read, polled only while there is work.**
   `GET /keystone/api/translate/progress` (`translations.view`) returns per
   language: interface strings done/total, content items done/total, queued,
   failed and a pause reason (budget or quota). The Overview and Interface
   text tabs draw it as progress bars that poll every 3 seconds while work is
   queued and STOP when it is not, so an idle tab sends nothing and does not
   slide ADR-105's idle timeout. When a language finishes, the page refreshes
   once so its tables agree with the bars.
7. **Sync refuses when no provider is configured** (`providerUnavailable`),
   rather than queueing jobs that would all fail `not_configured`.

## Consequences

- An admin can prepare Hindi in one press, watch it, then fill the legal site
  text by hand and switch it on.
- Sync on an off language spends money on pages nobody can read yet. That is
  now an explicit choice behind `translations.approve` and a confirmation that
  says so; nothing does it automatically.
- `overview.refusals.inactiveLocale` / `noActiveLocale` become
  `unknownLocale` / `noLocale`.
- The 200-per-press confirmation text on Interface text is replaced; the
  constant survives as the job's batch size.
