export const INCIDENT_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS incidents (
  owner_key TEXT NOT NULL,
  id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  run_token TEXT NOT NULL,
  state TEXT NOT NULL,
  header_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(owner_key,id)
);
CREATE TABLE IF NOT EXISTS incident_evidence (
  owner_key TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY(owner_key,incident_id,sequence),
  FOREIGN KEY(owner_key,incident_id) REFERENCES incidents(owner_key,id)
);
`;
