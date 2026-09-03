import { describe, expect, it } from 'vitest';
import { ok } from '@baitonghub-linux-mcp/domain';
import { RemoteFleetDiffService } from './remote-fleet-diff-service.js';

const baseline = {
  operation: 'snapshot',
  hosts: [
    { hostId: 'vm1', status: 'ok', value: { health: { ready: true }, inventory: { files: 2 }, 'service-status': { state: 'active' } } },
    { hostId: 'vm2', status: 'ok', value: { health: { ready: true }, inventory: { files: 3 }, 'service-status': { state: 'active' } } },
  ],
};

describe('RemoteFleetDiffService', () => {
  it('returns only changed sections and sanitized per-host status', async () => {
    const service = new RemoteFleetDiffService({ runtime: {
      execute: async (): Promise<ReturnType<typeof ok>> => ok({ operation: 'snapshot', hosts: [
        { hostId: 'vm1', status: 'ok', value: { health: { ready: true }, inventory: { files: 9 }, 'service-status': { state: 'active' }, secret: 'hidden' } },
        { hostId: 'vm2', status: 'ok', value: { health: { ready: true }, inventory: { files: 3 }, 'service-status': { state: 'active' } } },
        { hostId: 'vm3', status: 'error', error: { code: 'NOPE', message: '/private/path', recoverable: true } },
      ] }),
    } });
    const result = await service.execute({ hostIds: ['vm1', 'vm2', 'vm3'], baseline });
    expect(result).toMatchObject({
      ok: true,
      value: {
        hosts: [
          { hostId: 'vm1', status: 'changed', baselinePresent: true, currentStatus: 'ok', changedSections: ['inventory'] },
          { hostId: 'vm2', status: 'unchanged', baselinePresent: true, currentStatus: 'ok', changedSections: [] },
          { hostId: 'vm3', status: 'unavailable', baselinePresent: false, currentStatus: 'error', changedSections: [] },
        ],
        summary: { requested: 3, changed: 1, unchanged: 1, unavailable: 1 },
      },
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('/private/path');
  });

  it('rejects invalid, oversized, duplicate, or out-of-scope baselines', async () => {
    const service = new RemoteFleetDiffService({ runtime: { execute: async (): Promise<ReturnType<typeof ok>> => ok({ hosts: [] }) } });
    await expect(service.execute({ hostIds: ['vm1', 'vm1'], baseline })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await expect(service.execute({ hostIds: ['vm1'], baseline: { hosts: [{ hostId: 'vm2', status: 'ok', value: {} }] } })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await expect(service.execute({ hostIds: ['vm1'], baseline: { hosts: [{ hostId: 'vm1', status: 'ok', value: { blob: 'x'.repeat(300_000) } }] } })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('never mutates through the diff runtime and propagates cancellation', async () => {
    const calls: unknown[] = [];
    const service = new RemoteFleetDiffService({ runtime: { execute: async (input): Promise<ReturnType<typeof ok>> => { calls.push(input); return ok({ hosts: [] }); } } });
    const controller = new AbortController();
    controller.abort();
    await expect(service.execute({ hostIds: ['vm1'], baseline: { hosts: [] } }, controller.signal)).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    expect(calls).toHaveLength(0);
  });
});
