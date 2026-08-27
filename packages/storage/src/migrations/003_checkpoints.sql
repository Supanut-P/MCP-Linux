CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  files_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_workspace_created ON checkpoints(workspace_id, created_at DESC);
