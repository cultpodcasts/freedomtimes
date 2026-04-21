import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ALL_CULT_TERMS, getCultTermsForLanguage } from './cultTerms.js';
import { fetchJsonWithCache, fetchTextWithCache } from './httpCache.js';
import {
  GOOGLE_NEWS_COUNTRY_TERMS,
  GOOGLE_NEWS_GENERIC_QUERIES,
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

const NEWSDATA_ENABLED = (process.env.NEWSDATA_ENABLED ?? 'false').toLowerCase() === 'true';
const NEWSIO_API_KEY = process.env.NEWSIO_API_KEY ?? process.env.NEWSDATA_API_KEY;
const NEWSDATA_BASE_URL = 'https://newsdata.io/api/1/latest';
const NEWSDATA_QUERY_LIMIT = 10;
const DEFAULT_DISCOVERY_MAX_AGE_HOURS = 24;
const DISCOVERY_MAX_AGE_HOURS = Math.max(
  1,
  Number.parseInt(process.env.DISCOVERY_MAX_AGE_HOURS ?? `${DEFAULT_DISCOVERY_MAX_AGE_HOURS}`, 10) ||
    DEFAULT_DISCOVERY_MAX_AGE_HOURS,
);
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
  console.log(`[agent][progress] ${JSON.stringify({ scope: 'discovery', stage, ...data })}`);
}

function buildWatchlistQueries(): string[] {
  const queries: string[] = [];
  for (const site of GOOGLE_NEWS_WATCHLIST_SITES) {
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

function buildGoogleNewsRssUrl(query: string): string {
  const encoded = encodeURIComponent(query);
  return `https://news.google.com/rss/search?q=${encoded}&hl=en-GB&gl=GB&ceid=GB:en`;
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

    if (queryIndex === 1 || queryIndex % 3 === 0) {
      logDiscoveryProgress('newsdata-running', {
        queryIndex,
        queryCount: queries.length,
        discovered: discovered.length,
      });
    }

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
          continue;
        }

        const payload = response.json;
        if (!payload) {
          console.warn('[agent] newsdata parse error', { query });
          continue;
        }

        results = payload.results ?? [];
        setCachedNewsDataResults(cache, query, results);
        cacheUpdated = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn('[agent] newsdata fetch error', { query, message });
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

async function discoverFromGoogleNews(): Promise<DiscoveredStory[]> {
  const discovered: DiscoveredStory[] = [];
  const seen = new Set<string>();
  const watchlistQueries = buildWatchlistQueries();
  const runSeed = Number.parseInt(new Date().toISOString().slice(0, 10).replace(/-/g, ''), 10);
  const rotatedWatchlistQueries = rotateArray(watchlistQueries, runSeed);
  const boundedWatchlistQueries = rotatedWatchlistQueries.slice(0, MAX_WATCHLIST_GOOGLE_QUERIES_PER_RUN);
  const queries = [...boundedWatchlistQueries, ...GOOGLE_NEWS_GENERIC_QUERIES];
  // Google News RSS search returns up to 100 items; consume the full page per query.
  const perQueryLimit = 100;
  const globalCeiling = Math.max(queries.length * perQueryLimit, queries.length);
  let queryIndex = 0;

  logDiscoveryProgress('google-news-start', {
    queryCount: queries.length,
    globalCeiling,
  });

  for (const query of queries) {
    queryIndex += 1;

    if (discovered.length >= globalCeiling) {
      break;
    }

    if (queryIndex === 1 || queryIndex % 8 === 0) {
      logDiscoveryProgress('google-news-running', {
        queryIndex,
        queryCount: queries.length,
        discovered: discovered.length,
      });
    }

    const rssUrl = buildGoogleNewsRssUrl(query);

    try {
      const response = await fetchTextWithCache(rssUrl, {
        headers: {
          'User-Agent': 'FreedomTimes-Local-Agent/0.1',
          Accept: 'application/rss+xml, application/xml, text/xml',
        },
      });

      if (!response.ok) {
        continue;
      }

      const parsed = parseGoogleNewsFeed(response.text);

      let addedForQuery = 0;

      for (const item of parsed) {
        if (discovered.length >= globalCeiling || addedForQuery >= perQueryLimit) {
          break;
        }

        if (!isWithinFreshnessWindow(item.publishedAt)) {
          continue;
        }

        let selectedUrl = item.originalUrlFromMetadata;
        if (!selectedUrl) {
          selectedUrl = await resolveGoogleNewsLink(item.link);
        }

        if (seen.has(selectedUrl)) {
          continue;
        }

        seen.add(selectedUrl);
        discovered.push({
          url: selectedUrl,
          title: item.title,
          publishedAt: item.publishedAt,
          sourceFeed: `google-news:${query}`,
          sourceFormat: 'rss',
          sourceCategory: 'aggregator-feed',
          requiresUrlResolution: true,
          publisherName: item.publisherName,
          publisherUrl: item.publisherUrl,
        });
        addedForQuery += 1;
      }
    } catch {
      // Continue with remaining queries.
    }
  }

  logDiscoveryProgress('google-news-complete', {
    discovered: discovered.length,
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
  });

  for (const feed of uniqueFeeds) {
    feedIndex += 1;

    if (feedIndex === 1 || feedIndex % 25 === 0) {
      logDiscoveryProgress('feeds-running', {
        feedIndex,
        feedCount: uniqueFeeds.length,
        discovered: discovered.length,
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
  const enriched = await enrichPublishedAtForMissing(deduped);
  const fresh = enriched.filter((item) => isWithinFreshnessWindow(item.publishedAt));

  console.log('[agent] discovery freshness filter', {
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
