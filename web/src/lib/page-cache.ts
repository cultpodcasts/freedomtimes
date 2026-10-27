/**
 * Anonymous reader page cache — Workers runtime glue (Cache API + KV epoch).
 *
 * Runs in EmDash `middleware.outer` (src/emdash-outer-middleware.ts), i.e.
 * BEFORE EmDash runtime init, so a hit skips runtime init and every Turso
 * round trip. Policy lives in page-cache-policy.ts.
 *
 * Purge: content hooks (src/plugins/page-cache-purge.ts) write a new epoch to
 * KV (SESSION binding, key PAGE_CACHE_EPOCH_KV_KEY). The epoch is part of the
 * cache key, so a bump orphans every cached page in every colo at once.
 * Isolates re-read the epoch at most every EPOCH_MEMO_MS; KV edge caching
 * adds up to KV_CACHE_TTL_SECONDS. Worst-case staleness after a publish is
 * therefore ~EPOCH_MEMO_MS + KV_CACHE_TTL_SECONDS (+KV propagation), and never
 * more than the page TTL.
 */
import { env as cfEnv } from 'cloudflare:workers';

import { PAGE_CACHE_EPOCH_KV_KEY } from './page-cache-policy';

type KvLike = {
  get(key: string, options?: { cacheTtl?: number }): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
};

const EPOCH_MEMO_MS = 10_000;
const KV_CACHE_TTL_SECONDS = 30;

let memo: { epoch: string; at: number } | null = null;

function sessionKv(): KvLike | null {
  const kv = (cfEnv as Record<string, unknown>).SESSION as KvLike | undefined;
  return kv && typeof kv.get === 'function' ? kv : null;
}

/** Current cache epoch, or `null` when KV is unavailable (cache then stays off). */
export async function readPageCacheEpoch(now = Date.now()): Promise<string | null> {
  if (memo && now - memo.at < EPOCH_MEMO_MS) return memo.epoch;
  const kv = sessionKv();
  if (!kv) return null;
  try {
    const epoch = (await kv.get(PAGE_CACHE_EPOCH_KV_KEY, { cacheTtl: KV_CACHE_TTL_SECONDS })) ?? '0';
    memo = { epoch, at: now };
    return epoch;
  } catch (error) {
    console.warn('[ft-page-cache] epoch read failed', error);
    return null;
  }
}

/** Invalidate every cached page (all colos) by bumping the epoch. */
export async function bumpPageCacheEpoch(reason: string): Promise<void> {
  const kv = sessionKv();
  if (!kv) return;
  const epoch = Date.now().toString(36);
  try {
    await kv.put(PAGE_CACHE_EPOCH_KV_KEY, epoch);
    memo = { epoch, at: Date.now() };
    console.info('[ft-page-cache] epoch bumped', JSON.stringify({ epoch, reason }));
  } catch (error) {
    console.warn('[ft-page-cache] epoch bump failed', error);
  }
}

export function defaultPageCache(): Cache | null {
  try {
    return (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default ?? null;
  } catch {
    return null;
  }
}
