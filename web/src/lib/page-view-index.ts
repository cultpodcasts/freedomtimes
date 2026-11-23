/**
 * Pure helpers for the page-view Analytics Engine data point (no `cloudflare:workers` import,
 * so node tests can load this module directly).
 *
 * Workers Analytics Engine rejects any data point whose index is over 96 bytes
 * (`writeDataPoint(): Size of indexes[0] exceeds 96 bytes`). We used to put the raw path in
 * `index1`, so every view of a post whose `/posts/{slug}` path was longer than 96 bytes was
 * silently dropped. The index is only the sampling key — admin queries read the full path from
 * `blob1` (blobs allow 16 KB) — so we index a fixed-length hash of the path instead.
 */

/** Cloudflare Analytics Engine hard limit for each index, in bytes. */
export const ANALYTICS_ENGINE_INDEX_MAX_BYTES = 96;

/** Version prefix so a future change of key scheme is distinguishable in raw data. */
export const PAGE_VIEW_INDEX_PREFIX = 'p1:';

/** `p1:` + 16 hex chars = 19 bytes, always (well under the 96-byte limit). */
export const PAGE_VIEW_INDEX_LENGTH = PAGE_VIEW_INDEX_PREFIX.length + 16;

const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

/** FNV-1a 64-bit over the UTF-8 bytes of `value`, as 16 lowercase hex chars. Synchronous. */
export function fnv1a64Hex(value: string): string {
  let hash = FNV64_OFFSET;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV64_PRIME) & MASK64;
  }
  return hash.toString(16).padStart(16, '0');
}

/** Fixed-length Analytics Engine index (sampling key) for a canonical page path. */
export function pageViewIndexKey(path: string): string {
  return `${PAGE_VIEW_INDEX_PREFIX}${fnv1a64Hex(path)}`;
}

export type PageViewDataPoint = {
  blobs: string[];
  doubles: number[];
  indexes: string[];
};

/**
 * Data point layout (stable — SQL queries depend on order):
 * - blob1: full canonical path (what /admin/analytics groups and filters on)
 * - blob2: country (ISO-3166 alpha-2 or XX)
 * - blob3: is_bot ("0" | "1")
 * - double1: 1 (unit count; sampling uses `_sample_interval`)
 * - index1: `pageViewIndexKey(path)` — fixed 19 bytes, never the raw path
 */
export function buildPageViewDataPoint(path: string, country: string, isBot: boolean): PageViewDataPoint {
  return {
    blobs: [path, country, isBot ? '1' : '0'],
    doubles: [1],
    indexes: [pageViewIndexKey(path)],
  };
}

/**
 * Returns a reporter that logs a write failure as `console.error` once per isolate per distinct
 * message (instead of a quiet warning on every request), so a systematic failure is visible in
 * logs/alerts without flooding them.
 */
export function createOnceErrorReporter(
  log: (message: string, details: Record<string, unknown>) => void = (message, details) =>
    console.error(message, details),
): (error: unknown, details?: Record<string, unknown>) => boolean {
  const seen = new Set<string>();
  return (error, details = {}) => {
    const message = error instanceof Error ? error.message : String(error);
    if (seen.has(message)) {
      return false;
    }
    seen.add(message);
    log('[page-view-analytics] write failed — page views are NOT being recorded', {
      message,
      ...details,
      note: 'logged once per isolate per distinct error',
    });
    return true;
  };
}
