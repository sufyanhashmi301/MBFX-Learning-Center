// The translation job queue (ADR-162). Mechanics only: WHAT a job does is a
// handler the caller passes in (`@repo/core` owns the entity-specific read,
// translate and conditional write), and what happens after a batch — the
// cache revalidation — is a callback, so this package never imports Next.js.
//
// The rules, numbered as in the ADR (ADR-163 adds the locale check and the
// dashboard reads):
//
//   #1/#2 Enqueue is one INSERT … ON DUPLICATE KEY UPDATE: a DONE or FAILED
//         row is re-armed, a PENDING one is left alone, and a RUNNING one is
//         marked `rerun`. The handler's own hash check cannot catch an edit
//         saved AFTER its write committed but BEFORE the job is marked done;
//         `rerun` does, because finishing re-queues a job that carries it.
//   #3    Claim is one UPDATE … ORDER BY … LIMIT that stamps a fresh token;
//         the runner reads back only its own rows. Two runners never share.
//   #4    A RUNNING row older than the lease goes back to PENDING first.
//   #6    Three attempts with backoff, then FAILED. A quota or budget
//         refusal PAUSES (moves runAfter) and costs no attempt.
//   #9    A BACKFILL_LOCALE job expands into ITEM jobs a page at a time,
//         remembering where it is in `cursor`.
//   #10   DONE jobs go after 7 days, usage rows after 90.
import { randomUUID } from "node:crypto";
import { db } from "@repo/db";
import { PAUSING_TRANSLATE_REASONS, type TranslateReason } from "@repo/contracts";

import { isPausing, reasonOf, TranslateError } from "./errors.ts";

/** Batch size per claim (ADR-162 #3). */
export const DEFAULT_CLAIM_LIMIT = 25;
/** A RUNNING job this old is presumed dead (ADR-162 #4). */
export const LEASE_MS = 10 * 60 * 1000;
/** Attempts before a job is FAILED (ADR-162 #6). */
export const MAX_ATTEMPTS = 3;
/** Wait before the 2nd and 3rd attempt: 1 and 5 minutes (ADR-162 #6). */
export const RETRY_DELAYS_MS: readonly number[] = [60_000, 5 * 60_000];
/** How long a quota refusal pauses a job before it is tried again. */
export const QUOTA_PAUSE_MS = 30 * 60_000;

export interface JobKey {
  entityType: string;
  entityId: string;
  locale: string;
}

export interface ClaimedJob extends JobKey {
  id: string;
  attempts: number;
}

/**
 * What a handler reports. `done` — written, or nothing to write. `requeue` —
 * the source changed while it worked, so the result was discarded and the job
 * must run again against the new source. A handler signals failure by
 * throwing (a `TranslateError` for anything Google-shaped).
 */
export type JobOutcome = "done" | "requeue";

export type JobHandler = (job: ClaimedJob) => Promise<JobOutcome>;

/** Handlers by `entityType`. A job whose type has none fails as internal. */
export type JobHandlers = Readonly<Record<string, JobHandler>>;

export interface RunSummary {
  claimed: number;
  done: number;
  /** Finished without translating: the locale is no longer active (ADR-163 #4). */
  skipped: number;
  /** ITEM jobs a backfill expansion enqueued this tick. */
  backfillEnqueued: number;
  /**
   * Backfills this tick claimed and walked (0 or 1). A walk that crossed only
   * EMPTY types enqueues nothing and still has work left, so a drain must not
   * read `backfillEnqueued === 0` as "nothing to do".
   */
  backfillClaimed: number;
  requeued: number;
  retrying: number;
  paused: number;
  failed: number;
}

const emptySummary = (): RunSummary => ({
  claimed: 0,
  done: 0,
  skipped: 0,
  backfillEnqueued: 0,
  backfillClaimed: 0,
  requeued: 0,
  retrying: 0,
  paused: 0,
  failed: 0,
});

/** The first instant of the next UTC month: when a budget refusal can pass. */
export function nextBudgetPeriod(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/** Keys per INSERT statement: one round trip per chunk, not per key. */
const ENQUEUE_CHUNK = 200;

/**
 * Enqueues one ITEM job per key. Idempotent: re-saving an entity re-arms its
 * finished jobs and leaves pending or running ones as they are. Chunked into
 * multi-row INSERTs with bound parameters, because a backfill page enqueues
 * hundreds at once (ADR-162 #9).
 */
export async function enqueueTranslationJobs(keys: readonly JobKey[]): Promise<void> {
  for (let start = 0; start < keys.length; start += ENQUEUE_CHUNK) {
    const chunk = keys.slice(start, start + ENQUEUE_CHUNK);
    const rows = chunk.map(() => "(?, 'ITEM', ?, ?, ?, 'PENDING', 0, NOW(3), NOW(3), NOW(3))");
    const params = chunk.flatMap((key) => [randomUUID(), key.entityType, key.entityId, key.locale]);
    await db.$executeRawUnsafe(
      `INSERT INTO translation_jobs
         (id, kind, entityType, entityId, locale, status, attempts, runAfter, createdAt, updatedAt)
       VALUES ${rows.join(", ")}
       ON DUPLICATE KEY UPDATE
         attempts   = IF(status IN ('DONE', 'FAILED'), 0, attempts),
         runAfter   = IF(status IN ('DONE', 'FAILED'), NOW(3), runAfter),
         lastError  = IF(status IN ('DONE', 'FAILED'), NULL, lastError),
         claimToken = IF(status IN ('DONE', 'FAILED'), NULL, claimToken),
         rerun      = IF(status = 'RUNNING', TRUE, rerun),
         status     = IF(status IN ('DONE', 'FAILED'), 'PENDING', status),
         updatedAt  = NOW(3)`,
      ...params,
    );
  }
}

/** The wildcard a backfill job carries instead of NULL (ADR-162 #1). */
export const BACKFILL_WILDCARD = "*";

/**
 * Queues (or restarts) the backfill of one locale (ADR-162 #9, ADR-163 #4/#5).
 * A finished or pending backfill starts again from the first type; a running
 * one is marked `rerun`, and finishing restarts it — so pressing Sync always
 * results in a complete walk that began after the press.
 */
export async function enqueueLocaleBackfill(locale: string): Promise<void> {
  await db.$executeRaw`
    INSERT INTO translation_jobs
      (id, kind, entityType, entityId, locale, status, attempts, runAfter, createdAt, updatedAt)
    VALUES
      (${randomUUID()}, 'BACKFILL_LOCALE', ${BACKFILL_WILDCARD}, ${BACKFILL_WILDCARD}, ${locale},
       'PENDING', 0, NOW(3), NOW(3), NOW(3))
    ON DUPLICATE KEY UPDATE
      attempts   = IF(status = 'RUNNING', attempts, 0),
      runAfter   = IF(status = 'RUNNING', runAfter, NOW(3)),
      lastError  = IF(status = 'RUNNING', lastError, NULL),
      \`cursor\` = IF(status = 'RUNNING', \`cursor\`, NULL),
      rerun      = IF(status = 'RUNNING', TRUE, rerun),
      status     = IF(status = 'RUNNING', status, 'PENDING'),
      updatedAt  = NOW(3)`;
}

/**
 * Re-arms FAILED jobs — one locale's, or every locale's (ADR-163 #5). Returns
 * how many. A failure is a taxonomy reason on the dashboard until someone
 * presses this or the entity is saved again.
 */
export async function retryFailedJobs(locale?: string): Promise<number> {
  const result = await db.translationJob.updateMany({
    where: { status: "FAILED", ...(locale ? { locale } : {}) },
    data: {
      status: "PENDING",
      attempts: 0,
      lastError: null,
      claimToken: null,
      claimedAt: null,
      runAfter: new Date(),
    },
  });
  return result.count;
}

/**
 * Deletes one locale's PENDING jobs, items and backfill alike (ADR-189 #4):
 * what switching a language off does, so that it stops spending. A RUNNING
 * job finishes its own pass; nothing queues behind it.
 */
export async function cancelPendingLocaleJobs(locale: string): Promise<number> {
  const result = await db.translationJob.deleteMany({ where: { locale, status: "PENDING" } });
  return result.count;
}

/**
 * Locales whose queued work is held back by a pause (a budget or quota
 * refusal moved `runAfter` on, ADR-162 #6), with the reason. Progress
 * readouts say "paused" instead of showing a bar that has silently stopped.
 */
export async function loadPausedLocales(now: Date = new Date()): Promise<Map<string, string>> {
  const rows = await db.translationJob.findMany({
    where: {
      status: "PENDING",
      runAfter: { gt: now },
      lastError: { in: [...PAUSING_TRANSLATE_REASONS] },
    },
    select: { locale: true, lastError: true },
    distinct: ["locale"],
  });
  return new Map(rows.map((row) => [row.locale, row.lastError!]));
}

/** Returns RUNNING jobs whose lease ran out to PENDING (ADR-162 #4). */
export async function recoverStaleJobs(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - LEASE_MS);
  const result = await db.translationJob.updateMany({
    where: { status: "RUNNING", claimedAt: { lt: cutoff } },
    data: { status: "PENDING", claimToken: null, claimedAt: null },
  });
  return result.count;
}

/**
 * Claims up to `limit` due ITEM jobs, oldest first, optionally only one
 * entity's (the inline runner after a save). Atomic: one UPDATE stamps the
 * token, and only rows carrying it are returned.
 */
export async function claimJobs(
  options: { limit?: number; entity?: { type: string; id: string } } = {},
): Promise<ClaimedJob[]> {
  const token = randomUUID();
  const limit = options.limit ?? DEFAULT_CLAIM_LIMIT;
  if (options.entity) {
    await db.$executeRaw`
      UPDATE translation_jobs
         SET status = 'RUNNING', claimToken = ${token}, claimedAt = NOW(3), rerun = FALSE,
             updatedAt = NOW(3)
       WHERE status = 'PENDING' AND kind = 'ITEM' AND runAfter <= NOW(3)
         AND entityType = ${options.entity.type} AND entityId = ${options.entity.id}
       ORDER BY createdAt
       LIMIT ${limit}`;
  } else {
    await db.$executeRaw`
      UPDATE translation_jobs
         SET status = 'RUNNING', claimToken = ${token}, claimedAt = NOW(3), rerun = FALSE,
             updatedAt = NOW(3)
       WHERE status = 'PENDING' AND kind = 'ITEM' AND runAfter <= NOW(3)
       ORDER BY createdAt
       LIMIT ${limit}`;
  }
  const rows = await db.translationJob.findMany({
    where: { claimToken: token },
    select: { id: true, entityType: true, entityId: true, locale: true, attempts: true },
    orderBy: { createdAt: "asc" },
  });
  return rows;
}

async function settle(
  job: ClaimedJob,
  error: unknown,
  now: Date,
  summary: RunSummary,
): Promise<void> {
  const reason: TranslateReason =
    error instanceof TranslateError ? reasonOf(error) : "internal_error";

  if (isPausing(error)) {
    const runAfter =
      reason === "budget_exceeded"
        ? nextBudgetPeriod(now)
        : new Date(now.getTime() + QUOTA_PAUSE_MS);
    await db.translationJob.update({
      where: { id: job.id },
      data: { status: "PENDING", claimToken: null, claimedAt: null, lastError: reason, runAfter },
    });
    summary.paused += 1;
    return;
  }

  const attempts = job.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await db.translationJob.update({
      where: { id: job.id },
      data: { status: "FAILED", attempts, claimToken: null, claimedAt: null, lastError: reason },
    });
    summary.failed += 1;
    return;
  }
  const delay = RETRY_DELAYS_MS[attempts - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]!;
  await db.translationJob.update({
    where: { id: job.id },
    data: {
      status: "PENDING",
      attempts,
      claimToken: null,
      claimedAt: null,
      lastError: reason,
      runAfter: new Date(now.getTime() + delay),
    },
  });
  summary.retrying += 1;
}

/** Finishes a job: DONE, or another pass when an enqueue set `rerun` meanwhile. */
async function finish(jobId: string): Promise<void> {
  // One statement: a `rerun` set by an enqueue during this job turns DONE
  // into another pass, atomically with reading it. `cursor` is cleared so a
  // re-run backfill starts from its first type.
  await db.$executeRaw`
    UPDATE translation_jobs
       SET status = IF(rerun, 'PENDING', 'DONE'),
           runAfter = IF(rerun, NOW(3), runAfter),
           \`cursor\` = NULL, -- CURSOR is a reserved word in MariaDB
           rerun = FALSE, claimToken = NULL, claimedAt = NULL, lastError = NULL,
           updatedAt = NOW(3)
     WHERE id = ${jobId}`;
}

/**
 * Runs claimed jobs one by one and settles each. Never throws for a job. A job
 * whose locale is in `inactiveLocales` finishes WITHOUT its handler (ADR-163
 * #4): a locale switched off since the job was queued must not spend money.
 */
export async function runClaimedJobs(
  jobs: readonly ClaimedJob[],
  handlers: JobHandlers,
  now: () => Date = () => new Date(),
  inactiveLocales: ReadonlySet<string> = new Set(),
): Promise<RunSummary> {
  const summary = emptySummary();
  summary.claimed = jobs.length;

  for (const job of jobs) {
    const handler = handlers[job.entityType];
    try {
      if (inactiveLocales.has(job.locale)) {
        await finish(job.id);
        summary.skipped += 1;
        continue;
      }
      if (!handler) {
        throw new TranslateError("internal_error", `No handler for ${job.entityType}`);
      }
      const outcome = await handler(job);
      if (outcome === "requeue") {
        await db.translationJob.update({
          where: { id: job.id },
          data: { status: "PENDING", claimToken: null, claimedAt: null, runAfter: now() },
        });
        summary.requeued += 1;
      } else {
        await finish(job.id);
        summary.done += 1;
      }
    } catch (error) {
      await settle(job, error, now(), summary);
    }
  }
  return summary;
}

// ─── Backfill (ADR-162 #9) ────────────────────────────────────────────────

/**
 * One translatable type's walk: a page of entity ids strictly after `after`,
 * ascending by id. The caller (`@repo/core`) owns what counts as a source.
 */
export interface BackfillSource {
  entityType: string;
  page: (after: string | null, take: number) => Promise<string[]>;
}

/** Ids per page of a backfill walk. */
export const BACKFILL_PAGE_SIZE = 200;
/** Pages one tick expands before handing the claim back. */
export const BACKFILL_PAGES_PER_TICK = 10;

/**
 * A backfill cursor is `<entityType>|<last id>`: which type the walk is in and
 * where its next page starts. An empty id means "the start of that type".
 */
export function parseBackfillCursor(
  cursor: string | null,
  types: readonly string[],
): { typeIndex: number; after: string | null } {
  if (!cursor) return { typeIndex: 0, after: null };
  const bar = cursor.indexOf("|");
  const type = bar < 0 ? cursor : cursor.slice(0, bar);
  const after = bar < 0 ? "" : cursor.slice(bar + 1);
  const typeIndex = types.indexOf(type);
  // A type that left the registry: start over rather than skip the rest.
  if (typeIndex < 0) return { typeIndex: 0, after: null };
  return { typeIndex, after: after === "" ? null : after };
}

export interface BackfillSummary {
  /** Backfill jobs this tick worked on (0 or 1). */
  claimed: number;
  /** ITEM jobs enqueued. */
  enqueued: number;
  /** Backfills that reached the end of the last type. */
  completed: number;
}

/**
 * Expands one due backfill job by up to `pages` pages, enqueueing an ITEM job
 * per entity. Claimed atomically like an item (#3), so two ticks never walk
 * the same locale at once; the cursor is saved after every page, so a crash
 * loses at most one page's progress (and re-enqueueing is idempotent).
 */
export async function expandBackfill(options: {
  sources: readonly BackfillSource[];
  isLocaleActive?: (locale: string) => Promise<boolean>;
  pages?: number;
  pageSize?: number;
  now?: () => Date;
}): Promise<BackfillSummary> {
  const summary: BackfillSummary = { claimed: 0, enqueued: 0, completed: 0 };
  const token = randomUUID();
  await db.$executeRaw`
    UPDATE translation_jobs
       SET status = 'RUNNING', claimToken = ${token}, claimedAt = NOW(3), rerun = FALSE,
           updatedAt = NOW(3)
     WHERE status = 'PENDING' AND kind = 'BACKFILL_LOCALE' AND runAfter <= NOW(3)
     ORDER BY createdAt
     LIMIT 1`;
  const job = await db.translationJob.findFirst({
    where: { claimToken: token },
    select: {
      id: true,
      locale: true,
      cursor: true,
      attempts: true,
      entityType: true,
      entityId: true,
    },
  });
  if (!job) return summary;
  summary.claimed = 1;

  const now = options.now ?? (() => new Date());
  const pageSize = options.pageSize ?? BACKFILL_PAGE_SIZE;
  const pages = options.pages ?? BACKFILL_PAGES_PER_TICK;
  const types = options.sources.map((source) => source.entityType);

  try {
    if (options.isLocaleActive && !(await options.isLocaleActive(job.locale))) {
      await finish(job.id);
      return summary;
    }
    let { typeIndex, after } = parseBackfillCursor(job.cursor, types);
    for (let page = 0; page < pages && typeIndex < types.length; page += 1) {
      const source = options.sources[typeIndex]!;
      const ids = await source.page(after, pageSize);
      await enqueueTranslationJobs(
        ids.map((entityId) => ({ entityType: source.entityType, entityId, locale: job.locale })),
      );
      summary.enqueued += ids.length;
      if (ids.length < pageSize) {
        typeIndex += 1;
        after = null;
      } else {
        after = ids[ids.length - 1]!;
      }
      const cursor = typeIndex < types.length ? `${types[typeIndex]}|${after ?? ""}` : null;
      await db.translationJob.updateMany({
        where: { id: job.id, claimToken: token },
        data: { cursor, claimedAt: now() },
      });
    }

    if (typeIndex >= types.length) {
      await finish(job.id);
      summary.completed = 1;
    } else {
      // More to walk: hand the claim back so the next tick continues.
      await db.translationJob.updateMany({
        where: { id: job.id, claimToken: token },
        data: { status: "PENDING", claimToken: null, claimedAt: null, runAfter: now() },
      });
    }
  } catch (error) {
    await settle(job, error, now(), emptySummary());
  }
  return summary;
}

/**
 * One tick of the queue: recover stale leases, expand a backfill if one is
 * due, claim a batch of items, run it, and call `afterBatch` once if anything
 * was written — the one cache revalidation per batch (ADR-162 #8).
 */
export async function runTranslationQueue(options: {
  handlers: JobHandlers;
  limit?: number;
  entity?: { type: string; id: string };
  /** When given (the cron runner), a due backfill is expanded first. */
  backfill?: readonly BackfillSource[];
  /** Jobs for a locale this answers false for finish without translating. */
  isLocaleActive?: (locale: string) => Promise<boolean>;
  afterBatch?: (summary: RunSummary) => void | Promise<void>;
  now?: () => Date;
}): Promise<RunSummary> {
  const now = options.now ?? (() => new Date());
  await recoverStaleJobs(now());
  const expanded = options.backfill
    ? await expandBackfill({
        sources: options.backfill,
        isLocaleActive: options.isLocaleActive,
        now,
      })
    : null;
  const jobs = await claimJobs({ limit: options.limit, entity: options.entity });
  if (jobs.length === 0) {
    return {
      ...emptySummary(),
      backfillEnqueued: expanded?.enqueued ?? 0,
      backfillClaimed: expanded?.claimed ?? 0,
    };
  }

  const inactive = new Set<string>();
  if (options.isLocaleActive) {
    for (const locale of new Set(jobs.map((job) => job.locale))) {
      if (!(await options.isLocaleActive(locale))) inactive.add(locale);
    }
  }
  const summary = await runClaimedJobs(jobs, options.handlers, now, inactive);
  summary.backfillEnqueued = expanded?.enqueued ?? 0;
  summary.backfillClaimed = expanded?.claimed ?? 0;
  if (summary.done > 0) await options.afterBatch?.(summary);
  return summary;
}

// ─── Reads for the dashboard, and housekeeping ────────────────────────────

export type JobStatusName = "PENDING" | "RUNNING" | "DONE" | "FAILED";
export type JobKindName = "ITEM" | "BACKFILL_LOCALE";

export interface JobCount {
  locale: string;
  kind: JobKindName;
  status: JobStatusName;
  count: number;
}

/** Job counts by locale, kind and status — the dashboard's queue columns. */
export async function countJobs(): Promise<JobCount[]> {
  const rows = await db.translationJob.groupBy({
    by: ["locale", "kind", "status"],
    _count: { _all: true },
  });
  return rows.map((row) => ({
    locale: row.locale,
    kind: row.kind,
    status: row.status,
    count: row._count._all,
  }));
}

export interface BackfillState {
  locale: string;
  status: JobStatusName;
  /** The type the walk is in, or null when it has not started or has finished. */
  currentType: string | null;
  lastError: string | null;
  updatedAt: Date;
}

/** Each locale's backfill job, if it has one. */
export async function loadBackfillStates(): Promise<BackfillState[]> {
  const rows = await db.translationJob.findMany({
    where: { kind: "BACKFILL_LOCALE" },
    select: { locale: true, status: true, cursor: true, lastError: true, updatedAt: true },
  });
  return rows.map((row) => ({
    locale: row.locale,
    status: row.status,
    currentType: row.cursor ? (row.cursor.split("|")[0] ?? null) : null,
    lastError: row.lastError,
    updatedAt: row.updatedAt,
  }));
}

export interface FailedJob {
  id: string;
  kind: JobKindName;
  entityType: string;
  entityId: string;
  locale: string;
  lastError: string | null;
  attempts: number;
  updatedAt: Date;
}

/** The most recent FAILED jobs, newest first. */
export async function listFailedJobs(
  options: { locale?: string; take?: number } = {},
): Promise<FailedJob[]> {
  return db.translationJob.findMany({
    where: { status: "FAILED", ...(options.locale ? { locale: options.locale } : {}) },
    orderBy: { updatedAt: "desc" },
    take: Math.min(options.take ?? 50, 200),
    select: {
      id: true,
      kind: true,
      entityType: true,
      entityId: true,
      locale: true,
      lastError: true,
      attempts: true,
      updatedAt: true,
    },
  });
}

/** DONE jobs are kept this long (ADR-162 #10). */
export const DONE_JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Per-request usage rows are kept this long; the monthly totals forever (#10). */
export const USAGE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** The housekeeping sweep's translation half. Returns rows deleted. */
export async function purgeTranslationRows(
  now: Date = new Date(),
): Promise<{ jobs: number; usage: number }> {
  const [jobs, usage] = await Promise.all([
    db.translationJob.deleteMany({
      where: {
        status: "DONE",
        updatedAt: { lt: new Date(now.getTime() - DONE_JOB_RETENTION_MS) },
      },
    }),
    db.translateUsage.deleteMany({
      where: { createdAt: { lt: new Date(now.getTime() - USAGE_RETENTION_MS) } },
    }),
  ]);
  return { jobs: jobs.count, usage: usage.count };
}
