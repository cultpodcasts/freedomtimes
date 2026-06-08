-- Seed: Upsert a job to poll for newly published articles and send notifications
INSERT INTO scheduler_jobs (id, handler, payload, interval_minutes, next_run_at, active)
VALUES (
    'article-notifications-every-10-minutes',
    'send_article_notifications',
    '{}',
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
