/**
 * Scripts-only SOCKS5 proxy fetch implementation.
 * Never imported by production src/ — safe for Cloudflare Workers builds.
 *
 * Reads SOCKS_PROXY from env (e.g. socks5://127.0.0.1:9050 for Tor daemon).
 * Returns undefined if SOCKS_PROXY is not set, so callers fall back to global fetch.
 */

import nodeFetch from 'node-fetch';
import { SocksProxyAgent } from 'socks-proxy-agent';
import type { FetchFn } from '../src/httpCache.js';

export function createSocksFetchFn(socksUrl?: string): FetchFn | undefined {
  const proxy = socksUrl ?? process.env.SOCKS_PROXY;
  if (!proxy) return undefined;

  const agent = new SocksProxyAgent(proxy);

  return async (url: string, init?: RequestInit): Promise<Response> => {
    // node-fetch accepts a standard http.Agent, which socks-proxy-agent implements.
    // Cast the node-fetch response to the native Response interface — shape is compatible for our use.
    const res = await nodeFetch(url, { ...(init as object), agent } as Parameters<typeof nodeFetch>[1]);
    return res as unknown as Response;
  };
}
