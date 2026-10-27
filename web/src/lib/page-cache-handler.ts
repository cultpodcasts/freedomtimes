/**
 * Anonymous reader page cache — request handler with injected dependencies.
 *
 * No `cloudflare:workers` import: src/emdash-outer-middleware.ts wires the
 * Workers Cache API, the KV epoch reader, env, waitUntil and page-view
 * analytics in; scripts/test-page-cache-handler.mts drives it with fakes.
 * Policy (what may be cached) lives in page-cache-policy.ts.
 */
import {
  decidePageCacheRequest,
  isSilentBypass,
  isStorableResponse,
  pageCacheKeyUrl,
  pageCacheTtlSeconds,
  type PageCacheEnv,
} from './page-cache-policy';

/** Original Cache-Control of a stored page (the stored copy carries the edge TTL). */
export const ORIG_CACHE_CONTROL_HEADER = 'x-ft-orig-cache-control';

export type PageCacheStore = {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
};

export type PageCacheDeps = {
  env: PageCacheEnv;
  /** `caches.default`, or null when unavailable. */
  cache: PageCacheStore | null;
  /** Current epoch, or null when KV is unavailable (cache then bypasses). */
  readEpoch: () => Promise<string | null>;
  /** `waitUntil` for the background cache.put. */
  waitUntil: (promise: Promise<unknown>) => void;
  /** Analytics for hits (the inner middleware that normally records is skipped). */
  recordPageView: (request: Request, response: Response) => void;
  now?: () => number;
};

export type PageCacheCall = {
  request: Request;
  url: URL;
  next: () => Promise<Response>;
  /** Astro attaches `context.cookies` Set-Cookie only after the chain; check it directly. */
  hasPendingCookies: () => boolean;
};

function withCacheHeader(response: Response, state: string): Response {
  const headers = new Headers(response.headers);
  headers.set('x-ft-cache', state);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Returns a Response on a hit; otherwise calls `next()` and stores an eligible
 * 200. Reader-candidate bypasses are labelled `x-ft-cache: BYPASS-<reason>`;
 * disabled / method / path bypasses return `next()` untouched.
 */
export async function handlePageCache(deps: PageCacheDeps, call: PageCacheCall): Promise<Response> {
  const { request, url, next } = call;
  const now = deps.now ?? (() => performance.now());
  const decision = decidePageCacheRequest(deps.env, {
    method: request.method,
    pathname: url.pathname,
    search: url.search,
    cookie: request.headers.get('cookie'),
    authorization: request.headers.get('authorization'),
  });
  if (!decision.cacheable) {
    if (isSilentBypass(decision.reason)) return next();
    return withCacheHeader(await next(), `BYPASS-${decision.reason}`);
  }

  const cache = deps.cache;
  const lookupStart = now();
  let epoch: string | null = null;
  if (cache) {
    try {
      epoch = await deps.readEpoch();
    } catch (error) {
      console.warn('[ft-page-cache] epoch read failed', error);
    }
  }
  if (!cache || epoch === null) {
    return withCacheHeader(await next(), 'BYPASS-unavailable');
  }
  const key = new Request(pageCacheKeyUrl(url.origin, epoch, decision.keyPath), { method: 'GET' });

  let hit: Response | undefined;
  try {
    hit = await cache.match(key);
  } catch (error) {
    console.warn('[ft-page-cache] match failed', error);
  }
  if (hit) {
    const lookupMs = (now() - lookupStart).toFixed(1);
    const headers = new Headers(hit.headers);
    const original = headers.get(ORIG_CACHE_CONTROL_HEADER);
    headers.delete(ORIG_CACHE_CONTROL_HEADER);
    if (original) {
      headers.set('cache-control', original);
    } else {
      headers.delete('cache-control');
    }
    headers.set('x-ft-cache', 'HIT');
    headers.set('server-timing', `ftcache;desc="HIT";dur=${lookupMs}`);
    const response = new Response(request.method === 'HEAD' ? null : hit.body, { status: 200, headers });
    deps.recordPageView(request, response);
    return response;
  }

  const response = await next();
  if (request.method !== 'GET' || call.hasPendingCookies() || !isStorableResponse(response)) {
    return withCacheHeader(response, response.status === 200 ? 'BYPASS-response' : `BYPASS-${response.status}`);
  }

  const ttl = pageCacheTtlSeconds(deps.env);
  const [forClient, forCache] = response.body ? response.body.tee() : [null, null];
  const storeHeaders = new Headers(response.headers);
  const original = storeHeaders.get('cache-control');
  if (original) {
    storeHeaders.set(ORIG_CACHE_CONTROL_HEADER, original);
  }
  storeHeaders.set('cache-control', `public, max-age=${ttl}`);
  storeHeaders.delete('server-timing');
  deps.waitUntil(
    cache
      .put(key, new Response(forCache, { status: 200, headers: storeHeaders }))
      .catch((error) => console.warn('[ft-page-cache] put failed', error)),
  );

  const clientHeaders = new Headers(response.headers);
  clientHeaders.set('x-ft-cache', 'MISS');
  return new Response(forClient, { status: response.status, statusText: response.statusText, headers: clientHeaders });
}
