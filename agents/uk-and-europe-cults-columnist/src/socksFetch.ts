import type { FetchFn } from './httpCache.ts';

const SOCKS_PROXY_URL = process.env.SOCKS_PROXY?.trim() || undefined;

/** Whether SOCKS_PROXY is configured (e.g. Tor on 127.0.0.1:9050 / 9150). */
export function socksProxyConfigured(): boolean {
  return Boolean(SOCKS_PROXY_URL);
}

let cachedSocksFetchFn: FetchFn | undefined | null = null;

/**
 * Lazily-built SOCKS5 proxy FetchFn. Returns undefined when SOCKS_PROXY is unset
 * or socks-proxy-agent cannot load (e.g. Cloudflare Workers).
 */
export async function getSocksFetchFn(options?: { patchGlobalFetch?: boolean }): Promise<FetchFn | undefined> {
  if (!SOCKS_PROXY_URL) return undefined;
  if (cachedSocksFetchFn !== null) {
    if (cachedSocksFetchFn && options?.patchGlobalFetch) {
      (globalThis as unknown as Record<string, unknown>).fetch = cachedSocksFetchFn;
    }
    return cachedSocksFetchFn;
  }

  try {
    const [{ SocksProxyAgent }, { default: nodeFetch }] = await Promise.all([
      import('socks-proxy-agent'),
      import('node-fetch'),
    ]);
    const agent = new SocksProxyAgent(SOCKS_PROXY_URL);
    cachedSocksFetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
      const res = await nodeFetch(url, { ...(init as object), agent } as Parameters<typeof nodeFetch>[1]);
      return res as unknown as Response;
    };
  } catch {
    cachedSocksFetchFn = undefined;
  }

  if (cachedSocksFetchFn && options?.patchGlobalFetch) {
    (globalThis as unknown as Record<string, unknown>).fetch = cachedSocksFetchFn;
  }

  return cachedSocksFetchFn;
}
