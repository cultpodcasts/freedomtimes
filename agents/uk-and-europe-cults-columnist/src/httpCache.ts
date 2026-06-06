import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import {
  HTTP_CACHE_ENABLED,
  HTTP_ERROR_CACHE_TTL_SECONDS,
  HTTP_CACHE_MAX_ENTRIES,
  HTTP_CACHE_TTL_MINUTES,
  HTTP_FETCH_MAX_ATTEMPTS,
  HTTP_FETCH_RETRY_BASE_MS,
  HTTP_FETCH_RETRY_MAX_MS,
  HTTP_FETCH_RETRY_NETWORK_ERRORS,
  HTTP_FETCH_RETRYABLE_STATUS_CODES,
  HTTP_FETCH_TIMEOUT_MS,
  HTTP_USER_AGENT,
} from './http-cache/config.ts';
import { isBlockedHttpBody } from './archiveMirrors.ts';
import { buildCacheKey, normalizeHeaders } from './http-cache/key.ts';
import type { CachedEntry, CachedFetchResult } from './http-cache/types.ts';

/** Portable fetch abstraction — defaults to global `fetch`. Inject a proxy-backed impl locally; CF Workers provide their own. */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const HTTP_CACHE_DIR = new URL('../.cache/http-cache/', import.meta.url);
const LEGACY_HTTP_CACHE_PATH = new URL('../.cache/http-cache.json', import.meta.url);
const inFlight = new Map<string, Promise<CachedFetchResult>>();
let legacyMigrationAttempted = false;

function getCacheTtlMs(status: number): number {
  if (status >= 200 && status < 300) {
    return HTTP_CACHE_TTL_MINUTES * 60 * 1000;
  }

  return HTTP_ERROR_CACHE_TTL_SECONDS * 1000;
}

function isFresh(entry: CachedEntry): boolean {
  const fetchedAt = Date.parse(entry.fetchedAt);
  if (!Number.isFinite(fetchedAt)) {
    return false;
  }

  const ttlMs = getCacheTtlMs(entry.status);
  if (ttlMs <= 0) {
    return false;
  }

  const ageMs = Date.now() - fetchedAt;
  return ageMs >= 0 && ageMs <= ttlMs;
}

function shouldCacheStatus(status: number): boolean {
  return status >= 200 && status < 300 ? true : HTTP_ERROR_CACHE_TTL_SECONDS > 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryBackoffMs(attemptAfterFailure: number, status?: number): number {
  const base = HTTP_FETCH_RETRY_BASE_MS;
  let exp = base * 2 ** Math.max(0, attemptAfterFailure - 1);
  if (status === 503 || status === 429) {
    exp = Math.max(exp, 2500);
    exp = Math.floor(exp * 1.75);
  }
  return Math.min(exp, HTTP_FETCH_RETRY_MAX_MS);
}

/** Honor Retry-After (seconds or HTTP-date); cap to avoid hanging the agent. */
function parseRetryAfterMs(headers: Headers): number {
  const raw = headers.get('retry-after')?.trim();
  if (!raw) {
    return 0;
  }

  const asInt = Number.parseInt(raw, 10);
  if (Number.isFinite(asInt) && asInt >= 0) {
    return Math.min(asInt * 1000, HTTP_FETCH_RETRY_MAX_MS);
  }

  const when = Date.parse(raw);
  if (Number.isFinite(when)) {
    return Math.min(Math.max(0, when - Date.now()), HTTP_FETCH_RETRY_MAX_MS);
  }

  return 0;
}

function isRetryableNetworkError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') {
    return false;
  }
  return error instanceof TypeError;
}

/**
 * Single logical fetch with retries for transient HTTP statuses and (optionally) network errors.
 */
async function fetchTextThroughNetwork(
  url: string,
  init: RequestInit | undefined,
  requestHeaders: Headers,
  fetchFn: FetchFn = fetch,
): Promise<{ response: Response; text: string; attempts: number; durationMs: number }> {
  const outerStarted = Date.now();
  const maxAttempts = HTTP_FETCH_MAX_ATTEMPTS;
  let lastResponse: Response | undefined;
  let lastText = '';
  let attempts = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;
    try {
      const response = await fetchFn(url, {
        ...init,
        headers: requestHeaders,
        signal: init?.signal ?? AbortSignal.timeout(HTTP_FETCH_TIMEOUT_MS),
      });
      const text = await response.text();

      const shouldRetryStatus =
        !response.ok &&
        HTTP_FETCH_RETRYABLE_STATUS_CODES.has(response.status) &&
        attempt < maxAttempts;

      if (!shouldRetryStatus) {
        return {
          response,
          text,
          attempts,
          durationMs: Date.now() - outerStarted,
        };
      }

      lastResponse = response;
      lastText = text;
      const headerWait = parseRetryAfterMs(response.headers);
      const computed = retryBackoffMs(attempt, response.status);
      await sleep(Math.max(computed, headerWait));
    } catch (error) {
      const retryNet =
        HTTP_FETCH_RETRY_NETWORK_ERRORS && isRetryableNetworkError(error) && attempt < maxAttempts;
      if (!retryNet) {
        throw error;
      }
      await sleep(retryBackoffMs(attempt));
    }
  }

  return {
    response: lastResponse!,
    text: lastText,
    attempts,
    durationMs: Date.now() - outerStarted,
  };
}

function mergeRequestHeaders(headersInit: HeadersInit | undefined): Headers {
  const headers = new Headers(headersInit);
  const existingUserAgent = headers.get('user-agent')?.trim() ?? '';

  if (!existingUserAgent || existingUserAgent.startsWith('FreedomTimes-Local-Agent/')) {
    headers.set('User-Agent', HTTP_USER_AGENT);
  }

  if (!headers.has('Accept')) {
    headers.set('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
  }

  if (!headers.has('Accept-Language')) {
    headers.set('Accept-Language', 'en-GB,en;q=0.9');
  }

  if (!headers.has('Cache-Control')) {
    headers.set('Cache-Control', 'no-cache');
  }

  if (!headers.has('Pragma')) {
    headers.set('Pragma', 'no-cache');
  }

  return headers;
}

function getCacheFileUrl(cacheKey: string): URL {
  const hash = createHash('sha256').update(cacheKey).digest('hex');
  return new URL(`${hash}.json`, HTTP_CACHE_DIR);
}

function isUsableCachedBody(body: string): boolean {
  return body.length > 0 && !isBlockedHttpBody(body);
}

function cachedResultFromEntry(entry: CachedEntry, requestDurationMs: number): CachedFetchResult {
  return {
    ok: entry.status >= 200 && entry.status < 300,
    status: entry.status,
    url: entry.finalUrl,
    headers: entry.headers,
    text: entry.body,
    fromCache: true,
    requestDurationMs,
    networkAttempts: 0,
  };
}

function readEntry(cacheKey: string): CachedEntry | undefined {
  try {
    const fileUrl = getCacheFileUrl(cacheKey);
    const raw = readFileSync(fileUrl, 'utf-8');
    const parsed = JSON.parse(raw) as CachedEntry;
    if (
      typeof parsed?.fetchedAt === 'string' &&
      typeof parsed?.status === 'number' &&
      typeof parsed?.finalUrl === 'string' &&
      typeof parsed?.body === 'string' &&
      parsed?.headers &&
      typeof parsed.headers === 'object'
    ) {
      return parsed;
    }
  } catch {
    // Ignore missing or invalid cache file.
  }

  return undefined;
}

function pruneCacheDir(): void {
  try {
    const names = readdirSync(HTTP_CACHE_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name);

    if (names.length <= HTTP_CACHE_MAX_ENTRIES) {
      return;
    }

    names
      .map((name) => {
        const fileUrl = new URL(name, HTTP_CACHE_DIR);
        const stat = statSync(fileUrl);
        return { name, mtimeMs: stat.mtimeMs };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs)
      .slice(0, names.length - HTTP_CACHE_MAX_ENTRIES)
      .forEach((entry) => {
        rmSync(new URL(entry.name, HTTP_CACHE_DIR), { force: true });
      });
  } catch {
    // Best-effort pruning only.
  }
}

function writeEntry(cacheKey: string, entry: CachedEntry): void {
  try {
    mkdirSync(HTTP_CACHE_DIR, { recursive: true });
    const fileUrl = getCacheFileUrl(cacheKey);
    writeFileSync(fileUrl, `${JSON.stringify(entry, null, 2)}\n`, 'utf-8');
    pruneCacheDir();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[agent] failed to persist http cache entry', { message });
  }
}

function extractUrlFromLegacyKey(key: string, entry: CachedEntry): string {
  const match = key.match(/^[A-Z]+::(https?:\/\/.*?)(::accept=.*)?$/);
  const candidate = match?.[1] ?? entry.finalUrl;

  try {
    return new URL(candidate).toString();
  } catch {
    return entry.finalUrl;
  }
}

function migrateLegacyCacheIfNeeded(): void {
  if (legacyMigrationAttempted || !HTTP_CACHE_ENABLED) {
    return;
  }

  legacyMigrationAttempted = true;

  try {
    const existingFiles = readdirSync(HTTP_CACHE_DIR, { withFileTypes: true }).filter(
      (entry) => entry.isFile() && entry.name.endsWith('.json'),
    );
    if (existingFiles.length > 0) {
      return;
    }
  } catch {
    // Directory may not exist yet; continue.
  }

  try {
    const raw = readFileSync(LEGACY_HTTP_CACHE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as { version?: number; entries?: Record<string, CachedEntry> };
    const legacyEntries = parsed.entries;

    if (parsed.version !== 1 || !legacyEntries || typeof legacyEntries !== 'object') {
      return;
    }

    let migrated = 0;
    for (const [legacyKey, entry] of Object.entries(legacyEntries)) {
      if (
        !entry ||
        typeof entry.fetchedAt !== 'string' ||
        typeof entry.status !== 'number' ||
        typeof entry.finalUrl !== 'string' ||
        typeof entry.body !== 'string' ||
        !entry.headers ||
        typeof entry.headers !== 'object'
      ) {
        continue;
      }

      const url = extractUrlFromLegacyKey(legacyKey, entry);
      const cacheKey = buildCacheKey(url);
      writeEntry(cacheKey, entry);
      migrated += 1;
    }

    if (migrated > 0) {
      console.log('[agent] migrated legacy http cache', { migrated });
    }
  } catch {
    // Ignore missing or invalid legacy cache file.
  }
}

export async function fetchTextWithCache(
  url: string,
  init?: RequestInit,
  fetchFn?: FetchFn,
  options?: { cacheKeySuffix?: string },
): Promise<CachedFetchResult> {
  const requestHeaders = mergeRequestHeaders(init?.headers);

  if (!HTTP_CACHE_ENABLED) {
    const { response, text, attempts, durationMs } = await fetchTextThroughNetwork(url, init, requestHeaders, fetchFn);
    return {
      ok: response.ok,
      status: response.status,
      url: response.url,
      headers: normalizeHeaders(response.headers),
      text,
      fromCache: false,
      requestDurationMs: durationMs,
      networkAttempts: attempts,
    };
  }

  migrateLegacyCacheIfNeeded();

  const cacheKey = buildCacheKey(url, options?.cacheKeySuffix);
  const cached = readEntry(cacheKey);
  const staleUsableEntry = cached && isUsableCachedBody(cached.body) ? cached : undefined;

  if (cached && isFresh(cached) && isUsableCachedBody(cached.body)) {
    const cacheReadStarted = Date.now();
    return cachedResultFromEntry(cached, Date.now() - cacheReadStarted);
  }

  const existingInFlight = inFlight.get(cacheKey);
  if (existingInFlight) {
    return existingInFlight;
  }

  const fetchPromise = (async (): Promise<CachedFetchResult> => {
    const { response, text: body, attempts, durationMs } = await fetchTextThroughNetwork(
      url,
      init,
      requestHeaders,
      fetchFn,
    );
    const responseHeaders = normalizeHeaders(response.headers);

    if (shouldCacheStatus(response.status) && body.length > 0 && isUsableCachedBody(body)) {
      writeEntry(cacheKey, {
        fetchedAt: new Date().toISOString(),
        status: response.status,
        finalUrl: response.url,
        headers: responseHeaders,
        body,
      });
    }

    if (!isUsableCachedBody(body) && staleUsableEntry) {
      console.log('[agent] blocked fetch; using stale http cache', {
        url: url.length > 120 ? `${url.slice(0, 120)}…` : url,
      });
      return cachedResultFromEntry(staleUsableEntry, durationMs);
    }

    return {
      ok: response.ok,
      status: response.status,
      url: response.url,
      headers: responseHeaders,
      text: body,
      fromCache: false,
      requestDurationMs: durationMs,
      networkAttempts: attempts,
    };
  })();

  inFlight.set(cacheKey, fetchPromise);

  try {
    return await fetchPromise;
  } finally {
    inFlight.delete(cacheKey);
  }
}

export async function fetchJsonWithCache<T>(url: string, init?: RequestInit, fetchFn?: FetchFn): Promise<CachedFetchResult & { json?: T }> {
  const result = await fetchTextWithCache(url, init, fetchFn);
  if (!result.ok) {
    return result;
  }

  try {
    return {
      ...result,
      json: JSON.parse(result.text) as T,
    };
  } catch {
    return result;
  }
}
