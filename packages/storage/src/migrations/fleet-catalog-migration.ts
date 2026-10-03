export const FLEET_CATALOG_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS fleet_catalog (
  owner_key TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_key, id)
);
CREATE INDEX IF NOT EXISTS idx_fleet_catalog_owner_kind ON fleet_catalog(owner_key, kind, id);
`;
