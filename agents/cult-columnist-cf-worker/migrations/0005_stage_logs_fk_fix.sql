-- Fix invalid foreign key on stage_logs.stage.
-- stage_reviews(stage) is not unique, so referencing it is invalid in SQLite.
-- Keep run_id FK and stage index for query performance.

PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS stage_logs_new (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  data JSON,
  logged_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id)
);

INSERT INTO stage_logs_new (id, run_id, stage, level, message, data, logged_at)
SELECT id, run_id, stage, level, message, data, logged_at
FROM stage_logs;

DROP TABLE stage_logs;
ALTER TABLE stage_logs_new RENAME TO stage_logs;

CREATE INDEX IF NOT EXISTS idx_stage_logs_run_id ON stage_logs(run_id);
CREATE INDEX IF NOT EXISTS idx_stage_logs_stage ON stage_logs(stage);
CREATE INDEX IF NOT EXISTS idx_stage_logs_logged_at ON stage_logs(logged_at);

PRAGMA foreign_keys = ON;
