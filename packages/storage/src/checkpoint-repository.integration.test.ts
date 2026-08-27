import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Checkpoint } from '@baitonghub-linux-mcp/workspace';
import { AesGcmCheckpointCipher } from './checkpoint-cipher.js';
import { SqliteCheckpointRepository } from './checkpoint-repository.js';
import { SqliteDatabase } from './database.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('SqliteCheckpointRepository', () => {
  it('round-trips bounded checkpoint metadata and content', async () => {
    const root = await temporaryRoot();
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const repository = new SqliteCheckpointRepository(database);
    const checkpoint = fixtureCheckpoint('before');

    await repository.insert(checkpoint);

    await expect(repository.get(checkpoint.id)).resolves.toEqual(checkpoint);
    database.close();
  });

  it('encrypts checkpoint file content at rest with AES-256-GCM', async () => {
    const root = await temporaryRoot();
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const cipher = new AesGcmCheckpointCipher(Buffer.alloc(32, 7));
    const repository = new SqliteCheckpointRepository(database, cipher);
    const checkpoint = fixtureCheckpoint('sensitive-checkpoint-marker');

    await repository.insert(checkpoint);

    const row = database.connection.prepare('SELECT files_json FROM checkpoints WHERE id = ?').get(checkpoint.id) as { files_json?: string } | undefined;
    expect(row?.files_json).toMatch(/^baitonghub-linux-mcp:checkpoint:v1:/);
    expect(row?.files_json).not.toContain('sensitive-checkpoint-marker');
    await expect(repository.get(checkpoint.id)).resolves.toEqual(checkpoint);
    database.close();
  });

  it('upgrades a legacy plaintext checkpoint to ciphertext when the encrypted repository starts', async () => {
    const root = await temporaryRoot();
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const cipher = new AesGcmCheckpointCipher(Buffer.alloc(32, 9));
    const checkpoint = fixtureCheckpoint('legacy-plaintext-marker');
    const legacyPayload = JSON.stringify(checkpoint.files);
    database.connection.prepare(
      'INSERT INTO checkpoints (id, workspace_id, created_at, files_json) VALUES (?, ?, ?, ?)',
    ).run(checkpoint.id, checkpoint.workspaceId, checkpoint.createdAt, legacyPayload);
    const repository = new SqliteCheckpointRepository(database, cipher);

    await expect(repository.get(checkpoint.id)).resolves.toEqual(checkpoint);

    const row = database.connection.prepare('SELECT files_json FROM checkpoints WHERE id = ?').get(checkpoint.id) as { files_json?: string } | undefined;
    expect(row?.files_json).toMatch(/^baitonghub-linux-mcp:checkpoint:v1:/);
    expect(row?.files_json).not.toContain('legacy-plaintext-marker');
    database.close();
  });

  it('fails closed when an encrypted checkpoint payload is tampered with', async () => {
    const root = await temporaryRoot();
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const cipher = new AesGcmCheckpointCipher(Buffer.alloc(32, 11));
    const repository = new SqliteCheckpointRepository(database, cipher);
    const checkpoint = fixtureCheckpoint('tamper-marker');
    await repository.insert(checkpoint);
    const row = database.connection.prepare('SELECT files_json FROM checkpoints WHERE id = ?').get(checkpoint.id) as { files_json: string };
    const tampered = row.files_json.slice(0, -1) + (row.files_json.endsWith('A') ? 'B' : 'A');
    database.connection.prepare('UPDATE checkpoints SET files_json = ? WHERE id = ?').run(tampered, checkpoint.id);

    await expect(repository.get(checkpoint.id)).resolves.toBeNull();
    database.close();
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-checkpoint-db-'));
  temporaryRoots.push(root);
  return root;
}

function fixtureCheckpoint(content: string): Checkpoint {
  return {
    id: 'checkpoint-1',
    workspaceId: 'workspace-1',
    createdAt: new Date(0).toISOString(),
    files: [{ path: 'src/file.txt', content, contentSha256: 'hash', size: Buffer.byteLength(content) }],
  };
}
