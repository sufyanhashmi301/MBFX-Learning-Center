// Grouping segments into requests, and splitting a long HTML body into
// segments. Pure. The constants are Google's limits; each driver passes its
// own (ADR-186 #3), and the piece size below suits both providers.
//
// The Basic (v2) limits are confirmed by the Phase 1 spike against the real
// endpoint (plan §6). Until then these are the conservative values: 128
// segments per request is Google's documented cap, and 30,000 characters
// keeps a request well inside every size limit the edition publishes.

export const MAX_SEGMENTS_PER_REQUEST = 128;
export const MAX_CHARS_PER_REQUEST = 30_000;

export interface BatchLimits {
  maxSegments: number;
  maxChars: number;
}

const DEFAULT_LIMITS: BatchLimits = {
  maxSegments: MAX_SEGMENTS_PER_REQUEST,
  maxChars: MAX_CHARS_PER_REQUEST,
};

/**
 * Indices of `segments`, grouped into requests. Order is kept, so the caller
 * can put the answers back where they came from. A single segment larger than
 * `maxChars` travels alone rather than being refused: splitting prose is the
 * HTML splitter's job, done before this.
 */
export function planBatches(
  segments: readonly string[],
  limits: BatchLimits = DEFAULT_LIMITS,
): number[][] {
  const batches: number[][] = [];
  let current: number[] = [];
  let chars = 0;

  segments.forEach((segment, index) => {
    const length = segment.length;
    const full =
      current.length > 0 &&
      (current.length >= limits.maxSegments || chars + length > limits.maxChars);
    if (full) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(index);
    chars += length;
  });
  if (current.length > 0) batches.push(current);
  return batches;
}

// Elements with no closing tag. Anything else opened must be closed before a
// split point, so a piece never carries half an element.
const VOID_ELEMENTS = new Set([
  "area",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g;

/**
 * Splits an HTML body into pieces no longer than `maxChars`, cutting only
 * where every element opened so far has closed (nesting depth zero). A single
 * top-level element longer than the limit becomes a piece of its own.
 *
 * Joining the pieces gives back the input exactly: nothing is added, trimmed
 * or re-serialised.
 */
export function splitHtml(html: string, maxChars: number = MAX_CHARS_PER_REQUEST): string[] {
  if (html.length <= maxChars) return html.length > 0 ? [html] : [];

  // Every offset at which the document is at depth zero.
  const cuts: number[] = [];
  let depth = 0;
  for (const match of html.matchAll(TAG)) {
    const [whole, closing, rawName, selfClosing] = match;
    const name = (rawName ?? "").toLowerCase();
    if (closing) depth = Math.max(0, depth - 1);
    else if (!selfClosing && !VOID_ELEMENTS.has(name)) depth += 1;
    if (depth === 0) cuts.push((match.index ?? 0) + whole.length);
  }

  const pieces: string[] = [];
  let start = 0;
  let lastCut = 0;
  for (const cut of cuts) {
    if (cut - start > maxChars && lastCut > start) {
      pieces.push(html.slice(start, lastCut));
      start = lastCut;
    }
    lastCut = cut;
  }
  if (start < html.length) {
    const rest = html.slice(start);
    if (rest.length > maxChars && lastCut > start && lastCut < html.length) {
      pieces.push(html.slice(start, lastCut), html.slice(lastCut));
    } else {
      pieces.push(rest);
    }
  }
  return pieces;
}
