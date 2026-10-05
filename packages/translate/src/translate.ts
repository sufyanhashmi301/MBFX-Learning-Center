// **The one door** to the translation provider (ADR-160, ADR-186).
// `translateSegments` is the only export that reaches the provider, and it
// meters every outcome — a request, a failure, a refusal — so a caller cannot
// forget to log. `translateTexts` and `translateHtml` are shapes over it,
// never around it.
//
// Nothing here writes content anywhere. It returns strings; whoever asked
// decides what to save, under its own permission check and schema.
import type { TranslateProviderKindName, TranslateReason } from "@repo/contracts";

import { planBatches, splitHtml } from "./batch.ts";
import { TranslateError, isTransient, reasonOf } from "./errors.ts";
import type { TranslateWireFormat } from "./driver.ts";
import { stripKeepWrappers, substituteGlossary, type GlossaryPair } from "./html.ts";
import { loadTranslateDriver, type LoadedProvider } from "./provider.ts";
import { getPeriodUsage, recordUsage, type UsageFormat } from "./usage.ts";

/** Waits between attempts on a transient failure: 1 s, then 4 s. */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [1000, 4000];

export interface TranslateOptions {
  source: string;
  target: string;
  /** Who asked; null or absent for the job runner. */
  userId?: string | null;
  /** What it is about, for the usage log. */
  entity?: { type: string; id: string } | null;
  signal?: AbortSignal;
  /** Tests pass `[0, 0]`. */
  retryDelaysMs?: readonly number[];
  now?: () => Date;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function usageFormat(format: TranslateWireFormat): UsageFormat {
  return format === "html" ? "HTML" : "TEXT";
}

async function refuse(
  reason: TranslateReason,
  segments: number,
  format: TranslateWireFormat,
  options: TranslateOptions,
  price: number,
  message: string,
  provider: TranslateProviderKindName | null = null,
): Promise<never> {
  await recordUsage({
    status: "REFUSED",
    reason,
    provider,
    sourceLocale: options.source,
    targetLocale: options.target,
    format: usageFormat(format),
    segments,
    characters: 0,
    pricePerMillionChars: price,
    durationMs: 0,
    userId: options.userId,
    entityType: options.entity?.type,
    entityId: options.entity?.id,
    now: options.now?.(),
  });
  throw new TranslateError(reason, message);
}

/**
 * Translates `segments`, returning answers in the same order. Blank segments
 * come back as they went and are never sent. Throws `TranslateError`.
 */
export async function translateSegments(
  segments: readonly string[],
  format: TranslateWireFormat,
  options: TranslateOptions,
): Promise<string[]> {
  const results = [...segments];
  const toSend = segments
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment }) => segment.trim() !== "");
  if (toSend.length === 0) return results;

  let loaded: LoadedProvider;
  try {
    loaded = await loadTranslateDriver();
  } catch (error) {
    return refuse(reasonOf(error), toSend.length, format, options, 0, (error as Error).message);
  }
  const { driver, config } = loaded;

  // The budget is checked for the whole call up front: a backfill page either
  // fits in what is left of the month or waits for the next one.
  const totalChars = toSend.reduce((sum, { segment }) => sum + segment.length, 0);
  if (config.monthlyCharBudget !== null) {
    const used = await getPeriodUsage(options.now?.());
    if (used.characters + totalChars > config.monthlyCharBudget) {
      return refuse(
        "budget_exceeded",
        toSend.length,
        format,
        options,
        config.pricePerMillionChars,
        "The monthly translation budget is reached",
        config.kind,
      );
    }
  }

  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const batches = planBatches(
    toSend.map(({ segment }) => segment),
    driver.limits,
  );

  for (const batch of batches) {
    const batchSegments = batch.map((i) => toSend[i]!.segment);
    const characters = batchSegments.reduce((sum, s) => sum + s.length, 0);

    for (let attempt = 0; ; attempt += 1) {
      const started = Date.now();
      try {
        const answers = await driver.translate(
          { segments: batchSegments, source: options.source, target: options.target, format },
          options.signal,
        );
        await recordUsage({
          status: "OK",
          provider: config.kind,
          sourceLocale: options.source,
          targetLocale: options.target,
          format: usageFormat(format),
          segments: batchSegments.length,
          characters,
          pricePerMillionChars: config.pricePerMillionChars,
          durationMs: Date.now() - started,
          userId: options.userId,
          entityType: options.entity?.type,
          entityId: options.entity?.id,
          now: options.now?.(),
        });
        batch.forEach((i, position) => {
          results[toSend[i]!.index] = answers[position]!;
        });
        break;
      } catch (error) {
        const delay = delays[attempt];
        if (isTransient(error) && delay !== undefined) {
          await sleep(delay);
          continue;
        }
        await recordUsage({
          status: "FAILED",
          reason: reasonOf(error),
          provider: config.kind,
          sourceLocale: options.source,
          targetLocale: options.target,
          format: usageFormat(format),
          segments: batchSegments.length,
          characters,
          pricePerMillionChars: config.pricePerMillionChars,
          durationMs: Date.now() - started,
          userId: options.userId,
          entityType: options.entity?.type,
          entityId: options.entity?.id,
          now: options.now?.(),
        });
        throw error instanceof TranslateError
          ? error
          : new TranslateError("network_error", (error as Error).message);
      }
    }
  }
  return results;
}

/** Plain strings: titles, labels, excerpts. */
export function translateTexts(
  texts: readonly string[],
  options: TranslateOptions,
): Promise<string[]> {
  return translateSegments(texts, "text", options);
}

/**
 * A rich-text body. Long bodies are split at top-level element boundaries,
 * glossary terms are fixed to their human translation first (ADR-160 #9),
 * and the keep-wrappers are removed from the answer.
 *
 * **The result is NOT sanitized.** The caller runs `sanitizeRichText` on it
 * exactly as it would on an editor's save (security.md #8).
 */
export async function translateHtml(
  html: string,
  options: TranslateOptions & { glossary?: readonly GlossaryPair[] },
): Promise<string> {
  const [answer] = await translateHtmlMany([html], options);
  return answer ?? "";
}

/**
 * Several rich-text bodies in as few requests as the limits allow — an
 * article's body and its FAQ answers travel together rather than as one
 * request each. Answers come back in input order; the same caveat applies:
 * **the results are NOT sanitized.**
 */
export async function translateHtmlMany(
  htmls: readonly string[],
  options: TranslateOptions & { glossary?: readonly GlossaryPair[] },
): Promise<string[]> {
  const glossary = options.glossary ?? [];
  const pieces = htmls.map((html) =>
    splitHtml(html).map((piece) => substituteGlossary(piece, glossary)),
  );
  const answers = await translateSegments(pieces.flat(), "html", options);
  let offset = 0;
  return pieces.map((parts) => {
    const joined = answers
      .slice(offset, offset + parts.length)
      .map(stripKeepWrappers)
      .join("");
    offset += parts.length;
    return joined;
  });
}
