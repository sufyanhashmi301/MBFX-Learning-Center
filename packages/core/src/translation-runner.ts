// Running translation work (ADR-162 #7): the one function both runners call —
// `after()` for the item just saved, and the cron route for everything else,
// which also expands backfills (ADR-162 #9) and drains for a time budget
// (ADR-163 #7).
//
// It NEVER throws. Both callers run it where nobody is waiting for an answer
// (the tail of a request, a cron tick), so a failure becomes a job state and a
// log line, never an unhandled rejection.
import { revalidateTag } from "next/cache";
import { db } from "@repo/db";
import {
  runTranslationQueue,
  type BackfillSource,
  type JobHandlers,
  type RunSummary,
} from "@repo/translate";

import { INTERFACE_TEXT_JOB_TYPE, interfaceTextJobHandler } from "./interface-text.ts";
import { TRANSLATABLE_TYPES } from "./translatable-types.ts";

/**
 * Entity type → handler, from the registry, plus a language's interface text
 * (ADR-189 #2), which is queue work but not a translatable TYPE: it has no
 * table, no backfill walk and no review rows. A type with no entry is refused
 * by the queue as `internal_error`, so enqueueing an entity before its handler
 * exists fails loudly on the dashboard rather than silently.
 */
export const TRANSLATION_JOB_HANDLERS: JobHandlers = {
  ...Object.fromEntries(TRANSLATABLE_TYPES.map((type) => [type.entityType, type.handler])),
  [INTERFACE_TEXT_JOB_TYPE]: interfaceTextJobHandler,
};

async function defaultLocaleCode(): Promise<string> {
  return (
    (await db.locale.findFirst({ where: { isDefault: true }, select: { code: true } }))?.code ??
    "en"
  );
}

function backfillSources(defaultLocale: string): BackfillSource[] {
  return TRANSLATABLE_TYPES.map((type) => ({
    entityType: type.entityType,
    page: (after, take) => type.page(after, take, defaultLocale),
  }));
}

/**
 * The locales work may be done for, read once per tick: every language that
 * is not the default, live or not (ADR-189 #4). An off language only has
 * jobs because someone pressed Sync for it, and switching one off deletes its
 * pending jobs, so this no longer needs to be "is live" to stop spending. A
 * job for a deleted language (or the default) finishes without translating.
 */
async function workableLocaleCheck(): Promise<(locale: string) => Promise<boolean>> {
  const rows = await db.locale.findMany({ where: { isDefault: false }, select: { code: true } });
  const workable = new Set(rows.map((row) => row.code));
  return async (locale) => workable.has(locale);
}

export async function runTranslationWork(
  options: { entity?: { type: string; id: string }; limit?: number; backfill?: boolean } = {},
): Promise<RunSummary | null> {
  try {
    const [isLocaleActive, defaultLocale] = await Promise.all([
      workableLocaleCheck(),
      options.backfill ? defaultLocaleCode() : Promise.resolve(null),
    ]);
    return await runTranslationQueue({
      handlers: TRANSLATION_JOB_HANDLERS,
      limit: options.limit,
      entity: options.entity,
      backfill: defaultLocale ? backfillSources(defaultLocale) : undefined,
      isLocaleActive,
      // One revalidation per batch that wrote something (ADR-162 #8). Menu
      // labels are cached under `navigation`, not `content` (architecture.md
      // #12), so a batch drops both.
      afterBatch: () => {
        revalidateTag("content", { expire: 0 });
        revalidateTag("navigation", { expire: 0 });
      },
    });
  } catch (error) {
    console.error("[translate] queue run failed:", (error as Error).message);
    return null;
  }
}

/** How long one cron call keeps draining (ADR-163 #7): inside the 300 s timeouts. */
export const CRON_DRAIN_BUDGET_MS = 240_000;

export interface DrainSummary extends RunSummary {
  batches: number;
  /** Why the drain stopped. */
  stoppedBy: "empty" | "paused" | "time" | "error";
}

/**
 * The cron runner: batch after batch until nothing is due, a batch pauses
 * (budget or quota — every later job would pause too), or the time budget is
 * spent. Each batch is ADR-162 #3's atomic claim, so two overlapping cron
 * calls share the queue without sharing a job.
 */
export async function drainTranslationQueue(
  options: { budgetMs?: number; now?: () => number } = {},
): Promise<DrainSummary> {
  const clock = options.now ?? Date.now;
  const deadline = clock() + (options.budgetMs ?? CRON_DRAIN_BUDGET_MS);
  const total: DrainSummary = {
    claimed: 0,
    done: 0,
    skipped: 0,
    backfillEnqueued: 0,
    backfillClaimed: 0,
    requeued: 0,
    retrying: 0,
    paused: 0,
    failed: 0,
    batches: 0,
    stoppedBy: "empty",
  };

  for (;;) {
    const summary = await runTranslationWork({ backfill: true });
    if (!summary) {
      total.stoppedBy = "error";
      break;
    }
    total.batches += 1;
    for (const key of [
      "claimed",
      "done",
      "skipped",
      "backfillEnqueued",
      "backfillClaimed",
      "requeued",
      "retrying",
      "paused",
      "failed",
    ] as const) {
      total[key] += summary[key];
    }
    if (summary.paused > 0) {
      total.stoppedBy = "paused";
      break;
    }
    // A backfill that walked only empty types enqueued nothing and is not
    // finished: it is still work, so the drain goes round again.
    if (summary.claimed === 0 && summary.backfillEnqueued === 0 && summary.backfillClaimed === 0) {
      total.stoppedBy = "empty";
      break;
    }
    if (clock() >= deadline) {
      total.stoppedBy = "time";
      break;
    }
  }
  return total;
}

/**
 * The inline runner for a quiz save: the quiz row and each question are
 * separate translatable entities, and a quiz is offered in a language only
 * once EVERY question has a row there — so draining just the quiz would leave
 * it invisible until the cron came round.
 */
export async function runQuizTranslationWork(quizId: string): Promise<void> {
  await runTranslationWork({ entity: { type: "quiz", id: quizId } });
  const questions = await db.quizQuestion.findMany({ where: { quizId }, select: { id: true } });
  for (const question of questions) {
    await runTranslationWork({ entity: { type: "quiz_question", id: question.id } });
  }
}
