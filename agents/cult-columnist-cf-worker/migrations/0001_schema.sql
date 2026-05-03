-- Migration: 0001_schema
-- Creates all core tables for the cult-agent pipeline.
-- Run with: wrangler d1 migrations apply cult-agent-db [--local | --env staging]

-- ─── Pipeline runs ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS runs (
  id           TEXT PRIMARY KEY,          -- e.g. "2026-04-22T12:00:00Z"
  status       TEXT NOT NULL DEFAULT 'started',
  -- started | awaiting_review_feed_fetch | awaiting_review_candidate_extract
  -- | awaiting_review_url_resolve | awaiting_review_article_fetch
  -- | awaiting_review_scoring | awaiting_review_dedup | awaiting_review_cluster
  -- | awaiting_review_render | no_stories | published_draft | failed
  current_stage TEXT,
  article_id   TEXT,                      -- CMS article id once published
  error        TEXT,
  started_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── RLHF isolates ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pipeline_isolates (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  stage        TEXT NOT NULL,
  version      INTEGER NOT NULL,
  code         TEXT NOT NULL,             -- ESM source loaded at runtime
  active       INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0,1)),
  authored_by  TEXT NOT NULL DEFAULT 'human',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (stage, version)
);

CREATE INDEX IF NOT EXISTS idx_isolates_stage_active ON pipeline_isolates(stage, active);

-- ─── Stage review log ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS stage_reviews (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       TEXT NOT NULL REFERENCES runs(id),
  stage        TEXT NOT NULL,
  signal       TEXT NOT NULL,             -- 'approve' | 'reject'
  notes        TEXT,
  reviewed_by  TEXT,                      -- JWT sub claim
  isolate_id   INTEGER REFERENCES pipeline_isolates(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_stage_reviews_run ON stage_reviews(run_id, stage);

-- ─── Candidate stories ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS candidates (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL REFERENCES runs(id),
  raw_url         TEXT NOT NULL,
  resolved_url    TEXT,
  title           TEXT,
  pub_date        TEXT,
  feed_id         TEXT,                   -- references feeds.id
  source_language TEXT,
  requires_url_resolution INTEGER NOT NULL DEFAULT 0 CHECK (requires_url_resolution IN (0,1)),
  resolve_status  TEXT,                   -- 'ok' | 'failed' | 'skipped'
  article_r2_key  TEXT,                   -- R2 path to stored article HTML
  article_status  TEXT,                   -- 'ok' | 'failed' | 'blocked' | 'cached'
  article_http_status INTEGER,
  score           REAL,
  score_detail    TEXT,                   -- JSON blob
  excluded        INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0,1)),
  dedupe_reason   TEXT,
  group_id        INTEGER REFERENCES story_groups(id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_candidates_run ON candidates(run_id);
CREATE INDEX IF NOT EXISTS idx_candidates_run_excluded ON candidates(run_id, excluded);

-- ─── Story groups (clustering) ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS story_groups (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       TEXT NOT NULL REFERENCES runs(id),
  label        TEXT,
  member_urls  TEXT NOT NULL,             -- JSON array of resolved_urls
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_groups_run ON story_groups(run_id);

-- ─── Host backoff ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS host_backoff (
  host          TEXT PRIMARY KEY,
  failures      INTEGER NOT NULL DEFAULT 0,
  last_fail_at  TEXT,
  backoff_until TEXT                      -- ISO datetime; null = not in backoff
);

-- ─── Configuration tables (replaces JSON files) ───────────────────────────────

-- feeds.json → feeds table
CREATE TABLE IF NOT EXISTS feeds (
  id                      TEXT PRIMARY KEY,
  title                   TEXT NOT NULL,
  url                     TEXT NOT NULL,
  source_format           TEXT NOT NULL,  -- 'rss' | 'atom' | 'xml'
  source_category         TEXT NOT NULL,  -- 'publisher-feed' | 'aggregator-feed'
  language                TEXT NOT NULL DEFAULT 'en',
  requires_url_resolution INTEGER NOT NULL DEFAULT 0 CHECK (requires_url_resolution IN (0,1)),
  url_resolver            TEXT,           -- 'republishedSourceLink' etc.
  enabled                 INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

-- allowed-source-hosts.json → source_hosts table
CREATE TABLE IF NOT EXISTS source_hosts (
  host         TEXT PRIMARY KEY,
  list_type    TEXT NOT NULL,             -- 'allowed' | 'excluded' | 'watchlist'
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- cult-terms.json + data/discovery/lang/*.json (genericCultTerms, strictCultTermExtensions)
CREATE TABLE IF NOT EXISTS cult_terms (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  term         TEXT NOT NULL,
  language     TEXT NOT NULL DEFAULT 'en',
  term_type    TEXT NOT NULL,
  -- 'cult_term'            → from cult-terms.json (core match terms)
  -- 'generic_term'         → from data/discovery/lang/<code>.json genericCultTerms (weaker signals)
  -- 'strict_extension'     → from data/discovery/lang/<code>.json strictCultTermExtensions
  UNIQUE (term, language, term_type)
);

CREATE INDEX IF NOT EXISTS idx_cult_terms_lang_type ON cult_terms(language, term_type);

-- figurative-cult-context-terms.json
-- figurative-cult-commercial-context-terms.json
-- figurative-cult-phrases.json
-- figurative-cult-patterns-by-language.json (regex strings)
CREATE TABLE IF NOT EXISTS figurative_terms (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  term         TEXT NOT NULL,
  language     TEXT NOT NULL DEFAULT 'en',
  term_type    TEXT NOT NULL,
  -- 'context_term'         → figurative-cult-context-terms.json
  -- 'commercial_term'      → figurative-cult-commercial-context-terms.json
  -- 'phrase'               → figurative-cult-phrases.json
  -- 'regex_pattern'        → figurative-cult-patterns-by-language.json
  UNIQUE (term, language, term_type)
);

CREATE INDEX IF NOT EXISTS idx_figurative_terms_lang_type ON figurative_terms(language, term_type);

-- data/discovery/lang/*.json groupStopwords
CREATE TABLE IF NOT EXISTS group_stopwords (
  word         TEXT NOT NULL,
  language     TEXT NOT NULL DEFAULT 'en',
  PRIMARY KEY (word, language)
);
