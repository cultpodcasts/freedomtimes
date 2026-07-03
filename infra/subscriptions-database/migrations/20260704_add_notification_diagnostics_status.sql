-- Triage status for admin notification diagnostic reports
ALTER TABLE notification_diagnostics ADD COLUMN status TEXT NOT NULL DEFAULT 'unread';
ALTER TABLE notification_diagnostics ADD COLUMN updated_at TEXT;

CREATE INDEX IF NOT EXISTS idx_notification_diagnostics_status_created_at
    ON notification_diagnostics (status, created_at DESC);
