-- Migration: Anonymous notification troubleshooting reports from readers
CREATE TABLE IF NOT EXISTS notification_diagnostics (
    id TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    user_note TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_notification_diagnostics_created_at
    ON notification_diagnostics (created_at DESC);
