import { env as cfEnv } from 'cloudflare:workers';

import { isLockedSiteAccess, readOptionalEnv } from './auth';

/**
 * Site analytics for public reader pages (homepage, articles, CMS pages, etc.).
 * Aggregates are **viewed** on locked `/admin/analytics` — `/admin*` itself is never a tracked subject.
 *
 * Privacy / GDPR posture (see web/docs/ADMIN_ANALYTICS.md and ARCHITECTURE.md §4.13):
 * - Lawful basis: legitimate interest in operating the journalism platform (public site traffic).
 * - Data minimisation: only path + coarse country + bot flag via Cloudflare Analytics Engine.
 * - NOT stored: IP addresses, cookies, full User-Agent strings, session/user IDs, JA3, or fingerprints.
 * - Bot classification uses ephemeral CF Bot Management signals (and a short UA heuristic at write
 *   time only); raw client identifiers are never persisted into the analytics store.
 * - Retention: Workers Analytics Engine keeps data ~3 months (Cloudflare platform retention).
 * - No frontend trackers / consent-banner analytics scripts.
 * - Honour DNT: skip write when `DNT: 1`.
 */

/** Wrangler Analytics Engine binding (see wrangler.jsonc). */
export const PAGE_VIEWS_BINDING = 'PAGE_VIEWS';

/** Default dataset name when `PAGE_VIEWS_DATASET` var is unset. */
export const DEFAULT_PAGE_VIEWS_DATASET = 'freedomtimes_page_views';

export type AnalyticsRange = '1d' | '1w' | '1m';

export type PageViewStatRow = {
  key: string;
  views: number;
};

export type AdminAnalyticsSnapshot = {
  range: AnalyticsRange;
  excludeBots: boolean;
  /** Normalized path when drilling into countries for one page; null when site-wide. */
  selectedPath: string | null;
  configured: boolean;
  dataset: string;
  topPages: PageViewStatRow[];
  countries: PageViewStatRow[];
  /** Country breakdown for `selectedPath` only (empty when no path is selected). */
  pathCountries: PageViewStatRow[];
  totalViews: number;
  error?: string;
};

type AnalyticsEngineDataset = {
  writeDataPoint: (event: {
    blobs?: string[];
    doubles?: number[];
    indexes?: string[];
  }) => void;
};

type CfBotManagement = {
  score?: number;
  verifiedBot?: boolean;
};

type RequestCf = {
  country?: string;
  botManagement?: CfBotManagement;
};

const BOT_UA_RE =
  /(?:bot|crawler|spider|slurp|scrapy|httpclient|python-requests|curl\/|wget\/|libwww|headless|phantom|selenium|puppeteer|playwright|facebookexternalhit|facebot|linkedinbot|twitterbot|slackbot|discordbot|telegrambot|whatsapp|preview|pingdom|uptimerobot|statuscake|monitor|feedfetcher|applebot|bingbot|googlebot|yandex|baiduspider|duckduckbot|semrush|ahrefs|mj12bot|dotbot|bytespider|gptbot|claudebot|anthropic|ccbot|amazonbot)/i;

const STATIC_ASSET_RE =
  /\.(?:js|mjs|cjs|css|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|eot|otf|mp3|mp4|webm|ogg|wav|json|xml|txt|md|pdf|webmanifest|wasm)$/i;

/**
 * Internal / non-content prefixes — never counted as public page views.
 * `/admin*` (hub + analytics UI) is the stats viewer only; staff tooling must not appear in Top pages.
 */
const SKIP_PREFIXES = [
  '/api/',
  '/_emdash',
  '/auth/',
  '/.well-known/',
  '/admin',
  '/cdn-cgi/',
  '/_astro/',
] as const;

/** Staff / auth utility paths that return HTML but are not public reader content. */
const SKIP_EXACT_PATHS = new Set([
  '/signed-in',
  '/authorize',
  '/robots.txt',
  '/sitemap.xml',
  '/service-worker.js',
  '/sw.js',
  '/manifest.webmanifest',
  '/favicon.ico',
]);

const RANGE_INTERVAL: Record<AnalyticsRange, string> = {
  '1d': "INTERVAL '1' DAY",
  '1w': "INTERVAL '7' DAY",
  '1m': "INTERVAL '30' DAY",
};

const TOP_LIMIT = 20;

/**
 * Log-only bot heuristic for aggregate stats.
 * Prefer Cloudflare Bot Management when present; otherwise User-Agent patterns.
 * The UA string is inspected ephemerally and never written to Analytics Engine.
 */
export function isLikelyBotRequest(request: Request): boolean {
  const cf = getRequestCf(request);
  const botManagement = cf?.botManagement;

  if (botManagement) {
    if (botManagement.verifiedBot === true) {
      return true;
    }
    // Cloudflare bot score: 1 = likely automated, 99 = likely human.
    if (typeof botManagement.score === 'number' && botManagement.score > 0 && botManagement.score < 30) {
      return true;
    }
  }

  const ua = request.headers.get('user-agent')?.trim() ?? '';
  if (!ua || ua.length < 12) {
    return true;
  }

  if (BOT_UA_RE.test(ua)) {
    return true;
  }

  return false;
}

/**
 * Whether this response is a countable public HTML page view.
 *
 * Counts: homepage (`/` on production; `/homepage` on locked staging), `/posts/{slug}`,
 * CMS pages (`/{slug}`), archives, tip forms, and other public HTML reader pages.
 *
 * Does not count: `/admin*`, APIs, EmDash, auth, static assets, redirects, errors,
 * staging login wall at `/`, or non-GET methods.
 */
export function shouldRecordPageView(request: Request, response: Response): boolean {
  // Real page views only — HEAD / probes are not reader sessions.
  if (request.method !== 'GET') {
    return false;
  }

  // Honour Do Not Track where applicable (ARCHITECTURE.md §4.13).
  if (request.headers.get('dnt')?.trim() === '1') {
    return false;
  }

  // Successful HTML documents only — do not count auth redirects or soft failures.
  if (response.status < 200 || response.status >= 300) {
    return false;
  }

  const pathname = normalizeTrackedPath(new URL(request.url).pathname);
  if (!isTrackablePath(pathname)) {
    return false;
  }

  const accept = request.headers.get('accept')?.toLowerCase() ?? '';
  if (accept && !accept.includes('text/html') && !accept.includes('*/*')) {
    return false;
  }

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType && !contentType.includes('text/html')) {
    return false;
  }

  return true;
}

export function normalizeTrackedPath(pathname: string): string {
  let path = pathname.split('?')[0]?.split('#')[0] || '/';
  if (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
  }
  if (path.length > 256) {
    path = path.slice(0, 256);
  }
  return path || '/';
}

/**
 * Public reader HTML paths we want on Top pages.
 * Denylist for internals; article identity stays the request pathname (`/posts/{slug}`).
 */
export function isTrackablePath(pathname: string): boolean {
  if (!pathname || SKIP_EXACT_PATHS.has(pathname)) {
    return false;
  }

  // Locked staging: `/` is the Auth0 login wall, not the newsroom (newsroom is `/homepage`).
  // Production: `/` is the public homepage via rewrite — still trackable.
  if (pathname === '/' && isLockedSiteAccess()) {
    return false;
  }

  if (STATIC_ASSET_RE.test(pathname)) {
    return false;
  }

  for (const prefix of SKIP_PREFIXES) {
    if (
      prefix.endsWith('/')
        ? pathname.startsWith(prefix) || pathname === prefix.slice(0, -1)
        : pathname === prefix || pathname.startsWith(`${prefix}/`)
    ) {
      return false;
    }
  }

  return true;
}

export function readCountryCode(request: Request): string {
  const fromCf = getRequestCf(request)?.country?.trim().toUpperCase();
  if (fromCf && /^[A-Z]{2}$/.test(fromCf)) {
    return fromCf;
  }

  // cf-ipcountry is set by Cloudflare at the edge — still only a two-letter code, not an IP.
  const header = request.headers.get('cf-ipcountry')?.trim().toUpperCase() ?? '';
  if (header && /^[A-Z]{2}$/.test(header)) {
    return header;
  }

  return 'XX';
}

/**
 * Best-effort page-view write. Never throws; binding may be absent in local/dev.
 *
 * Data point layout (stable — SQL queries depend on order):
 * - blob1: path (public page path, e.g. `/`, `/posts/my-slug`)
 * - blob2: country (ISO-3166 alpha-2 or XX)
 * - blob3: is_bot ("0" | "1")
 * - double1: 1 (unit count; sampling uses `_sample_interval`)
 * - index1: path (sampling key)
 */
export function recordPageView(request: Request, response: Response): void {
  try {
    if (!shouldRecordPageView(request, response)) {
      return;
    }

    const dataset = readPageViewsBinding();
    if (!dataset) {
      return;
    }

    const path = normalizeTrackedPath(new URL(request.url).pathname);
    const country = readCountryCode(request);
    const isBot = isLikelyBotRequest(request);

    dataset.writeDataPoint({
      blobs: [path, country, isBot ? '1' : '0'],
      doubles: [1],
      indexes: [path],
    });
  } catch (error) {
    console.warn('[page-view-analytics] write failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function parseAnalyticsRange(value: string | null | undefined): AnalyticsRange {
  if (value === '1w' || value === '1m' || value === '1d') {
    return value;
  }
  return '1w';
}

/**
 * Optional path filter for admin drill-down (`?path=`).
 * Returns a normalized public-style path, or null when absent/invalid.
 * Strict charset keeps the value safe to interpolate into Analytics Engine SQL.
 */
export function parseAnalyticsPathFilter(value: string | null | undefined): string | null {
  if (value == null) {
    return null;
  }
  const raw = value.trim();
  if (!raw) {
    return null;
  }

  const path = normalizeTrackedPath(raw);
  // Paths we write are `/…` with URL-safe characters only; reject anything else.
  if (!/^\/[A-Za-z0-9/_.~%-]*$/.test(path) || path.length > 256) {
    return null;
  }
  return path;
}

/** Single-quoted SQL string literal (escape embedded quotes). */
function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function isAnalyticsQueryConfigured(): boolean {
  return Boolean(
    readOptionalEnv('CLOUDFLARE_ACCOUNT_ID').trim()
    && readOptionalEnv('CLOUDFLARE_ANALYTICS_API_TOKEN').trim(),
  );
}

export function getPageViewsDatasetName(): string {
  const configured = readOptionalEnv('PAGE_VIEWS_DATASET').trim();
  if (configured && /^[A-Za-z_][A-Za-z0-9_]*$/.test(configured)) {
    return configured;
  }
  return DEFAULT_PAGE_VIEWS_DATASET;
}

export async function loadAdminAnalytics(params: {
  range: AnalyticsRange;
  excludeBots?: boolean;
  /** When set, also return `pathCountries` for this path (page × country drill-down). */
  path?: string | null;
}): Promise<AdminAnalyticsSnapshot> {
  const excludeBots = params.excludeBots !== false;
  const selectedPath = parseAnalyticsPathFilter(params.path ?? null);
  const dataset = getPageViewsDatasetName();
  const accountId = readOptionalEnv('CLOUDFLARE_ACCOUNT_ID').trim();
  const apiToken = readOptionalEnv('CLOUDFLARE_ANALYTICS_API_TOKEN').trim();

  if (!accountId || !apiToken) {
    return {
      range: params.range,
      excludeBots,
      selectedPath,
      configured: false,
      dataset,
      topPages: [],
      countries: [],
      pathCountries: [],
      totalViews: 0,
      error:
        'Analytics query is not configured. Set Worker secrets CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_ANALYTICS_API_TOKEN via Terraform (dataset id = terraform output page_views_dataset). See web/docs/ADMIN_ANALYTICS.md.',
    };
  }

  const botFilter = excludeBots ? "AND blob3 = '0'" : '';
  const interval = RANGE_INTERVAL[params.range];

  const topPagesSql = `
SELECT
  blob1 AS key,
  SUM(_sample_interval) AS views
FROM ${dataset}
WHERE timestamp > NOW() - ${interval}
  ${botFilter}
GROUP BY key
ORDER BY views DESC
LIMIT ${TOP_LIMIT}
FORMAT JSON
`.trim();

  const countriesSql = `
SELECT
  blob2 AS key,
  SUM(_sample_interval) AS views
FROM ${dataset}
WHERE timestamp > NOW() - ${interval}
  ${botFilter}
GROUP BY key
ORDER BY views DESC
LIMIT ${TOP_LIMIT}
FORMAT JSON
`.trim();

  const totalSql = `
SELECT
  SUM(_sample_interval) AS views
FROM ${dataset}
WHERE timestamp > NOW() - ${interval}
  ${botFilter}
FORMAT JSON
`.trim();

  const pathCountriesSql = selectedPath
    ? `
SELECT
  blob2 AS key,
  SUM(_sample_interval) AS views
FROM ${dataset}
WHERE timestamp > NOW() - ${interval}
  AND blob1 = ${sqlStringLiteral(selectedPath)}
  ${botFilter}
GROUP BY key
ORDER BY views DESC
LIMIT ${TOP_LIMIT}
FORMAT JSON
`.trim()
    : null;

  try {
    const [topPages, countries, totals, pathCountries] = await Promise.all([
      runAnalyticsSql<{ key: string; views: number | string }>(accountId, apiToken, topPagesSql),
      runAnalyticsSql<{ key: string; views: number | string }>(accountId, apiToken, countriesSql),
      runAnalyticsSql<{ views: number | string }>(accountId, apiToken, totalSql),
      pathCountriesSql
        ? runAnalyticsSql<{ key: string; views: number | string }>(accountId, apiToken, pathCountriesSql)
        : Promise.resolve([] as { key: string; views: number | string }[]),
    ]);

    return {
      range: params.range,
      excludeBots,
      selectedPath,
      configured: true,
      dataset,
      topPages: topPages.map(normalizeStatRow).filter((row) => row.key),
      countries: countries.map(normalizeStatRow).filter((row) => row.key),
      pathCountries: pathCountries.map(normalizeStatRow).filter((row) => row.key),
      totalViews: Number(totals[0]?.views ?? 0) || 0,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[page-view-analytics] query failed', { message, dataset, range: params.range });
    return {
      range: params.range,
      excludeBots,
      selectedPath,
      configured: true,
      dataset,
      topPages: [],
      countries: [],
      pathCountries: [],
      totalViews: 0,
      error: message,
    };
  }
}

function normalizeStatRow(row: { key: string; views: number | string }): PageViewStatRow {
  return {
    key: String(row.key ?? ''),
    views: Number(row.views) || 0,
  };
}

async function runAnalyticsSql<T extends Record<string, unknown>>(
  accountId: string,
  apiToken: string,
  sql: string,
): Promise<T[]> {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
    },
    body: sql,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Analytics SQL HTTP ${response.status}: ${truncate(text, 400)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Analytics SQL returned non-JSON: ${truncate(text, 200)}`);
  }

  if (parsed && typeof parsed === 'object' && 'data' in parsed && Array.isArray((parsed as { data: unknown }).data)) {
    return (parsed as { data: T[] }).data;
  }

  // Some account responses wrap under Cloudflare's usual envelope.
  if (
    parsed
    && typeof parsed === 'object'
    && 'result' in parsed
    && (parsed as { result: unknown }).result
    && typeof (parsed as { result: unknown }).result === 'object'
    && 'data' in ((parsed as { result: { data?: unknown } }).result)
    && Array.isArray((parsed as { result: { data: T[] } }).result.data)
  ) {
    return (parsed as { result: { data: T[] } }).result.data;
  }

  throw new Error(`Unexpected Analytics SQL response shape: ${truncate(text, 200)}`);
}

function readPageViewsBinding(): AnalyticsEngineDataset | null {
  const runtime = cfEnv as Record<string, unknown>;
  const candidate = runtime[PAGE_VIEWS_BINDING];
  if (candidate && typeof candidate === 'object' && 'writeDataPoint' in candidate) {
    return candidate as AnalyticsEngineDataset;
  }
  return null;
}

function getRequestCf(request: Request): RequestCf | undefined {
  return (request as Request & { cf?: RequestCf }).cf;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}…`;
}
