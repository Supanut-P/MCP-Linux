import { describe, expect, it, vi } from 'vitest';
import { ok } from '@baitonghub-linux-mcp/domain';
import { ToolRegistry } from '../tool-registry.js';

describe('fleet catalog tool boundary', () => {
  it('appears only when configured and forwards the trusted actor', async () => {
    const actor = { clientId: 'owner', clientName: 'fixture' };
    const execute = vi.fn(async () => ok({ entries: [] }));
    const registry = new ToolRegistry({ fleetCatalog: { execute } }, actor, { serverProfileProvider: (): 'fleet' => 'fleet' });
    expect(registry.list().some(tool => tool.name === 'fleet_catalog')).toBe(true);
    expect((await registry.invoke('fleet_catalog', { operation: 'list' })).isError).not.toBe(true);
    expect(execute.mock.calls[0]?.[0]).toEqual(actor);
    expect((await registry.invoke('fleet_catalog', { operation: 'list', ownerKey: 'fake' })).isError).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(new ToolRegistry({ fleetCatalog: { execute } }, actor, { serverProfileProvider: (): 'core' => 'core' }).list().some(tool => tool.name === 'fleet_catalog')).toBe(false);
    expect(new ToolRegistry({}, actor).list().some(tool => tool.name === 'fleet_catalog')).toBe(false);
  });
});
