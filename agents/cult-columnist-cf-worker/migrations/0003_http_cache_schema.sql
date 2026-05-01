-- Migration: 0003_http_cache_schema
-- Runtime-only transient HTTP cache metadata/body for current runs.
-- No seed/backfill of historical HTTP data is permitted.

CREATE TABLE IF NOT EXISTS http_cache_entries (
  cache_key         TEXT PRIMARY KEY,     -- sha256(url|method|headers)
  request_url       TEXT NOT NULL,
  final_url         TEXT,
  status            INTEGER NOT NULL,
  fetched_at        TEXT NOT NULL,
  expires_at        TEXT NOT NULL,        -- TTL cutoff; cache entry is stale after this
  content_type      TEXT,
  r2_key            TEXT NOT NULL,        -- R2 object key for feed XML
  body_sha256       TEXT NOT NULL,        -- hash of XML for deduplication
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_http_cache_request_url ON http_cache_entries(request_url);
CREATE INDEX IF NOT EXISTS idx_http_cache_final_url ON http_cache_entries(final_url);
CREATE INDEX IF NOT EXISTS idx_http_cache_status ON http_cache_entries(status);
CREATE INDEX IF NOT EXISTS idx_http_cache_fetched_at ON http_cache_entries(fetched_at);
CREATE INDEX IF NOT EXISTS idx_http_cache_expires_at ON http_cache_entries(expires_at);
