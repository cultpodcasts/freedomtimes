-- Triage status for admin notification diagnostic reports (new / reviewed / archived)
ALTER TABLE notification_diagnostics ADD COLUMN status TEXT NOT NULL DEFAULT 'new';
ALTER TABLE notification_diagnostics ADD COLUMN updated_at TEXT;

CREATE INDEX IF NOT EXISTS idx_notification_diagnostics_status_created_at
    ON notification_diagnostics (status, created_at DESC);
