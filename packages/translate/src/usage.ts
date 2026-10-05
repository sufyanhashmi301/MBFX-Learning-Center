// Metering (ADR-160 #6). One `TranslateUsage` row per request to the
// provider or refusal before one; the budget month is a single row incremented
// atomically. No text is ever stored — a count, never the content.
import { db } from "@repo/db";
import type { TranslateProviderKindName, TranslateReason } from "@repo/contracts";

export type UsageStatus = "OK" | "FAILED" | "REFUSED";
export type UsageFormat = "TEXT" | "HTML";

/** "YYYY-MM" in UTC — the budget month. */
export function currentPeriod(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/**
 * Cost in integer micro-dollars: characters × (USD per million characters).
 * Integer so that sums of many small requests do not drift in floating point.
 */
export function costMicros(characters: number, pricePerMillionChars: number): number {
  return Math.round(characters * pricePerMillionChars);
}

/** Micro-dollars as the six-decimal string a Decimal column takes. */
export function microsToUsd(micros: number): string {
  return (micros / 1_000_000).toFixed(6);
}

export interface UsageRecord {
  status: UsageStatus;
  reason?: TranslateReason | null;
  /** The service called (ADR-186 #6); absent for a refusal before one was loaded. */
  provider?: TranslateProviderKindName | null;
  sourceLocale: string;
  targetLocale: string;
  format: UsageFormat;
  segments: number;
  /** What was sent. Zero for a refusal: nothing reached the provider. */
  characters: number;
  pricePerMillionChars: number;
  durationMs: number;
  userId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  now?: Date;
}

/**
 * Writes the row and, for a billed request, adds it to the budget month.
 * Only `OK` is billed: no provider charges a request it refused.
 */
export async function recordUsage(record: UsageRecord): Promise<void> {
  const billed = record.status === "OK";
  const micros = billed ? costMicros(record.characters, record.pricePerMillionChars) : 0;
  const now = record.now ?? new Date();

  await db.translateUsage.create({
    data: {
      status: record.status,
      reason: record.reason ?? null,
      provider: record.provider ?? null,
      sourceLocale: record.sourceLocale,
      targetLocale: record.targetLocale,
      format: record.format,
      segments: record.segments,
      characters: record.characters,
      costUsd: microsToUsd(micros),
      durationMs: record.durationMs,
      userId: record.userId ?? null,
      entityType: record.entityType ?? null,
      entityId: record.entityId ?? null,
      createdAt: now,
    },
  });

  if (!billed) return;
  // One statement, so two runners finishing at once cannot lose an increment
  // (Prisma's upsert is a read then a write).
  await db.$executeRaw`
    INSERT INTO translate_usage_periods (period, characters, costUsd, requests, updatedAt)
    VALUES (${currentPeriod(now)}, ${record.characters}, ${microsToUsd(micros)}, 1, NOW(3))
    ON DUPLICATE KEY UPDATE
      characters = characters + VALUES(characters),
      costUsd = costUsd + VALUES(costUsd),
      requests = requests + 1,
      updatedAt = NOW(3)`;
}

export interface PeriodUsage {
  period: string;
  characters: number;
  /** Estimated (ADR-100). A six-decimal string. */
  costUsd: string;
  requests: number;
}

export async function getPeriodUsage(now: Date = new Date()): Promise<PeriodUsage> {
  const period = currentPeriod(now);
  const row = await db.translateUsagePeriod.findUnique({ where: { period } });
  return {
    period,
    characters: row ? Number(row.characters) : 0,
    costUsd: row ? row.costUsd.toFixed(6) : "0.000000",
    requests: row?.requests ?? 0,
  };
}

/** How many requests (of any outcome) a person caused in the last window. */
export async function recentRequestsBy(
  userId: string,
  windowMs: number,
  now: Date = new Date(),
): Promise<number> {
  return db.translateUsage.count({
    where: { userId, createdAt: { gt: new Date(now.getTime() - windowMs) } },
  });
}
