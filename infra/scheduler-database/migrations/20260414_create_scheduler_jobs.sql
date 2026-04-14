-- Migration: Create scheduler_jobs table for recurring notification tasks
CREATE TABLE IF NOT EXISTS scheduler_jobs (
    id TEXT PRIMARY KEY,
    handler TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    interval_minutes INTEGER NOT NULL,
    next_run_at TEXT NOT NULL,
    last_run_at TEXT,
    last_error TEXT,
    run_count INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_scheduler_jobs_due
    ON scheduler_jobs (active, next_run_at);