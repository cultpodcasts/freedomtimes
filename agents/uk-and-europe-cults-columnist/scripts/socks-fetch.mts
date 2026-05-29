/**
 * Scripts-only SOCKS5 proxy fetch helpers.
 * Delegates to src/socksFetch.ts; safe to import from probe / test scripts.
 */

import type { FetchFn } from '../src/httpCache.ts';
import { getSocksFetchFn, socksProxyConfigured } from '../src/socksFetch.ts';

export { socksProxyConfigured };

/**
 * Patch globalThis.fetch with the SOCKS proxy fetch so third-party libs
 * (e.g. google-news-url-decoder) that use global fetch also route through Tor.
 * Call this before any imports that may trigger fetch.
 * Returns true if the patch was applied.
 */
export async function installGlobalSocksFetch(socksUrl?: string): Promise<boolean> {
  if (socksUrl && socksUrl !== process.env.SOCKS_PROXY) {
    process.env.SOCKS_PROXY = socksUrl;
  }
  const fn = await getSocksFetchFn({ patchGlobalFetch: true });
  return Boolean(fn);
}

export async function createSocksFetchFn(socksUrl?: string): Promise<FetchFn | undefined> {
  if (socksUrl && socksUrl !== process.env.SOCKS_PROXY) {
    process.env.SOCKS_PROXY = socksUrl;
  }
  return getSocksFetchFn();
}
