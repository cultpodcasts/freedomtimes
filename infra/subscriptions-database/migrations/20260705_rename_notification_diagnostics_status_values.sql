-- Align notification_diagnostics.status with story tips (new / reviewed / archived).
-- Existing rows: unread → new, read → reviewed; archived unchanged.
-- Application inserts always set status explicitly to 'new'.
UPDATE notification_diagnostics SET status = 'new' WHERE status = 'unread';
UPDATE notification_diagnostics SET status = 'reviewed' WHERE status = 'read';
