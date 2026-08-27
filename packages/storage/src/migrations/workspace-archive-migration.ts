export const WORKSPACE_ARCHIVE_MIGRATION_SQL = `
ALTER TABLE workspaces ADD COLUMN archived_at TEXT;
CREATE INDEX IF NOT EXISTS idx_workspaces_archived_at ON workspaces(archived_at);
`;
