import type { Env } from '../types';
import { loadDiscoveryFocus } from './discoveryFocus';

export type DynamicSource = {
  id: string;
  title: string;
  url: string;
  sourceCategory: string;
  language: string;
  requiresUrlResolution: number;
  kind: 'google-news' | 'newsdata';
};

const GOOGLE_NEWS_BASE_URL = 'https://news.google.com/rss/search';
const NEWSDATA_BASE_URL = 'https://newsdata.io/api/1/latest';

const GOOGLE_WATCHLIST_HOST_LIMIT = 12;
const GOOGLE_TERM_LIMIT = 3;
const NEWSDATA_TERM_LIMIT = 6;

const GOOGLE_GENERIC_QUERIES = [
  'cult OR sect Europe',
  'destructive cult abuse',
  'high-control group investigation',
  'coercive control religious group',
  'spiritual movement abuse',
  'cult trial Europe',
];

const NEWSDATA_GENERIC_QUERIES = [
  'cult OR sect',
  'high-control group',
  'coercive control religion',
];

function rotate<T>(items: T[], seed: number): T[] {
  if (items.length === 0) {
    return [];
  }

  const start = ((seed % items.length) + items.length) % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}

function daySeed(): number {
  const day = new Date().toISOString().slice(0, 10);
  return Number.parseInt(day.replace(/-/g, ''), 10) || 0;
}

function truncateLabel(value: string, max = 72): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max - 1)}...`;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function normalizeIsoDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return new Date(parsed).toISOString();
}

export function buildGoogleNewsRssUrl(query: string): string {
  const params = new URLSearchParams({
    q: query,
    hl: 'en-GB',
    gl: 'GB',
    ceid: 'GB:en',
  });
  return `${GOOGLE_NEWS_BASE_URL}?${params.toString()}`;
}

export function buildNewsDataUrl(query: string, env: Env): string | null {
  const apiKey = env.NEWSDATA_API_KEY ?? env.NEWSIO_API_KEY;
  if (!apiKey) {
    return null;
  }

  const timeframeHours = Number.parseInt(env.NEWSDATA_TIMEFRAME_HOURS ?? '24', 10) || 24;
  const size = Number.parseInt(env.NEWSDATA_QUERY_LIMIT ?? '10', 10) || 10;
  const fromDate = new Date(Date.now() - timeframeHours * 60 * 60 * 1000).toISOString().slice(0, 10);

  const params = new URLSearchParams({
    apikey: apiKey,
    q: query,
    country: env.NEWSDATA_COUNTRY_CODES ?? 'gb,ie,fr,de,es,it,nl,be,at,ch,se,no,dk,fi,pl,pt,ro,cz,gr,hr,si,hu,sk',
    language: env.NEWSDATA_LANGUAGES ?? 'en',
    size: String(size),
    removeduplicate: '1',
    timeframe: String(timeframeHours),
    from_date: fromDate,
  });

  return `${NEWSDATA_BASE_URL}?${params.toString()}`;
}

async function listWatchlistHosts(db: D1Database): Promise<string[]> {
  const rows = await db
    .prepare("SELECT host FROM source_hosts WHERE list_type = 'watchlist' ORDER BY host")
    .all<{ host: string }>();

  return (rows.results ?? []).map((r) => r.host).filter(Boolean);
}

async function listCultTerms(db: D1Database): Promise<string[]> {
  const rows = await db
    .prepare("SELECT term FROM cult_terms WHERE language = 'en' AND term_type = 'cult_term' ORDER BY term")
    .all<{ term: string }>();

  return (rows.results ?? []).map((r) => r.term).filter(Boolean);
}

export async function buildDynamicSources(db: D1Database, env: Env): Promise<DynamicSource[]> {
  const seed = daySeed();
  const focus = loadDiscoveryFocus(env);
  const [watchlistHosts, cultTerms] = await Promise.all([listWatchlistHosts(db), listCultTerms(db)]);

  const mergedWatchlistHosts = Array.from(new Set([...watchlistHosts, ...focus.priorityWatchlistHosts]));
  const mergedCultTerms = Array.from(new Set([...cultTerms, ...focus.focusSignalTerms]));
  const rotatedHosts = rotate(mergedWatchlistHosts, seed).slice(0, GOOGLE_WATCHLIST_HOST_LIMIT);
  const rotatedTerms = rotate(mergedCultTerms, seed).slice(0, GOOGLE_TERM_LIMIT);

  const googleQueries = [
    ...rotatedHosts.flatMap((host) => rotatedTerms.map((term) => `site:${host} \"${term}\"`)),
    ...GOOGLE_GENERIC_QUERIES,
    ...focus.googleNewsGenericQueries,
  ];

  const uniqueGoogleQueries = Array.from(new Set(googleQueries.map((q) => q.trim()).filter(Boolean)));

  const googleSources: DynamicSource[] = uniqueGoogleQueries.map((query, idx) => ({
    id: `google-news:${idx + 1}`,
    title: `Google News: ${truncateLabel(query)}`,
    url: buildGoogleNewsRssUrl(query),
    sourceCategory: 'aggregator-feed',
    language: 'en',
    requiresUrlResolution: 1,
    kind: 'google-news',
  }));

  const newsDataEnabled = (env.NEWSDATA_ENABLED ?? 'false').toLowerCase() === 'true';
  const newsDataKey = env.NEWSDATA_API_KEY ?? env.NEWSIO_API_KEY;

  let newsDataSources: DynamicSource[] = [];
  if (newsDataEnabled && newsDataKey) {
    const rotatedNewsDataTerms = rotate(mergedCultTerms, seed + 11).slice(0, NEWSDATA_TERM_LIMIT);
    const queries = Array.from(new Set([...rotatedNewsDataTerms, ...NEWSDATA_GENERIC_QUERIES, ...focus.newsdataQueries]));

    const mapped: Array<DynamicSource | null> = queries.map((query, idx) => {
        const url = buildNewsDataUrl(query, env);
        if (!url) {
          return null;
        }

        return {
          id: `newsdata:${idx + 1}`,
          title: `NewsData: ${truncateLabel(query)}`,
          url,
          sourceCategory: 'api',
          language: 'en',
          requiresUrlResolution: 0,
          kind: 'newsdata' as const,
        };
      });

    newsDataSources = mapped.filter((source): source is DynamicSource => source !== null);
  }

  return [...googleSources, ...newsDataSources];
}

export function describeDynamicSourceFromUrl(requestUrl: string): Omit<DynamicSource, 'kind'> | null {
  try {
    const url = new URL(requestUrl);

    if (url.hostname === 'news.google.com' && url.pathname === '/rss/search') {
      const query = url.searchParams.get('q') ?? 'query';
      return {
        id: `google-news:${query}`,
        title: `Google News: ${truncateLabel(query)}`,
        url: requestUrl,
        sourceCategory: 'aggregator-feed',
        language: 'en',
        requiresUrlResolution: 1,
      };
    }

    if (url.hostname === 'newsdata.io' && url.pathname === '/api/1/latest') {
      const query = url.searchParams.get('q') ?? 'query';
      return {
        id: `newsdata:${query}`,
        title: `NewsData: ${truncateLabel(query)}`,
        url: requestUrl,
        sourceCategory: 'api',
        language: 'en',
        requiresUrlResolution: 0,
      };
    }

    return null;
  } catch {
    return null;
  }
}

export function describeDynamicSourceFromId(sourceId: string): Omit<DynamicSource, 'kind'> | null {
  if (sourceId.startsWith('google-news:')) {
    const query = sourceId.slice('google-news:'.length).trim() || 'query';
    return {
      id: sourceId,
      title: `Google News: ${truncateLabel(query)}`,
      url: buildGoogleNewsRssUrl(query),
      sourceCategory: 'aggregator-feed',
      language: 'en',
      requiresUrlResolution: 1,
    };
  }

  if (sourceId.startsWith('newsdata:')) {
    const query = sourceId.slice('newsdata:'.length).trim() || 'query';
    return {
      id: sourceId,
      title: `NewsData: ${truncateLabel(query)}`,
      url: '',
      sourceCategory: 'api',
      language: 'en',
      requiresUrlResolution: 0,
    };
  }

  return null;
}

export function newsDataResultsToRss(
  items: Array<{ title?: unknown; link?: unknown; pubDate?: unknown; pub_date?: unknown; publishedAt?: unknown }>,
): string {
  const rssItems = items
    .map((item) => {
      const link = typeof item.link === 'string' ? item.link.trim() : '';
      const title = typeof item.title === 'string' ? item.title.trim() : '';
      const normalizedDate = normalizeIsoDate(item.pubDate) ?? normalizeIsoDate(item.pub_date) ?? normalizeIsoDate(item.publishedAt);

      if (!link || !title) {
        return '';
      }

      return [
        '<item>',
        `<title>${xmlEscape(title)}</title>`,
        `<link>${xmlEscape(link)}</link>`,
        normalizedDate ? `<pubDate>${xmlEscape(normalizedDate)}</pubDate>` : '',
        '</item>',
      ].join('');
    })
    .filter(Boolean)
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>NewsData Query</title>${rssItems}</channel></rss>`;
}
