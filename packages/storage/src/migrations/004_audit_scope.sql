ALTER TABLE audit_events ADD COLUMN session_id TEXT;

CREATE INDEX IF NOT EXISTS idx_audit_events_scope_timestamp
  ON audit_events(workspace_id, session_id, timestamp DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_audit_events_action_scope_timestamp
  ON audit_events(action, workspace_id, session_id, timestamp DESC, id DESC);
