-- Migration: Create sent_article_notifications table to track push notifications for articles
CREATE TABLE IF NOT EXISTS sent_article_notifications (
    article_id TEXT PRIMARY KEY,
    sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
