import type { WorkspaceCheckpointEntry, WorkspaceCheckpointRecord, WorkspaceCheckpointRepository } from '@baitonghub-linux-mcp/workspace';
import type { WorkspaceId } from '@baitonghub-linux-mcp/domain';
import type { SqliteDatabase } from './database.js';

interface WorkspaceCheckpointRow {
  readonly id: string;
  readonly owner_key: string;
  readonly workspace_id: string;
  readonly name: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly path: string;
  readonly entries_json: string;
  readonly scanned_entries: number;
  readonly truncated: number;
}

export class SqliteWorkspaceCheckpointRepository implements WorkspaceCheckpointRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  public async insert(record: WorkspaceCheckpointRecord): Promise<void> {
    this.database.connection.prepare(
      `INSERT INTO workspace_checkpoints
        (id, owner_key, workspace_id, name, created_at, expires_at, path, entries_json, scanned_entries, truncated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.id,
      record.ownerKey,
      record.workspaceId,
      record.name,
      record.createdAt,
      record.expiresAt,
      record.path,
      JSON.stringify(record.entries),
      record.scannedEntries,
      record.truncated ? 1 : 0,
    );
  }

  public async list(ownerKey: string, workspaceId?: WorkspaceId, limit = 32): Promise<readonly WorkspaceCheckpointRecord[]> {
    const rows = workspaceId === undefined
      ? this.database.connection.prepare(
        'SELECT id, owner_key, workspace_id, name, created_at, expires_at, path, entries_json, scanned_entries, truncated FROM workspace_checkpoints WHERE owner_key = ? ORDER BY created_at DESC LIMIT ?',
      ).all(ownerKey, limit)
      : this.database.connection.prepare(
        'SELECT id, owner_key, workspace_id, name, created_at, expires_at, path, entries_json, scanned_entries, truncated FROM workspace_checkpoints WHERE owner_key = ? AND workspace_id = ? ORDER BY created_at DESC LIMIT ?',
      ).all(ownerKey, workspaceId, limit);
    return rows.flatMap((row) => {
      const parsed = this.toRecord(row);
      return parsed === null ? [] : [parsed];
    });
  }

  public async get(ownerKey: string, id: string): Promise<WorkspaceCheckpointRecord | null> {
    const row = this.database.connection.prepare(
      'SELECT id, owner_key, workspace_id, name, created_at, expires_at, path, entries_json, scanned_entries, truncated FROM workspace_checkpoints WHERE owner_key = ? AND id = ?',
    ).get(ownerKey, id);
    return this.toRecord(row);
  }

  public async delete(ownerKey: string, id: string): Promise<boolean> {
    const result = this.database.connection.prepare('DELETE FROM workspace_checkpoints WHERE owner_key = ? AND id = ?').run(ownerKey, id);
    return result.changes === 1;
  }

  public async pruneExpired(ownerKey: string, now: string): Promise<number> {
    const result = this.database.connection.prepare('DELETE FROM workspace_checkpoints WHERE owner_key = ? AND expires_at <= ?').run(ownerKey, now);
    return Number(result.changes);
  }

  public async count(ownerKey: string): Promise<number> {
    const row = this.database.connection.prepare('SELECT COUNT(*) AS count FROM workspace_checkpoints WHERE owner_key = ?').get(ownerKey) as { count?: number } | undefined;
    return typeof row?.count === 'number' || typeof row?.count === 'bigint' ? Number(row.count) : 0;
  }

  public async totalBytes(ownerKey: string): Promise<number> {
    const row = this.database.connection.prepare('SELECT COALESCE(SUM(length(entries_json)), 0) AS bytes FROM workspace_checkpoints WHERE owner_key = ?').get(ownerKey) as { bytes?: number } | undefined;
    return typeof row?.bytes === 'number' ? row.bytes : 0;
  }

  private toRecord(value: unknown): WorkspaceCheckpointRecord | null {
    if (!isRow(value)) return null;
    let entries: unknown;
    try { entries = JSON.parse(value.entries_json) as unknown; } catch { return null; }
    if (!Array.isArray(entries) || !entries.every(isEntry)) return null;
    if (!Number.isSafeInteger(value.scanned_entries) || value.scanned_entries < 0) return null;
    return {
      id: value.id,
      ownerKey: value.owner_key,
      workspaceId: value.workspace_id,
      name: value.name,
      createdAt: value.created_at,
      expiresAt: value.expires_at,
      path: value.path,
      entries,
      scannedEntries: value.scanned_entries,
      truncated: value.truncated === 1,
    };
  }
}

function isRow(value: unknown): value is WorkspaceCheckpointRow {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === 'string'
    && typeof row.owner_key === 'string'
    && typeof row.workspace_id === 'string'
    && typeof row.name === 'string'
    && typeof row.created_at === 'string'
    && typeof row.expires_at === 'string'
    && typeof row.path === 'string'
    && typeof row.entries_json === 'string'
    && typeof row.scanned_entries === 'number'
    && typeof row.truncated === 'number';
}

function isEntry(value: unknown): value is WorkspaceCheckpointEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.path === 'string'
    && typeof entry.bytes === 'number' && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0
    && typeof entry.mtimeMs === 'number' && Number.isFinite(entry.mtimeMs)
    && (entry.sha256 === undefined || (typeof entry.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(entry.sha256)));
}
