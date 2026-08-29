/** v0.5 registrations contain metadata only; secret values stay in Secret Service. */
export const DATA_REMOTE_HOSTS_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS database_targets (
  id TEXT PRIMARY KEY NOT NULL,
  display_name TEXT NOT NULL,
  driver TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  database_name TEXT NOT NULL,
  username TEXT NOT NULL,
  secret_ref TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS remote_hosts (
  id TEXT PRIMARY KEY NOT NULL,
  display_name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  username TEXT NOT NULL,
  secret_ref TEXT NOT NULL,
  pinned_fingerprint TEXT NOT NULL,
  roots_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;
