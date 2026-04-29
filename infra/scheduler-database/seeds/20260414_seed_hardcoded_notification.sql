-- Seed: Upsert a hardcoded notification job that runs every 10 minutes
INSERT INTO scheduler_jobs (id, handler, payload, interval_minutes, next_run_at, active)
VALUES (
    'hardcoded-notification-every-10-minutes',
    'send_hardcoded_notification',
    '{"title":"Freedom Times","message":"This is a hardcoded notification from the scheduler."}',
    10,
    DATETIME(CURRENT_TIMESTAMP, '+10 minutes'),
    1
)
ON CONFLICT(id) DO UPDATE SET
    handler = excluded.handler,
    payload = excluded.payload,
    interval_minutes = excluded.interval_minutes,
    active = excluded.active,
    updated_at = CURRENT_TIMESTAMP;