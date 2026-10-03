export const DIAGNOSIS_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS diagnosis_records (
  owner_key TEXT NOT NULL, id TEXT NOT NULL, request_fingerprint TEXT NOT NULL,
  document_json TEXT NOT NULL, document_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(owner_key,id)
);
`;
