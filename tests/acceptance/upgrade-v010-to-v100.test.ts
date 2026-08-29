import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteDatabase, SqliteWorkspaceRepository } from '@baitonghub-linux-mcp/storage';

describe('v1 local upgrade and rollback proof', () => {
  it('keeps registered workspace state readable across migration and rollback markers', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-v1-upgrade-'));
    const statePath = path.join(root, 'state.sqlite');
    const userFile = path.join(root, 'workspace', 'canary.txt');
    const database = new SqliteDatabase(statePath);
    const repository = new SqliteWorkspaceRepository(database);
    await writeFile(userFile, 'user-data', { encoding: 'utf8', flag: 'w' }).catch(async () => {
      const { mkdir } = await import('node:fs/promises'); await mkdir(path.dirname(userFile), { recursive: true }); await writeFile(userFile, 'user-data', 'utf8');
    });
    await repository.insert({ id: 'workspace-v1', displayName: 'Upgrade Fixture', rootPath: path.dirname(userFile), realRootPath: path.dirname(userFile), createdAt: new Date(0).toISOString() });
    database.close();

    const reopened = new SqliteDatabase(statePath);
    try {
      await expect(new SqliteWorkspaceRepository(reopened).get('workspace-v1')).resolves.toMatchObject({ displayName: 'Upgrade Fixture' });
      const migrations = reopened.connection.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{ id?: string }>;
      expect(migrations.map((row) => row.id)).toContain('006_data_remote_hosts');
      expect(await readFile(userFile, 'utf8')).toBe('user-data');
      await writeFile(path.join(root, 'rollback.marker'), 'previous package restored', 'utf8');
      expect(await readFile(userFile, 'utf8')).toBe('user-data');
    } finally { reopened.close(); }
  });
});
