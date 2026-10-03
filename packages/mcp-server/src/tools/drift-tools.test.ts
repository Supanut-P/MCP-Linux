import { expect, it, vi } from 'vitest';
import { ok } from '@baitonghub-linux-mcp/domain';
import { ToolRegistry } from '../tool-registry.js';

it('uses the trusted actor and rejects owner spoofing and comparison target overrides', async () => {
  const actor = { clientId: 'owner', clientName: 'fixture' };
  const execute = vi.fn(async () => ok({ state: 'complete' }));
  const registry = new ToolRegistry({ drift: { execute } }, actor, { serverProfileProvider: (): 'fleet' => 'fleet' });
  expect((await registry.invoke('drift', { operation: 'status', snapshotId: 's' })).isError).not.toBe(true);
  expect(execute.mock.calls[0]?.[0]).toEqual(actor);
  expect((await registry.invoke('drift', { operation: 'status', snapshotId: 's', ownerKey: 'spoof' })).isError).toBe(true);
  expect((await registry.invoke('drift', { operation: 'compare', snapshotId: 's', baselineId: 'b', baselineHash: 'a'.repeat(64), targets: [] })).isError).toBe(true);
  expect(execute).toHaveBeenCalledTimes(1);
});

it('is optional and excluded from core', () => {
  const actor = { clientId: 'x', clientName: 'x' };
  expect(new ToolRegistry({}, actor).list().some(t => t.name === 'drift')).toBe(false);
  expect(new ToolRegistry({ drift: { execute: async (): Promise<ReturnType<typeof ok>> => ok({}) } }, actor, { serverProfileProvider: (): 'core' => 'core' }).list().some(t => t.name === 'drift')).toBe(false);
});
