import { insertFeedFetchCache, listEnabledFeeds } from '../lib/db';
import type { Env } from '../types';
import { buildDynamicSources, newsDataResultsToRss } from '../lib/dynamicSources';

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return toHex(new Uint8Array(digest));
}

function ttlHoursForStatus(status: number): number {
  return status >= 200 && status < 300 ? 24 : 2;
}

function addHours(iso: string, hours: number): string {
  const dt = new Date(iso);
  dt.setUTCHours(dt.getUTCHours() + hours);
  return dt.toISOString();
}

const CONCURRENCY = 10;

type FetchSource = {
  id: string;
  title: string;
  url: string;
  source_category: string;
  language: string;
  requires_url_resolution: number;
  kind: 'feed' | 'google-news' | 'newsdata';
};

export async function runFeedFetchStage(db: D1Database, r2: R2Bucket, env: Env): Promise<{ fetched: number; failed: number }> {
  const [feeds, dynamicSources] = await Promise.all([listEnabledFeeds(db), buildDynamicSources(db, env)]);
  const allSources: FetchSource[] = [
    ...feeds.map((feed) => ({ ...feed, kind: 'feed' as const })),
    ...dynamicSources.map((source) => ({
      id: source.id,
      title: source.title,
      url: source.url,
      source_category: source.sourceCategory,
      language: source.language,
      requires_url_resolution: source.requiresUrlResolution,
      kind: source.kind,
    })),
  ];

  let fetched = 0;
  let failed = 0;

  async function fetchOneFeed(feed: FetchSource): Promise<void> {
    try {
      const response = await fetch(feed.url, {
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
          accept:
            feed.kind === 'newsdata'
              ? 'application/json, */*;q=0.1'
              : 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.1',
        },
      });

      let body = await response.text();
      let contentType = response.headers.get('content-type');

      if (feed.kind === 'newsdata' && response.ok) {
        try {
          const parsed = JSON.parse(body) as { results?: Array<{ title?: unknown; link?: unknown; pubDate?: unknown; pub_date?: unknown; publishedAt?: unknown }> };
          const results = Array.isArray(parsed.results) ? parsed.results : [];
          body = newsDataResultsToRss(results);
          contentType = 'application/rss+xml; charset=utf-8';
        } catch {
          // Keep original body/content type if JSON parse fails.
        }
      }

      const fetchedAt = new Date().toISOString();
      const status = response.status;

      const cacheKey = await sha256Hex(feed.url);
      const r2Key = `feeds/${cacheKey}.xml`;
      const bodySha256 = await sha256Hex(body);

      // Store XML in R2
      await r2.put(r2Key, body);

      await insertFeedFetchCache(db, {
        cacheKey,
        requestUrl: feed.url,
        finalUrl: response.url,
        status,
        fetchedAt,
        expiresAt: addHours(fetchedAt, ttlHoursForStatus(status)),
        contentType,
        r2Key,
        bodySha256,
      });

      if (status >= 200 && status < 300) {
        fetched += 1;
      } else {
        failed += 1;
      }
    } catch {
      failed += 1;
    }
  }

  // Process feeds in parallel with a concurrency cap
  for (let i = 0; i < allSources.length; i += CONCURRENCY) {
    await Promise.all(allSources.slice(i, i + CONCURRENCY).map(fetchOneFeed));
  }

  return { fetched, failed };
}
