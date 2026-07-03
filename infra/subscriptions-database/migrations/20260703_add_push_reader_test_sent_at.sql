-- Track reader-initiated test push sends for per-device rate limiting
ALTER TABLE push_subscriptions ADD COLUMN last_reader_test_at TEXT;
