-- Stage execution logging for audit trail and testing verification
CREATE TABLE IF NOT EXISTS stage_logs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  data JSON,
  logged_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id),
  FOREIGN KEY (stage) REFERENCES stage_reviews(stage)
);

CREATE INDEX IF NOT EXISTS idx_stage_logs_run_id ON stage_logs(run_id);
CREATE INDEX IF NOT EXISTS idx_stage_logs_stage ON stage_logs(stage);
CREATE INDEX IF NOT EXISTS idx_stage_logs_logged_at ON stage_logs(logged_at);
