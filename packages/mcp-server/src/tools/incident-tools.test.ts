import { describe, expect, it, vi } from 'vitest';
import { ok } from '@baitonghub-linux-mcp/domain';
import { ToolRegistry } from '../tool-registry.js';

it('forwards the trusted actor and rejects spoofed ownership before execution', async () => {
  const actor = { clientId: 'owner', clientName: 'fixture' };
  const execute = vi.fn(async () => ok({ state: 'partial' }));
  const registry = new ToolRegistry({ incident: { execute } }, actor, { serverProfileProvider: (): 'fleet' => 'fleet' });
  expect((await registry.invoke('incident', { operation: 'status', incidentId: 'i' })).isError).not.toBe(true);
  expect(execute.mock.calls[0]?.[0]).toEqual(actor);
  expect((await registry.invoke('incident', { operation: 'status', incidentId: 'i', ownerKey: 'spoof' })).isError).toBe(true);
  expect(execute).toHaveBeenCalledTimes(1);
});
describe('incident profile exposure', () => {
  it('is optional and excluded from core', () => {
    expect(new ToolRegistry({}, { clientId: 'x', clientName: 'x' }).list().some(t => t.name === 'incident')).toBe(false);
    expect(new ToolRegistry({ incident: { execute: async (): Promise<ReturnType<typeof ok>> => ok({}) } }, { clientId: 'x', clientName: 'x' }, { serverProfileProvider: (): 'core' => 'core' }).list().some(t => t.name === 'incident')).toBe(false);
  });
});
