import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SqliteDatabase } from './database.js';
import { SqliteRemoteRolloutRepository, type RemoteRollout } from './remote-rollout-repository.js';

function plan(): RemoteRollout {
  const now = new Date().toISOString();
  return {
    id: randomUUID(), workspaceId: 'workspace-1', hostIds: ['vm-a', 'vm-b'], unit: 'app.service', canaryCount: 1, maxParallel: 2,
    hostPlans: [{ hostId: 'vm-a', previewHash: 'a'.repeat(64) }, { hostId: 'vm-b', previewHash: 'b'.repeat(64) }], previewHash: 'c'.repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString(), state: 'planned', createdAt: now, updatedAt: now,
  };
}

describe('SqliteRemoteRolloutRepository', () => {
  it('persists a plan and atomically claims it once', async () => {
    const database = new SqliteDatabase(':memory:');
    try {
      const repository = new SqliteRemoteRolloutRepository(database);
      const value = plan();
      await repository.create(value);
      await expect(repository.get(value.id)).resolves.toMatchObject({ id: value.id, state: 'planned', hostIds: ['vm-a', 'vm-b'] });
      await expect(repository.claim(value.id, 'planned')).resolves.toBe(true);
      await expect(repository.claim(value.id, 'planned')).resolves.toBe(false);
      await expect(repository.get(value.id)).resolves.toMatchObject({ state: 'running' });
    } finally { database.close(); }
  });

  it('round-trips sanitized terminal results and cancellation state', async () => {
    const database = new SqliteDatabase(':memory:');
    try {
      const repository = new SqliteRemoteRolloutRepository(database);
      const value = plan();
      await repository.create(value);
      await repository.update(value.id, { state: 'failed', results: [{ hostId: 'vm-a', status: 'error', error: { code: 'CAPABILITY_UNAVAILABLE', message: 'failed', recoverable: true } }], cancelRequested: true });
      await expect(repository.get(value.id)).resolves.toMatchObject({ state: 'failed', cancelRequested: true, results: [{ hostId: 'vm-a', status: 'error' }] });
    } finally { database.close(); }
  });
});
