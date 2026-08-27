import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Workspace } from '@baitonghub-linux-mcp/workspace';
import { SqliteDatabase } from './database.js';
import { SqliteWorkspaceRepository } from './workspace-repository.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('SqliteWorkspaceRepository', () => {
  it('round-trips workspaces through the initial schema', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-db-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const repository = new SqliteWorkspaceRepository(database);
    const workspace: Workspace = {
      id: 'workspace-1',
      displayName: 'Fixture',
      rootPath: 'C:\\workspace',
      realRootPath: 'C:\\workspace',
      createdAt: new Date(0).toISOString(),
    };

    await repository.insert(workspace);

    await expect(repository.get(workspace.id)).resolves.toEqual(workspace);
    await expect(repository.list()).resolves.toEqual([workspace]);
    await repository.delete(workspace.id);
    await expect(repository.get(workspace.id)).resolves.toBeNull();
    database.close();
  });

  it('archives registrations outside the runtime view and restores them without deleting project data', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-workspace-archive-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.sqlite'));
    try {
      const repository = new SqliteWorkspaceRepository(database);
      const workspace = { id: 'workspace-archived', displayName: 'Archived', rootPath: root, realRootPath: root, createdAt: new Date(0).toISOString() };
      await repository.insert(workspace);
      await repository.archive(workspace.id, '2026-08-24T00:00:00.000Z');

      await expect(repository.list()).resolves.toEqual([]);
      await expect(repository.get(workspace.id)).resolves.toBeNull();
      await expect(repository.getAny(workspace.id)).resolves.toMatchObject({ id: workspace.id, archivedAt: '2026-08-24T00:00:00.000Z' });
      await expect(repository.listAll()).resolves.toEqual([expect.objectContaining({ id: workspace.id, archivedAt: '2026-08-24T00:00:00.000Z' })]);

      await repository.restore(workspace.id);
      await expect(repository.get(workspace.id)).resolves.toMatchObject({ id: workspace.id });
      expect((await repository.getAny(workspace.id))?.archivedAt).toBeUndefined();
    } finally {
      database.close();
    }
  });

});
