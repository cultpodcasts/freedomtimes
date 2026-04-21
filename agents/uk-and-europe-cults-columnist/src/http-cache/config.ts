const DEFAULT_HTTP_CACHE_TTL_MINUTES = 180;
const DEFAULT_HTTP_CACHE_MAX_ENTRIES = 5000;
const DEFAULT_HTTP_FETCH_TIMEOUT_MS = 15000;
const DEFAULT_HTTP_ERROR_CACHE_TTL_SECONDS = 0;
const DEFAULT_BROWSER_RENDER_TIMEOUT_MS = 20000;
const DEFAULT_HTTP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';

export const HTTP_CACHE_ENABLED = (process.env.HTTP_CACHE_ENABLED ?? 'true').toLowerCase() !== 'false';

export const HTTP_CACHE_TTL_MINUTES = Math.max(
  1,
  Number.parseInt(process.env.HTTP_CACHE_TTL_MINUTES ?? `${DEFAULT_HTTP_CACHE_TTL_MINUTES}`, 10) ||
    DEFAULT_HTTP_CACHE_TTL_MINUTES,
);

export const HTTP_CACHE_MAX_ENTRIES = Math.max(
  100,
  Number.parseInt(process.env.HTTP_CACHE_MAX_ENTRIES ?? `${DEFAULT_HTTP_CACHE_MAX_ENTRIES}`, 10) ||
    DEFAULT_HTTP_CACHE_MAX_ENTRIES,
);

export const HTTP_FETCH_TIMEOUT_MS = Math.max(
  1000,
  Number.parseInt(process.env.HTTP_FETCH_TIMEOUT_MS ?? `${DEFAULT_HTTP_FETCH_TIMEOUT_MS}`, 10) ||
    DEFAULT_HTTP_FETCH_TIMEOUT_MS,
);

export const HTTP_ERROR_CACHE_TTL_SECONDS = Math.max(
  0,
  Number.parseInt(process.env.HTTP_ERROR_CACHE_TTL_SECONDS ?? `${DEFAULT_HTTP_ERROR_CACHE_TTL_SECONDS}`, 10) ||
    DEFAULT_HTTP_ERROR_CACHE_TTL_SECONDS,
);

export const BROWSER_RENDER_FALLBACK_ENABLED =
  (process.env.BROWSER_RENDER_FALLBACK_ENABLED ?? 'true').toLowerCase() === 'true';

export const BROWSER_RENDER_TIMEOUT_MS = Math.max(
  1000,
  Number.parseInt(process.env.BROWSER_RENDER_TIMEOUT_MS ?? `${DEFAULT_BROWSER_RENDER_TIMEOUT_MS}`, 10) ||
    DEFAULT_BROWSER_RENDER_TIMEOUT_MS,
);

export const BROWSER_RENDER_FALLBACK_STATUS_CODES: Set<number> = new Set(
  (process.env.BROWSER_RENDER_FALLBACK_STATUS_CODES ?? '403,429,451')
    .split(',')
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value) && value >= 100),
);

export const HTTP_USER_AGENT = process.env.HTTP_USER_AGENT?.trim() || DEFAULT_HTTP_USER_AGENT;

// Comma-separated list of hosts to retry via archive.ph when a direct fetch returns a non-2xx response.
export const ARCHIVE_FALLBACK_HOSTS: Set<string> = new Set(
  (process.env.ARCHIVE_FALLBACK_HOSTS ?? 'scotsman.com,telegraaf.nl')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
);
