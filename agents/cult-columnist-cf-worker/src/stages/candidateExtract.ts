import {
  getFreshHttpCacheEntryByRequestUrl,
  insertCandidate,
  insertFeedFetchCache,
  listEnabledFeeds,
  setCandidateExcluded,
  updateCandidateFetchState,
} from '../lib/db';
import { describeDynamicSourceFromUrl } from '../lib/dynamicSources';
import { parseFeedItems } from '../lib/rss';

const ARTICLE_CONCURRENCY = 5;

export type CandidateWorkItem = {
  candidateId: number;
  rawUrl: string;
  requiresUrlResolution: number;
};

function addHours(iso: string, hours: number): string {
  const dt = new Date(iso);
  dt.setUTCHours(dt.getUTCHours() + hours);
  return dt.toISOString();
}

function articleTtlHoursForStatus(status: number): number {
  return status >= 200 && status < 300 ? 24 : 2;
}

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

function articleStatusForHttpStatus(status: number): 'failed' | 'blocked' {
  if (status === 401 || status === 403 || status === 429 || status === 451 || status === 503) {
    return 'blocked';
  }
  return 'failed';
}

const RELEVANCE_TERMS = [
  'cult',
  'sect',
  'high-control',
  'high control',
  'coercive control',
  'spiritual abuse',
  'religious abuse',
  'brainwash',
  'brainwashing',
];

function stripHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLikelyRelevantArticle(rawUrl: string, resolvedUrl: string, body: string): boolean {
  const urlText = `${rawUrl} ${resolvedUrl}`.toLowerCase();
  const text = stripHtml(body).toLowerCase().slice(0, 250000);
  const haystack = `${urlText} ${text}`;
  return RELEVANCE_TERMS.some((term) => haystack.includes(term));
}

function buildRelevanceTrace(rawUrl: string, resolvedUrl: string, body: string): {
  matchedTerms: string[];
  scannedChars: number;
} {
  const urlText = `${rawUrl} ${resolvedUrl}`.toLowerCase();
  const text = stripHtml(body).toLowerCase().slice(0, 250000);
  const haystack = `${urlText} ${text}`;
  const matchedTerms = RELEVANCE_TERMS.filter((term) => haystack.includes(term));
  return {
    matchedTerms,
    scannedChars: haystack.length,
  };
}

export async function processCandidateFetchWorkItem(
  db: D1Database,
  r2: R2Bucket,
  item: CandidateWorkItem,
): Promise<'ok' | 'failed' | 'blocked' | 'cached' | 'filtered'> {
  try {
    const cached = await getFreshHttpCacheEntryByRequestUrl(db, item.rawUrl);
    if (cached && cached.status >= 200 && cached.status < 300) {
      const cachedObject = await r2.get(cached.r2_key);
      if (cachedObject) {
        await updateCandidateFetchState(db, {
          candidateId: item.candidateId,
          resolvedUrl: cached.final_url ?? item.rawUrl,
          resolveStatus: item.requiresUrlResolution === 1 ? 'ok' : 'skipped',
          articleR2Key: cached.r2_key,
          articleStatus: 'cached',
          articleHttpStatus: cached.status,
          decisionCode: 'accept_cache_hit',
          decisionDetail: JSON.stringify({
            reason: 'fresh_article_cache_entry',
            requestUrl: item.rawUrl,
            finalUrl: cached.final_url ?? item.rawUrl,
            cacheStatus: cached.status,
            cacheR2Key: cached.r2_key,
          }),
        });
        return 'cached';
      }
    }

    const response = await fetch(item.rawUrl, {
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.1',
      },
    });

    const resolvedUrl = response.url || item.rawUrl;
    const resolveStatus = item.requiresUrlResolution === 1 ? (response.ok ? 'ok' : 'failed') : 'skipped';

    if (!response.ok) {
      const articleStatus = articleStatusForHttpStatus(response.status);
      await updateCandidateFetchState(db, {
        candidateId: item.candidateId,
        resolvedUrl,
        resolveStatus,
        articleR2Key: null,
        articleStatus,
        articleHttpStatus: response.status,
        decisionCode: `reject_http_${response.status}`,
        decisionDetail: JSON.stringify({
          reason: 'http_response_not_ok',
          httpStatus: response.status,
          rawUrl: item.rawUrl,
          resolvedUrl,
        }),
      });
      return articleStatus;
    }

    const body = await response.text();
    const relevance = buildRelevanceTrace(item.rawUrl, resolvedUrl, body);
    const relevant = relevance.matchedTerms.length > 0;
    if (!relevant) {
      await updateCandidateFetchState(db, {
        candidateId: item.candidateId,
        resolvedUrl,
        resolveStatus,
        articleR2Key: null,
        articleStatus: 'filtered',
        articleHttpStatus: response.status,
        decisionCode: 'reject_content_filter_non_match',
        decisionDetail: JSON.stringify({
          reason: 'no_relevance_terms_found',
          rawUrl: item.rawUrl,
          resolvedUrl,
          httpStatus: response.status,
          matchedTerms: relevance.matchedTerms,
          scannedChars: relevance.scannedChars,
        }),
      });
      await setCandidateExcluded(db, item.candidateId, 'content_filter_non_match');
      return 'filtered';
    }

    const contentType = response.headers.get('content-type') ?? 'text/html; charset=utf-8';
    const urlHash = await sha256Hex(resolvedUrl);
    const articleR2Key = `articles/shared/${urlHash}.html`;
    const bodySha256 = await sha256Hex(body);
    const fetchedAt = new Date().toISOString();

    await r2.put(articleR2Key, body, {
      httpMetadata: {
        contentType,
      },
    });

    const rawUrlCacheKey = await sha256Hex(`article:${item.rawUrl}`);
    await insertFeedFetchCache(db, {
      cacheKey: rawUrlCacheKey,
      requestUrl: item.rawUrl,
      finalUrl: resolvedUrl,
      status: response.status,
      fetchedAt,
      expiresAt: addHours(fetchedAt, articleTtlHoursForStatus(response.status)),
      contentType,
      r2Key: articleR2Key,
      bodySha256,
    });

    if (resolvedUrl !== item.rawUrl) {
      const resolvedUrlCacheKey = await sha256Hex(`article:${resolvedUrl}`);
      await insertFeedFetchCache(db, {
        cacheKey: resolvedUrlCacheKey,
        requestUrl: resolvedUrl,
        finalUrl: resolvedUrl,
        status: response.status,
        fetchedAt,
        expiresAt: addHours(fetchedAt, articleTtlHoursForStatus(response.status)),
        contentType,
        r2Key: articleR2Key,
        bodySha256,
      });
    }

    await updateCandidateFetchState(db, {
      candidateId: item.candidateId,
      resolvedUrl,
      resolveStatus,
      articleR2Key,
      articleStatus: 'ok',
      articleHttpStatus: response.status,
      decisionCode: 'accept_content_filter_match',
      decisionDetail: JSON.stringify({
        reason: 'relevance_terms_found',
        rawUrl: item.rawUrl,
        resolvedUrl,
        httpStatus: response.status,
        matchedTerms: relevance.matchedTerms,
        scannedChars: relevance.scannedChars,
        storedR2Key: articleR2Key,
      }),
    });

    return 'ok';
  } catch {
    await updateCandidateFetchState(db, {
      candidateId: item.candidateId,
      resolvedUrl: item.rawUrl,
      resolveStatus: item.requiresUrlResolution === 1 ? 'failed' : 'skipped',
      articleR2Key: null,
      articleStatus: 'failed',
      articleHttpStatus: null,
      decisionCode: 'reject_fetch_exception',
      decisionDetail: JSON.stringify({
        reason: 'fetch_or_processing_exception',
        rawUrl: item.rawUrl,
      }),
    });
    return 'failed';
  }
}

export async function runCandidateExtractStage(
  db: D1Database,
  r2: R2Bucket,
  runId: string,
): Promise<{ inserted: number }> {
  void r2;
  const feeds = await listEnabledFeeds(db);
  let inserted = 0;

  for (const feed of feeds) {
    const cacheEntry = await db
      .prepare(
        `SELECT r2_key, status
         FROM http_cache_entries
         WHERE request_url = ? AND expires_at > datetime('now')
         ORDER BY fetched_at DESC
         LIMIT 1`,
      )
      .bind(feed.url)
      .first<{ r2_key: string; status: number }>();

    if (!cacheEntry || cacheEntry.status < 200 || cacheEntry.status >= 300) {
      continue;
    }

    // Fetch XML from R2
    const xmlObj = await r2.get(cacheEntry.r2_key);
    if (!xmlObj) continue;
    const body = await xmlObj.text();

    const items = parseFeedItems(body)
      .filter((item) => item.url.startsWith('http://') || item.url.startsWith('https://'))
      .map((item) => ({
        runId,
        feedId: feed.id,
        sourceLanguage: feed.language,
        rawUrl: item.url,
        title: item.title,
        pubDate: item.pubDate,
        requiresUrlResolution: feed.requires_url_resolution,
      }));

    for (const item of items) {
      await insertCandidate(db, item);
      inserted += 1;
    }
  }

  const dynamicCacheEntries = await db
    .prepare(
      `SELECT request_url, r2_key, status
       FROM http_cache_entries
       WHERE expires_at > datetime('now')
         AND status >= 200
         AND status < 300
         AND (
           request_url LIKE 'https://news.google.com/rss/search?%'
           OR request_url LIKE 'https://newsdata.io/api/1/latest?%'
         )
       ORDER BY fetched_at DESC`,
    )
    .all<{ request_url: string; r2_key: string; status: number }>();

  for (const entry of dynamicCacheEntries.results ?? []) {
    const source = describeDynamicSourceFromUrl(entry.request_url);
    if (!source) {
      continue;
    }

    const xmlObj = await r2.get(entry.r2_key);
    if (!xmlObj) {
      continue;
    }
    const body = await xmlObj.text();

    const items = parseFeedItems(body)
      .filter((item) => item.url.startsWith('http://') || item.url.startsWith('https://'))
      .map((item) => ({
        runId,
        feedId: source.id,
        sourceLanguage: source.language,
        rawUrl: item.url,
        title: item.title,
        pubDate: item.pubDate,
        requiresUrlResolution: source.requiresUrlResolution,
      }));

    for (const item of items) {
      await insertCandidate(db, item);
      inserted += 1;
    }
  }

  return { inserted };
}
