import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { detect as detectClusterTitleLanguage, detect as detectGoogleNewsItemLanguage } from 'tinyld';
import { ALL_CULT_TERMS, getCultTermsForLanguage } from './cultTerms.js';
import { fetchJsonWithCache, fetchTextWithCache } from './httpCache.js';
import {
  FOCUS_SIGNAL_TERMS,
  GOOGLE_NEWS_GENERIC_QUERIES,
  GOOGLE_NEWS_GENERIC_QUERY_SPECS,
  GOOGLE_NEWS_QUERY_GROUPS,
  GOOGLE_NEWS_WATCHLIST_SITES,
  LOCALE_LANG_FILES,
  NEWSDATA_COUNTRY_CODES,
  NEWSDATA_LANGUAGES,
  NEWSDATA_QUERIES,
  PRIORITY_WATCHLIST_HOSTS,
  REGION_TERMS,
} from './discoveryConfig.js';
import { loadGroupStopwordsByLanguageFromDiscoveryLangFiles } from './discoveryLangGroupStopwords.js';
import {
  getCoerciveHarmTermsForLanguage,
  getReligiousGroupTermsForLanguage,
} from './pipelineTerms.js';

type GoogleNewsUrlDecoder = {
  decode: (url: string) => Promise<{ status?: boolean; decoded_url?: string; message?: string }>;
};

type FeedFetchFailure = {
  feedId: string;
  feedTitle: string;
  feedUrl: string;
  timestamp: string;
  status?: number;
  finalUrl?: string;
  contentType?: string;
  requestDurationMs?: number;
  networkAttempts?: number;
  errorMessage?: string;
  requestHeaders: Record<string, string>;
};

const FEED_REQUEST_HEADERS = {
  'User-Agent': 'FreedomTimes-Local-Agent/0.1',
  Accept:
    'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.8, */*;q=0.7',
};

/** One Google News RSS search (optional edition pin for cluster follow-ups). */
export type GoogleNewsQueryRunSpec = {
  query: string;
  /** When set, only these `GoogleNewsLocale.id` cells are fetched (e.g. `FR-fr`). */
  googleNewsLocaleIds?: readonly string[];
};

export type DiscoveredStory = {
  url: string;
  title: string;
  publishedAt?: string;
  discoveryScore?: number;
  discoveryScoreBreakdown?: Record<string, number>;
  sourceFeed: string;
  sourceFormat: 'rss' | 'atom' | 'xml' | 'x' | 'newsio' | 'html';
  sourceCategory: 'publisher-feed' | 'aggregator-feed' | 'platform' | 'api' | 'web-page';
  requiresUrlResolution: boolean;
  sourceLanguage?: string;
  publisherName?: string;
  publisherUrl?: string;
};

type FeedDefinition = {
  id: string;
  title: string;
  url: string;
  language: string;
  sourceFormat: 'rss' | 'atom' | 'xml';
  sourceCategory: 'publisher-feed' | 'aggregator-feed';
  requiresUrlResolution: boolean;
  enabled: boolean;
};

function loadFeedDefinitions(): FeedDefinition[] {
  try {
    const configUrl = new URL('../feeds.json', import.meta.url);
    const raw = readFileSync(configUrl, 'utf-8');
    const parsed = JSON.parse(raw) as { feeds?: FeedDefinition[] };
    const feeds = parsed.feeds ?? [];

    return feeds.filter((feed) => {
      return (
        typeof feed.id === 'string' &&
        typeof feed.title === 'string' &&
        typeof feed.url === 'string' &&
        typeof feed.language === 'string' &&
        typeof feed.sourceFormat === 'string' &&
        typeof feed.sourceCategory === 'string' &&
        typeof feed.requiresUrlResolution === 'boolean' &&
        typeof feed.enabled === 'boolean'
      );
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[agent] failed to load feeds.json', { message });
    return [];
  }
}

const FEEDS = loadFeedDefinitions();

/**
 * Positive integer cap, or unlimited when env unset / empty / `0` / invalid.
 * Use for expansion and watchlist chunking so defaults do not hide queries from the plan.
 */
function readPositiveIntCapOrUnlimited(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') {
    return Number.POSITIVE_INFINITY;
  }
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || n <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return n;
}

function capSlice<T>(items: readonly T[], max: number): T[] {
  if (!Number.isFinite(max) || max >= items.length) {
    return [...items];
  }
  return items.slice(0, max);
}

function rotateSlice<T>(items: readonly T[], max: number, seed: number): T[] {
  if (!Number.isFinite(max) || max >= items.length) {
    return [...items];
  }
  if (max <= 0 || items.length === 0) {
    return [];
  }
  const start = Math.abs(seed) % items.length;
  const rotated = [...items.slice(start), ...items.slice(0, start)];
  return rotated.slice(0, max);
}

const CLUSTER_EXPANSION_ENABLED = (process.env.CLUSTER_EXPANSION_ENABLED ?? 'true').toLowerCase() !== 'false';
const CLUSTER_EXPANSION_MIN_CLUSTER_SIZE = Math.max(
  2,
  Number.parseInt(process.env.CLUSTER_EXPANSION_MIN_CLUSTER_SIZE ?? '3', 10) || 3,
);
const CLUSTER_EXPANSION_MIN_SCORE = Math.max(
  1,
  Number.parseInt(process.env.CLUSTER_EXPANSION_MIN_SCORE ?? '70', 10) || 70,
);
const CLUSTER_EXPANSION_MAX_CLUSTERS = readPositiveIntCapOrUnlimited(process.env.CLUSTER_EXPANSION_MAX_CLUSTERS);
const CLUSTER_EXPANSION_MAX_QUERIES_PER_CLUSTER = readPositiveIntCapOrUnlimited(
  process.env.CLUSTER_EXPANSION_MAX_QUERIES_PER_CLUSTER,
);
const CLUSTER_EXPANSION_MAX_TOTAL_QUERIES = readPositiveIntCapOrUnlimited(
  process.env.CLUSTER_EXPANSION_MAX_TOTAL_QUERIES,
);
/** When fewer than `CLUSTER_EXPANSION_MIN_CLUSTER_SIZE` high-scoring stories exist, still run a small follow-up Google News pass from title phrases (“cluster of one”). */
const CLUSTER_EXPANSION_SINGLETON_ENABLED =
  (process.env.CLUSTER_EXPANSION_SINGLETON_ENABLED ?? 'true').toLowerCase() !== 'false';
const CLUSTER_EXPANSION_SINGLETON_MAX_STORIES = readPositiveIntCapOrUnlimited(
  process.env.CLUSTER_EXPANSION_SINGLETON_MAX_STORIES,
);

/**
 * Optional safety bound on total RSS-derived Google News rows per run (`0` = unlimited).
 * Prefer tuning broad queries + `when:` over relying on a low cap.
 */
const GOOGLE_NEWS_TOTAL_CAP_RAW = Number.parseInt(process.env.GOOGLE_NEWS_TOTAL_CAP ?? '0', 10);
const GOOGLE_NEWS_TOTAL_CAP =
  Number.isFinite(GOOGLE_NEWS_TOTAL_CAP_RAW) && GOOGLE_NEWS_TOTAL_CAP_RAW > 0 ? GOOGLE_NEWS_TOTAL_CAP_RAW : 0;

const GOOGLE_NEWS_GENERIC_QUERY_LIMIT = readPositiveIntCapOrUnlimited(
  process.env.GOOGLE_NEWS_GENERIC_QUERY_LIMIT ?? '',
);

/**
 * Max `site:` hosts per OR-merge before splitting (`0` / unset = one query with every host for that bundle).
 */
const GOOGLE_NEWS_WATCHLIST_SITE_OR_CHUNK = readPositiveIntCapOrUnlimited(
  process.env.GOOGLE_NEWS_WATCHLIST_SITE_OR_CHUNK ?? '1',
);

const GOOGLE_NEWS_RESOLVE_USE_PLAYWRIGHT =
  (process.env.GOOGLE_NEWS_RESOLVE_USE_PLAYWRIGHT ?? 'false').toLowerCase() === 'true';
/** Max Playwright navigations per discovery run (`0` = unlimited when Playwright resolve is on). */
const GOOGLE_NEWS_PLAYWRIGHT_MAX_RESOLVES = readPositiveIntCapOrUnlimited(
  process.env.GOOGLE_NEWS_PLAYWRIGHT_MAX_RESOLVES,
);

type GoogleNewsWrappedLinkRecord = {
  recordedAt: string;
  sourcePrefix: string;
  localeId: string;
  queryPreview: string;
  title: string;
  guid?: string;
  rssItemLink: string;
  resolvedUrl: string;
  publisherName?: string;
  publisherUrl?: string;
  descriptionText?: string;
  descriptionLinks?: string[];
};

const googleNewsWrappedLinkBuffer: GoogleNewsWrappedLinkRecord[] = [];
let googleNewsPlaywrightAttemptsThisRun = 0;
let googleNewsPlaywrightSuccessesThisRun = 0;

export function resetGoogleNewsDiscoveryReporting(): void {
  googleNewsWrappedLinkBuffer.length = 0;
  googleNewsPlaywrightAttemptsThisRun = 0;
  googleNewsPlaywrightSuccessesThisRun = 0;
}

function recordGoogleNewsWrappedLink(entry: Omit<GoogleNewsWrappedLinkRecord, 'recordedAt'>): void {
  googleNewsWrappedLinkBuffer.push({
    recordedAt: new Date().toISOString(),
    ...entry,
  });
}

export function flushGoogleNewsWrappedLinksReport(): void {
  if (googleNewsWrappedLinkBuffer.length === 0) {
    return;
  }
  const reportsDir = new URL('../reports/', import.meta.url);
  mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const payload = {
    recordedAt: new Date().toISOString(),
    count: googleNewsWrappedLinkBuffer.length,
    playwrightAttemptsThisRun: googleNewsPlaywrightAttemptsThisRun,
    playwrightSuccessesThisRun: googleNewsPlaywrightSuccessesThisRun,
    items: [...googleNewsWrappedLinkBuffer],
  };
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  writeFileSync(new URL(`google-news-wrapped-links-${stamp}.json`, reportsDir), json, 'utf-8');
  writeFileSync(new URL('google-news-wrapped-links-latest.json', reportsDir), json, 'utf-8');
  console.log('[agent] google-news wrapped RSS links report written', {
    path: 'reports/google-news-wrapped-links-latest.json',
    count: payload.count,
    playwrightAttemptsThisRun: payload.playwrightAttemptsThisRun,
    playwrightSuccessesThisRun: payload.playwrightSuccessesThisRun,
  });
  googleNewsWrappedLinkBuffer.length = 0;
  googleNewsPlaywrightAttemptsThisRun = 0;
  googleNewsPlaywrightSuccessesThisRun = 0;
}

function writeFeedFetchFailuresReport(feedFailures: FeedFetchFailure[]): void {
  if (feedFailures.length === 0) {
    return;
  }

  const reportsDir = new URL('../reports/', import.meta.url);
  mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const payload = {
    generatedAt: new Date().toISOString(),
    count: feedFailures.length,
    rows: feedFailures,
  };
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  writeFileSync(new URL(`feed-fetch-failures-${stamp}.json`, reportsDir), json, 'utf-8');
  writeFileSync(new URL('feed-fetch-failures-latest.json', reportsDir), json, 'utf-8');
  console.log('[agent] feed fetch failures report written', {
    path: 'reports/feed-fetch-failures-latest.json',
    count: feedFailures.length,
  });
}

/** Pacing between Google News RSS cells to reduce 429/503 bursts (0 = off). */
const GOOGLE_NEWS_RSS_REQUEST_GAP_MS = Math.max(
  0,
  Number.parseInt(process.env.GOOGLE_NEWS_RSS_REQUEST_GAP_MS ?? '200', 10) || 0,
);

/** Extra pause after a 503 on Google News RSS so rate limits can recover (0 = off). */
const GOOGLE_NEWS_RSS_AFTER_503_MS = Math.max(
  0,
  Number.parseInt(process.env.GOOGLE_NEWS_RSS_AFTER_503_MS ?? '0', 10) || 0,
);

const GOOGLE_NEWS_RSS_TIMEOUT_MS = Math.max(
  1000,
  Number.parseInt(process.env.GOOGLE_NEWS_RSS_TIMEOUT_MS ?? '8000', 10) || 8000,
);

const GOOGLE_NEWS_RSS_MAX_CONSECUTIVE_THROTTLES = Math.max(
  1,
  Number.parseInt(process.env.GOOGLE_NEWS_RSS_MAX_CONSECUTIVE_THROTTLES ?? '5', 10) || 5,
);

/** Concurrent article link resolutions after each RSS parse (same URL shares one in-flight job). */
const GOOGLE_NEWS_LINK_RESOLVE_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.GOOGLE_NEWS_LINK_RESOLVE_CONCURRENCY ?? '1', 10) || 1,
);

/** How far ahead to schedule link resolves (items in the feed), as a multiple of concurrency. */
const GOOGLE_NEWS_LINK_PREFETCH_MULT = Math.max(
  1,
  Number.parseInt(process.env.GOOGLE_NEWS_LINK_PREFETCH_MULT ?? '1', 10) || 1,
);

const GOOGLE_NEWS_PRERESOLVE_TITLE_FILTER =
  (process.env.GOOGLE_NEWS_PRERESOLVE_TITLE_FILTER ?? 'true').toLowerCase() !== 'false';

/** Write `reports/google-news-query-plan-*.json` (and `-latest`) before each main Google News pass. */
const GOOGLE_NEWS_RECORD_QUERY_PLAN =
  (process.env.GOOGLE_NEWS_RECORD_QUERY_PLAN ?? 'true').toLowerCase() !== 'false';

/** If true, each plan row includes `localeIds` (much larger JSON). `rssCells` is always included. */
const GOOGLE_NEWS_QUERY_PLAN_INCLUDE_LOCALE_IDS =
  (process.env.GOOGLE_NEWS_QUERY_PLAN_INCLUDE_LOCALE_IDS ?? 'false').toLowerCase() === 'true';

const DISCOVERY_GOOGLE_NEWS_ENABLED =
  (process.env.DISCOVERY_GOOGLE_NEWS_ENABLED ?? 'true').toLowerCase() !== 'false';

const NEWSDATA_ENABLED = (process.env.NEWSDATA_ENABLED ?? 'false').toLowerCase() === 'true';
const NEWSIO_API_KEY = process.env.NEWSIO_API_KEY ?? process.env.NEWSDATA_API_KEY;
const NEWSDATA_BASE_URL = 'https://newsdata.io/api/1/latest';
const NEWSDATA_QUERY_LIMIT = 10;
const DISCOVERY_MAX_AGE_HOURS = (() => {
  const raw = process.env.DISCOVERY_MAX_AGE_HOURS?.trim();
  if (!raw) {
    throw new Error('DISCOVERY_MAX_AGE_HOURS must be provided as runtime input');
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error('DISCOVERY_MAX_AGE_HOURS must be a positive integer');
  }

  return parsed;
})();
const DEFAULT_DISCOVERY_PUBLISHED_AT_LOOKUP_LIMIT = 120;
const DISCOVERY_PUBLISHED_AT_LOOKUP_LIMIT = Math.max(
  0,
  Number.parseInt(
    process.env.DISCOVERY_PUBLISHED_AT_LOOKUP_LIMIT ?? `${DEFAULT_DISCOVERY_PUBLISHED_AT_LOOKUP_LIMIT}`,
    10,
  ) || DEFAULT_DISCOVERY_PUBLISHED_AT_LOOKUP_LIMIT,
);
const NEWSIO_CACHE_ENABLED = (process.env.NEWSIO_CACHE_ENABLED ?? 'true').toLowerCase() !== 'false';
const DEFAULT_NEWSIO_CACHE_TTL_MINUTES = 360;
const NEWSIO_CACHE_TTL_MINUTES = Math.max(
  1,
  Number.parseInt(process.env.NEWSIO_CACHE_TTL_MINUTES ?? `${DEFAULT_NEWSIO_CACHE_TTL_MINUTES}`, 10) ||
    DEFAULT_NEWSIO_CACHE_TTL_MINUTES,
);
const NEWSDATA_CACHE_PATH = new URL('../.cache/newsdata-cache.json', import.meta.url);
const DEFAULT_NEWSIO_MAX_CREDITS_PER_RUN = 6;

const HEADLINEFEED_ENABLED = (process.env.HEADLINEFEED_ENABLED ?? 'false').toLowerCase() === 'true';
const HEADLINEFEED_API_KEY = process.env.HEADLINEFEED_API_KEY;
const HEADLINEFEED_BASE_URL = 'https://api.headlinefeed.dev/api/search';
const HEADLINEFEED_CACHE_PATH = new URL('../.cache/headlinefeed-cache.json', import.meta.url);
const DEFAULT_HEADLINEFEED_CACHE_TTL_MINUTES = 360;
const HEADLINEFEED_CACHE_TTL_MINUTES = Math.max(
  1,
  Number.parseInt(
    process.env.HEADLINEFEED_CACHE_TTL_MINUTES ?? `${DEFAULT_HEADLINEFEED_CACHE_TTL_MINUTES}`,
    10,
  ) || DEFAULT_HEADLINEFEED_CACHE_TTL_MINUTES,
);
const NEWSIO_MAX_CREDITS_PER_RUN = Math.max(
  1,
  Number.parseInt(process.env.NEWSIO_MAX_CREDITS_PER_RUN ?? `${DEFAULT_NEWSIO_MAX_CREDITS_PER_RUN}`, 10) ||
    DEFAULT_NEWSIO_MAX_CREDITS_PER_RUN,
);

type HeadlineFeedArticle = {
  title?: string;
  url?: string;
  source?: string;
  publishedAt?: string;
  description?: string;
};

type HeadlineFeedCacheEntry = {
  fetchedAt: string;
  results: HeadlineFeedArticle[];
};

type HeadlineFeedCache = {
  version: 1;
  entries: Record<string, HeadlineFeedCacheEntry>;
};

function loadHeadlineFeedCache(): HeadlineFeedCache {
  try {
    const raw = readFileSync(HEADLINEFEED_CACHE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as { version?: number; entries?: Record<string, HeadlineFeedCacheEntry> };
    if (parsed.version === 1 && parsed.entries && typeof parsed.entries === 'object') {
      return { version: 1, entries: parsed.entries };
    }
  } catch {
    // Missing or invalid cache — start fresh.
  }
  return { version: 1, entries: {} };
}

function saveHeadlineFeedCache(cache: HeadlineFeedCache): void {
  try {
    mkdirSync(new URL('../.cache/', import.meta.url), { recursive: true });
    writeFileSync(HEADLINEFEED_CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`, 'utf-8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[agent] failed to write headlinefeed cache', { message });
  }
}

function isHeadlineFeedCacheEntryFresh(entry: HeadlineFeedCacheEntry): boolean {
  const fetchedAtEpochMs = Date.parse(entry.fetchedAt);
  if (!Number.isFinite(fetchedAtEpochMs)) {
    return false;
  }
  const ageMs = Date.now() - fetchedAtEpochMs;
  const ttlMs = HEADLINEFEED_CACHE_TTL_MINUTES * 60 * 1000;
  return ageMs >= 0 && ageMs <= ttlMs;
}

function buildHeadlineFeedDateRange(): { startDate: string; endDate: string } {
  const maxAgeMs = Math.min(DISCOVERY_MAX_AGE_HOURS, 168) * 60 * 60 * 1000;
  const startDate = new Date(Date.now() - maxAgeMs).toISOString().slice(0, 10);
  const endDate = new Date().toISOString().slice(0, 10);
  return { startDate, endDate };
}

async function discoverFromHeadlineFeed(): Promise<DiscoveredStory[]> {
  if (!HEADLINEFEED_ENABLED) {
    return [];
  }

  if (!HEADLINEFEED_API_KEY) {
    console.warn('[agent] HeadlineFeed enabled but HEADLINEFEED_API_KEY is missing');
    return [];
  }

  const searchTerms = ['cult', 'cults', 'sect', 'sects', 'brainwashing', 'trafficking', 'slavery'];
  const { startDate, endDate } = buildHeadlineFeedDateRange();
  const discovered: DiscoveredStory[] = [];
  const cache = loadHeadlineFeedCache();
  let cacheUpdated = false;
  let termIndex = 0;

  logDiscoveryProgress('headlinefeed-start', { termCount: searchTerms.length, startDate, endDate });

  for (const term of searchTerms) {
    termIndex += 1;
    const cacheKey = `${term}|${startDate}|${endDate}`;
    const discoveredBefore = discovered.length;
    let results: HeadlineFeedArticle[];

    const cached = cache.entries[cacheKey];
    if (cached && isHeadlineFeedCacheEntryFresh(cached)) {
      console.log('[agent] headlinefeed cache hit', { term, resultCount: cached.results.length });
      results = cached.results;
    } else {
      try {
        const httpResponse = await fetch(HEADLINEFEED_BASE_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${HEADLINEFEED_API_KEY}`,
            'Content-Type': 'application/json',
            'User-Agent': 'FreedomTimes-Local-Agent/0.1',
          },
          body: JSON.stringify({ title: term, startDate, endDate }),
        });

        if (!httpResponse.ok) {
          console.warn('[agent] headlinefeed fetch failed', { term, status: httpResponse.status });
          logDiscoveryProgress('headlinefeed-running', {
            termIndex,
            termCount: searchTerms.length,
            term,
            discovered: discovered.length,
            addedThisQuery: 0,
            fetchOk: false,
          });
          continue;
        }

        const payload = await httpResponse.json() as { headlines?: HeadlineFeedArticle[] };
        results = payload.headlines ?? [];
        cache.entries[cacheKey] = { fetchedAt: new Date().toISOString(), results };
        cacheUpdated = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn('[agent] headlinefeed fetch error', { term, message });
        logDiscoveryProgress('headlinefeed-running', {
          termIndex,
          termCount: searchTerms.length,
          term,
          discovered: discovered.length,
          addedThisQuery: 0,
          fetchError: true,
        });
        continue;
      }
    }

    for (const item of results) {
      const url = normalizePossibleUrl(item.url);
      const title = (item.title ?? '').trim();

      if (!url || !title) {
        continue;
      }

      if (!getHost(url)) {
        continue;
      }

      const publishedAt = normalizePublishedAt(item.publishedAt);
      if (!isWithinFreshnessWindow(publishedAt)) {
        continue;
      }

      discovered.push({
        url,
        title,
        publishedAt,
        sourceFeed: `headlinefeed:${term}`,
        sourceFormat: 'newsio',
        sourceCategory: 'api',
        requiresUrlResolution: false,
        publisherName: item.source,
      });
    }

    logDiscoveryProgress('headlinefeed-running', {
      termIndex,
      termCount: searchTerms.length,
      term,
      discovered: discovered.length,
      addedThisQuery: discovered.length - discoveredBefore,
      resultRows: results.length,
      fetchOk: true,
    });
  }

  if (cacheUpdated) {
    saveHeadlineFeedCache(cache);
  }

  logDiscoveryProgress('headlinefeed-complete', { discovered: discovered.length });
  return discovered;
}

function logDiscoveryProgress(stage: string, data: Record<string, unknown>): void {
  console.log(
    `[agent][progress] ${JSON.stringify({ scope: 'discovery', at: new Date().toISOString(), stage, ...data })}`,
  );
}

const DISCOVERY_PROGRESS_GOOGLE_NEWS_EVERY = Math.max(
  1,
  Number.parseInt(process.env.DISCOVERY_PROGRESS_GOOGLE_NEWS_EVERY ?? '10', 10) || 10,
);
const DISCOVERY_PROGRESS_FEEDS_EVERY = Math.max(
  1,
  Number.parseInt(process.env.DISCOVERY_PROGRESS_FEEDS_EVERY ?? '5', 10) || 5,
);

const DISCOVERY_LOG_EVERY_GOOGLE_NEWS_HTTP =
  (process.env.DISCOVERY_LOG_EVERY_GOOGLE_NEWS_HTTP ?? 'false').toLowerCase() === 'true';

/** Log fetch-start / fetch-done per RSS cell so long network waits are visible (set false to reduce noise). */
const DISCOVERY_LOG_GOOGLE_NEWS_FETCH_LIFECYCLE =
  (process.env.DISCOVERY_LOG_GOOGLE_NEWS_FETCH_LIFECYCLE ?? 'true').toLowerCase() !== 'false';

/** While resolving Google News article links after RSS parse, log every N resolutions (1 = every link). */
const DISCOVERY_PROGRESS_GOOGLE_NEWS_LINK_RESOLVE_EVERY = Math.max(
  1,
  Number.parseInt(process.env.DISCOVERY_PROGRESS_GOOGLE_NEWS_LINK_RESOLVE_EVERY ?? '5', 10) || 5,
);

function truncateForProgress(value: string, maxLen: number): string {
  const t = value.replace(/\s+/g, ' ').trim();
  if (t.length <= maxLen) {
    return t;
  }
  return `${t.slice(0, maxLen - 1)}…`;
}

function sleepMs(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatWatchlistOrGroup(terms: string[]): string {
  return `(${terms.join(' OR ')})`;
}

function chunkArray<T>(items: readonly T[], chunkSize: number): T[][] {
  if (!Number.isFinite(chunkSize) || chunkSize <= 0) {
    return items.length === 0 ? [] : [[...items]];
  }
  const size = Math.max(1, Math.floor(chunkSize));
  if (items.length === 0) {
    return [];
  }
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function formatSiteOrClause(sites: readonly string[]): string {
  const parts = sites.map((s) => `site:${normalizePublisherSiteHost(s)}`);
  return parts.length === 1 ? parts[0]! : `(${parts.join(' OR ')})`;
}

let europeCountryOrMultilingualCache: string[] | undefined;

/** Resolve cult terms for a locale hl subtag from the LocaleLangFile interface. */
function resolveLocaleCultTerms(hl: string): string[] | undefined {
  const locale = LOCALE_LANG_FILES.get(hl);
  if (!locale) return undefined;
  const terms: string[] = [
    ...(locale.cultTerms ?? []),
    ...(locale.harmSignals ?? []),
    ...(locale.religiousGroupTerms ?? []),
  ];
  return terms.length > 0 ? terms : undefined;
}

/** Resolve europeCountryOr terms for a locale hl subtag, or union all locales if 'multilingual'. */
function resolveLocaleCountryTerms(hl: string | 'multilingual'): string[] | undefined {
  if (hl === 'multilingual') {
    if (!europeCountryOrMultilingualCache) {
      const set = new Set<string>();
      for (const locale of LOCALE_LANG_FILES.values()) {
        for (const term of locale.europeCountryOr ?? []) {
          set.add(term);
        }
      }
      europeCountryOrMultilingualCache = Array.from(set);
    }
    return europeCountryOrMultilingualCache.length > 0 ? europeCountryOrMultilingualCache : undefined;
  }
  const terms = LOCALE_LANG_FILES.get(hl)?.europeCountryOr;
  return terms && terms.length > 0 ? terms : undefined;
}

/** Load the set of language keys that have watchlist bundles (from the bundles file, keyed by hl). */
function loadWatchlistBundleHls(): Set<string> {
  try {
    const configUrl = new URL('../data/google-news-watchlist-locales.json', import.meta.url);
    const parsed = JSON.parse(readFileSync(configUrl, 'utf-8')) as { locales?: unknown[] };
    const locales = (parsed.locales ?? []).filter((k): k is string => typeof k === 'string' && k.length > 0);
    return new Set(locales.map((k) => k.toLowerCase()));
  } catch {
    return new Set(LOCALE_LANG_FILES.keys());
  }
}

const WATCHLIST_BUNDLE_HLS: Set<string> = loadWatchlistBundleHls();

/** Primary BCP47 subtag for Google News `hl` (e.g. en-GB → en, pt-PT → pt). */
function primaryGoogleNewsHlSubtag(hl: string): string {
  const h = hl.trim().toLowerCase();
  if (h === 'en-gb' || h.startsWith('en-')) {
    return 'en';
  }
  return (h.split('-')[0] ?? h).trim() || 'en';
}

/**
 * When every Google News edition for the host shares one primary `hl` and we have a bundle,
 * returns that language key; otherwise null (one English aggregate OR+OR query per site).
 */
function watchlistUnifiedLanguageKeyForSite(site: string): string | null {
  const host = normalizePublisherSiteHost(site);
  const probe = `site:${host} cult`;
  const allLocales = loadEuropeGoogleNewsLocales();
  const queryLocales = localesForGoogleNewsPublisherQuery(probe, allLocales);
  if (queryLocales.length === 0) {
    return null;
  }

  const subtags = queryLocales.map((locale) => primaryGoogleNewsHlSubtag(locale.hl));
  const unique = new Set(subtags);
  if (unique.size !== 1) {
    return null;
  }

  const lang = [...unique][0]!;
  return WATCHLIST_BUNDLE_HLS.has(lang) ? lang : null;
}

/** When `publisher-host-config.json` pins a watchlist bundle (e.g. German OR+OR for DW despite many `hl`s). */
function watchlistExplicitBundleKeyForSite(site: string): string | null {
  const cfg = loadPublisherSiteLocalesConfig();
  const key = cfg.watchlistQueryBundleByHost?.[normalizePublisherSiteHost(site)];
  if (!key) {
    return null;
  }
  return WATCHLIST_BUNDLE_HLS.has(key.toLowerCase()) ? key.toLowerCase() : null;
}

function watchlistLocaleKeyForSite(site: string): string {
  return watchlistExplicitBundleKeyForSite(site) ?? watchlistUnifiedLanguageKeyForSite(site) ?? 'en-aggregate';
}

function buildWatchlistQuerySuffixForSite(site: string): { kind: 'bundle'; suffix: string } | { kind: 'legacy' } {
  const explicitLang = watchlistExplicitBundleKeyForSite(site);
  if (explicitLang) {
    const cult = resolveLocaleCultTerms(explicitLang);
    if (cult?.length) {
      return { kind: 'bundle', suffix: formatWatchlistOrGroup(cult) };
    }
  }

  const lang = watchlistUnifiedLanguageKeyForSite(site);
  if (lang) {
    const cult = resolveLocaleCultTerms(lang);
    if (cult?.length) {
      return { kind: 'bundle', suffix: formatWatchlistOrGroup(cult) };
    }
  }

  const enCult = resolveLocaleCultTerms('en');
  if (enCult?.length) {
    return { kind: 'bundle', suffix: formatWatchlistOrGroup(enCult) };
  }

  return { kind: 'legacy' };
}

function buildEnglishWatchlistFallbackSuffix(): string | null {
  const cult = resolveLocaleCultTerms('en');
  if (!cult?.length) {
    return null;
  }
  return formatWatchlistOrGroup(cult);
}

/**
 * One Google News `q=` per bundle (cult + country OR-groups), with publishers OR-merged and chunked for URL size.
 * Unmapped sites share one English `en` bundle-shaped suffix (no per-country `cult "…"` grid).
 */
export function buildWatchlistQueries(): string[] {
  const bundleSuffixToSites = new Map<string, string[]>();
  const fallbackSuffix = buildEnglishWatchlistFallbackSuffix();

  for (const site of GOOGLE_NEWS_WATCHLIST_SITES) {
    const resolved = buildWatchlistQuerySuffixForSite(site);
    if (resolved.kind === 'bundle') {
      const list = bundleSuffixToSites.get(resolved.suffix) ?? [];
      list.push(site);
      bundleSuffixToSites.set(resolved.suffix, list);
      continue;
    }

    if (fallbackSuffix) {
      const list = bundleSuffixToSites.get(fallbackSuffix) ?? [];
      list.push(site);
      bundleSuffixToSites.set(fallbackSuffix, list);
    }
  }

  const queries: string[] = [];
  const chunk = GOOGLE_NEWS_WATCHLIST_SITE_OR_CHUNK;

  for (const [suffix, sites] of bundleSuffixToSites) {
    for (const siteChunk of chunkArray(sites, chunk)) {
      queries.push(`${formatSiteOrClause(siteChunk)} ${suffix}`);
    }
  }

  return queries;
}

const CULT_TERMS = ALL_CULT_TERMS;

const CLUSTER_STOPWORD_LANG_ALIASES: Record<string, string> = {
  nb: 'no',
  nn: 'no',
};

let clusterStopwordsByLangCache: Map<string, Set<string>> | undefined;

function normalizeClusterStopwordLang(code: string | undefined): string {
  if (!code || code.length < 2) {
    return 'en';
  }
  const base = code.toLowerCase().trim().split('-')[0] ?? 'en';
  return CLUSTER_STOPWORD_LANG_ALIASES[base] ?? base;
}

function loadClusterStopwordsByLang(): Map<string, Set<string>> {
  if (clusterStopwordsByLangCache) {
    return clusterStopwordsByLangCache;
  }

  const map = new Map<string, Set<string>>();
  try {
    const configUrl = new URL('../data/cluster-token-stopwords.json', import.meta.url);
    const raw = readFileSync(configUrl, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const baseRaw = parsed.base;
    const baseArr = Array.isArray(baseRaw) ? baseRaw : [];
    const baseSet = new Set(baseArr.map((t) => String(t).toLowerCase()));

    for (const [key, val] of Object.entries(parsed)) {
      if (key === 'base' || key.startsWith('_')) {
        continue;
      }
      if (!Array.isArray(val)) {
        continue;
      }
      const set = new Set(baseSet);
      for (const t of val) {
        set.add(String(t).toLowerCase());
      }
      map.set(key.toLowerCase(), set);
    }

    if (!map.has('en')) {
      map.set('en', new Set(baseSet));
    }

    try {
      const groupByLang = loadGroupStopwordsByLanguageFromDiscoveryLangFiles();
      for (const [lang, val] of Object.entries(groupByLang)) {
        if (!Array.isArray(val) || val.length === 0) {
          continue;
        }
        const code = lang.toLowerCase();
        const set = map.get(code) ?? new Set(baseSet);
        for (const t of val) {
          set.add(String(t).toLowerCase());
        }
        map.set(code, set);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[agent] failed to merge discovery lang groupStopwords', { message });
    }

    clusterStopwordsByLangCache = map;
    return map;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[agent] failed to load cluster-token-stopwords.json', { message });
    const fallback = new Set(
      [
        'with', 'from', 'that', 'this', 'after', 'under', 'about', 'into', 'over', 'more', 'than', 'have',
        'been', 'were', 'their', 'they', 'them', 'will', 'what', 'where', 'which', 'while', 'during',
        'religious', 'group', 'groups', 'sect', 'sects', 'cult', 'cults', 'slavery', 'raid', 'raids',
        'police', 'investigation', 'members', 'people', 'arrested', 'bail', 'charged', 'allegations',
      ].map((t) => t.toLowerCase()),
    );
    clusterStopwordsByLangCache = new Map([['en', fallback]]);
    return clusterStopwordsByLangCache;
  }
}

function clusterStopwordsForLanguage(lang: string | undefined): Set<string> {
  const map = loadClusterStopwordsByLang();
  const code = normalizeClusterStopwordLang(lang);
  return map.get(code) ?? map.get('en')!;
}

function detectTitleLanguageForCluster(title: string, hint?: string | undefined): string {
  const trimmed = hint?.trim();
  if (trimmed && trimmed.length >= 2) {
    return normalizeClusterStopwordLang(trimmed);
  }
  if (title.trim().length < 8) {
    return 'en';
  }
  try {
    const d = detectClusterTitleLanguage(title);
    if (d && typeof d === 'string' && d.length >= 2) {
      return normalizeClusterStopwordLang(d);
    }
  } catch {
    // ignore tinyld failures
  }
  return 'en';
}

function decodeXml(text: string): string {
  return text
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTag(block: string, tag: string): string | undefined {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match?.[1] ? decodeXml(match[1]) : undefined;
}

function extractAtomLink(block: string): string | undefined {
  const linkMatch = block.match(/<link[^>]+href=["']([^"']+)["'][^>]*>/i);
  return linkMatch?.[1];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsPhrase(text: string, phrase: string): boolean {
  const escaped = escapeRegExp(phrase.toLowerCase());
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, 'iu');
  return pattern.test(text);
}

function containsTerm(text: string, terms: string[]): boolean {
  const normalized = text.toLowerCase();
  return terms.some((term) => containsPhrase(normalized, term));
}

function googleNewsItemHasPreResolveTitleSignal(item: GoogleNewsFeedItem): boolean {
  const text = `${item.title} ${item.publisherName ?? ''} ${item.descriptionText ?? ''}`.toLowerCase();
  const metadataUrls = [item.publisherUrl, ...item.descriptionLinks].filter((v): v is string => typeof v === 'string');
  const detectedLanguage = detectGoogleNewsItemLanguage(text);
  const localCultTerms = getCultTermsForLanguage(detectedLanguage);
  const localIncidentTerms = [
    ...getReligiousGroupTermsForLanguage(detectedLanguage),
    ...getCoerciveHarmTermsForLanguage(detectedLanguage),
  ];
  return (
    containsTerm(text, localCultTerms) ||
    containsTerm(text, localIncidentTerms) ||
    containsTerm(text, REGION_TERMS) ||
    (FOCUS_SIGNAL_TERMS.length > 0 && containsTerm(text, FOCUS_SIGNAL_TERMS)) ||
    metadataUrls.some(isPriorityWatchlistHost)
  );
}

function normalizePublishedAt(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return new Date(parsed).toISOString();
}

function isWithinFreshnessWindow(publishedAt: string | undefined): boolean {
  if (!publishedAt) {
    return true;
  }

  const publishedAtEpochMs = Date.parse(publishedAt);
  if (!Number.isFinite(publishedAtEpochMs)) {
    return false;
  }

  const ageMs = Date.now() - publishedAtEpochMs;
  if (ageMs < 0) {
    return true;
  }

  const maxAgeMs = DISCOVERY_MAX_AGE_HOURS * 60 * 60 * 1000;
  return ageMs <= maxAgeMs;
}

function detectPublishedAtFromHtml(html: string): string | undefined {
  const patterns = [
    /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+name=["']article:published_time["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+property=["']og:published_time["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+name=["']pubdate["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+name=["']publishdate["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+itemprop=["']datePublished["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<time[^>]+datetime=["']([^"']+)["'][^>]*>/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    const normalized = normalizePublishedAt(match?.[1]);
    if (normalized) {
      return normalized;
    }
  }

  return undefined;
}

async function lookupPublishedAtFromArticle(url: string): Promise<string | undefined> {
  try {
    const response = await fetchTextWithCache(url, {
      headers: {
        'User-Agent': 'FreedomTimes-Local-Agent/0.1',
        Accept: 'text/html,application/xhtml+xml',
      },
    });

    if (!response.ok) {
      return undefined;
    }

    const contentType = response.headers['content-type']?.toLowerCase() ?? '';
    if (contentType && !contentType.includes('html') && !contentType.includes('xml')) {
      return undefined;
    }

    return detectPublishedAtFromHtml(response.text);
  } catch {
    return undefined;
  }
}

async function enrichPublishedAtForMissing(stories: DiscoveredStory[]): Promise<DiscoveredStory[]> {
  const missing = stories.filter((story) => !story.publishedAt).slice(0, DISCOVERY_PUBLISHED_AT_LOOKUP_LIMIT);

  if (missing.length === 0) {
    return stories;
  }

  const lookedUp = new Map<string, string | undefined>();

  await Promise.all(
    missing.map(async (story) => {
      const publishedAt = await lookupPublishedAtFromArticle(story.url);
      lookedUp.set(story.url, publishedAt);
    }),
  );

  const resolvedCount = Array.from(lookedUp.values()).filter((value) => Boolean(value)).length;
  console.log('[agent] discovery publication date enrichment', {
    attempted: missing.length,
    resolved: resolvedCount,
    unresolved: missing.length - resolvedCount,
    lookupLimit: DISCOVERY_PUBLISHED_AT_LOOKUP_LIMIT,
  });

  return stories.map((story) => {
    if (story.publishedAt) {
      return story;
    }

    const lookedUpPublishedAt = lookedUp.get(story.url);
    if (!lookedUpPublishedAt) {
      return story;
    }

    return {
      ...story,
      publishedAt: lookedUpPublishedAt,
    };
  });
}

function parseFeed(
  xml: string,
  feed: Pick<FeedDefinition, 'url' | 'language' | 'sourceFormat' | 'sourceCategory' | 'requiresUrlResolution'>,
): DiscoveredStory[] {
  const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/gi) ?? [];
  const entryBlocks = xml.match(/<entry[\s\S]*?<\/entry>/gi) ?? [];
  const blocks = [...itemBlocks, ...entryBlocks];

  const stories: DiscoveredStory[] = [];
  for (const block of blocks) {
    const title = extractTag(block, 'title') ?? '';
    const link = extractTag(block, 'link') ?? extractAtomLink(block);
    const publishedAt = normalizePublishedAt(
      extractTag(block, 'pubDate') ?? extractTag(block, 'published') ?? extractTag(block, 'updated'),
    );

    if (!title || !link || !isWithinFreshnessWindow(publishedAt)) {
      continue;
    }

    stories.push({
      url: link.trim(),
      title: title.trim(),
      publishedAt,
      sourceFeed: feed.url,
      sourceFormat: feed.sourceFormat,
      sourceCategory: feed.sourceCategory,
      requiresUrlResolution: feed.requiresUrlResolution,
      sourceLanguage: feed.language,
    });
  }

  return stories;
}

type GoogleNewsFeedItem = {
  title: string;
  link: string;
  guid?: string;
  publishedAt?: string;
  publisherName?: string;
  publisherUrl?: string;
  originalUrlFromMetadata?: string;
  descriptionText?: string;
  descriptionLinks: string[];
};

function extractSourceTag(block: string): { publisherName?: string; publisherUrl?: string } {
  const sourceMatch = block.match(/<source[^>]*url=["']([^"']+)["'][^>]*>([\s\S]*?)<\/source>/i);
  if (!sourceMatch) {
    return {};
  }

  const publisherUrl = sourceMatch[1] ? decodeXml(sourceMatch[1]).trim() : undefined;
  const publisherName = sourceMatch[2] ? decodeXml(sourceMatch[2]).trim() : undefined;
  return { publisherName, publisherUrl };
}

function extractOriginalUrlFromDescription(description: string): string | undefined {
  return extractPublisherLinksFromDescription(description)[0];
}

function extractPublisherLinksFromDescription(description: string): string[] {
  const hrefMatches = description.match(/href=["']([^"']+)["']/gi) ?? [];
  const links: string[] = [];
  for (const token of hrefMatches) {
    const hrefMatch = token.match(/href=["']([^"']+)["']/i);
    const href = hrefMatch?.[1] ? decodeXml(hrefMatch[1]).trim() : undefined;
    if (!href) {
      continue;
    }

    try {
      const host = normalizeHost(new URL(href).hostname);
      if (host === 'news.google.com' || host.endsWith('.google.com') || host === 'google.com') {
        continue;
      }
      links.push(href);
    } catch {
      // Ignore malformed links in description.
    }
  }

  return [...new Set(links)];
}

function htmlToPlainText(html: string): string {
  return decodeXml(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseGoogleNewsFeed(xml: string): GoogleNewsFeedItem[] {
  const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/gi) ?? [];
  const items: GoogleNewsFeedItem[] = [];

  for (const block of itemBlocks) {
    const title = extractTag(block, 'title') ?? '';
    const description = extractTag(block, 'description') ?? '';
    const link = extractTag(block, 'link') ?? '';
    const source = extractSourceTag(block);
    const descriptionLinks = extractPublisherLinksFromDescription(description);

    if (!title || !link) {
      continue;
    }

    items.push({
      title: title.trim(),
      link: link.trim(),
      guid: extractTag(block, 'guid')?.trim(),
      publishedAt: normalizePublishedAt(extractTag(block, 'pubDate')),
      publisherName: source.publisherName,
      publisherUrl: source.publisherUrl,
      originalUrlFromMetadata: descriptionLinks[0] ?? extractOriginalUrlFromDescription(description),
      descriptionText: htmlToPlainText(description),
      descriptionLinks,
    });
  }

  return items;
}

type GoogleNewsLocale = {
  /** Stable id for logs and optional GOOGLE_NEWS_LOCALE_IDS filter (e.g. FR-fr, DE-de). */
  id: string;
  hl: string;
  gl: string;
  ceid: string;
};

type CultKeywordRuleJson = {
  hlStartsWith?: string;
  hlEquals?: string;
  extraTerms: string[];
};

type CultKeywordsConfigJson = {
  baseTerms: string[];
  fallbackExtraTerms: string[];
  rules: CultKeywordRuleJson[];
};

let europeGoogleNewsLocalesCache: GoogleNewsLocale[] | undefined;
let cultKeywordsConfigCache: CultKeywordsConfigJson | undefined;

type PublisherSiteLocalesJson = {
  localeIdsByHost?: Record<string, string[]>;
  homepageLangByHost?: Record<string, string>;
  /** Normalized host → bundle key in google-news-watchlist-query-bundles.json (e.g. `de` for German OR+OR query text). */
  watchlistQueryBundleByHost?: Record<string, string>;
};

/** On-disk shape for `data/publisher-host-config.json` (central host rules). */
type PublisherHostConfigFileJson = {
  watchlistQueryBundleByHost?: Record<string, string>;
  hosts?: Record<
    string,
    {
      googleNewsLocaleIds?: string[];
      homepageLang?: string;
      localeSource?: string;
    }
  >;
  /** Legacy flat map (older `google-news-publisher-site-locales.json`); still supported if present. */
  localeIdsByHost?: Record<string, string[]>;
};

let publisherSiteLocalesCache: PublisherSiteLocalesJson | undefined;
const warnedPublisherHostsWithoutRule = new Set<string>();

function loadCountryTldToGoogleNewsGl(): Record<string, string> {
  const fileUrl = new URL('../data/country-tld-to-google-news-gl.json', import.meta.url);
  const raw = readFileSync(fileUrl, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('data/country-tld-to-google-news-gl.json must be a JSON object');
  }

  const result: Record<string, string> = {};
  for (const [tld, gl] of Object.entries(parsed)) {
    if (typeof gl !== 'string') {
      throw new Error(`data/country-tld-to-google-news-gl.json: value for "${tld}" must be a string`);
    }
    result[tld.toLowerCase()] = gl.toUpperCase();
  }
  return result;
}

const CC_TLD_TO_GL = loadCountryTldToGoogleNewsGl();

function loadPublisherSiteLocalesConfig(): PublisherSiteLocalesJson {
  if (publisherSiteLocalesCache) {
    return publisherSiteLocalesCache;
  }

  try {
    const configUrl = new URL('../data/publisher-host-config.json', import.meta.url);
    const raw = readFileSync(configUrl, 'utf-8');
    const parsed = JSON.parse(raw) as PublisherHostConfigFileJson;
    const localeIdsByHost: Record<string, string[]> = {};
    const homepageLangByHost: Record<string, string> = {};

    const watchlistQueryBundleByHost: Record<string, string> = {};
    const rawBundleMap =
      parsed.watchlistQueryBundleByHost && typeof parsed.watchlistQueryBundleByHost === 'object'
        ? parsed.watchlistQueryBundleByHost
        : {};
    for (const [k, v] of Object.entries(rawBundleMap)) {
      if (k.startsWith('_') || typeof v !== 'string' || !v.trim()) {
        continue;
      }
      watchlistQueryBundleByHost[normalizePublisherSiteHost(k)] = v.trim().toLowerCase();
    }

    const nestedHosts = parsed.hosts && typeof parsed.hosts === 'object' && !Array.isArray(parsed.hosts) ? parsed.hosts : {};
    for (const [k, entry] of Object.entries(nestedHosts)) {
      if (k.startsWith('_') || !entry || typeof entry !== 'object') {
        continue;
      }
      const ids = entry.googleNewsLocaleIds;
      if (typeof entry.homepageLang === 'string' && entry.homepageLang.trim()) {
        homepageLangByHost[normalizePublisherSiteHost(k)] = entry.homepageLang.trim();
      }
      if (Array.isArray(ids) && ids.length > 0) {
        localeIdsByHost[normalizePublisherSiteHost(k)] = ids.filter((id): id is string => typeof id === 'string');
      }
    }

    const legacyFlat =
      parsed.localeIdsByHost && typeof parsed.localeIdsByHost === 'object' && !Array.isArray(parsed.localeIdsByHost)
        ? parsed.localeIdsByHost
        : {};
    for (const [k, v] of Object.entries(legacyFlat)) {
      if (!Array.isArray(v)) {
        continue;
      }
      const host = normalizePublisherSiteHost(k);
      const cleaned = v.filter((id): id is string => typeof id === 'string');
      if (cleaned.length === 0) {
        continue;
      }
      if (!localeIdsByHost[host]) {
        localeIdsByHost[host] = cleaned;
      }
    }

    publisherSiteLocalesCache = {
      localeIdsByHost,
      homepageLangByHost,
      watchlistQueryBundleByHost:
        Object.keys(watchlistQueryBundleByHost).length > 0 ? watchlistQueryBundleByHost : undefined,
    };
    return publisherSiteLocalesCache;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[agent] failed to load publisher-host-config.json', { message });
    publisherSiteLocalesCache = { localeIdsByHost: {} };
    return publisherSiteLocalesCache;
  }
}

function normalizePublisherSiteHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/^["']+|["']+$/g, '');
}

/** Every `site:` host in the query (supports merged `(site:a OR site:b) …`). */
function extractAllSiteHostsFromGoogleNewsQuery(query: string): string[] {
  const raw: string[] = [];
  const re = /\bsite:\s*([^\s)]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query)) !== null) {
    const captured = m[1];
    if (captured) {
      raw.push(normalizePublisherSiteHost(captured));
    }
  }
  return [...new Set(raw)];
}

/** First `site:` host in the query, if any (for logs / plan summaries). */
function extractSiteHostFromGoogleNewsQuery(query: string): string | undefined {
  return extractAllSiteHostsFromGoogleNewsQuery(query)[0];
}

function resolveGlsFromPublisherHostname(host: string): string[] | undefined {
  const h = host.toLowerCase();
  if (h.endsWith('.co.uk') || h === 'uk' || h.endsWith('.uk')) {
    return ['GB'];
  }

  const parts = h.split('.').filter(Boolean);
  if (parts.length < 2) {
    return undefined;
  }

  const tld = parts[parts.length - 1]!;
  const gl = CC_TLD_TO_GL[tld];
  if (gl) {
    return [gl];
  }

  return undefined;
}

function primaryHomepageLangSubtag(lang: string | undefined): string {
  if (!lang) {
    return '';
  }
  const first = lang.split(/[;,]/)[0]?.trim().toLowerCase() ?? '';
  return (first.split('-')[0] ?? '').trim();
}

function localesFromHomepageLang(homepageLang: string | undefined, allLocales: GoogleNewsLocale[]): GoogleNewsLocale[] {
  const subtag = primaryHomepageLangSubtag(homepageLang);
  if (!subtag) {
    return [];
  }

  const matches = allLocales.filter((locale) => primaryGoogleNewsHlSubtag(locale.hl) === subtag);
  if (matches.length > 0) {
    return matches;
  }

  if (subtag === 'sl') {
    return allLocales.filter((locale) => locale.id === 'SI-sl');
  }
  if (subtag === 'sr') {
    return allLocales.filter((locale) => locale.id === 'RS-sr-Latn' || locale.id === 'ME-sr-Latn');
  }

  return [];
}

function localesForSingleSiteHost(siteHost: string, allLocales: GoogleNewsLocale[]): GoogleNewsLocale[] {
  const cfg = loadPublisherSiteLocalesConfig();
  const byHost = cfg.localeIdsByHost ?? {};
  const explicit = byHost[siteHost];
  if (explicit && explicit.length > 0) {
    const idSet = new Set(explicit);
    const picked = allLocales.filter((l) => idSet.has(l.id));
    if (picked.length > 0) {
      return picked;
    }
  }

  const homepageLocales = localesFromHomepageLang(cfg.homepageLangByHost?.[siteHost], allLocales);
  if (homepageLocales.length > 0) {
    return homepageLocales;
  }

  const gls = resolveGlsFromPublisherHostname(siteHost);
  if (gls && gls.length > 0) {
    const glSet = new Set(gls);
    return allLocales.filter((l) => glSet.has(l.gl));
  }

  if (!warnedPublisherHostsWithoutRule.has(siteHost)) {
    warnedPublisherHostsWithoutRule.add(siteHost);
    console.warn('[agent] google-news site: host has no locale rule; using all editions', {
      host: siteHost,
      hint: 'data/publisher-host-config.json',
    });
  }

  return allLocales;
}

/**
 * For `site:publisher` watchlist queries, only Google News editions that match the publishers' markets.
 * Merged `(site:a OR site:b)` uses the union of each host's editions. Generic queries (no `site:`) use all locales.
 */
function localesForGoogleNewsPublisherQuery(query: string, allLocales: GoogleNewsLocale[]): GoogleNewsLocale[] {
  const siteHosts = extractAllSiteHostsFromGoogleNewsQuery(query);
  if (siteHosts.length === 0) {
    return allLocales;
  }

  const byId = new Map<string, GoogleNewsLocale>();
  for (const siteHost of siteHosts) {
    for (const loc of localesForSingleSiteHost(siteHost, allLocales)) {
      byId.set(loc.id, loc);
    }
  }

  return byId.size > 0 ? [...byId.values()] : allLocales;
}

function normalizeGoogleNewsRunSpecs(
  queries: readonly string[] | readonly GoogleNewsQueryRunSpec[],
): GoogleNewsQueryRunSpec[] {
  if (queries.length === 0) {
    return [];
  }
  const first = queries[0]!;
  if (typeof first === 'string') {
    return (queries as string[]).map((query) => ({ query }));
  }
  return (queries as GoogleNewsQueryRunSpec[]).map((spec) => ({ ...spec }));
}

function countGoogleNewsRssCells(
  queries: readonly string[] | readonly GoogleNewsQueryRunSpec[],
  allLocales: GoogleNewsLocale[],
): number {
  const specs = normalizeGoogleNewsRunSpecs(queries);
  let n = 0;
  for (const spec of specs) {
    const pinned = spec.googleNewsLocaleIds;
    const locales =
      pinned && pinned.length > 0
        ? allLocales.filter((l) => pinned.includes(l.id))
        : localesForGoogleNewsPublisherQuery(spec.query, allLocales);
    const effective = locales.length > 0 ? locales : allLocales;
    n += effective.length;
  }
  return n;
}

function loadEuropeGoogleNewsLocalesFromFile(): GoogleNewsLocale[] {
  if (europeGoogleNewsLocalesCache) {
    return europeGoogleNewsLocalesCache;
  }

  try {
    const configUrl = new URL('../data/google-news-europe-locales.json', import.meta.url);
    const raw = readFileSync(configUrl, 'utf-8');
    const parsed = JSON.parse(raw) as { locales?: unknown };
    if (!parsed.locales || !Array.isArray(parsed.locales)) {
      throw new Error('google-news-europe-locales.json must contain a locales array');
    }

    const locales: GoogleNewsLocale[] = [];
    for (const item of parsed.locales) {
      if (
        item &&
        typeof item === 'object' &&
        typeof (item as GoogleNewsLocale).id === 'string' &&
        typeof (item as GoogleNewsLocale).hl === 'string' &&
        typeof (item as GoogleNewsLocale).gl === 'string' &&
        typeof (item as GoogleNewsLocale).ceid === 'string'
      ) {
        locales.push(item as GoogleNewsLocale);
      }
    }

    if (locales.length === 0) {
      throw new Error('google-news-europe-locales.json contained no valid locale entries');
    }

    europeGoogleNewsLocalesCache = locales;
    return locales;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[agent] failed to load google-news-europe-locales.json', { message });
    europeGoogleNewsLocalesCache = [];
    return [];
  }
}

function loadCultKeywordsConfigFromFile(): CultKeywordsConfigJson {
  if (cultKeywordsConfigCache) {
    return cultKeywordsConfigCache;
  }

  try {
    const configUrl = new URL('../data/google-news-locale-cult-keywords.json', import.meta.url);
    const raw = readFileSync(configUrl, 'utf-8');
    const parsed = JSON.parse(raw) as CultKeywordsConfigJson;
    if (!Array.isArray(parsed.baseTerms) || !parsed.baseTerms.every((t) => typeof t === 'string')) {
      throw new Error('google-news-locale-cult-keywords.json baseTerms must be a string array');
    }
    if (!Array.isArray(parsed.fallbackExtraTerms) || !parsed.fallbackExtraTerms.every((t) => typeof t === 'string')) {
      throw new Error('google-news-locale-cult-keywords.json fallbackExtraTerms must be a string array');
    }
    if (!Array.isArray(parsed.rules)) {
      throw new Error('google-news-locale-cult-keywords.json rules must be an array');
    }
    for (const rule of parsed.rules) {
      if (!rule || typeof rule !== 'object' || !Array.isArray(rule.extraTerms)) {
        throw new Error('each rule must have extraTerms array');
      }
      if (!rule.extraTerms.every((t) => typeof t === 'string')) {
        throw new Error('rule.extraTerms must be strings');
      }
      if (!rule.hlStartsWith && !rule.hlEquals) {
        throw new Error('each rule needs hlStartsWith or hlEquals');
      }
    }

    cultKeywordsConfigCache = parsed;
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[agent] failed to load google-news-locale-cult-keywords.json', { message });
    cultKeywordsConfigCache = {
      baseTerms: ['cult', 'cults'],
      fallbackExtraTerms: ['sect', 'sects', 'sekta'],
      rules: [{ hlStartsWith: 'en', extraTerms: ['sect', 'sects'] }],
    };
    return cultKeywordsConfigCache;
  }
}

function loadEuropeGoogleNewsLocales(): GoogleNewsLocale[] {
  const all = loadEuropeGoogleNewsLocalesFromFile();
  const localeIdsFilter = process.env.GOOGLE_NEWS_LOCALE_IDS?.trim();
  if (!localeIdsFilter) {
    return all;
  }

  const wanted = new Set(
    localeIdsFilter
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const picked = all.filter((locale) => wanted.has(locale.id));
  if (picked.length === 0) {
    console.warn('[agent] GOOGLE_NEWS_LOCALE_IDS did not match any known locale id; using full European set');
    return all;
  }

  return picked;
}

function uniquePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    ordered.push(value);
  }
  return ordered;
}

function hlMatchesCultKeywordRule(hlLower: string, rule: CultKeywordRuleJson): boolean {
  if (rule.hlEquals !== undefined && hlLower === rule.hlEquals.toLowerCase()) {
    return true;
  }
  if (rule.hlStartsWith !== undefined && hlLower.startsWith(rule.hlStartsWith.toLowerCase())) {
    return true;
  }
  return false;
}

/**
 * OR-group of cult-type keywords for this Google News edition (from
 * data/google-news-locale-cult-keywords.json): base terms + first matching hl rule, else fallback.
 */
function buildLocalizedCultKeywordClause(locale: GoogleNewsLocale): string {
  const config = loadCultKeywordsConfigFromFile();
  const hlLower = locale.hl.toLowerCase();
  const terms: string[] = [...config.baseTerms];

  for (const rule of config.rules) {
    if (hlMatchesCultKeywordRule(hlLower, rule)) {
      terms.push(...rule.extraTerms);
      return `(${uniquePreserveOrder(terms).join(' OR ')})`;
    }
  }

  terms.push(...config.fallbackExtraTerms);
  return `(${uniquePreserveOrder(terms).join(' OR ')})`;
}

/** AND the base discovery query with a locale-appropriate cult/sect keyword bucket (Google treats adjacent groups as AND). */
function applyLocalizedCultTermsToGoogleNewsQuery(baseQuery: string, locale: GoogleNewsLocale): string {
  const clause = buildLocalizedCultKeywordClause(locale);
  return `${baseQuery} ${clause}`.trim();
}

/**
 * Google News RSS honors unofficial `when:` tokens inside the q= string. The `h` suffix (e.g. when:168h)
 * aligns the RSS window with DISCOVERY_MAX_AGE_HOURS; without this, rankings skew and stories fall past the
 * ~100-item cap. Very large N may be ignored by Google — override with GOOGLE_NEWS_WHEN if needed.
 */
function buildGoogleNewsTimeQualifier(): string {
  const raw = process.env.GOOGLE_NEWS_WHEN?.trim();
  if (raw) {
    const lower = raw.toLowerCase();
    if (lower === 'off' || lower === 'none' || lower === 'false') {
      return '';
    }
    return raw;
  }

  const h = Math.max(1, Math.round(DISCOVERY_MAX_AGE_HOURS));
  const maxHoursForWhenH = 24 * 365;

  if (h <= maxHoursForWhenH) {
    return `when:${h}h`;
  }

  return 'when:1y';
}

function buildGoogleNewsRssUrl(query: string, locale: GoogleNewsLocale): string {
  const withCult = applyLocalizedCultTermsToGoogleNewsQuery(query, locale);
  const timeQualifier = buildGoogleNewsTimeQualifier();
  const fullQuery = timeQualifier ? `${withCult} ${timeQualifier}`.trim() : withCult;
  const encodedQuery = encodeURIComponent(fullQuery);
  const encodedHl = encodeURIComponent(locale.hl);
  const encodedCeid = encodeURIComponent(locale.ceid);
  return `https://news.google.com/rss/search?q=${encodedQuery}&hl=${encodedHl}&gl=${locale.gl}&ceid=${encodedCeid}`;
}

type NewsDataResult = {
  title?: string;
  link?: string;
  source_name?: string;
  source_url?: string;
  description?: string;
  pubDate?: string;
  pub_date?: string;
  publishedAt?: string;
};

type NewsDataCacheEntry = {
  fetchedAt: string;
  results: NewsDataResult[];
};

type NewsDataCache = {
  version: 1;
  entries: Record<string, NewsDataCacheEntry>;
};

function loadNewsDataCache(): NewsDataCache {
  if (!NEWSIO_CACHE_ENABLED) {
    return { version: 1, entries: {} };
  }

  try {
    const raw = readFileSync(NEWSDATA_CACHE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as { version?: number; entries?: Record<string, NewsDataCacheEntry> };
    if (parsed.version === 1 && parsed.entries && typeof parsed.entries === 'object') {
      return { version: 1, entries: parsed.entries };
    }
  } catch {
    // Missing or invalid cache file should not break discovery.
  }

  return { version: 1, entries: {} };
}

function saveNewsDataCache(cache: NewsDataCache): void {
  if (!NEWSIO_CACHE_ENABLED) {
    return;
  }

  try {
    mkdirSync(new URL('../.cache/', import.meta.url), { recursive: true });
    writeFileSync(NEWSDATA_CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`, 'utf-8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[agent] failed to write newsdata cache', { message });
  }
}

function isNewsDataCacheEntryFresh(entry: NewsDataCacheEntry): boolean {
  const fetchedAtEpochMs = Date.parse(entry.fetchedAt);
  if (!Number.isFinite(fetchedAtEpochMs)) {
    return false;
  }

  const ageMs = Date.now() - fetchedAtEpochMs;
  const ttlMs = NEWSIO_CACHE_TTL_MINUTES * 60 * 1000;
  return ageMs >= 0 && ageMs <= ttlMs;
}

function getCachedNewsDataResults(cache: NewsDataCache, query: string): NewsDataResult[] | undefined {
  const entry = cache.entries[query];
  if (!entry || !isNewsDataCacheEntryFresh(entry)) {
    return undefined;
  }

  return entry.results;
}

function setCachedNewsDataResults(cache: NewsDataCache, query: string, results: NewsDataResult[]): void {
  cache.entries[query] = {
    fetchedAt: new Date().toISOString(),
    results,
  };
}

function buildNewsDataUrl(query: string): string {
  const fromDate = new Date(Date.now() - DISCOVERY_MAX_AGE_HOURS * 60 * 60 * 1000).toISOString().slice(0, 10);
  const params = new URLSearchParams({
    apikey: NEWSIO_API_KEY ?? '',
    q: query,
    country: NEWSDATA_COUNTRY_CODES,
    language: NEWSDATA_LANGUAGES,
    size: String(NEWSDATA_QUERY_LIMIT),
    removeduplicate: '1',
    timeframe: String(DISCOVERY_MAX_AGE_HOURS),
    from_date: fromDate,
  });

  return `${NEWSDATA_BASE_URL}?${params.toString()}`;
}

function normalizePossibleUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return new URL(value).toString();
  } catch {
    return undefined;
  }
}

async function discoverFromNewsData(): Promise<DiscoveredStory[]> {
  if (!NEWSDATA_ENABLED) {
    return [];
  }

  if (!NEWSIO_API_KEY) {
    console.warn('[agent] NewsData enabled but NEWSIO_API_KEY is missing');
    return [];
  }

  const discovered: DiscoveredStory[] = [];
  const queries = NEWSDATA_QUERIES.slice(0, NEWSIO_MAX_CREDITS_PER_RUN);
  const cache = loadNewsDataCache();
  let cacheUpdated = false;
  let queryIndex = 0;

  logDiscoveryProgress('newsdata-start', {
    queryCount: queries.length,
  });

  for (const query of queries) {
    queryIndex += 1;
    const discoveredBefore = discovered.length;
    const cachedResults = getCachedNewsDataResults(cache, query);
    let results: NewsDataResult[];

    if (cachedResults) {
      console.log('[agent] newsdata cache hit', { query, resultCount: cachedResults.length });
      results = cachedResults;
    } else {
      const url = buildNewsDataUrl(query);

      try {
        const response = await fetchJsonWithCache<{ results?: NewsDataResult[] }>(url, {
          headers: {
            'User-Agent': 'FreedomTimes-Local-Agent/0.1',
            Accept: 'application/json',
          },
        });

        if (!response.ok) {
          console.warn('[agent] newsdata fetch failed', { status: response.status, query });
          logDiscoveryProgress('newsdata-running', {
            queryIndex,
            queryCount: queries.length,
            newsdataPct:
              queries.length > 0 ? Number(((queryIndex / queries.length) * 100).toFixed(1)) : 100,
            queryPreview: truncateForProgress(query, 100),
            discovered: discovered.length,
            addedThisQuery: 0,
            resultRows: 0,
            fetchOk: false,
          });
          continue;
        }

        const payload = response.json;
        if (!payload) {
          console.warn('[agent] newsdata parse error', { query });
          logDiscoveryProgress('newsdata-running', {
            queryIndex,
            queryCount: queries.length,
            newsdataPct:
              queries.length > 0 ? Number(((queryIndex / queries.length) * 100).toFixed(1)) : 100,
            queryPreview: truncateForProgress(query, 100),
            discovered: discovered.length,
            addedThisQuery: 0,
            resultRows: 0,
            fetchOk: false,
            parseError: true,
          });
          continue;
        }

        results = payload.results ?? [];
        setCachedNewsDataResults(cache, query, results);
        cacheUpdated = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn('[agent] newsdata fetch error', { query, message });
        logDiscoveryProgress('newsdata-running', {
          queryIndex,
          queryCount: queries.length,
          newsdataPct:
            queries.length > 0 ? Number(((queryIndex / queries.length) * 100).toFixed(1)) : 100,
          queryPreview: truncateForProgress(query, 100),
          discovered: discovered.length,
          addedThisQuery: 0,
          resultRows: 0,
          fetchError: true,
        });
        continue;
      }
    }

    for (const item of results) {
      const link = normalizePossibleUrl(item.link);
      const title = (item.title ?? '').trim();

      if (!link || !title) {
        continue;
      }

      if (!getHost(link)) {
        continue;
      }

      const publishedAt = normalizePublishedAt(item.pubDate ?? item.pub_date ?? item.publishedAt);
      if (!isWithinFreshnessWindow(publishedAt)) {
        continue;
      }

      discovered.push({
        url: link,
        title,
        publishedAt,
        sourceFeed: `newsdata:${query}`,
        sourceFormat: 'newsio',
        sourceCategory: 'api',
        requiresUrlResolution: false,
        publisherName: item.source_name,
        publisherUrl: normalizePossibleUrl(item.source_url),
      });
    }

    logDiscoveryProgress('newsdata-running', {
      queryIndex,
      queryCount: queries.length,
      newsdataPct:
        queries.length > 0 ? Number(((queryIndex / queries.length) * 100).toFixed(1)) : 100,
      queryPreview: truncateForProgress(query, 100),
      discovered: discovered.length,
      addedThisQuery: discovered.length - discoveredBefore,
      resultRows: results.length,
      fetchOk: true,
    });
  }

  if (cacheUpdated) {
    saveNewsDataCache(cache);
  }

  logDiscoveryProgress('newsdata-complete', {
    discovered: discovered.length,
  });

  return discovered;
}

let googleNewsPlaywrightBrowser: import('playwright').Browser | undefined;
let googleNewsPlaywrightMutex: Promise<unknown> = Promise.resolve();

async function disposeGoogleNewsPlaywrightBrowser(): Promise<void> {
  if (googleNewsPlaywrightBrowser) {
    await googleNewsPlaywrightBrowser.close().catch(() => {});
    googleNewsPlaywrightBrowser = undefined;
  }
}

async function tryResolveGoogleNewsUrlWithPlaywright(gnUrl: string): Promise<string | undefined> {
  if (!GOOGLE_NEWS_RESOLVE_USE_PLAYWRIGHT) {
    return undefined;
  }
  if (
    Number.isFinite(GOOGLE_NEWS_PLAYWRIGHT_MAX_RESOLVES) &&
    googleNewsPlaywrightAttemptsThisRun >= GOOGLE_NEWS_PLAYWRIGHT_MAX_RESOLVES
  ) {
    return undefined;
  }
  googleNewsPlaywrightAttemptsThisRun += 1;
  try {
    const { chromium } = await import('playwright');
    if (!googleNewsPlaywrightBrowser) {
      googleNewsPlaywrightBrowser = await chromium.launch({ headless: true });
    }
    const page = await googleNewsPlaywrightBrowser.newPage();
    await page.goto(gnUrl, { waitUntil: 'domcontentloaded', timeout: 35_000 });
    const finalUrl = page.url();
    await page.close();
    if (!isGoogleNewsUrl(finalUrl)) {
      googleNewsPlaywrightSuccessesThisRun += 1;
      return finalUrl;
    }
  } catch {
    // Playwright optional; ignore failures.
  }
  return undefined;
}

function enqueuePlaywrightResolveGnUrl(gnUrl: string): Promise<string | undefined> {
  const done = googleNewsPlaywrightMutex.then(() => tryResolveGoogleNewsUrlWithPlaywright(gnUrl));
  googleNewsPlaywrightMutex = done.then(
    () => undefined,
    () => undefined,
  );
  return done;
}

async function resolveGoogleNewsLink(url: string): Promise<string> {
  let resolved = url;
  try {
    const response = await fetchTextWithCache(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'FreedomTimes-Local-Agent/0.1',
      },
    });

    if (!isGoogleNewsUrl(response.url)) {
      return response.url;
    }

    const decoded = await decodeGoogleNewsWrapperUrl(url);
    if (decoded) {
      return decoded;
    }

    resolved = response.url;
  } catch {
    resolved = url;
  }

  if (isGoogleNewsUrl(resolved)) {
    const playwrightUrl = await enqueuePlaywrightResolveGnUrl(url);
    if (playwrightUrl) {
      return playwrightUrl;
    }
  }

  return resolved;
}

/**
 * Bounded parallelism for per-feed URL resolution: dedupe by URL, at most `maxConcurrent` calls to `resolveOne` at once.
 */
function createPooledUrlResolver(
  maxConcurrent: number,
  resolveOne: (url: string) => Promise<string>,
): { schedule: (url: string) => void; get: (url: string) => Promise<string> } {
  let active = 0;
  const waitQueue: Array<() => void> = [];
  const urlToPromise = new Map<string, Promise<string>>();

  function acquireSlot(): Promise<void> {
    if (active < maxConcurrent) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      waitQueue.push(() => {
        active += 1;
        resolve();
      });
    });
  }

  function releaseSlot(): void {
    active -= 1;
    const next = waitQueue.shift();
    if (next) {
      next();
    }
  }

  function get(url: string): Promise<string> {
    const hit = urlToPromise.get(url);
    if (hit) {
      return hit;
    }

    const created = (async () => {
      await acquireSlot();
      try {
        return await resolveOne(url);
      } finally {
        releaseSlot();
      }
    })();

    urlToPromise.set(url, created);
    void created.finally(() => {
      urlToPromise.delete(url);
    });
    return created;
  }

  return {
    get,
    schedule(url: string): void {
      void get(url);
    },
  };
}

const googleNewsDecodedUrlCache = new Map<string, string>();
let googleNewsDecoder: GoogleNewsUrlDecoder | undefined;
let googleNewsDecoderUnavailable = false;

function isGoogleNewsUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^www\./, '');
    return host === 'news.google.com';
  } catch {
    return false;
  }
}

async function getGoogleNewsDecoder(): Promise<GoogleNewsUrlDecoder | undefined> {
  if (googleNewsDecoderUnavailable) {
    return undefined;
  }

  if (googleNewsDecoder) {
    return googleNewsDecoder;
  }

  try {
    const module = (await import('google-news-url-decoder')) as {
      GoogleDecoder?: new () => GoogleNewsUrlDecoder;
      default?: { GoogleDecoder?: new () => GoogleNewsUrlDecoder };
    };

    const DecoderCtor = module.GoogleDecoder ?? module.default?.GoogleDecoder;
    if (!DecoderCtor) {
      googleNewsDecoderUnavailable = true;
      return undefined;
    }

    googleNewsDecoder = new DecoderCtor();
    return googleNewsDecoder;
  } catch {
    googleNewsDecoderUnavailable = true;
    return undefined;
  }
}

async function decodeGoogleNewsWrapperUrl(url: string): Promise<string | undefined> {
  if (!isGoogleNewsUrl(url)) {
    return undefined;
  }

  const cached = googleNewsDecodedUrlCache.get(url);
  if (cached) {
    return cached;
  }

  const decoder = await getGoogleNewsDecoder();
  if (!decoder) {
    return undefined;
  }

  try {
    const decoded = await decoder.decode(url);
    const decodedUrl = decoded.decoded_url?.trim();
    if (!decoded.status || !decodedUrl || isGoogleNewsUrl(decodedUrl)) {
      return undefined;
    }

    googleNewsDecodedUrlCache.set(url, decodedUrl);
    return decodedUrl;
  } catch {
    return undefined;
  }
}

type GoogleNewsQueryPlanRow = {
  query: string;
  source: 'watchlist' | 'generic';
  siteHost?: string;
  siteHosts?: string[];
  /** Unified `hl` bundle key (e.g. `de`, `fr`) or `en-aggregate` for English OR+OR fallback. */
  watchlistLocaleKey?: string;
  localeIds?: string[];
  rssCells: number;
  inMainPassThisRun: boolean;
  pinnedGoogleNewsLocaleIds?: string[];
};

function buildGoogleNewsQueryPlanRow(
  query: string,
  source: 'watchlist' | 'generic',
  allLocales: GoogleNewsLocale[],
  options?: { pinnedGoogleNewsLocaleIds?: readonly string[] },
): Omit<GoogleNewsQueryPlanRow, 'inMainPassThisRun'> {
  const siteHosts = extractAllSiteHostsFromGoogleNewsQuery(query);
  const siteHost = siteHosts[0];
  const pinned = options?.pinnedGoogleNewsLocaleIds;
  const queryLocales =
    pinned && pinned.length > 0
      ? allLocales.filter((l) => pinned.includes(l.id))
      : localesForGoogleNewsPublisherQuery(query, allLocales);
  const effectiveLocales = queryLocales.length > 0 ? queryLocales : allLocales;
  const watchlistLocaleKey = siteHost ? watchlistLocaleKeyForSite(siteHost) : undefined;
  const row: Omit<GoogleNewsQueryPlanRow, 'inMainPassThisRun'> = {
    query,
    source,
    siteHost: siteHost ?? undefined,
    siteHosts: siteHosts.length > 0 ? siteHosts : undefined,
    watchlistLocaleKey,
    rssCells: effectiveLocales.length,
  };
  if (pinned && pinned.length > 0) {
    row.pinnedGoogleNewsLocaleIds = [...pinned];
  }
  if (GOOGLE_NEWS_QUERY_PLAN_INCLUDE_LOCALE_IDS) {
    row.localeIds = effectiveLocales.map((l) => l.id);
  }
  return row;
}

function recordGoogleNewsQueryPlanFromConfig(params: {
  runSeed: number;
  watchlistQueriesFull: string[];
  mainPassSpecs: GoogleNewsQueryRunSpec[];
}): void {
  if (!GOOGLE_NEWS_RECORD_QUERY_PLAN) {
    return;
  }

  const allLocales = loadEuropeGoogleNewsLocales();
  const genericSet = new Set(GOOGLE_NEWS_GENERIC_QUERIES);

  const configDerivedQueries: GoogleNewsQueryPlanRow[] = [
    ...params.watchlistQueriesFull.map((query) => ({
      ...buildGoogleNewsQueryPlanRow(query, 'watchlist', allLocales),
      inMainPassThisRun: true,
    })),
    ...GOOGLE_NEWS_GENERIC_QUERY_SPECS.map((spec) => ({
      ...buildGoogleNewsQueryPlanRow(
        spec.query,
        'generic',
        allLocales,
        spec.googleNewsLocaleIds && spec.googleNewsLocaleIds.length > 0
          ? { pinnedGoogleNewsLocaleIds: spec.googleNewsLocaleIds }
          : undefined,
      ),
      inMainPassThisRun: true,
    })),
  ];

  const watchlistByHost: Record<
    string,
    {
      watchlistLocaleKey?: string;
      queryCount: number;
      rssCellsSum: number;
      queries: string[];
    }
  > = {};

  for (const row of configDerivedQueries) {
    if (row.source !== 'watchlist') {
      continue;
    }
    const hosts =
      row.siteHosts && row.siteHosts.length > 0 ? row.siteHosts : row.siteHost ? [row.siteHost] : [];
    if (hosts.length === 0) {
      continue;
    }
    for (const host of hosts) {
      const bucket = watchlistByHost[host] ?? {
        watchlistLocaleKey: watchlistLocaleKeyForSite(host),
        queryCount: 0,
        rssCellsSum: 0,
        queries: [],
      };
      bucket.queryCount += 1;
      bucket.rssCellsSum += row.rssCells;
      bucket.queries.push(row.query);
      if (!bucket.watchlistLocaleKey) {
        bucket.watchlistLocaleKey = watchlistLocaleKeyForSite(host);
      }
      watchlistByHost[host] = bucket;
    }
  }

  const mainPassRows: GoogleNewsQueryPlanRow[] = params.mainPassSpecs.map((spec) => ({
    ...buildGoogleNewsQueryPlanRow(
      spec.query,
      genericSet.has(spec.query) ? 'generic' : 'watchlist',
      allLocales,
      spec.googleNewsLocaleIds && spec.googleNewsLocaleIds.length > 0
        ? { pinnedGoogleNewsLocaleIds: spec.googleNewsLocaleIds }
        : undefined,
    ),
    inMainPassThisRun: true,
  }));

  const payload = {
    recordedAt: new Date().toISOString(),
    runSeed: params.runSeed,
    watchlistSiteOrChunk: GOOGLE_NEWS_WATCHLIST_SITE_OR_CHUNK,
    googleNewsTotalCap: GOOGLE_NEWS_TOTAL_CAP,
    localeCount: allLocales.length,
    options: {
      includeLocaleIdsPerQuery: GOOGLE_NEWS_QUERY_PLAN_INCLUDE_LOCALE_IDS,
    },
    summary: {
      configWatchlistQueryStrings: params.watchlistQueriesFull.length,
      configGenericQueryStrings: GOOGLE_NEWS_GENERIC_QUERY_SPECS.length,
      genericQueryLimit:
        Number.isFinite(GOOGLE_NEWS_GENERIC_QUERY_LIMIT) ? GOOGLE_NEWS_GENERIC_QUERY_LIMIT : 'unlimited',
      mainPassQueryStrings: params.mainPassSpecs.length,
      rssCellsFullConfigPool: countGoogleNewsRssCells(
        [
          ...params.watchlistQueriesFull.map((q) => ({ query: q })),
          ...GOOGLE_NEWS_GENERIC_QUERY_SPECS,
        ],
        allLocales,
      ),
      rssCellsMainPassThisRun: countGoogleNewsRssCells(params.mainPassSpecs, allLocales),
    },
    configDerivedQueries,
    watchlistByHost,
    mainPassThisRun: {
      queryStringsInOrder: params.mainPassSpecs.map((s) => s.query),
      rows: mainPassRows,
    },
  };

  const reportsDir = new URL('../reports/', import.meta.url);
  mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  writeFileSync(new URL(`google-news-query-plan-${stamp}.json`, reportsDir), json, 'utf-8');
  writeFileSync(new URL('google-news-query-plan-latest.json', reportsDir), json, 'utf-8');
}

/** Build the generic query specs for a run (with rotation applied). Exported for tooling. */
export function buildGenericQuerySpecsForRun(runSeed?: number): GoogleNewsQueryRunSpec[] {
  const seed = runSeed ?? Number.parseInt(new Date().toISOString().slice(0, 10).replace(/-/g, ''), 10);
  return rotateSlice(GOOGLE_NEWS_GENERIC_QUERY_SPECS, GOOGLE_NEWS_GENERIC_QUERY_LIMIT, seed).map((spec) => ({ ...spec }));
}

/** Google News RSS discovery only (watchlist + generic queries), for tooling / smoke tests. */
export async function discoverFromGoogleNews(options?: {
  /** When false, caller owns `flushGoogleNewsWrappedLinksReport()` (e.g. full `discoverCandidateStories`). Default true. */
  flushWrappedLinksReport?: boolean;
}): Promise<DiscoveredStory[]> {
  const flushWrapped = options?.flushWrappedLinksReport !== false;
  if (flushWrapped) {
    resetGoogleNewsDiscoveryReporting();
  }
  const watchlistQueries = buildWatchlistQueries();
  const runSeed = Number.parseInt(new Date().toISOString().slice(0, 10).replace(/-/g, ''), 10);
  const genericSpecs = rotateSlice(GOOGLE_NEWS_GENERIC_QUERY_SPECS, GOOGLE_NEWS_GENERIC_QUERY_LIMIT, runSeed);
  const mainPassSpecs: GoogleNewsQueryRunSpec[] = [
    ...watchlistQueries.map((query) => ({ query })),
    ...genericSpecs.map((spec) => ({ ...spec })),
  ];
  recordGoogleNewsQueryPlanFromConfig({
    runSeed,
    watchlistQueriesFull: watchlistQueries,
    mainPassSpecs,
  });
  const stories = await discoverFromGoogleNewsQueries(mainPassSpecs, 'google-news');
  if (flushWrapped) {
    flushGoogleNewsWrappedLinksReport();
  }
  return stories;
}

/** Diagnostics: planned RSS GET counts for the main Google News pass (no network). */
export function reportGoogleNewsMainPassRssFootprint(isoDateSeed?: string): Record<string, unknown> {
  const locales = loadEuropeGoogleNewsLocales();
  const localeCount = locales.length;
  const runSeed = Number.parseInt((isoDateSeed ?? new Date().toISOString().slice(0, 10)).replace(/-/g, ''), 10);

  const watchlistQueries = buildWatchlistQueries();
  const genericSpecs = rotateSlice(GOOGLE_NEWS_GENERIC_QUERY_SPECS, GOOGLE_NEWS_GENERIC_QUERY_LIMIT, runSeed);
  const passSpecs: GoogleNewsQueryRunSpec[] = [
    ...watchlistQueries.map((query) => ({ query })),
    ...genericSpecs.map((spec) => ({ ...spec })),
  ];
  const rssCellsThisPass = countGoogleNewsRssCells(passSpecs, locales);

  const watchlistLocaleSiteCounts: Record<string, number> = {};
  let watchlistEnAggregateSites = 0;
  for (const site of GOOGLE_NEWS_WATCHLIST_SITES) {
    const lang = watchlistUnifiedLanguageKeyForSite(site);
    if (lang) {
      watchlistLocaleSiteCounts[lang] = (watchlistLocaleSiteCounts[lang] ?? 0) + 1;
    } else {
      watchlistEnAggregateSites += 1;
    }
  }

  const fullPoolSpecs: GoogleNewsQueryRunSpec[] = [
    ...watchlistQueries.map((q) => ({ query: q })),
    ...GOOGLE_NEWS_GENERIC_QUERY_SPECS.map((spec) => ({ ...spec })),
  ];
  const rssCellsFullPoolNew = countGoogleNewsRssCells(fullPoolSpecs, locales);

  return {
    localeCount,
    runSeed,
    watchlistSiteOrChunk: GOOGLE_NEWS_WATCHLIST_SITE_OR_CHUNK,
    googleNewsTotalCap: GOOGLE_NEWS_TOTAL_CAP,
    googleNewsGenericQueryLimit:
      Number.isFinite(GOOGLE_NEWS_GENERIC_QUERY_LIMIT) ? GOOGLE_NEWS_GENERIC_QUERY_LIMIT : 'unlimited',
    genericTemplateSpecs: GOOGLE_NEWS_GENERIC_QUERY_SPECS.length,
    genericTemplateQueryStringsUnique: GOOGLE_NEWS_GENERIC_QUERIES.length,
    watchlistSites: GOOGLE_NEWS_WATCHLIST_SITES.length,
    watchlistQueryStringsTotal: watchlistQueries.length,
    watchlistLocaleSiteCounts,
    watchlistEnAggregateSites,
    queriesInMainPass: passSpecs.length,
    rssGetCellsMainPass: rssCellsThisPass,
    rssGetCellsFullPoolWatchlistAndGenerics: rssCellsFullPoolNew,
  };
}

function tokenizeForCluster(value: string, languageCode: string): string[] {
  const stop = clusterStopwordsForLanguage(languageCode);
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 4)
    .filter((token) => !stop.has(token));
}

function extractTitlePhrases(title: string, languageCode: string): string[] {
  const tokens = tokenizeForCluster(title, languageCode);
  const phrases: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (i < tokens.length - 1) {
      phrases.push(`${tokens[i]} ${tokens[i + 1]}`);
    }
    if (i < tokens.length - 2) {
      phrases.push(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`);
    }
  }
  return phrases;
}

/** Extra stems so French (and similar) headlines still yield seeds when English-only `incidentSignalTerms` miss. */
const SINGLETON_EXPANSION_PHRASE_SIGNAL_TERMS = [
  'secte',
  'sectes',
  'viol',
  'viols',
  'emprise',
  'gourou',
  'détention',
  'detention',
  'esclavage',
  'abus',
  'adeptes',
];

function phraseQualifiesForSingletonExpansionSeed(phrase: string, storyTitleLower: string): boolean {
  const p = phrase.trim();
  if (p.length < 8 || p.includes('"')) {
    return false;
  }
  const lower = p.toLowerCase();
  if (
    containsTerm(lower, SINGLETON_EXPANSION_PHRASE_SIGNAL_TERMS) ||
    containsTerm(lower, CULT_TERMS) ||
    containsTerm(lower, [
      'religious group',
      'sect',
      'slavery',
      'raid',
      'abuse',
      'trafficking',
    ]) ||
    (FOCUS_SIGNAL_TERMS.length > 0 && containsTerm(lower, FOCUS_SIGNAL_TERMS))
  ) {
    return true;
  }
  /** Title already has cult signals but n-gram lacks an English stem (e.g. “dérives sectaires”). */
  if (containsTerm(storyTitleLower, CULT_TERMS) && p.length >= 12 && p.split(/\s+/).filter(Boolean).length >= 2) {
    return true;
  }
  return false;
}

function publisherHostnameFromArticleUrl(articleUrl: string): string | undefined {
  try {
    return normalizeHost(new URL(articleUrl).hostname);
  } catch {
    return undefined;
  }
}

/** Google News `ceid` ids (e.g. FR-fr) inferred from the resolved publisher URL. */
function googleNewsEditionIdsForPublisherUrl(
  articleUrl: string,
  allLocales: GoogleNewsLocale[],
): string[] {
  const host = publisherHostnameFromArticleUrl(articleUrl);
  if (!host) {
    return [];
  }
  const cfg = loadPublisherSiteLocalesConfig();
  const explicit = cfg.localeIdsByHost?.[host];
  if (explicit?.length) {
    return explicit.filter((id) => allLocales.some((l) => l.id === id));
  }
  const gls = resolveGlsFromPublisherHostname(host);
  if (gls?.length) {
    const glSet = new Set(gls);
    return allLocales.filter((l) => glSet.has(l.gl)).map((l) => l.id);
  }
  return [];
}

function mergeClusterExpansionQuerySpecs(specs: GoogleNewsQueryRunSpec[]): GoogleNewsQueryRunSpec[] {
  const map = new Map<string, Set<string>>();
  const order: string[] = [];
  for (const s of specs) {
    const key = s.query.trim();
    if (!map.has(key)) {
      map.set(key, new Set());
      order.push(key);
    }
    if (s.googleNewsLocaleIds?.length) {
      for (const id of s.googleNewsLocaleIds) {
        map.get(key)!.add(id);
      }
    }
  }
  return order.map((key) => {
    const ids = map.get(key)!;
    return {
      query: key,
      googleNewsLocaleIds: ids.size > 0 ? [...ids] : undefined,
    };
  });
}

/**
 * Follow-up Google News queries when we have strong candidate(s) but not enough for multi-story phrase overlap.
 * Uses title n-grams that already contain cult / harm / focus signals (conservative to limit noise).
 */
function buildSingletonClusterExpansionQueries(
  eligible: DiscoveredStory[],
  allLocales: GoogleNewsLocale[],
): GoogleNewsQueryRunSpec[] {
  if (!CLUSTER_EXPANSION_SINGLETON_ENABLED || eligible.length === 0) {
    return [];
  }

  const expansionTail = `(sect OR "religious group" OR slavery OR raid OR cult OR secte OR sectes OR emprise)`;
  const collected: GoogleNewsQueryRunSpec[] = [];
  const seen = new Set<string>();

  for (const story of capSlice(eligible, CLUSTER_EXPANSION_SINGLETON_MAX_STORIES)) {
    const storyTitleLower = story.title.toLowerCase();
    const lang = detectTitleLanguageForCluster(story.title, story.sourceLanguage);
    const editionPin = googleNewsEditionIdsForPublisherUrl(story.url, allLocales);
    const pin = editionPin.length > 0 ? editionPin : undefined;
    for (const phrase of extractTitlePhrases(story.title, lang)) {
      if (!phraseQualifiesForSingletonExpansionSeed(phrase, storyTitleLower)) {
        continue;
      }
      const q = `"${phrase.replace(/"/g, '')}" ${expansionTail}`;
      const key = `${q.toLowerCase()}|${pin?.join(',') ?? 'all'}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      collected.push({ query: q, googleNewsLocaleIds: pin });
      if (collected.length >= CLUSTER_EXPANSION_MAX_TOTAL_QUERIES) {
        return mergeClusterExpansionQuerySpecs(collected);
      }
    }
  }

  return mergeClusterExpansionQuerySpecs(collected);
}

function buildExpansionQueries(scored: DiscoveredStory[]): GoogleNewsQueryRunSpec[] {
  const allLocales = loadEuropeGoogleNewsLocales();
  const incidentSignalTerms = ['religious group', 'sect', 'slavery', 'raid', 'abuse', 'trafficking'];
  const eligible = scored
    .filter((story) => (story.discoveryScore ?? 0) >= CLUSTER_EXPANSION_MIN_SCORE)
    .filter((story) => {
      const title = story.title.toLowerCase();
      return (
        containsTerm(title, incidentSignalTerms) ||
        containsTerm(title, CULT_TERMS) ||
        (FOCUS_SIGNAL_TERMS.length > 0 && containsTerm(title, FOCUS_SIGNAL_TERMS))
      );
    })
    .slice(0, 300);
  if (eligible.length < CLUSTER_EXPANSION_MIN_CLUSTER_SIZE) {
    return buildSingletonClusterExpansionQueries(eligible, allLocales);
  }

  const phraseCounts = new Map<string, number>();
  const phraseScore = new Map<string, number>();
  const phraseLocales = new Map<string, Set<string>>();
  const seenPhraseByStory = new Map<number, Set<string>>();
  for (let i = 0; i < eligible.length; i += 1) {
    const story = eligible[i];
    if (!story) {
      continue;
    }
    const seen = new Set<string>();
    seenPhraseByStory.set(i, seen);
    const lang = detectTitleLanguageForCluster(story.title, story.sourceLanguage);
    const phrases = extractTitlePhrases(story.title, lang);
    const editionIds = googleNewsEditionIdsForPublisherUrl(story.url, allLocales);
    for (const phrase of phrases) {
      if (seen.has(phrase)) {
        continue;
      }
      seen.add(phrase);
      phraseCounts.set(phrase, (phraseCounts.get(phrase) ?? 0) + 1);
      phraseScore.set(phrase, (phraseScore.get(phrase) ?? 0) + (story.discoveryScore ?? 0));
      if (editionIds.length > 0) {
        let locSet = phraseLocales.get(phrase);
        if (!locSet) {
          locSet = new Set();
          phraseLocales.set(phrase, locSet);
        }
        for (const id of editionIds) {
          locSet.add(id);
        }
      }
    }
  }

  const minCoverage = Math.max(2, Math.ceil(CLUSTER_EXPANSION_MIN_CLUSTER_SIZE * 0.67));
  const rankedSeeds = Array.from(phraseCounts.entries())
    .filter(([, count]) => count >= minCoverage)
    .sort((a, b) => {
      const aScore = (phraseScore.get(a[0]) ?? 0) / a[1];
      const bScore = (phraseScore.get(b[0]) ?? 0) / b[1];
      if (b[1] !== a[1]) {
        return b[1] - a[1];
      }
      return bScore - aScore;
    })
    .map(([phrase]) => phrase);

  const fallbackSeeds = (() => {
    const tokenCounts = new Map<string, number>();
    for (const story of eligible) {
      const lang = detectTitleLanguageForCluster(story.title, story.sourceLanguage);
      const seen = new Set<string>();
      for (const token of tokenizeForCluster(story.title, lang)) {
        if (seen.has(token)) {
          continue;
        }
        seen.add(token);
        tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
      }
    }
    return capSlice(
      Array.from(tokenCounts.entries())
        .filter(([, count]) => count >= 2)
        .sort((a, b) => b[1] - a[1])
        .map(([token]) => token),
      CLUSTER_EXPANSION_MAX_TOTAL_QUERIES,
    );
  })();

  const clusterBudget =
    !Number.isFinite(CLUSTER_EXPANSION_MAX_CLUSTERS) || !Number.isFinite(CLUSTER_EXPANSION_MAX_QUERIES_PER_CLUSTER)
      ? Number.POSITIVE_INFINITY
      : CLUSTER_EXPANSION_MAX_CLUSTERS * CLUSTER_EXPANSION_MAX_QUERIES_PER_CLUSTER;
  const seedLimit = Math.min(CLUSTER_EXPANSION_MAX_TOTAL_QUERIES, clusterBudget);
  const expansionTail = `(sect OR "religious group" OR slavery OR raid OR cult OR secte OR sectes OR emprise)`;
  const queries: GoogleNewsQueryRunSpec[] = [];

  if (rankedSeeds.length > 0) {
    for (const phrase of rankedSeeds.slice(0, seedLimit)) {
      const ids = phraseLocales.get(phrase);
      const pin = ids && ids.size > 0 ? [...ids] : undefined;
      queries.push({
        query: `"${phrase}" ${expansionTail}`,
        googleNewsLocaleIds: pin,
      });
    }
  } else if (fallbackSeeds.length > 0) {
    const allPins = new Set<string>();
    for (const story of eligible) {
      for (const id of googleNewsEditionIdsForPublisherUrl(story.url, allLocales)) {
        allPins.add(id);
      }
    }
    const unionPin = allPins.size > 0 ? [...allPins] : undefined;
    for (const token of fallbackSeeds.slice(0, seedLimit)) {
      queries.push({
        query: `"${token}" ${expansionTail}`,
        googleNewsLocaleIds: unionPin,
      });
    }
  }

  return mergeClusterExpansionQuerySpecs(queries);
}

export async function discoverFromGoogleNewsQueries(
  queries: readonly string[] | readonly GoogleNewsQueryRunSpec[],
  sourcePrefix: string,
): Promise<DiscoveredStory[]> {
  const localesFull = loadEuropeGoogleNewsLocales();
  const specs = normalizeGoogleNewsRunSpecs(queries);
  const discovered: DiscoveredStory[] = [];
  const seen = new Set<string>();
  // Google News RSS search returns up to 100 items per request; each query runs per locale edition.
  const perRequestLimit = 100;
  const totalRequests = countGoogleNewsRssCells(specs, localesFull);
  let requestIndex = 0;
  let consecutiveGoogleNewsThrottles = 0;
  const gridStartedAt = Date.now();

  try {
  logDiscoveryProgress('google-news-start', {
    sourcePrefix,
    queryCount: specs.length,
    localeCount: localesFull.length,
    rssRequests: totalRequests,
    totalCap: GOOGLE_NEWS_TOTAL_CAP > 0 ? GOOGLE_NEWS_TOTAL_CAP : 'unlimited',
    logEvery: DISCOVERY_PROGRESS_GOOGLE_NEWS_EVERY,
    logEveryHttp: DISCOVERY_LOG_EVERY_GOOGLE_NEWS_HTTP,
    logFetchLifecycle: DISCOVERY_LOG_GOOGLE_NEWS_FETCH_LIFECYCLE,
  });

  for (let queryIdx = 0; queryIdx < specs.length; queryIdx += 1) {
    const spec = specs[queryIdx]!;
    const query = spec.query;
    const pinned = spec.googleNewsLocaleIds;
    const queryLocales =
      pinned && pinned.length > 0
        ? localesFull.filter((l) => pinned.includes(l.id))
        : localesForGoogleNewsPublisherQuery(query, localesFull);
    const effectiveLocales = queryLocales.length > 0 ? queryLocales : localesFull;
    if (pinned && pinned.length > 0 && queryLocales.length === 0) {
      console.warn('[agent] google-news pinned locales not in europe grid; using full grid', {
        pinned,
        queryPreview: truncateForProgress(query, 96),
      });
    }
    for (let localeIdx = 0; localeIdx < effectiveLocales.length; localeIdx += 1) {
      const locale = effectiveLocales[localeIdx]!;
      requestIndex += 1;

      if (GOOGLE_NEWS_TOTAL_CAP > 0 && discovered.length >= GOOGLE_NEWS_TOTAL_CAP) {
        const rssRequestsPct =
          totalRequests > 0 ? Number(((requestIndex / totalRequests) * 100).toFixed(1)) : 100;
        logDiscoveryProgress('google-news-complete', {
          sourcePrefix,
          reason: 'total_cap',
          discovered: discovered.length,
          cappedAtTotal: GOOGLE_NEWS_TOTAL_CAP,
          requestIndex,
          rssRequests: totalRequests,
          rssRequestsPct,
          elapsedMs: Date.now() - gridStartedAt,
          wrappedLinksBuffered: googleNewsWrappedLinkBuffer.length,
          playwrightAttemptsThisRun: googleNewsPlaywrightAttemptsThisRun,
          playwrightSuccessesThisRun: googleNewsPlaywrightSuccessesThisRun,
        });
        return discovered;
      }

      const rssUrl = buildGoogleNewsRssUrl(query, locale);
      let rssItemCount = 0;
      let addedForRequest = 0;
      let skippedFreshness = 0;
      let skippedDup = 0;
      let fetchOk = false;
      let httpStatus = 0;
      let fromCache = false;
      let fetchError = false;
      let httpDurationMs: number | undefined;
      let httpNetworkAttempts: number | undefined;

      try {
        if (DISCOVERY_LOG_GOOGLE_NEWS_FETCH_LIFECYCLE) {
          logDiscoveryProgress('google-news-rss', {
            phase: 'fetch-start',
            sourcePrefix,
            requestIndex,
            rssRequests: totalRequests,
            localeId: locale.id,
            queryPreview: truncateForProgress(query, 96),
            rssUrlHost: (() => {
              try {
                return new URL(rssUrl).hostname;
              } catch {
                return undefined;
              }
            })(),
          });
        }

        const response = await fetchTextWithCache(rssUrl, {
          headers: {
            'User-Agent': 'FreedomTimes-Local-Agent/0.1',
            Accept: 'application/rss+xml, application/xml, text/xml',
          },
          signal: AbortSignal.timeout(GOOGLE_NEWS_RSS_TIMEOUT_MS),
        });

        fetchOk = response.ok;
        httpStatus = response.status;
        fromCache = response.fromCache;
        httpDurationMs = response.requestDurationMs;
        httpNetworkAttempts = response.networkAttempts;
        consecutiveGoogleNewsThrottles =
          !fromCache && (httpStatus === 429 || httpStatus === 503) ? consecutiveGoogleNewsThrottles + 1 : 0;

        if (DISCOVERY_LOG_GOOGLE_NEWS_FETCH_LIFECYCLE) {
          logDiscoveryProgress('google-news-rss', {
            phase: 'fetch-done',
            sourcePrefix,
            requestIndex,
            localeId: locale.id,
            queryPreview: truncateForProgress(query, 96),
            httpDurationMs: response.requestDurationMs,
            networkAttempts: response.networkAttempts,
            fromCache: response.fromCache,
            httpStatus: response.status,
            fetchOk: response.ok,
          });
        }

        if (DISCOVERY_LOG_EVERY_GOOGLE_NEWS_HTTP) {
          logDiscoveryProgress('google-news-http', {
            sourcePrefix,
            requestIndex,
            localeId: locale.id,
            queryPreview: truncateForProgress(query, 96),
            httpDurationMs: response.requestDurationMs,
            networkAttempts: response.networkAttempts,
            fromCache: response.fromCache,
            httpStatus: response.status,
            fetchOk: response.ok,
          });
        }

        if (!response.ok) {
          if (consecutiveGoogleNewsThrottles >= GOOGLE_NEWS_RSS_MAX_CONSECUTIVE_THROTTLES) {
            logDiscoveryProgress('google-news-complete', {
              sourcePrefix,
              reason: 'consecutive_google_news_throttles',
              requestIndex,
              rssRequests: totalRequests,
              httpStatus,
              consecutiveGoogleNewsThrottles,
              maxConsecutiveGoogleNewsThrottles: GOOGLE_NEWS_RSS_MAX_CONSECUTIVE_THROTTLES,
              discovered: discovered.length,
              elapsedMs: Date.now() - gridStartedAt,
              wrappedLinksBuffered: googleNewsWrappedLinkBuffer.length,
            });
            return discovered;
          }
        } else {
          const parsed = parseGoogleNewsFeed(response.text);
          rssItemCount = parsed.length;
          let rssItemsMissingMetadata = 0;
          let wrappedLinkRows = 0;
          for (const item of parsed) {
            if (!item.originalUrlFromMetadata) {
              rssItemsMissingMetadata += 1;
            }
          }

          const logPostprocess =
            DISCOVERY_LOG_GOOGLE_NEWS_FETCH_LIFECYCLE && rssItemsMissingMetadata > 0;
          const postprocessStartedAt = logPostprocess ? Date.now() : 0;
          if (logPostprocess) {
            logDiscoveryProgress('google-news-rss', {
              phase: 'postprocess-start',
              sourcePrefix,
              requestIndex,
              rssRequests: totalRequests,
              localeId: locale.id,
              queryPreview: truncateForProgress(query, 96),
              rssItemCount,
              rssItemsMissingMetadata,
              linkResolveConcurrency: GOOGLE_NEWS_LINK_RESOLVE_CONCURRENCY,
            });
          }

          const pooledLinkResolver = createPooledUrlResolver(
            GOOGLE_NEWS_LINK_RESOLVE_CONCURRENCY,
            resolveGoogleNewsLink,
          );
          const prefetchWindow =
            GOOGLE_NEWS_LINK_RESOLVE_CONCURRENCY * GOOGLE_NEWS_LINK_PREFETCH_MULT;

          let resolvedLinkCount = 0;
          let skippedPreResolveFilter = 0;
          let prefetchScheduledThrough = 0;

          for (let i = 0; i < parsed.length; i += 1) {
            const item = parsed[i]!;

            const prefetchTarget = Math.min(i + prefetchWindow, parsed.length);
            while (prefetchScheduledThrough < prefetchTarget) {
              const pj = parsed[prefetchScheduledThrough]!;
              prefetchScheduledThrough += 1;
              if (!isWithinFreshnessWindow(pj.publishedAt)) {
                continue;
              }
              if (
                GOOGLE_NEWS_PRERESOLVE_TITLE_FILTER &&
                !pj.originalUrlFromMetadata &&
                !googleNewsItemHasPreResolveTitleSignal(pj)
              ) {
                continue;
              }
              if (!pj.originalUrlFromMetadata) {
                pooledLinkResolver.schedule(pj.link);
              }
            }

            if (
              (GOOGLE_NEWS_TOTAL_CAP > 0 && discovered.length >= GOOGLE_NEWS_TOTAL_CAP) ||
              addedForRequest >= perRequestLimit
            ) {
              break;
            }

            if (!isWithinFreshnessWindow(item.publishedAt)) {
              skippedFreshness += 1;
              continue;
            }

            if (
              GOOGLE_NEWS_PRERESOLVE_TITLE_FILTER &&
              !item.originalUrlFromMetadata &&
              !googleNewsItemHasPreResolveTitleSignal(item)
            ) {
              skippedPreResolveFilter += 1;
              continue;
            }

            let selectedUrl = item.originalUrlFromMetadata;
            if (!selectedUrl) {
              selectedUrl = await pooledLinkResolver.get(item.link);
              resolvedLinkCount += 1;
              if (logPostprocess) {
                const every = DISCOVERY_PROGRESS_GOOGLE_NEWS_LINK_RESOLVE_EVERY;
                if (resolvedLinkCount === 1 || resolvedLinkCount % every === 0) {
                  logDiscoveryProgress('google-news-rss', {
                    phase: 'resolve-link-progress',
                    sourcePrefix,
                    requestIndex,
                    rssRequests: totalRequests,
                    localeId: locale.id,
                    queryPreview: truncateForProgress(query, 96),
                    resolvedLinkCount,
                    rssItemsMissingMetadata,
                    skippedPreResolveFilter,
                    resolveLinksElapsedMs: Date.now() - postprocessStartedAt,
                  });
                }
              }
            }

            if (isGoogleNewsUrl(selectedUrl)) {
              wrappedLinkRows += 1;
              recordGoogleNewsWrappedLink({
                sourcePrefix,
                localeId: locale.id,
                queryPreview: truncateForProgress(query, 200),
                title: item.title,
                guid: item.guid,
                rssItemLink: item.link,
                resolvedUrl: selectedUrl,
                publisherName: item.publisherName,
                publisherUrl: item.publisherUrl,
                descriptionText: item.descriptionText,
                descriptionLinks: item.descriptionLinks,
              });
              continue;
            }

            if (seen.has(selectedUrl)) {
              skippedDup += 1;
              continue;
            }

            seen.add(selectedUrl);
            discovered.push({
              url: selectedUrl,
              title: item.title,
              publishedAt: item.publishedAt,
              sourceFeed: `${sourcePrefix}[${locale.id}]:${query}`,
              sourceFormat: 'rss',
              sourceCategory: 'aggregator-feed',
              requiresUrlResolution: true,
              publisherName: item.publisherName,
              publisherUrl: item.publisherUrl,
            });
            addedForRequest += 1;
          }

          if (logPostprocess) {
            logDiscoveryProgress('google-news-rss', {
              phase: 'postprocess-done',
              sourcePrefix,
              requestIndex,
              rssRequests: totalRequests,
              localeId: locale.id,
              queryPreview: truncateForProgress(query, 96),
              rssItemCount,
              rssItemsMissingMetadata,
              resolvedLinkCount,
              wrappedLinkRowsThisRequest: wrappedLinkRows,
              skippedPreResolveFilterThisRequest: skippedPreResolveFilter,
              postprocessElapsedMs: Date.now() - postprocessStartedAt,
              addedUniqueThisRequest: addedForRequest,
              skippedFreshnessThisRequest: skippedFreshness,
              skippedDupThisRequest: skippedDup,
            });
          }
        }
      } catch (error) {
        fetchError = true;
        if (DISCOVERY_LOG_GOOGLE_NEWS_FETCH_LIFECYCLE) {
          logDiscoveryProgress('google-news-rss', {
            phase: 'fetch-threw',
            sourcePrefix,
            requestIndex,
            localeId: locale.id,
            queryPreview: truncateForProgress(query, 96),
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const elapsedMs = Date.now() - gridStartedAt;
      const avgMsPerRequest = requestIndex > 0 ? elapsedMs / requestIndex : 0;
      const remainingRequests = totalRequests - requestIndex;
      const etaMs =
        remainingRequests > 0 && avgMsPerRequest > 0 ? Math.round(remainingRequests * avgMsPerRequest) : 0;

      const shouldLogProgress =
        requestIndex === 1 ||
        requestIndex === totalRequests ||
        requestIndex % DISCOVERY_PROGRESS_GOOGLE_NEWS_EVERY === 0;

      if (shouldLogProgress) {
        const rssRequestsPct =
          totalRequests > 0 ? Number(((requestIndex / totalRequests) * 100).toFixed(1)) : 100;
        logDiscoveryProgress('google-news-running', {
          sourcePrefix,
          requestIndex,
          rssRequests: totalRequests,
          rssRequestsPct,
          queryIndex: queryIdx + 1,
          queryCount: specs.length,
          queriesPct:
            specs.length > 0
              ? Number((((queryIdx + (localeIdx + 1) / effectiveLocales.length) / specs.length) * 100).toFixed(1))
              : 100,
          localeIndex: localeIdx + 1,
          localeCount: effectiveLocales.length,
          localeId: locale.id,
          queryPreview: truncateForProgress(query, 96),
          discovered: discovered.length,
          rssItemCount,
          addedUniqueThisRequest: addedForRequest,
          skippedFreshnessThisRequest: skippedFreshness,
          skippedDupThisRequest: skippedDup,
          fetchOk,
          httpStatus,
          fromCache,
          fetchError,
          httpDurationMs,
          networkAttempts: httpNetworkAttempts,
          elapsedMs,
          etaMs,
        });
      }

      if (!fetchOk && httpStatus === 503 && GOOGLE_NEWS_RSS_AFTER_503_MS > 0) {
        if (DISCOVERY_LOG_GOOGLE_NEWS_FETCH_LIFECYCLE) {
          logDiscoveryProgress('google-news-rss', {
            phase: 'pace-after-503',
            sourcePrefix,
            requestIndex,
            sleepMs: GOOGLE_NEWS_RSS_AFTER_503_MS,
          });
        }
        await sleepMs(GOOGLE_NEWS_RSS_AFTER_503_MS);
      }
      if (!fromCache && GOOGLE_NEWS_RSS_REQUEST_GAP_MS > 0) {
        if (DISCOVERY_LOG_GOOGLE_NEWS_FETCH_LIFECYCLE) {
          logDiscoveryProgress('google-news-rss', {
            phase: 'pace-between-requests',
            sourcePrefix,
            requestIndex,
            sleepMs: GOOGLE_NEWS_RSS_REQUEST_GAP_MS,
          });
        }
        await sleepMs(GOOGLE_NEWS_RSS_REQUEST_GAP_MS);
      }
    }
  }

  logDiscoveryProgress('google-news-complete', {
    sourcePrefix,
    reason: 'done',
    discovered: discovered.length,
    requestIndex,
    rssRequests: totalRequests,
    rssRequestsPct: 100,
    elapsedMs: Date.now() - gridStartedAt,
    wrappedLinksBuffered: googleNewsWrappedLinkBuffer.length,
    playwrightAttemptsThisRun: googleNewsPlaywrightAttemptsThisRun,
    playwrightSuccessesThisRun: googleNewsPlaywrightSuccessesThisRun,
  });

  return discovered;
  } finally {
    await disposeGoogleNewsPlaywrightBrowser();
  }
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

function getHost(url: string): string | undefined {
  try {
    return normalizeHost(new URL(url).hostname);
  } catch {
    return undefined;
  }
}

function isPriorityWatchlistHost(url: string): boolean {
  const host = getHost(url);
  if (!host) {
    return false;
  }

  return PRIORITY_WATCHLIST_HOSTS.some((watchHost) => host === watchHost || host.endsWith(`.${watchHost}`));
}

function scoreDiscoveredStory(story: DiscoveredStory, allowedHosts: Set<string>): {
  score: number;
  breakdown: Record<string, number>;
} {
  const breakdown: Record<string, number> = {};
  let score = 0;
  const host = getHost(story.url);

  const add = (reason: string, points: number): void => {
    if (points === 0) {
      return;
    }
    score += points;
    breakdown[reason] = (breakdown[reason] ?? 0) + points;
  };

  if (host && isAllowedOrSubdomain(host, allowedHosts)) {
    add('allowlist_host', 18);
  }

  if (isPriorityWatchlistHost(story.url)) {
    add('priority_watchlist_host', 14);
  }

  if (story.url.startsWith('https://')) {
    add('https_url', 10);
  }

  if (story.publisherName || story.publisherUrl) {
    add('publisher_metadata_present', 8);
  }

  if (!story.requiresUrlResolution) {
    add('direct_url_no_resolution', 6);
  }

  if (story.sourceCategory === 'publisher-feed') {
    add('source_publisher_feed', 12);
  } else if (story.sourceCategory === 'api') {
    add('source_api', 8);
  } else if (story.sourceCategory === 'web-page') {
    add('source_web_page', 4);
  } else if (story.sourceCategory === 'aggregator-feed') {
    add('source_aggregator_feed', 2);
  } else if (story.sourceCategory === 'platform') {
    add('source_platform_penalty', -8);
  }

  const titleLength = story.title.trim().length;
  if (titleLength >= 24 && titleLength <= 180) {
    add('title_length_good', 6);
  } else if (titleLength > 0) {
    add('title_length_ok', 2);
  }

  const titleLower = story.title.toLowerCase();
  if (containsTerm(titleLower, CULT_TERMS)) {
    add('title_has_cult_signal', 12);
  }

  if (containsTerm(titleLower, REGION_TERMS)) {
    add('title_has_region_signal', 8);
  }

  if (FOCUS_SIGNAL_TERMS.length > 0 && containsTerm(titleLower, FOCUS_SIGNAL_TERMS)) {
    add('title_has_focus_signal', 16);
  }

  try {
    const parsed = new URL(story.url);
    const path = parsed.pathname.toLowerCase();

    if (/\/(video|videos|audio|podcast)\//.test(path)) {
      add('url_media_format_penalty', -6);
    }

    if (/\/\d{4}\/\w{3}\/\d{1,2}\//.test(path) || /\/\d{4}\/\d{1,2}\/\d{1,2}\//.test(path)) {
      add('url_article_date_pattern', 6);
    }
  } catch {
    add('url_parse_penalty', -10);
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    breakdown,
  };
}

function isAllowedOrSubdomain(hostname: string, allowedHosts: Set<string>): boolean {
  const host = normalizeHost(hostname);
  for (const allowed of allowedHosts) {
    const normalizedAllowed = normalizeHost(allowed);
    if (host === normalizedAllowed || host.endsWith(`.${normalizedAllowed}`)) {
      return true;
    }
  }
  return false;
}

export async function discoverCandidateStories(allowedHosts: Set<string>): Promise<DiscoveredStory[]> {
  resetGoogleNewsDiscoveryReporting();
  const discovered: DiscoveredStory[] = [];

  try {
  logDiscoveryProgress('start', {
    enabledFeedCount: FEEDS.filter((feed) => feed.enabled).length,
    googleNewsEnabled: DISCOVERY_GOOGLE_NEWS_ENABLED,
    phases: DISCOVERY_GOOGLE_NEWS_ENABLED
      ? ['newsdata', 'headlinefeed', 'google-news', 'publisher-feeds', 'enrich-dates', 'freshness-filter', 'score', 'cluster-expansion']
      : ['newsdata', 'headlinefeed', 'publisher-feeds', 'enrich-dates', 'freshness-filter', 'score', 'cluster-expansion'],
  });

  try {
    discovered.push(...(await discoverFromNewsData()));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[agent] newsdata discovery failed', { message });
  }

  try {
    discovered.push(...(await discoverFromHeadlineFeed()));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[agent] headlinefeed discovery failed', { message });
  }

  if (DISCOVERY_GOOGLE_NEWS_ENABLED) {
    try {
      discovered.push(...(await discoverFromGoogleNews({ flushWrappedLinksReport: false })));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[agent] google-news discovery failed', { message });
    }
  } else {
    console.log('[agent] google-news discovery skipped (DISCOVERY_GOOGLE_NEWS_ENABLED=false)');
  }

  const uniqueFeeds = Array.from(new Map(FEEDS.filter((feed) => feed.enabled).map((feed) => [feed.url, feed])).values());
  let feedIndex = 0;
  const feedFailures: FeedFetchFailure[] = [];

  logDiscoveryProgress('feeds-start', {
    feedCount: uniqueFeeds.length,
    logEvery: DISCOVERY_PROGRESS_FEEDS_EVERY,
  });

  const feedsStartedAt = Date.now();

  for (const feed of uniqueFeeds) {
    feedIndex += 1;

    const shouldLogFeed =
      feedIndex === 1 ||
      feedIndex === uniqueFeeds.length ||
      feedIndex % DISCOVERY_PROGRESS_FEEDS_EVERY === 0;

    if (shouldLogFeed) {
      const feedsPct =
        uniqueFeeds.length > 0 ? Number(((feedIndex / uniqueFeeds.length) * 100).toFixed(1)) : 100;
      const elapsedMs = Date.now() - feedsStartedAt;
      const avgMsPerFeed = feedIndex > 0 ? elapsedMs / feedIndex : 0;
      const remainingFeeds = uniqueFeeds.length - feedIndex;
      const etaMs =
        remainingFeeds > 0 && avgMsPerFeed > 0 ? Math.round(remainingFeeds * avgMsPerFeed) : 0;
      logDiscoveryProgress('feeds-running', {
        feedIndex,
        feedCount: uniqueFeeds.length,
        feedsPct,
        feedId: feed.id,
        feedTitle: truncateForProgress(feed.title, 80),
        discovered: discovered.length,
        elapsedMs,
        etaMs,
      });
    }

    try {
      const response = await fetchTextWithCache(feed.url, {
        headers: FEED_REQUEST_HEADERS,
      });

      if (!response.ok) {
        console.warn('[agent] feed fetch failed', { feedUrl: feed.url, status: response.status });
        feedFailures.push({
          feedId: feed.id,
          feedTitle: feed.title,
          feedUrl: feed.url,
          timestamp: new Date().toISOString(),
          status: response.status,
          finalUrl: response.url,
          contentType: response.headers['content-type'],
          requestDurationMs: response.requestDurationMs,
          networkAttempts: response.networkAttempts,
          errorMessage: `HTTP ${response.status}`,
          requestHeaders: FEED_REQUEST_HEADERS,
        });
        continue;
      }

      discovered.push(...parseFeed(response.text, feed));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[agent] feed fetch error', { feedUrl: feed.url, message });
      feedFailures.push({
        feedId: feed.id,
        feedTitle: feed.title,
        feedUrl: feed.url,
        timestamp: new Date().toISOString(),
        errorMessage: message,
        requestHeaders: FEED_REQUEST_HEADERS,
      });
    }
  }

  writeFeedFetchFailuresReport(feedFailures);

  logDiscoveryProgress('feeds-complete', {
    discovered: discovered.length,
    failedFeeds: feedFailures.length,
  });

  const deduped = Array.from(new Map(discovered.map((item) => [item.url, item])).values());
  logDiscoveryProgress('enrich-published-at-start', { deduped: deduped.length });
  const enriched = await enrichPublishedAtForMissing(deduped);
  logDiscoveryProgress('enrich-published-at-complete', { enriched: enriched.length });
  const fresh = enriched.filter((item) => isWithinFreshnessWindow(item.publishedAt));

  logDiscoveryProgress('freshness-filter', {
    maxAgeHours: DISCOVERY_MAX_AGE_HOURS,
    input: enriched.length,
    kept: fresh.length,
    dropped: enriched.length - fresh.length,
  });

  const scored = fresh.map((item) => {
    const scoredStory = scoreDiscoveredStory(item, allowedHosts);
    return {
      ...item,
      discoveryScore: scoredStory.score,
      discoveryScoreBreakdown: scoredStory.breakdown,
    };
  });

  if (CLUSTER_EXPANSION_ENABLED && DISCOVERY_GOOGLE_NEWS_ENABLED) {
    const expansionQueries = buildExpansionQueries(scored);
    if (expansionQueries.length > 0) {
      logDiscoveryProgress('cluster-expansion-start', {
        queryCount: expansionQueries.length,
        queryPreview: expansionQueries.map((spec) =>
          truncateForProgress(
            spec.googleNewsLocaleIds?.length
              ? `${spec.query} @(${spec.googleNewsLocaleIds.join(',')})`
              : spec.query,
            96,
          ),
        ),
      });

      try {
        const expanded = await discoverFromGoogleNewsQueries(expansionQueries, 'google-news-cluster');
        if (expanded.length > 0) {
          const alreadySeen = new Set(scored.map((item) => item.url));
          const novelExpanded = expanded.filter((item) => !alreadySeen.has(item.url));
          for (const item of novelExpanded) {
            const scoredStory = scoreDiscoveredStory(item, allowedHosts);
            scored.push({
              ...item,
              discoveryScore: scoredStory.score,
              discoveryScoreBreakdown: scoredStory.breakdown,
            });
          }

          logDiscoveryProgress('cluster-expansion-complete', {
            discovered: expanded.length,
            novelAdded: novelExpanded.length,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn('[agent] cluster expansion discovery failed', { message });
      }
    }
  }

  scored.sort((a, b) => {
    const scoreDiff = (b.discoveryScore ?? 0) - (a.discoveryScore ?? 0);
    if (scoreDiff !== 0) {
      return scoreDiff;
    }

    const aPriority = isPriorityWatchlistHost(a.url) ? 1 : 0;
    const bPriority = isPriorityWatchlistHost(b.url) ? 1 : 0;
    return bPriority - aPriority;
  });

  logDiscoveryProgress('complete', {
    discoveredRaw: discovered.length,
    deduped: deduped.length,
    fresh: fresh.length,
    returned: scored.length,
  });

  return scored;
  } finally {
    flushGoogleNewsWrappedLinksReport();
  }
}
