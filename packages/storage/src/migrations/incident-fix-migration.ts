export const INCIDENT_FIX_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS incident_fix_records (
  owner_key TEXT NOT NULL, id TEXT NOT NULL, workflow_id TEXT NOT NULL UNIQUE,
  request_fingerprint TEXT NOT NULL, document_json TEXT NOT NULL,
  document_hash TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(owner_key,id),
  FOREIGN KEY(workflow_id) REFERENCES durable_workflows(id)
);
`;
