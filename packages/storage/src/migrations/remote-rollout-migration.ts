/** v1.8 durable remote rollout plans; only registration IDs and sanitized results are persisted. */
export const REMOTE_ROLLOUT_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS remote_rollouts (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  host_ids_json TEXT NOT NULL,
  unit TEXT NOT NULL,
  canary_count INTEGER NOT NULL,
  max_parallel INTEGER NOT NULL,
  host_plans_json TEXT NOT NULL,
  preview_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  results_json TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0
);
`;
