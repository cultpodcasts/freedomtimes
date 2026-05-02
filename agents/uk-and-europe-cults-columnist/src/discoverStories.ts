import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { detect as detectClusterTitleLanguage } from 'tinyld';
import { ALL_CULT_TERMS, getCultTermsForLanguage } from './cultTerms.js';
import { fetchJsonWithCache, fetchTextWithCache } from './httpCache.js';
import {
  FOCUS_SIGNAL_TERMS,
  GOOGLE_NEWS_COUNTRY_TERMS,
  GOOGLE_NEWS_GENERIC_QUERIES,
  GOOGLE_NEWS_QUERY_GROUPS,
  GOOGLE_NEWS_WATCHLIST_SITES,
  NEWSDATA_COUNTRY_CODES,
  NEWSDATA_LANGUAGES,
  NEWSDATA_QUERIES,
  PRIORITY_WATCHLIST_HOSTS,
  REGION_TERMS,
} from './discoveryConfig.js';

type GoogleNewsUrlDecoder = {
  decode: (url: string) => Promise<{ status?: boolean; decoded_url?: string; message?: string }>;
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

const MAX_WATCHLIST_GOOGLE_QUERIES_PER_RUN = 28;
const CLUSTER_EXPANSION_ENABLED = (process.env.CLUSTER_EXPANSION_ENABLED ?? 'true').toLowerCase() !== 'false';
const CLUSTER_EXPANSION_MIN_CLUSTER_SIZE = Math.max(
  2,
  Number.parseInt(process.env.CLUSTER_EXPANSION_MIN_CLUSTER_SIZE ?? '3', 10) || 3,
);
const CLUSTER_EXPANSION_MIN_SCORE = Math.max(
  1,
  Number.parseInt(process.env.CLUSTER_EXPANSION_MIN_SCORE ?? '70', 10) || 70,
);
const CLUSTER_EXPANSION_MAX_CLUSTERS = Math.max(
  1,
  Number.parseInt(process.env.CLUSTER_EXPANSION_MAX_CLUSTERS ?? '2', 10) || 2,
);
const CLUSTER_EXPANSION_MAX_QUERIES_PER_CLUSTER = Math.max(
  1,
  Number.parseInt(process.env.CLUSTER_EXPANSION_MAX_QUERIES_PER_CLUSTER ?? '3', 10) || 3,
);
const CLUSTER_EXPANSION_MAX_TOTAL_QUERIES = Math.max(
  1,
  Number.parseInt(process.env.CLUSTER_EXPANSION_MAX_TOTAL_QUERIES ?? '6', 10) || 6,
);

/** Hard stop so multi-locale Google News runs cannot fetch without bound. */
const GOOGLE_NEWS_TOTAL_CAP = Math.max(
  1000,
  Number.parseInt(process.env.GOOGLE_NEWS_TOTAL_CAP ?? '25000', 10) || 25000,
);

/** Pacing between Google News RSS cells to reduce 429/503 bursts (0 = off). */
const GOOGLE_NEWS_RSS_REQUEST_GAP_MS = Math.max(
  0,
  Number.parseInt(process.env.GOOGLE_NEWS_RSS_REQUEST_GAP_MS ?? '200', 10) || 0,
);

/** Extra pause after a 503 on Google News RSS so rate limits can recover (0 = off). */
const GOOGLE_NEWS_RSS_AFTER_503_MS = Math.max(
  0,
  Number.parseInt(process.env.GOOGLE_NEWS_RSS_AFTER_503_MS ?? '5000', 10) || 0,
);

/** Concurrent article link resolutions after each RSS parse (same URL shares one in-flight job). */
const GOOGLE_NEWS_LINK_RESOLVE_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.GOOGLE_NEWS_LINK_RESOLVE_CONCURRENCY ?? '8', 10) || 8,
);

/** How far ahead to schedule link resolves (items in the feed), as a multiple of concurrency. */
const GOOGLE_NEWS_LINK_PREFETCH_MULT = Math.max(
  2,
  Number.parseInt(process.env.GOOGLE_NEWS_LINK_PREFETCH_MULT ?? '4', 10) || 4,
);

/** Write `reports/google-news-query-plan-*.json` (and `-latest`) before each main Google News pass. */
const GOOGLE_NEWS_RECORD_QUERY_PLAN =
  (process.env.GOOGLE_NEWS_RECORD_QUERY_PLAN ?? 'true').toLowerCase() !== 'false';

/** If true, each plan row includes `localeIds` (much larger JSON). `rssCells` is always included. */
const GOOGLE_NEWS_QUERY_PLAN_INCLUDE_LOCALE_IDS =
  (process.env.GOOGLE_NEWS_QUERY_PLAN_INCLUDE_LOCALE_IDS ?? 'false').toLowerCase() === 'true';

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
const NEWSIO_MAX_CREDITS_PER_RUN = Math.max(
  1,
  Number.parseInt(process.env.NEWSIO_MAX_CREDITS_PER_RUN ?? `${DEFAULT_NEWSIO_MAX_CREDITS_PER_RUN}`, 10) ||
    DEFAULT_NEWSIO_MAX_CREDITS_PER_RUN,
);

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

function googleNewsHlIsDe(hl: string): boolean {
  const h = hl.toLowerCase();
  return h === 'de' || h.startsWith('de-');
}

function googleNewsHlIsFr(hl: string): boolean {
  const h = hl.toLowerCase();
  return h === 'fr' || h.startsWith('fr-');
}

function googleNewsHlIsIt(hl: string): boolean {
  const h = hl.toLowerCase();
  return h === 'it' || h.startsWith('it-');
}

/**
 * When every Google News edition we use for a host shares one `hl`, emit one OR-rich query
 * (localized cult terms × European country names) instead of English `cult "UK"` … grids.
 */
function watchlistLanguageProfileForSite(
  site: string,
): 'de-one' | 'fr-one' | 'it-one' | 'en-cartesian' {
  const host = normalizePublisherSiteHost(site);
  const probe = `site:${host} cult`;
  const allLocales = loadEuropeGoogleNewsLocales();
  const queryLocales = localesForGoogleNewsPublisherQuery(probe, allLocales);
  if (queryLocales.length === 0) {
    return 'en-cartesian';
  }

  const hls = queryLocales.map((l) => l.hl);
  if (hls.every(googleNewsHlIsDe)) {
    return 'de-one';
  }
  if (hls.every(googleNewsHlIsFr)) {
    return 'fr-one';
  }
  if (hls.every(googleNewsHlIsIt)) {
    return 'it-one';
  }
  return 'en-cartesian';
}

function buildWatchlistQueries(): string[] {
  const queries: string[] = [];
  const g = GOOGLE_NEWS_QUERY_GROUPS;
  const deCult = g.deAtChTerms;
  const deCountries = g.deEuropeCountryOr;
  const frCult = g.frBeTerms;
  const frCountries = g.frEuropeCountryOr;
  const itCult = g.itTerms;
  const itCountries = g.itEuropeCountryOr;

  for (const site of GOOGLE_NEWS_WATCHLIST_SITES) {
    const profile = watchlistLanguageProfileForSite(site);
    if (profile === 'de-one' && deCult?.length && deCountries?.length) {
      queries.push(`site:${site} ${formatWatchlistOrGroup(deCult)} ${formatWatchlistOrGroup(deCountries)}`);
      continue;
    }
    if (profile === 'fr-one' && frCult?.length && frCountries?.length) {
      queries.push(`site:${site} ${formatWatchlistOrGroup(frCult)} ${formatWatchlistOrGroup(frCountries)}`);
      continue;
    }
    if (profile === 'it-one' && itCult?.length && itCountries?.length) {
      queries.push(`site:${site} ${formatWatchlistOrGroup(itCult)} ${formatWatchlistOrGroup(itCountries)}`);
      continue;
    }

    for (const country of GOOGLE_NEWS_COUNTRY_TERMS) {
      queries.push(`site:${site} cult "${country}"`);
    }
  }

  return queries;
}

function rotateArray<T>(items: T[], offset: number): T[] {
  if (items.length === 0) {
    return items;
  }

  const start = ((offset % items.length) + items.length) % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
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
  publishedAt?: string;
  publisherName?: string;
  publisherUrl?: string;
  originalUrlFromMetadata?: string;
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
  const hrefMatches = description.match(/href=["']([^"']+)["']/gi) ?? [];
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
      return href;
    } catch {
      // Ignore malformed links in description.
    }
  }

  return undefined;
}

function parseGoogleNewsFeed(xml: string): GoogleNewsFeedItem[] {
  const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/gi) ?? [];
  const items: GoogleNewsFeedItem[] = [];

  for (const block of itemBlocks) {
    const title = extractTag(block, 'title') ?? '';
    const description = extractTag(block, 'description') ?? '';
    const link = extractTag(block, 'link') ?? '';
    const source = extractSourceTag(block);

    if (!title || !link) {
      continue;
    }

    items.push({
      title: title.trim(),
      link: link.trim(),
      publishedAt: normalizePublishedAt(extractTag(block, 'pubDate')),
      publisherName: source.publisherName,
      publisherUrl: source.publisherUrl,
      originalUrlFromMetadata: extractOriginalUrlFromDescription(description),
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
  useAllLocalesHosts?: string[];
  localeIdsByHost?: Record<string, string[]>;
};

let publisherSiteLocalesCache: PublisherSiteLocalesJson | undefined;
const warnedPublisherHostsWithoutRule = new Set<string>();

/** ISO 3166-1 alpha-2 TLD (last label) → Google News `gl` for our European editions. */
const CC_TLD_TO_GL: Record<string, string> = {
  ie: 'IE',
  fr: 'FR',
  es: 'ES',
  it: 'IT',
  nl: 'NL',
  be: 'BE',
  at: 'AT',
  ch: 'CH',
  pl: 'PL',
  pt: 'PT',
  gr: 'GR',
  cy: 'CY',
  cz: 'CZ',
  sk: 'SK',
  hu: 'HU',
  ro: 'RO',
  bg: 'BG',
  hr: 'HR',
  si: 'SI',
  rs: 'RS',
  ba: 'BA',
  me: 'ME',
  mk: 'MK',
  al: 'AL',
  ua: 'UA',
  md: 'MD',
  se: 'SE',
  no: 'NO',
  dk: 'DK',
  fi: 'FI',
  is: 'IS',
  ee: 'EE',
  lv: 'LV',
  lt: 'LT',
  lu: 'LU',
  mt: 'MT',
  de: 'DE',
};

function loadPublisherSiteLocalesConfig(): PublisherSiteLocalesJson {
  if (publisherSiteLocalesCache) {
    return publisherSiteLocalesCache;
  }

  try {
    const configUrl = new URL('../data/google-news-publisher-site-locales.json', import.meta.url);
    const raw = readFileSync(configUrl, 'utf-8');
    const parsed = JSON.parse(raw) as PublisherSiteLocalesJson;
    const rawHostMap =
      parsed.localeIdsByHost && typeof parsed.localeIdsByHost === 'object' && !Array.isArray(parsed.localeIdsByHost)
        ? parsed.localeIdsByHost
        : {};
    const localeIdsByHost: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(rawHostMap)) {
      if (!Array.isArray(v)) {
        continue;
      }
      localeIdsByHost[normalizePublisherSiteHost(k)] = v.filter((id): id is string => typeof id === 'string');
    }
    publisherSiteLocalesCache = {
      useAllLocalesHosts: Array.isArray(parsed.useAllLocalesHosts)
        ? parsed.useAllLocalesHosts.map((h) => normalizePublisherSiteHost(String(h)))
        : [],
      localeIdsByHost,
    };
    return publisherSiteLocalesCache;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[agent] failed to load google-news-publisher-site-locales.json', { message });
    publisherSiteLocalesCache = { useAllLocalesHosts: [], localeIdsByHost: {} };
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

/** First `site:` host in the query, if any (Google News `site:` operator). */
function extractSiteHostFromGoogleNewsQuery(query: string): string | undefined {
  const match = query.match(/\bsite:([^\s)]+)/i);
  return match?.[1] ? normalizePublisherSiteHost(match[1]) : undefined;
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

/**
 * For `site:publisher` watchlist queries, only Google News editions that match the publisher's market.
 * Generic queries (no `site:`) use the full European locale set.
 */
function localesForGoogleNewsPublisherQuery(query: string, allLocales: GoogleNewsLocale[]): GoogleNewsLocale[] {
  const siteHost = extractSiteHostFromGoogleNewsQuery(query);
  if (!siteHost) {
    return allLocales;
  }

  const cfg = loadPublisherSiteLocalesConfig();
  const useAll = new Set((cfg.useAllLocalesHosts ?? []).map(normalizePublisherSiteHost));
  if (useAll.has(siteHost)) {
    return allLocales;
  }

  const byHost = cfg.localeIdsByHost ?? {};
  const explicit = byHost[siteHost];
  if (explicit && explicit.length > 0) {
    const idSet = new Set(explicit);
    const picked = allLocales.filter((l) => idSet.has(l.id));
    if (picked.length > 0) {
      return picked;
    }
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
      hint: 'data/google-news-publisher-site-locales.json',
    });
  }

  return allLocales;
}

function countGoogleNewsRssCells(queries: string[], allLocales: GoogleNewsLocale[]): number {
  let n = 0;
  for (const q of queries) {
    n += localesForGoogleNewsPublisherQuery(q, allLocales).length;
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

async function resolveGoogleNewsLink(url: string): Promise<string> {
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

    return response.url;
  } catch {
    // Fallback to original URL.
  }

  return url;
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
  watchlistProfile?: 'de-one' | 'fr-one' | 'it-one' | 'en-cartesian';
  localeIds?: string[];
  rssCells: number;
  inMainPassThisRun: boolean;
};

function buildGoogleNewsQueryPlanRow(
  query: string,
  source: 'watchlist' | 'generic',
  allLocales: GoogleNewsLocale[],
): Omit<GoogleNewsQueryPlanRow, 'inMainPassThisRun'> {
  const siteHost = extractSiteHostFromGoogleNewsQuery(query);
  const queryLocales = localesForGoogleNewsPublisherQuery(query, allLocales);
  const watchlistProfile = siteHost ? watchlistLanguageProfileForSite(siteHost) : undefined;
  const row: Omit<GoogleNewsQueryPlanRow, 'inMainPassThisRun'> = {
    query,
    source,
    siteHost: siteHost ?? undefined,
    watchlistProfile,
    rssCells: queryLocales.length,
  };
  if (GOOGLE_NEWS_QUERY_PLAN_INCLUDE_LOCALE_IDS) {
    row.localeIds = queryLocales.map((l) => l.id);
  }
  return row;
}

function recordGoogleNewsQueryPlanFromConfig(params: {
  runSeed: number;
  watchlistQueriesFull: string[];
  mainPassQueries: string[];
}): void {
  if (!GOOGLE_NEWS_RECORD_QUERY_PLAN) {
    return;
  }

  const allLocales = loadEuropeGoogleNewsLocales();
  const mainPassSet = new Set(params.mainPassQueries);
  const genericSet = new Set(GOOGLE_NEWS_GENERIC_QUERIES);

  const configDerivedQueries: GoogleNewsQueryPlanRow[] = [
    ...params.watchlistQueriesFull.map((query) => ({
      ...buildGoogleNewsQueryPlanRow(query, 'watchlist', allLocales),
      inMainPassThisRun: mainPassSet.has(query),
    })),
    ...GOOGLE_NEWS_GENERIC_QUERIES.map((query) => ({
      ...buildGoogleNewsQueryPlanRow(query, 'generic', allLocales),
      inMainPassThisRun: mainPassSet.has(query),
    })),
  ];

  const watchlistByHost: Record<
    string,
    {
      watchlistProfile?: 'de-one' | 'fr-one' | 'it-one' | 'en-cartesian';
      queryCount: number;
      rssCellsSum: number;
      queries: string[];
    }
  > = {};

  for (const row of configDerivedQueries) {
    if (row.source !== 'watchlist' || !row.siteHost) {
      continue;
    }
    const bucket = watchlistByHost[row.siteHost] ?? {
      watchlistProfile: row.watchlistProfile,
      queryCount: 0,
      rssCellsSum: 0,
      queries: [],
    };
    bucket.queryCount += 1;
    bucket.rssCellsSum += row.rssCells;
    bucket.queries.push(row.query);
    if (!bucket.watchlistProfile && row.watchlistProfile) {
      bucket.watchlistProfile = row.watchlistProfile;
    }
    watchlistByHost[row.siteHost] = bucket;
  }

  const mainPassRows: GoogleNewsQueryPlanRow[] = params.mainPassQueries.map((query) => ({
    ...buildGoogleNewsQueryPlanRow(query, genericSet.has(query) ? 'generic' : 'watchlist', allLocales),
    inMainPassThisRun: true,
  }));

  const payload = {
    recordedAt: new Date().toISOString(),
    runSeed: params.runSeed,
    maxWatchlistQueriesPerRun: MAX_WATCHLIST_GOOGLE_QUERIES_PER_RUN,
    localeCount: allLocales.length,
    options: {
      includeLocaleIdsPerQuery: GOOGLE_NEWS_QUERY_PLAN_INCLUDE_LOCALE_IDS,
    },
    summary: {
      configWatchlistQueryStrings: params.watchlistQueriesFull.length,
      configGenericQueryStrings: GOOGLE_NEWS_GENERIC_QUERIES.length,
      mainPassQueryStrings: params.mainPassQueries.length,
      rssCellsFullConfigPool: countGoogleNewsRssCells(
        [...params.watchlistQueriesFull, ...GOOGLE_NEWS_GENERIC_QUERIES],
        allLocales,
      ),
      rssCellsMainPassThisRun: countGoogleNewsRssCells(params.mainPassQueries, allLocales),
    },
    configDerivedQueries,
    watchlistByHost,
    mainPassThisRun: {
      queryStringsInOrder: params.mainPassQueries,
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

/** Google News RSS discovery only (watchlist + generic queries), for tooling / smoke tests. */
export async function discoverFromGoogleNews(): Promise<DiscoveredStory[]> {
  const watchlistQueries = buildWatchlistQueries();
  const runSeed = Number.parseInt(new Date().toISOString().slice(0, 10).replace(/-/g, ''), 10);
  const rotatedWatchlistQueries = rotateArray(watchlistQueries, runSeed);
  const boundedWatchlistQueries = rotatedWatchlistQueries.slice(0, MAX_WATCHLIST_GOOGLE_QUERIES_PER_RUN);
  const queries = [...boundedWatchlistQueries, ...GOOGLE_NEWS_GENERIC_QUERIES];
  recordGoogleNewsQueryPlanFromConfig({
    runSeed,
    watchlistQueriesFull: watchlistQueries,
    mainPassQueries: queries,
  });
  return discoverFromGoogleNewsQueries(queries, 'google-news');
}

/** Diagnostics: planned RSS GET counts for the main Google News pass (no network). */
export function reportGoogleNewsMainPassRssFootprint(isoDateSeed?: string): Record<string, unknown> {
  const locales = loadEuropeGoogleNewsLocales();
  const localeCount = locales.length;
  const runSeed = Number.parseInt((isoDateSeed ?? new Date().toISOString().slice(0, 10)).replace(/-/g, ''), 10);

  const watchlistQueries = buildWatchlistQueries();
  const rotated = rotateArray(watchlistQueries, runSeed);
  const boundedWatchlist = rotated.slice(0, MAX_WATCHLIST_GOOGLE_QUERIES_PER_RUN);
  const passQueries = [...boundedWatchlist, ...GOOGLE_NEWS_GENERIC_QUERIES];
  const rssCellsThisPass = countGoogleNewsRssCells(passQueries, locales);

  let profileDe = 0;
  let profileFr = 0;
  let profileIt = 0;
  let profileEn = 0;
  for (const site of GOOGLE_NEWS_WATCHLIST_SITES) {
    const p = watchlistLanguageProfileForSite(site);
    if (p === 'de-one') {
      profileDe += 1;
    } else if (p === 'fr-one') {
      profileFr += 1;
    } else if (p === 'it-one') {
      profileIt += 1;
    } else {
      profileEn += 1;
    }
  }

  const legacyEnglishWatchlist: string[] = [];
  for (const site of GOOGLE_NEWS_WATCHLIST_SITES) {
    for (const country of GOOGLE_NEWS_COUNTRY_TERMS) {
      legacyEnglishWatchlist.push(`site:${site} cult "${country}"`);
    }
  }
  const legacyRotated = rotateArray(legacyEnglishWatchlist, runSeed);
  const legacyBounded = legacyRotated.slice(0, MAX_WATCHLIST_GOOGLE_QUERIES_PER_RUN);
  const legacyPassQueries = [...legacyBounded, ...GOOGLE_NEWS_GENERIC_QUERIES];
  const rssCellsLegacyWatchlistPublisherLocales = countGoogleNewsRssCells(legacyPassQueries, locales);
  const rssCellsLegacyWatchlistAllLocalesEveryQuery = legacyPassQueries.length * localeCount;

  const allNewPlusGeneric = [...watchlistQueries, ...GOOGLE_NEWS_GENERIC_QUERIES];
  const allLegacyPlusGeneric = [...legacyEnglishWatchlist, ...GOOGLE_NEWS_GENERIC_QUERIES];
  const rssCellsFullPoolNew = countGoogleNewsRssCells(allNewPlusGeneric, locales);
  const rssCellsFullPoolLegacyPublisherLocales = countGoogleNewsRssCells(allLegacyPlusGeneric, locales);
  const rssCellsFullPoolLegacyFullGrid = allLegacyPlusGeneric.length * localeCount;

  return {
    localeCount,
    runSeed,
    maxWatchlistQueriesPerRun: MAX_WATCHLIST_GOOGLE_QUERIES_PER_RUN,
    genericTemplateQueries: GOOGLE_NEWS_GENERIC_QUERIES.length,
    watchlistSites: GOOGLE_NEWS_WATCHLIST_SITES.length,
    watchlistQueryStringsTotal: watchlistQueries.length,
    watchlistProfileSites: { deOne: profileDe, frOne: profileFr, itOne: profileIt, enCartesian: profileEn },
    queriesInMainPass: passQueries.length,
    rssGetCellsMainPass: rssCellsThisPass,
    /** Same 28-slot rotation + generics, old `cult "<country>"` grid, current per-publisher locales. */
    rssGetCellsLegacyEnglishWatchlistPublisherLocales: rssCellsLegacyWatchlistPublisherLocales,
    /** Same pass query count, every query × every locale (no publisher-scoped locales). */
    rssGetCellsLegacyFullEuropeGrid: rssCellsLegacyWatchlistAllLocalesEveryQuery,
    legacyEnglishWatchlistStringsTotal: legacyEnglishWatchlist.length,
    /** Entire watchlist pool + generics, current localized watchlist + publisher locales. */
    rssGetCellsFullPoolNewWatchlist: rssCellsFullPoolNew,
    /** Entire legacy English grid + generics, publisher locales. */
    rssGetCellsFullPoolLegacyWatchlistPublisherLocales: rssCellsFullPoolLegacyPublisherLocales,
    /** Entire legacy grid + generics × all locales every time. */
    rssGetCellsFullPoolLegacyFullEuropeGrid: rssCellsFullPoolLegacyFullGrid,
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

function buildExpansionQueries(scored: DiscoveredStory[]): string[] {
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
    return [];
  }

  const phraseCounts = new Map<string, number>();
  const phraseScore = new Map<string, number>();
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
    for (const phrase of phrases) {
      if (seen.has(phrase)) {
        continue;
      }
      seen.add(phrase);
      phraseCounts.set(phrase, (phraseCounts.get(phrase) ?? 0) + 1);
      phraseScore.set(phrase, (phraseScore.get(phrase) ?? 0) + (story.discoveryScore ?? 0));
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
    return Array.from(tokenCounts.entries())
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .map(([token]) => token)
      .slice(0, CLUSTER_EXPANSION_MAX_TOTAL_QUERIES);
  })();

  const seeds = rankedSeeds.length > 0 ? rankedSeeds : fallbackSeeds;
  if (seeds.length === 0) {
    return [];
  }

  const queries: string[] = [];
  const seedLimit = Math.min(
    CLUSTER_EXPANSION_MAX_TOTAL_QUERIES,
    CLUSTER_EXPANSION_MAX_CLUSTERS * CLUSTER_EXPANSION_MAX_QUERIES_PER_CLUSTER,
  );
  for (const seed of seeds.slice(0, seedLimit)) {
    queries.push(`"${seed}" (sect OR "religious group" OR slavery OR raid OR cult)`);
  }

  return Array.from(new Set(queries));
}

async function discoverFromGoogleNewsQueries(queries: string[], sourcePrefix: string): Promise<DiscoveredStory[]> {
  const localesFull = loadEuropeGoogleNewsLocales();
  const discovered: DiscoveredStory[] = [];
  const seen = new Set<string>();
  // Google News RSS search returns up to 100 items per request; each query runs per locale edition.
  const perRequestLimit = 100;
  const totalRequests = countGoogleNewsRssCells(queries, localesFull);
  let requestIndex = 0;
  const gridStartedAt = Date.now();

  logDiscoveryProgress('google-news-start', {
    sourcePrefix,
    queryCount: queries.length,
    localeCount: localesFull.length,
    rssRequests: totalRequests,
    totalCap: GOOGLE_NEWS_TOTAL_CAP,
    logEvery: DISCOVERY_PROGRESS_GOOGLE_NEWS_EVERY,
    logEveryHttp: DISCOVERY_LOG_EVERY_GOOGLE_NEWS_HTTP,
    logFetchLifecycle: DISCOVERY_LOG_GOOGLE_NEWS_FETCH_LIFECYCLE,
  });

  for (let queryIdx = 0; queryIdx < queries.length; queryIdx += 1) {
    const query = queries[queryIdx]!;
    const queryLocales = localesForGoogleNewsPublisherQuery(query, localesFull);
    for (let localeIdx = 0; localeIdx < queryLocales.length; localeIdx += 1) {
      const locale = queryLocales[localeIdx]!;
      requestIndex += 1;

      if (discovered.length >= GOOGLE_NEWS_TOTAL_CAP) {
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
        });

        fetchOk = response.ok;
        httpStatus = response.status;
        fromCache = response.fromCache;
        httpDurationMs = response.requestDurationMs;
        httpNetworkAttempts = response.networkAttempts;

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
          // fall through to logging
        } else {
          const parsed = parseGoogleNewsFeed(response.text);
          rssItemCount = parsed.length;
          let rssItemsMissingMetadata = 0;
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
              if (!pj.originalUrlFromMetadata) {
                pooledLinkResolver.schedule(pj.link);
              }
            }

            if (discovered.length >= GOOGLE_NEWS_TOTAL_CAP || addedForRequest >= perRequestLimit) {
              break;
            }

            if (!isWithinFreshnessWindow(item.publishedAt)) {
              skippedFreshness += 1;
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
                    resolveLinksElapsedMs: Date.now() - postprocessStartedAt,
                  });
                }
              }
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
          queryCount: queries.length,
          queriesPct:
            queries.length > 0
              ? Number((((queryIdx + (localeIdx + 1) / queryLocales.length) / queries.length) * 100).toFixed(1))
              : 100,
          localeIndex: localeIdx + 1,
          localeCount: queryLocales.length,
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
  });

  return discovered;
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
  const discovered: DiscoveredStory[] = [];

  logDiscoveryProgress('start', {
    enabledFeedCount: FEEDS.filter((feed) => feed.enabled).length,
    phases: ['newsdata', 'google-news', 'publisher-feeds', 'enrich-dates', 'freshness-filter', 'score', 'cluster-expansion'],
  });

  try {
    discovered.push(...(await discoverFromNewsData()));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[agent] newsdata discovery failed', { message });
  }

  try {
    discovered.push(...(await discoverFromGoogleNews()));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[agent] google-news discovery failed', { message });
  }

  const uniqueFeeds = Array.from(new Map(FEEDS.filter((feed) => feed.enabled).map((feed) => [feed.url, feed])).values());
  let feedIndex = 0;

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
        headers: {
          'User-Agent': 'FreedomTimes-Local-Agent/0.1',
          Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
        },
      });

      if (!response.ok) {
        console.warn('[agent] feed fetch failed', { feedUrl: feed.url, status: response.status });
        continue;
      }

      discovered.push(...parseFeed(response.text, feed));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[agent] feed fetch error', { feedUrl: feed.url, message });
    }
  }

  logDiscoveryProgress('feeds-complete', {
    discovered: discovered.length,
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

  if (CLUSTER_EXPANSION_ENABLED) {
    const expansionQueries = buildExpansionQueries(scored);
    if (expansionQueries.length > 0) {
      logDiscoveryProgress('cluster-expansion-start', {
        queryCount: expansionQueries.length,
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
}
