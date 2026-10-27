/**
 * Anonymous reader page cache — pure policy (no Workers imports; unit-tested).
 *
 * Production only, behind `PAGE_CACHE=on` (wrangler.jsonc env vars). Staging is
 * Auth0-locked, so every reader response there is per-session: the cache is
 * disabled whenever SITE_ACCESS_MODE is locked, regardless of the flag.
 */

export const PAGE_CACHE_DEFAULT_TTL_SECONDS = 120;
export const PAGE_CACHE_MAX_TTL_SECONDS = 600;
export const PAGE_CACHE_EPOCH_KV_KEY = 'ft:page-cache:epoch';

/**
 * Cookies that never identify a reader session: Cloudflare bot/LB cookies and
 * Google Analytics. ANY other cookie (astro-session, ft_session, Auth0, EmDash,
 * unknown) disables caching for the request.
 */
const NON_SESSION_COOKIE_PATTERNS: readonly RegExp[] = [
  /^__cf_bm$/,
  /^cf_clearance$/,
  /^_cfuvid$/,
  /^__cflb$/,
  /^_ga(_[A-Za-z0-9]+)?$/,
  /^_gid$/,
];

/** Query params that do not change the page: stripped from the cache key. */
const TRACKING_PARAM_PATTERNS: readonly RegExp[] = [
  /^utm_[a-z_]+$/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^msclkid$/i,
  /^mc_cid$/i,
  /^mc_eid$/i,
  /^ref$/i,
];

/** Top-level single-segment paths that are NOT cacheable reader pages. */
const DENY_TOP_LEVEL = new Set([
  'admin',
  'api',
  'auth',
  'authorize',
  'homepage',
  'login-wall',
  'signed-in',
  'submit-a-tip',
  'tip-source',
  'manifest.webmanifest',
  'preview',
  'draft',
  'edit',
  'logout',
  'login',
  'account',
]);

const SLUG = '[a-z0-9][a-z0-9-]*';
const CACHEABLE_PATH_PATTERNS: readonly RegExp[] = [
  /^\/$/,
  /^\/robots\.txt$/,
  new RegExp(`^/posts/${SLUG}$`),
  new RegExp(`^/archives$`),
  new RegExp(`^/archives/${SLUG}$`),
  new RegExp(`^/(${SLUG})$`),
];

export type PageCacheEnv = {
  PAGE_CACHE?: string;
  PAGE_CACHE_TTL_SECONDS?: string;
  SITE_ACCESS_MODE?: string;
};

export function isPageCacheEnabled(env: PageCacheEnv): boolean {
  if ((env.SITE_ACCESS_MODE ?? '').trim().toLowerCase() !== 'public') return false;
  return (env.PAGE_CACHE ?? '').trim().toLowerCase() === 'on';
}

export function pageCacheTtlSeconds(env: PageCacheEnv): number {
  const n = Number.parseInt((env.PAGE_CACHE_TTL_SECONDS ?? '').trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return PAGE_CACHE_DEFAULT_TTL_SECONDS;
  return Math.min(n, PAGE_CACHE_MAX_TTL_SECONDS);
}

export function isCacheablePath(pathname: string): boolean {
  if (pathname.includes('//') || pathname.includes('%')) return false;
  if (pathname.startsWith('/_') || pathname.startsWith('/.')) return false;
  const first = pathname.split('/')[1] ?? '';
  if (DENY_TOP_LEVEL.has(first) && pathname !== '/') return false;
  if (first === 'api' || first === 'admin' || first === 'auth' || first === 'cdn-cgi') return false;
  if (/^\/sitemap[^/]*\.xml$/.test(pathname)) return false; // own resilient cache
  return CACHEABLE_PATH_PATTERNS.some((re) => re.test(pathname));
}

/** Cookie names from a Cookie header (values ignored). */
export function cookieNames(cookieHeader: string | null | undefined): string[] {
  if (!cookieHeader) return [];
  return cookieHeader
    .split(';')
    .map((part) => part.split('=')[0]?.trim() ?? '')
    .filter((name) => name.length > 0);
}

/** True when the request carries no cookie other than known non-session ones. */
export function hasOnlyNonSessionCookies(cookieHeader: string | null | undefined): boolean {
  return cookieNames(cookieHeader).every((name) =>
    NON_SESSION_COOKIE_PATTERNS.some((re) => re.test(name)),
  );
}

/**
 * Normalised query for the cache key, or `null` when a non-tracking param is
 * present (preview tokens, edit mode, pagination…) — such requests bypass.
 */
export function cacheKeySearch(search: string): string | null {
  const params = new URLSearchParams(search);
  const kept: [string, string][] = [];
  for (const [key, value] of params) {
    if (TRACKING_PARAM_PATTERNS.some((re) => re.test(key))) continue;
    kept.push([key, value]);
  }
  return kept.length === 0 ? '' : null;
}

export type PageCacheRequestInfo = {
  method: string;
  pathname: string;
  search: string;
  cookie: string | null;
  authorization: string | null;
};

export type PageCacheDecision =
  | { cacheable: true; keyPath: string }
  | { cacheable: false; reason: string };

export function decidePageCacheRequest(env: PageCacheEnv, req: PageCacheRequestInfo): PageCacheDecision {
  if (!isPageCacheEnabled(env)) return { cacheable: false, reason: 'disabled' };
  if (req.method !== 'GET' && req.method !== 'HEAD') return { cacheable: false, reason: 'method' };
  if (req.authorization) return { cacheable: false, reason: 'authorization' };
  if (!hasOnlyNonSessionCookies(req.cookie)) return { cacheable: false, reason: 'cookie' };
  if (!isCacheablePath(req.pathname)) return { cacheable: false, reason: 'path' };
  const search = cacheKeySearch(req.search);
  if (search === null) return { cacheable: false, reason: 'query' };
  return { cacheable: true, keyPath: req.pathname };
}

export type PageCacheResponseInfo = {
  status: number;
  headers: Headers;
};

/** Only plain 200 HTML / text responses without cookies or private caching. */
export function isStorableResponse(res: PageCacheResponseInfo): boolean {
  if (res.status !== 200) return false;
  if (res.headers.has('set-cookie')) return false;
  const cc = (res.headers.get('cache-control') ?? '').toLowerCase();
  if (/(^|[\s,])(private|no-store|no-cache)([\s,=]|$)/.test(cc)) return false;
  const vary = (res.headers.get('vary') ?? '').toLowerCase();
  if (vary.includes('*') || vary.includes('cookie') || vary.includes('authorization')) return false;
  const ct = (res.headers.get('content-type') ?? '').toLowerCase();
  if (!ct.startsWith('text/html') && !ct.startsWith('text/plain')) return false;
  return true;
}

/** Synthetic cache key URL (never a routable path); epoch makes purges global. */
export function pageCacheKeyUrl(origin: string, epoch: string, keyPath: string): string {
  return `${origin}/__ft_page_cache/${encodeURIComponent(epoch)}${keyPath}`;
}
