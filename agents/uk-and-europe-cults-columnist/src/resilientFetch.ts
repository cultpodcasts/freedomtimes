import { isArchiveMirrorHost, looksLikeBlockedFetchPage } from './archiveMirrors.ts';
import type { CachedFetchResult } from './http-cache/types.ts';
import { fetchTextWithCache, type FetchFn } from './httpCache.ts';
import { getSocksFetchFn } from './socksFetch.ts';

function hostFromFetchUrl(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return undefined;
  }
}

function isArchiveServiceUrl(url: string): boolean {
  const host = hostFromFetchUrl(url);
  return host ? isArchiveMirrorHost(host) : false;
}

function isArchiveRateLimited(result: Pick<CachedFetchResult, 'status' | 'text' | 'url'>): boolean {
  if (result.status === 429) return true;
  const host = hostFromFetchUrl(result.url);
  if (!host || !isArchiveMirrorHost(host)) return false;
  return looksLikeBlockedFetchPage(result.text);
}

export type ResilientFetchOptions = {
  fetchFn?: FetchFn;
  /** Retry archive.ph / archive.is rate-limits via SOCKS_PROXY (default true). */
  retryArchiveRateLimitWithTor?: boolean;
  /** Prefer SOCKS_PROXY for archive URLs when configured (default true). */
  preferSocksForArchive?: boolean;
};

/**
 * HTTP fetch with disk cache. Archive mirror URLs use SOCKS_PROXY when configured,
 * and fall back to Tor on rate-limit (429 or rate-limit page body).
 */
export async function fetchTextResilient(
  url: string,
  init?: RequestInit,
  options?: ResilientFetchOptions,
): Promise<CachedFetchResult> {
  const isArchive = isArchiveServiceUrl(url);
  const preferSocksForArchive = options?.preferSocksForArchive !== false && isArchive;

  let activeFetchFn = options?.fetchFn;
  if (preferSocksForArchive && !activeFetchFn) {
    activeFetchFn = await getSocksFetchFn();
  }

  let result = await fetchTextWithCache(url, init, activeFetchFn);

  const retryEnabled = options?.retryArchiveRateLimitWithTor !== false;
  if (!isArchive || !retryEnabled || !isArchiveRateLimited(result)) {
    return result;
  }

  const socksFn = await getSocksFetchFn();
  if (!socksFn || activeFetchFn === socksFn) {
    return result;
  }

  console.log('[agent] archive rate-limit; retrying via SOCKS proxy', {
    url: url.length > 120 ? `${url.slice(0, 120)}…` : url,
    status: result.status,
  });

  const torResult = await fetchTextWithCache(url, init, socksFn, { cacheKeySuffix: 'socks' });
  if (torResult.ok) {
    return torResult;
  }
  if (torResult.status !== 429 && !isArchiveRateLimited(torResult)) {
    return torResult;
  }
  if (torResult.text.length > result.text.length) {
    return torResult;
  }

  return result;
}
