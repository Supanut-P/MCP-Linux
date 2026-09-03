import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkspaceCheckpointRecord } from '@baitonghub-linux-mcp/workspace';
import { SqliteDatabase } from './database.js';
import { SqliteWorkspaceCheckpointRepository } from './workspace-checkpoint-repository.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('SqliteWorkspaceCheckpointRepository', () => {
  it('round-trips metadata, scopes by owner, and never stores file contents', async () => {
    const root = await temporaryRoot();
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const repository = new SqliteWorkspaceCheckpointRepository(database);
    const record = fixture('checkpoint-1', 'owner-a');

    await repository.insert(record);

    await expect(repository.get('owner-a', record.id)).resolves.toEqual(record);
    await expect(repository.get('owner-b', record.id)).resolves.toBeNull();
    const row = database.connection.prepare('SELECT entries_json FROM workspace_checkpoints WHERE id = ?').get(record.id) as { entries_json?: string } | undefined;
    expect(row?.entries_json).not.toContain('content');
    expect(row?.entries_json).not.toContain('absolutePath');
    database.close();
  });

  it('prunes expired rows and reports owner byte/count quotas', async () => {
    const root = await temporaryRoot();
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const repository = new SqliteWorkspaceCheckpointRepository(database);
    await repository.insert(fixture('expired', 'owner-a', '2026-09-01T00:00:00.000Z'));
    await repository.insert(fixture('live', 'owner-a', '2026-09-05T00:00:00.000Z'));

    await expect(repository.count('owner-a')).resolves.toBe(2);
    await expect(repository.totalBytes('owner-a')).resolves.toBeGreaterThan(0);
    await expect(repository.pruneExpired('owner-a', '2026-09-03T00:00:00.000Z')).resolves.toBe(1);
    await expect(repository.list('owner-a')).resolves.toHaveLength(1);
    database.close();
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-workspace-checkpoint-db-'));
  temporaryRoots.push(root);
  return root;
}

function fixture(id: string, ownerKey: string, expiresAt = '2026-09-04T00:00:00.000Z'): WorkspaceCheckpointRecord {
  return {
    id,
    ownerKey,
    workspaceId: 'workspace-1',
    name: 'before-build',
    createdAt: '2026-09-03T00:00:00.000Z',
    expiresAt,
    path: 'src',
    entries: [{ path: 'src/app.ts', bytes: 12, mtimeMs: 1_700_000_000_000 }],
    scannedEntries: 1,
    truncated: false,
  };
}
