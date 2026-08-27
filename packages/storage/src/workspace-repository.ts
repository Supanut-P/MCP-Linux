import type { Workspace } from '@baitonghub-linux-mcp/workspace';
import type { SqliteDatabase } from './database.js';

interface WorkspaceRow {
  readonly id: string;
  readonly display_name: string;
  readonly root_path: string;
  readonly real_root_path: string;
  readonly created_at: string;
  readonly archived_at: string | null;
}

const workspaceColumns = 'id, display_name, root_path, real_root_path, created_at, archived_at';

export class SqliteWorkspaceRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  /** Runtime-visible workspaces only. Archived registrations are intentionally outside the active trust boundary. */
  public async list(): Promise<Workspace[]> {
    const rows = this.database.connection.prepare(
      `SELECT ${workspaceColumns} FROM workspaces WHERE archived_at IS NULL ORDER BY created_at, id`,
    ).all();
    return this.toWorkspaceList(rows);
  }

  /** Runtime-visible lookup only. Use getAny() from trusted management surfaces. */
  public async get(id: string): Promise<Workspace | null> {
    const row = this.database.connection.prepare(
      `SELECT ${workspaceColumns} FROM workspaces WHERE id = ? AND archived_at IS NULL`,
    ).get(id);
    return this.toWorkspace(row);
  }

  /** Trusted management view including archived registrations. */
  public async listAll(): Promise<Workspace[]> {
    const rows = this.database.connection.prepare(
      `SELECT ${workspaceColumns} FROM workspaces ORDER BY archived_at IS NOT NULL, created_at, id`,
    ).all();
    return this.toWorkspaceList(rows);
  }

  /** Trusted management lookup including archived registrations. */
  public async getAny(id: string): Promise<Workspace | null> {
    const row = this.database.connection.prepare(`SELECT ${workspaceColumns} FROM workspaces WHERE id = ?`).get(id);
    return this.toWorkspace(row);
  }

  public async insert(workspace: Workspace): Promise<void> {
    this.database.connection.prepare(
      'INSERT INTO workspaces (id, display_name, root_path, real_root_path, created_at, archived_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(workspace.id, workspace.displayName, workspace.rootPath, workspace.realRootPath, workspace.createdAt, workspace.archivedAt ?? null);
  }

  public async archive(id: string, archivedAt: string = new Date().toISOString()): Promise<void> {
    this.database.connection.prepare('UPDATE workspaces SET archived_at = ? WHERE id = ?').run(archivedAt, id);
  }

  public async restore(id: string): Promise<void> {
    this.database.connection.prepare('UPDATE workspaces SET archived_at = NULL WHERE id = ?').run(id);
  }

  public async delete(id: string): Promise<void> {
    this.database.connection.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
  }

  private toWorkspaceList(rows: readonly unknown[]): Workspace[] {
    return rows.flatMap((row) => {
      const workspace = this.toWorkspace(row);
      return workspace === null ? [] : [workspace];
    });
  }

  private toWorkspace(value: unknown): Workspace | null {
    if (!this.isWorkspaceRow(value)) return null;
    return {
      id: value.id,
      displayName: value.display_name,
      rootPath: value.root_path,
      realRootPath: value.real_root_path,
      createdAt: value.created_at,
      ...(value.archived_at === null ? {} : { archivedAt: value.archived_at }),
    };
  }

  private isWorkspaceRow(value: unknown): value is WorkspaceRow {
    if (typeof value !== 'object' || value === null) return false;
    if (!('id' in value) || !('display_name' in value) || !('root_path' in value)
      || !('real_root_path' in value) || !('created_at' in value) || !('archived_at' in value)) return false;
    return typeof value.id === 'string'
      && typeof value.display_name === 'string'
      && typeof value.root_path === 'string'
      && typeof value.real_root_path === 'string'
      && typeof value.created_at === 'string'
      && (value.archived_at === null || typeof value.archived_at === 'string');
  }
}
