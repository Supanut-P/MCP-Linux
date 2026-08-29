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
});
