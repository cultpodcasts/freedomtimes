-- Migration: Editorial workflow fields for story tips
ALTER TABLE story_tips ADD COLUMN status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewed', 'archived'));
ALTER TABLE story_tips ADD COLUMN internal_notes TEXT;
ALTER TABLE story_tips ADD COLUMN reviewed_at TEXT;
ALTER TABLE story_tips ADD COLUMN reviewed_by TEXT;

CREATE INDEX IF NOT EXISTS idx_story_tips_status
    ON story_tips (status, created_at DESC);
