export const DRIFT_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS drift_snapshots (
  owner_key TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL, run_token TEXT NOT NULL, state TEXT NOT NULL,
  header_json TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, snapshot_hash TEXT, approved_at INTEGER, approval_hash TEXT,
  PRIMARY KEY(owner_key,id)
);
CREATE TABLE IF NOT EXISTS drift_evidence (
  owner_key TEXT NOT NULL, snapshot_id TEXT NOT NULL, sequence INTEGER NOT NULL,
  hash TEXT NOT NULL, payload_json TEXT NOT NULL,
  PRIMARY KEY(owner_key,snapshot_id,sequence),
  FOREIGN KEY(owner_key,snapshot_id) REFERENCES drift_snapshots(owner_key,id)
);
`;
