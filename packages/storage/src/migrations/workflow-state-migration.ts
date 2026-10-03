export const WORKFLOW_STATE_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS durable_workflows (
  id TEXT PRIMARY KEY NOT NULL,
  owner_key TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  cancelled INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_durable_workflows_owner ON durable_workflows(owner_key, created_at, id);
CREATE TABLE IF NOT EXISTS durable_workflow_tasks (
  workflow_id TEXT NOT NULL REFERENCES durable_workflows(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  contract_json TEXT NOT NULL,
  dependencies_json TEXT NOT NULL,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL,
  checkpoint_json TEXT,
  claim_token TEXT,
  PRIMARY KEY(workflow_id, task_id)
);
CREATE TABLE IF NOT EXISTS durable_workflow_events (
  workflow_id TEXT NOT NULL REFERENCES durable_workflows(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  task_id TEXT,
  type TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  revision INTEGER,
  PRIMARY KEY(workflow_id, sequence)
);
`;
