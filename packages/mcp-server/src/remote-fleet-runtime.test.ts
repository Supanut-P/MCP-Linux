import { describe, expect, it } from 'vitest';
import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import { RemoteFleetRuntime } from './remote-fleet-runtime.js';

describe('RemoteFleetRuntime', () => {
  it('fans out only registered host IDs with a maximum of four concurrent calls', async () => {
    const calls: Record<string, unknown>[] = [];
    let active = 0;
    let maximum = 0;
    const runtime = new RemoteFleetRuntime({
      execute: async (_tool: string, input: unknown): Promise<Result<unknown>> => {
        calls.push(input as Record<string, unknown>);
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return ok({ host: (input as Record<string, unknown>).hostId, output: 'healthy' });
      },
    });
    const hostIds = Array.from({ length: 10 }, (_, index) => `vm${index + 1}`);
    const result = await runtime.execute({ hostIds, operation: 'health', hostname: 'untrusted.example', command: 'cat /etc/passwd' });

    expect(result).toMatchObject({ ok: true, value: { summary: { requested: 10, completed: 10, failed: 0, maxConcurrency: 4 } } });
    expect(maximum).toBeLessThanOrEqual(4);
    expect(calls).toHaveLength(10);
    expect(calls.every((call) => Object.keys(call).sort().join(',') === 'hostId,operation')).toBe(true);
  });

  it('preserves per-host failures while redacting sensitive output', async () => {
    const runtime = new RemoteFleetRuntime({
      execute: async (_tool: string, input: unknown): Promise<Result<unknown>> => (input as Record<string, unknown>).hostId === 'vm2'
        ? err(appError('CAPABILITY_UNAVAILABLE', 'apiKey=super-secret', true))
        : ok({ output: 'service=ready' }),
    });
    const result = await runtime.execute({ hostIds: ['vm1', 'vm2'], operation: 'service-status', unit: 'baitonghub.service' });

    expect(result).toMatchObject({
      ok: true,
      value: {
        hosts: [
          { hostId: 'vm1', status: 'ok', value: { output: 'service=ready' } },
          { hostId: 'vm2', status: 'error', error: { code: 'CAPABILITY_UNAVAILABLE', message: 'apiKey=[redacted]' } },
        ],
        summary: { failed: 1 },
      },
    });
    expect(JSON.stringify(result)).not.toContain('super-secret');
  });

  it('rejects duplicate, malformed, or oversized host lists before dispatch', async () => {
    let calls = 0;
    const runtime = new RemoteFleetRuntime({ execute: async (): Promise<Result<unknown>> => { calls += 1; return ok({}); } });
    await expect(runtime.execute({ hostIds: ['vm1', 'vm1'], operation: 'health' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await expect(runtime.execute({ hostIds: ['../etc'], operation: 'health' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await expect(runtime.execute({ hostIds: Array.from({ length: 21 }, (_, index) => `vm${index}`), operation: 'health' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(calls).toBe(0);
  });

  it('builds a deterministic bounded snapshot from fixed read operations', async () => {
    const calls: string[] = [];
    let active = 0;
    let maximum = 0;
    const runtime = new RemoteFleetRuntime({
      execute: async (_tool: string, input: unknown): Promise<Result<unknown>> => {
        const request = input as Record<string, unknown>;
        calls.push(`${String(request.hostId)}:${String(request.operation)}`);
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise<void>((resolve) => setTimeout(resolve, 3));
        active -= 1;
        return ok({ operation: request.operation, value: 'ready' });
      },
    });
    const result = await runtime.execute({ hostIds: ['vm2', 'vm1'], operation: 'snapshot', unit: 'baitonghub.service', maxParallel: 1 });
    expect(result).toMatchObject({ ok: true, value: {
      operation: 'snapshot',
      completed: 2,
      failed: 0,
      truncated: false,
      maxParallel: 1,
      hosts: [
        { hostId: 'vm1', status: 'ok', value: { health: { operation: 'health' }, inventory: { operation: 'inventory' }, 'service-status': { operation: 'service-status' } } },
        { hostId: 'vm2', status: 'ok' },
      ],
    } });
    expect(maximum).toBe(1);
    expect(calls).toEqual(['vm1:health', 'vm1:inventory', 'vm1:service-status', 'vm2:health', 'vm2:inventory', 'vm2:service-status']);
  });

  it('keeps partial snapshot failures and enforces the per-host byte cap', async () => {
    const runtime = new RemoteFleetRuntime({
      execute: async (_tool: string, input: unknown): Promise<Result<unknown>> => {
        const operation = (input as Record<string, unknown>).operation;
        if (operation === 'inventory') return ok({ huge: 'x'.repeat(300_000) });
        if ((input as Record<string, unknown>).hostId === 'vm2' && operation === 'service-status') return err(appError('CAPABILITY_UNAVAILABLE', 'remote failed', true));
        return ok({ operation });
      },
    });
    const result = await runtime.execute({ hostIds: ['vm1', 'vm2'], operation: 'snapshot' });
    expect(result).toMatchObject({ ok: true, value: { completed: 1, failed: 1, truncated: true, hosts: [
      { hostId: 'vm1', status: 'ok', truncated: true },
      { hostId: 'vm2', status: 'error', error: { code: 'CAPABILITY_UNAVAILABLE' } },
    ] } });
  });

  it('rejects an invalid snapshot concurrency before dispatch', async () => {
    const runtime = new RemoteFleetRuntime({ execute: async (): Promise<Result<unknown>> => ok({}) });
    await expect(runtime.execute({ hostIds: ['vm1'], operation: 'snapshot', maxParallel: 5 })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('returns a bounded timeout when one host provider does not settle', async () => {
    const runtime = new RemoteFleetRuntime({
      execute: async (): Promise<Result<unknown>> => new Promise<Result<unknown>>(() => undefined),
    }, undefined, { hostTimeoutMs: 5 });
    await expect(runtime.execute({ hostIds: ['vm1'], operation: 'health' })).resolves.toMatchObject({
      ok: true,
      value: { hosts: [{ hostId: 'vm1', status: 'error', error: { code: 'PROCESS_TIMEOUT' } }], summary: { failed: 1, cancelled: 1 } },
    });
  });

  it('cancels an in-flight host without waiting for the provider promise', async () => {
    const controller = new AbortController();
    const runtime = new RemoteFleetRuntime({
      execute: async (): Promise<Result<unknown>> => new Promise<Result<unknown>>(() => undefined),
    }, undefined, { hostTimeoutMs: 10_000 });
    const pending = runtime.execute({ hostIds: ['vm1'], operation: 'health' }, controller.signal);
    controller.abort();
    await expect(pending).resolves.toMatchObject({
      ok: true,
      value: { hosts: [{ hostId: 'vm1', status: 'error', error: { code: 'PROCESS_TIMEOUT' } }], summary: { failed: 1, cancelled: 1 } },
    });
  });

  it('emits sanitized per-host audit metadata without remote connection details', async () => {
    const audit: Array<{ readonly hostId: string; readonly operation: string; readonly resultCode: string; readonly durationMs: number }> = [];
    const runtime = new RemoteFleetRuntime({
      execute: async (): Promise<Result<unknown>> => ok({ secret: 'do-not-audit' }),
    }, async (event) => { audit.push(event); });
    await runtime.execute({ hostIds: ['vm1'], operation: 'snapshot' });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ hostId: 'vm1', operation: 'snapshot', resultCode: 'OK' });
    expect(JSON.stringify(audit)).not.toContain('do-not-audit');
  });
});
