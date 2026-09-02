import { describe, expect, it, vi } from 'vitest';
import { RemoteRolloutRuntime, type RemoteRollout, type RemoteRolloutRepository, type RemoteRolloutState } from './remote-rollout-runtime.js';
import { ok } from '@baitonghub-linux-mcp/domain';

function repository(): RemoteRolloutRepository & { readonly plans: Map<string, RemoteRollout> } {
  const plans = new Map<string, RemoteRollout>();
  return {
    plans,
    create: vi.fn(async (plan: RemoteRollout): Promise<void> => { plans.set(plan.id, plan); }),
    get: vi.fn(async (id: string): Promise<RemoteRollout | null> => plans.get(id) ?? null),
    list: vi.fn(async (state?: RemoteRolloutState): Promise<readonly RemoteRollout[]> => [...plans.values()].filter((plan) => state === undefined || plan.state === state)),
    claim: vi.fn(async (id: string, state: 'planned'): Promise<boolean> => {
      const plan = plans.get(id);
      if (plan?.state !== state) return false;
      plans.set(id, { ...plan, state: 'running' });
      return true;
    }),
    claimResume: vi.fn(async (id: string): Promise<boolean> => {
      const plan = plans.get(id);
      if (plan === undefined || (plan.state !== 'failed' && plan.state !== 'cancelled') || plan.resumePreview === undefined || plan.resumePreview === null) return false;
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

  it('records a later batch failure while still attempting the remaining bounded batch', async () => {
    const repo = repository();
    const execute = vi.fn()
      .mockResolvedValueOnce(ok({ operation: 'service-restart', hostId: 'a', previewHash: 'a'.repeat(64), preview: {}, dry_run: true }))
      .mockResolvedValueOnce(ok({ operation: 'service-restart', hostId: 'b', previewHash: 'b'.repeat(64), preview: {}, dry_run: true }))
      .mockResolvedValueOnce(ok({ operation: 'service-restart', hostId: 'c', previewHash: 'c'.repeat(64), preview: {}, dry_run: true }))
      .mockResolvedValueOnce(ok({ operation: 'service-restart', hostId: 'a', output: '' }))
      .mockResolvedValueOnce({ ok: false, error: { code: 'CAPABILITY_UNAVAILABLE', message: 'remote host unavailable', recoverable: true } })
      .mockResolvedValueOnce(ok({ operation: 'service-restart', hostId: 'c', output: '' }));
    const runtime = new RemoteRolloutRuntime({ capabilities: { execute }, repository: repo });
    const planned = await runtime.execute({ operation: 'plan', workspaceId: 'w', hostIds: ['a', 'b', 'c'], unit: 'app.service', canaryCount: 1, maxParallel: 1 });
    if (!planned.ok) throw new Error('plan failed');

    const result = await runtime.execute({ operation: 'execute', rolloutId: String(planned.value.rolloutId), workspaceId: 'w', previewHash: String(planned.value.previewHash), userConfirmed: true });

    expect(result).toMatchObject({ ok: true, value: { state: 'failed', summary: { requested: 3, completed: 2, failed: 1 } } });
    expect(execute.mock.calls.slice(3).map((call) => (call[1] as { hostId: string }).hostId)).toEqual(['a', 'b', 'c']);
  });

  it('lets a fast host complete while another host is slow within maxParallel', async () => {
    const repo = repository();
    let releaseSlow!: (value: ReturnType<typeof ok>) => void;
    const slow = new Promise<ReturnType<typeof ok>>((resolve) => { releaseSlow = resolve; });
    const execute = vi.fn(async (_tool: string, input: unknown): Promise<ReturnType<typeof ok>> => {
      const request = input as { hostId: string; userConfirmed?: boolean; dry_run?: boolean };
      if (request.dry_run === true) return ok({ operation: 'service-restart', hostId: request.hostId, previewHash: 'a'.repeat(64), preview: {}, dry_run: true });
      if (request.hostId === 'slow') return slow;
      return ok({ operation: 'service-restart', hostId: request.hostId, output: '' });
    });
    const runtime = new RemoteRolloutRuntime({ capabilities: { execute }, repository: repo });
    const planned = await runtime.execute({ operation: 'plan', workspaceId: 'w', hostIds: ['slow', 'fast'], unit: 'app.service', canaryCount: 2, maxParallel: 2 });
    if (!planned.ok) throw new Error('plan failed');

    const running = runtime.execute({ operation: 'execute', rolloutId: String(planned.value.rolloutId), workspaceId: 'w', previewHash: String(planned.value.previewHash), userConfirmed: true });
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    expect(execute.mock.calls.some((call) => (call[1] as { hostId?: string }).hostId === 'fast' && (call[1] as { userConfirmed?: boolean }).userConfirmed === true)).toBe(true);
    releaseSlow(ok({ operation: 'service-restart', hostId: 'slow', output: '' }));
    await expect(running).resolves.toMatchObject({ ok: true, value: { state: 'completed', summary: { completed: 2 } } });
  });

  it('cancels after the canary and does not start the next batch', async () => {
    const repo = repository();
    const parent = new AbortController();
    const execute = vi.fn(async (_tool: string, input: unknown): Promise<ReturnType<typeof ok>> => {
      const request = input as { hostId: string; userConfirmed?: boolean; dry_run?: boolean };
      if (request.dry_run === true) return ok({ operation: 'service-restart', hostId: request.hostId, previewHash: 'a'.repeat(64), preview: {}, dry_run: true });
      parent.abort();
      return ok({ operation: 'service-restart', hostId: request.hostId, output: '' });
    });
    const runtime = new RemoteRolloutRuntime({ capabilities: { execute }, repository: repo });
    const planned = await runtime.execute({ operation: 'plan', workspaceId: 'w', hostIds: ['canary', 'later'], unit: 'app.service', canaryCount: 1, maxParallel: 1 });
    if (!planned.ok) throw new Error('plan failed');

    await expect(runtime.execute({ operation: 'execute', rolloutId: String(planned.value.rolloutId), workspaceId: 'w', previewHash: String(planned.value.previewHash), userConfirmed: true }, parent.signal)).resolves.toMatchObject({ ok: true, value: { state: 'cancelled', summary: { completed: 1 } } });
    expect(execute.mock.calls.some((call) => (call[1] as { hostId?: string }).hostId === 'later' && (call[1] as { userConfirmed?: boolean }).userConfirmed === true)).toBe(false);
  });

  it('returns a sanitized result for fingerprint and Secret Service failures during planning', async () => {
    const fingerprintRepo = repository();
    const fingerprint = vi.fn().mockResolvedValue({ ok: false, error: { code: 'CAPABILITY_UNAVAILABLE', message: 'fingerprint mismatch for 192.168.1.39', recoverable: true } });
    const fingerprintRuntime = new RemoteRolloutRuntime({ capabilities: { execute: fingerprint }, repository: fingerprintRepo });
    await expect(fingerprintRuntime.execute({ operation: 'plan', workspaceId: 'w', hostIds: ['a'], unit: 'app.service', canaryCount: 1, maxParallel: 1 })).resolves.toMatchObject({ ok: false, error: { code: 'CAPABILITY_UNAVAILABLE' } });
    expect(fingerprintRepo.create).not.toHaveBeenCalled();

    const secretRepo = repository();
    const secret = vi.fn().mockRejectedValue(new Error('Secret Service unavailable for api_key=super-secret'));
    const secretRuntime = new RemoteRolloutRuntime({ capabilities: { execute: secret }, repository: secretRepo });
    const result = await secretRuntime.execute({ operation: 'plan', workspaceId: 'w', hostIds: ['a'], unit: 'app.service', canaryCount: 1, maxParallel: 1 });
    expect(result).toMatchObject({ ok: false, error: { code: 'CAPABILITY_UNAVAILABLE', message: 'Remote rollout planning failed' } });
    expect(JSON.stringify(result)).not.toMatch(/super-secret|api_key/i);
    expect(secretRepo.create).not.toHaveBeenCalled();
  });

  it('reconciles running plans as failed with execution_interrupted after a server restart', async () => {
    const repo = repository();
    const runtime = new RemoteRolloutRuntime({ repository: repo });
    const createdAt = '2026-01-01T00:00:00.000Z';
    const plan: RemoteRollout = {
      id: '00000000-0000-4000-8000-000000000001',
      workspaceId: 'w',
      hostIds: ['a', 'b'],
      unit: 'app.service',
      canaryCount: 1,
      maxParallel: 1,
      hostPlans: [{ hostId: 'a', previewHash: 'a'.repeat(64) }, { hostId: 'b', previewHash: 'b'.repeat(64) }],
      previewHash: 'c'.repeat(64),
      expiresAt: '2026-01-01T01:00:00.000Z',
      state: 'running',
      createdAt,
      updatedAt: createdAt,
    };
    await repo.create(plan);

    await runtime.reconcile();

    expect(await repo.get(plan.id)).toMatchObject({ state: 'failed', results: [
      { hostId: 'a', status: 'error', error: { message: 'execution_interrupted' } },
      { hostId: 'b', status: 'error', error: { message: 'execution_interrupted' } },
    ] });
  });

  it('previews and resumes only the hosts that did not complete', async () => {
    const repo = repository();
    const parent = new AbortController();
    const execute = vi.fn(async (_tool: string, input: unknown): Promise<ReturnType<typeof ok>> => {
      const request = input as { hostId: string; dry_run?: boolean };
      if (request.dry_run === true) return ok({ operation: 'service-restart', hostId: request.hostId, previewHash: request.hostId === 'pending' ? 'b'.repeat(64) : 'a'.repeat(64), preview: {}, dry_run: true });
      if (request.hostId === 'ok') { parent.abort(); return ok({ operation: 'service-restart', hostId: request.hostId, output: '' }); }
      return ok({ operation: 'service-restart', hostId: request.hostId, output: '' });
    });
    const runtime = new RemoteRolloutRuntime({ capabilities: { execute }, repository: repo, wait: async (): Promise<void> => undefined });
    const planned = await runtime.execute({ operation: 'plan', workspaceId: 'w', hostIds: ['ok', 'pending'], unit: 'app.service', canaryCount: 1, maxParallel: 1 });
    if (!planned.ok) throw new Error('plan failed');
    await expect(runtime.execute({ operation: 'execute', rolloutId: String(planned.value.rolloutId), workspaceId: 'w', previewHash: String(planned.value.previewHash), userConfirmed: true }, parent.signal)).resolves.toMatchObject({ ok: true, value: { state: 'cancelled' } });

    const preview = await runtime.resume({ operation: 'preview', rolloutId: String(planned.value.rolloutId), workspaceId: 'w' });
    expect(preview).toMatchObject({ ok: true, value: { operation: 'preview', hostIds: ['pending'], retryCounts: { pending: 1 } } });
    if (!preview.ok) return;
    const previewHash = String(preview.value.previewHash);
    const resumed = await runtime.resume({ operation: 'execute', rolloutId: String(planned.value.rolloutId), workspaceId: 'w', previewHash, userConfirmed: true });
    expect(resumed).toMatchObject({ ok: true, value: { operation: 'resume', state: 'completed', summary: { completed: 2, failed: 0, unverified: 0 } } });
    expect(execute.mock.calls.filter((call) => (call[1] as { hostId?: string; dry_run?: boolean }).hostId === 'ok' && (call[1] as { dry_run?: boolean }).dry_run !== true)).toHaveLength(1);
  });

  it('never previews an unverified remote outcome for automatic retry', async () => {
    const repo = repository();
    const execute = vi.fn()
      .mockResolvedValueOnce(ok({ operation: 'service-restart', hostId: 'a', previewHash: 'a'.repeat(64), preview: {}, dry_run: true }))
      .mockResolvedValueOnce({ ok: false, error: { code: 'CAPABILITY_UNAVAILABLE', message: 'connection lost', recoverable: true } });
    const runtime = new RemoteRolloutRuntime({ capabilities: { execute }, repository: repo, wait: async (): Promise<void> => undefined });
    const planned = await runtime.execute({ operation: 'plan', workspaceId: 'w', hostIds: ['a'], unit: 'app.service', canaryCount: 1, maxParallel: 1 });
    if (!planned.ok) throw new Error('plan failed');
    await runtime.execute({ operation: 'execute', rolloutId: String(planned.value.rolloutId), workspaceId: 'w', previewHash: String(planned.value.previewHash), userConfirmed: true });
    await expect(runtime.resume({ operation: 'preview', rolloutId: String(planned.value.rolloutId), workspaceId: 'w' })).resolves.toMatchObject({ ok: false, error: { code: 'CAPABILITY_UNAVAILABLE' } });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('caps a known failed host at two total attempts', async () => {
    const repo = repository();
    const execute = vi.fn()
      .mockResolvedValueOnce(ok({ operation: 'service-restart', hostId: 'a', previewHash: 'a'.repeat(64), preview: {}, dry_run: true }))
      .mockResolvedValueOnce({ ok: false, error: { code: 'PERMISSION_DENIED', message: 'service policy denied', recoverable: false } })
      .mockResolvedValueOnce(ok({ operation: 'service-restart', hostId: 'a', previewHash: 'b'.repeat(64), preview: {}, dry_run: true }))
      .mockResolvedValueOnce({ ok: false, error: { code: 'PERMISSION_DENIED', message: 'service policy denied', recoverable: false } });
    const runtime = new RemoteRolloutRuntime({ capabilities: { execute }, repository: repo, wait: async (): Promise<void> => undefined });
    const planned = await runtime.execute({ operation: 'plan', workspaceId: 'w', hostIds: ['a'], unit: 'app.service', canaryCount: 1, maxParallel: 1 });
    if (!planned.ok) throw new Error('plan failed');
    await runtime.execute({ operation: 'execute', rolloutId: String(planned.value.rolloutId), workspaceId: 'w', previewHash: String(planned.value.previewHash), userConfirmed: true });
    const preview = await runtime.resume({ operation: 'preview', rolloutId: String(planned.value.rolloutId), workspaceId: 'w' });
    if (!preview.ok) throw new Error('resume preview failed');
    await runtime.resume({ operation: 'execute', rolloutId: String(planned.value.rolloutId), workspaceId: 'w', previewHash: String(preview.value.previewHash), userConfirmed: true });
    await expect(runtime.resume({ operation: 'preview', rolloutId: String(planned.value.rolloutId), workspaceId: 'w' })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    expect(execute).toHaveBeenCalledTimes(4);
  });
});
