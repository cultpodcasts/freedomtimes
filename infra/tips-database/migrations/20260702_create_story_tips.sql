-- Migration: Secure story tip submissions (anonymous or identified)
CREATE TABLE IF NOT EXISTS story_tips (
    id TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    anonymous INTEGER NOT NULL CHECK (anonymous IN (0, 1)),
    contact_name TEXT,
    contact_email TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_story_tips_created_at
    ON story_tips (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_story_tips_anonymous
    ON story_tips (anonymous, created_at DESC);
