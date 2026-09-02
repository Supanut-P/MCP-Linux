import { describe, expect, it, vi } from 'vitest';
import { RemoteRolloutRuntime, type RemoteRollout, type RemoteRolloutRepository } from './remote-rollout-runtime.js';
import { ok } from '@baitonghub-linux-mcp/domain';

function repository(): RemoteRolloutRepository {
  const plans = new Map<string, RemoteRollout>();
  return {
    create: vi.fn(async (plan: RemoteRollout): Promise<void> => { plans.set(plan.id, plan); }),
    get: vi.fn(async (id: string): Promise<RemoteRollout | null> => plans.get(id) ?? null),
    claim: vi.fn(async (id: string, state: 'planned'): Promise<boolean> => {
      const plan = plans.get(id);
      if (plan?.state !== state) return false;
      plans.set(id, { ...plan, state: 'running' });
      return true;
    }),
    update: vi.fn(async (id: string, patch: Partial<RemoteRollout>): Promise<void> => { const plan = plans.get(id); if (plan) plans.set(id, { ...plan, ...patch, updatedAt: patch.updatedAt ?? plan.updatedAt }); }),
  };
}

describe('RemoteRolloutRuntime', () => {
  it('plans fixed service restarts with an aggregate hash and no connection metadata', async () => {
    const repo = repository();
    const execute = vi.fn()
      .mockResolvedValueOnce(ok({ operation: 'service-restart', hostId: 'vm-a', previewHash: 'a'.repeat(64), preview: { command: ['systemctl', 'restart', 'app.service'] }, dry_run: true }))
      .mockResolvedValueOnce(ok({ operation: 'service-restart', hostId: 'vm-b', previewHash: 'b'.repeat(64), preview: { command: ['systemctl', 'restart', 'app.service'] }, dry_run: true }));
    const runtime = new RemoteRolloutRuntime({ capabilities: { execute }, repository: repo });

    const result = await runtime.execute({ operation: 'plan', workspaceId: 'workspace-1', hostIds: ['vm-a', 'vm-b'], unit: 'app.service', canaryCount: 1, maxParallel: 2 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ operation: 'plan', state: 'planned', canaryCount: 1, maxParallel: 2, rolloutId: expect.any(String), previewHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.stringify(result.value)).not.toMatch(/192\.168\.|secret|password|username|fingerprint|private[_-]?key/i);
    expect(repo.create).toHaveBeenCalledTimes(1);
  });

  it('stops after a canary failure and never starts the remaining hosts', async () => {
    const repo = repository();
    const execute = vi.fn()
      .mockResolvedValueOnce(ok({ operation: 'service-restart', hostId: 'a', previewHash: 'a'.repeat(64), preview: {}, dry_run: true }))
      .mockResolvedValueOnce(ok({ operation: 'service-restart', hostId: 'b', previewHash: 'b'.repeat(64), preview: {}, dry_run: true }))
      .mockResolvedValueOnce({ ok: false, error: { code: 'CAPABILITY_UNAVAILABLE', message: 'remote failed', recoverable: true } });
    const runtime = new RemoteRolloutRuntime({ capabilities: { execute }, repository: repo });
    const plan = await runtime.execute({ operation: 'plan', workspaceId: 'w', hostIds: ['a', 'b'], unit: 'app.service', canaryCount: 1, maxParallel: 2 });
    if (!plan.ok) throw new Error('plan failed');

    const result = await runtime.execute({ operation: 'execute', rolloutId: String(plan.value.rolloutId), workspaceId: 'w', previewHash: String(plan.value.previewHash), userConfirmed: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ state: 'failed', summary: { completed: 0, failed: 1 } });
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls[2]![1]).toMatchObject({ hostId: 'a', operation: 'service-restart', userConfirmed: true });
  });

  it('rejects expired or replayed plans before remote mutation', async () => {
    const repo = repository();
    const execute = vi.fn().mockResolvedValue(ok({ operation: 'service-restart', hostId: 'a', previewHash: 'a'.repeat(64), preview: {}, dry_run: true }));
    const runtime = new RemoteRolloutRuntime({ capabilities: { execute }, repository: repo, now: (): Date => new Date('2026-01-01T00:00:00.000Z') });
    const plan = await runtime.execute({ operation: 'plan', workspaceId: 'w', hostIds: ['a'], unit: 'app.service', canaryCount: 1, maxParallel: 1, expiresAt: '2025-12-31T23:59:00.000Z' });
    expect(plan.ok).toBe(false);
    expect(execute).toHaveBeenCalledTimes(0);
  });

  it('rejects a changed aggregate hash and prevents a second terminal execution', async () => {
    const repo = repository();
    const execute = vi.fn()
      .mockResolvedValueOnce(ok({ operation: 'service-restart', hostId: 'a', previewHash: 'a'.repeat(64), preview: {}, dry_run: true }))
      .mockResolvedValueOnce(ok({ operation: 'service-restart', hostId: 'a', output: '' }));
    const runtime = new RemoteRolloutRuntime({ capabilities: { execute }, repository: repo });
    const planned = await runtime.execute({ operation: 'plan', workspaceId: 'w', hostIds: ['a'], unit: 'app.service', canaryCount: 1, maxParallel: 1 });
    if (!planned.ok) throw new Error('plan failed');
    await expect(runtime.execute({ operation: 'execute', rolloutId: String(planned.value.rolloutId), workspaceId: 'w', previewHash: 'f'.repeat(64), userConfirmed: true })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    await expect(runtime.execute({ operation: 'execute', rolloutId: String(planned.value.rolloutId), workspaceId: 'w', previewHash: String(planned.value.previewHash), userConfirmed: true })).resolves.toMatchObject({ ok: true, value: { state: 'completed' } });
    await expect(runtime.execute({ operation: 'execute', rolloutId: String(planned.value.rolloutId), workspaceId: 'w', previewHash: String(planned.value.previewHash), userConfirmed: true })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('cancels a planned rollout only for its original workspace', async () => {
    const repo = repository();
    const execute = vi.fn().mockResolvedValue(ok({ operation: 'service-restart', hostId: 'a', previewHash: 'a'.repeat(64), preview: {}, dry_run: true }));
    const runtime = new RemoteRolloutRuntime({ capabilities: { execute }, repository: repo });
    const planned = await runtime.execute({ operation: 'plan', workspaceId: 'w', hostIds: ['a'], unit: 'app.service', canaryCount: 1, maxParallel: 1 });
    if (!planned.ok) throw new Error('plan failed');
    await expect(runtime.execute({ operation: 'cancel', rolloutId: String(planned.value.rolloutId), workspaceId: 'other' })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    await expect(runtime.execute({ operation: 'cancel', rolloutId: String(planned.value.rolloutId), workspaceId: 'w' })).resolves.toMatchObject({ ok: true, value: { state: 'cancelled' } });
  });
});
