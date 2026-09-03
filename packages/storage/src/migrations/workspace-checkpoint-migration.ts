export const WORKSPACE_CHECKPOINT_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS workspace_checkpoints (
  id TEXT PRIMARY KEY NOT NULL,
  owner_key TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  path TEXT NOT NULL,
  entries_json TEXT NOT NULL,
  scanned_entries INTEGER NOT NULL,
  truncated INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workspace_checkpoints_owner_created
  ON workspace_checkpoints(owner_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_checkpoints_expiry
  ON workspace_checkpoints(owner_key, expires_at);
`;
