import { describe, expect, it } from 'vitest';
import { err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import type { FileActor } from '@baitonghub-linux-mcp/application';
import type {
  WorkspaceCheckpointRecord,
  WorkspaceCheckpointRepository,
} from '@baitonghub-linux-mcp/workspace';
import {
  WorkspaceCheckpointService,
  type WorkspaceCheckpointManifestProvider,
} from './workspace-checkpoint-service.js';

const actorA: FileActor = { clientId: 'client-a', clientName: 'Client A', sessionId: 'session-a' };
const actorB: FileActor = { clientId: 'client-b', clientName: 'Client B', sessionId: 'session-b' };

class MemoryRepository implements WorkspaceCheckpointRepository {
  readonly records: WorkspaceCheckpointRecord[] = [];
  quotaCount = 0;

  async insert(record: WorkspaceCheckpointRecord): Promise<void> { this.records.push(record); }
  async list(ownerKey: string, workspaceId?: string, limit = 32): Promise<readonly WorkspaceCheckpointRecord[]> {
    return this.records.filter((record) => record.ownerKey === ownerKey && (workspaceId === undefined || record.workspaceId === workspaceId)).slice(0, limit);
  }
  async get(ownerKey: string, id: string): Promise<WorkspaceCheckpointRecord | null> {
    return this.records.find((record) => record.ownerKey === ownerKey && record.id === id) ?? null;
  }
  async delete(ownerKey: string, id: string): Promise<boolean> {
    const index = this.records.findIndex((record) => record.ownerKey === ownerKey && record.id === id);
    if (index < 0) return false;
    this.records.splice(index, 1);
    return true;
  }
  async pruneExpired(ownerKey: string, now: string): Promise<number> {
    const before = this.records.length;
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      if (this.records[index]?.ownerKey === ownerKey && this.records[index]!.expiresAt <= now) this.records.splice(index, 1);
    }
    return before - this.records.length;
  }
  async count(ownerKey: string): Promise<number> { return this.quotaCount || this.records.filter((record) => record.ownerKey === ownerKey).length; }
  async totalBytes(ownerKey: string): Promise<number> {
    return this.records.filter((record) => record.ownerKey === ownerKey).reduce((total, record) => total + Buffer.byteLength(JSON.stringify(record.entries), 'utf8'), 0);
  }
}

function provider(result: Result<unknown>): WorkspaceCheckpointManifestProvider {
  return { execute: async () => result as Awaited<ReturnType<WorkspaceCheckpointManifestProvider['execute']>> };
}

function manifest(): Result<{ readonly workspaceId: string; readonly path: string; readonly hashMode: 'none'; readonly entries: readonly [{ readonly path: string; readonly bytes: number; readonly mtimeMs: number }]; readonly count: number; readonly scannedEntries: number; readonly truncated: false }> {
  return ok({
    workspaceId: 'ws-1',
    path: 'src',
    hashMode: 'none' as const,
    entries: [{ path: 'src/app.ts', bytes: 12, mtimeMs: 1_700_000_000_000 }],
    count: 1,
    scannedEntries: 2,
    truncated: false,
  });
}

describe('WorkspaceCheckpointService', () => {
  it('creates a bounded metadata-only checkpoint and isolates owners', async () => {
    const repository = new MemoryRepository();
    const service = new WorkspaceCheckpointService(repository, provider(manifest()), { now: (): Date => new Date('2026-09-03T00:00:00.000Z') });

    const created = await service.execute(actorA, { operation: 'create', workspaceId: 'ws-1', path: 'src', name: 'before-build', ttlSeconds: 3600 });
    expect(created).toMatchObject({ ok: true, value: { operation: 'create', checkpoint: { workspaceId: 'ws-1', name: 'before-build', entries: [{ path: 'src/app.ts', bytes: 12 }] } } });
    if (!created.ok) return;
    expect(JSON.stringify(created.value)).not.toContain('content');
    expect(repository.records[0]).not.toHaveProperty('absolutePath');

    const checkpointId = created.value.checkpoint.id;
    await expect(service.execute(actorB, { operation: 'get', checkpointId })).resolves.toMatchObject({ ok: false, error: { code: 'FILE_NOT_FOUND' } });
    await expect(service.execute(actorA, { operation: 'list', workspaceId: 'ws-1' })).resolves.toMatchObject({ ok: true, value: { operation: 'list', count: 1 } });
    await expect(service.execute(actorB, { operation: 'list', workspaceId: 'ws-1' })).resolves.toMatchObject({ ok: true, value: { operation: 'list', count: 0 } });
    await expect(service.execute(actorA, { operation: 'delete', checkpointId })).resolves.toMatchObject({ ok: true, value: { operation: 'delete', checkpointId, deleted: true } });
    await expect(service.execute(actorA, { operation: 'get', checkpointId })).resolves.toMatchObject({ ok: false, error: { code: 'FILE_NOT_FOUND' } });
  });

  it('prunes expired records and enforces the per-owner quota', async () => {
    const repository = new MemoryRepository();
    repository.quotaCount = 32;
    const service = new WorkspaceCheckpointService(repository, provider(manifest()), { now: (): Date => new Date('2026-09-03T00:00:00.000Z') });
    await expect(service.execute(actorA, { operation: 'create', workspaceId: 'ws-1' })).resolves.toMatchObject({ ok: false, error: { code: 'QUOTA_EXCEEDED' } });

    repository.quotaCount = 0;
    repository.records.push({ id: 'expired', ownerKey: 'owner', workspaceId: 'ws-1', name: 'old', createdAt: '2026-09-01T00:00:00.000Z', expiresAt: '2026-09-02T00:00:00.000Z', path: '.', entries: [], scannedEntries: 0, truncated: false });
    await expect(service.execute(actorA, { operation: 'create', workspaceId: 'ws-1', ttlSeconds: 59 })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(repository.records).toHaveLength(1);
  });

  it('returns provider failures without exposing raw exceptions', async () => {
    const repository = new MemoryRepository();
    const service = new WorkspaceCheckpointService(repository, provider(err({ code: 'CAPABILITY_UNAVAILABLE', message: 'scanner unavailable', recoverable: true })));
    await expect(service.execute(actorA, { operation: 'create', workspaceId: 'ws-1' })).resolves.toMatchObject({ ok: false, error: { code: 'CAPABILITY_UNAVAILABLE' } });
  });

  it('rejects absolute or traversal metadata from an untrusted manifest provider', async () => {
    const repository = new MemoryRepository();
    const unsafe = provider(ok({ ...manifest().value, entries: [{ path: '/etc/passwd', bytes: 1, mtimeMs: 1 }] }));
    const service = new WorkspaceCheckpointService(repository, unsafe);
    await expect(service.execute(actorA, { operation: 'create', workspaceId: 'ws-1' })).resolves.toMatchObject({ ok: false, error: { code: 'CAPABILITY_UNAVAILABLE' } });
  });
});
