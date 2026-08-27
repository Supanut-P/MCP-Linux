CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY NOT NULL,
  timestamp TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  workspace_id TEXT,
  action TEXT NOT NULL,
  target_summary TEXT,
  permission_decision TEXT,
  result_code TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  metadata_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_events_timestamp ON audit_events(timestamp DESC);
