// What every translation driver is (ADR-186): one HTTP request in, the
// answers out in the same order, plus the limits the door batches by. The
// drivers are `google.ts` and `deepl.ts`; `provider.ts` picks one from the
// row, and nothing outside this package ever holds one.
import type { BatchLimits } from "./batch.ts";

export type TranslateWireFormat = "text" | "html";

export interface TranslateDriverRequest {
  segments: readonly string[];
  /** Our own locale code (`routing.ts`); a driver maps it to its vendor's. */
  source: string;
  target: string;
  format: TranslateWireFormat;
}

export interface TranslateDriver {
  /** How many segments, and how many characters, one request may carry. */
  readonly limits: BatchLimits;
  /** One HTTP request. The caller batches; this never splits. */
  translate(request: TranslateDriverRequest, signal?: AbortSignal): Promise<string[]>;
}
