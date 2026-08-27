import { describe, expect, it, vi } from 'vitest';
import { AtSpi2Provider, type AtSpiNode, type AtSpiTransport } from './at-spi-provider.js';

const tree: AtSpiNode = {
  id: 'registry|root', busName: 'registry', objectPath: '/root', name: 'Desktop', description: '', role: 'desktop frame', interfaces: [],
  children: [{
    id: 'app|button', busName: 'app', objectPath: '/button', name: 'Save', description: '', role: 'push button', interfaces: ['org.a11y.atspi.Action'], children: [],
  }],
};

describe('AtSpi2Provider', () => {
  it('reports AT-SPI availability without executing an action', async () => {
    const provider = new AtSpi2Provider({ transport: transport() });
    await expect(provider.status()).resolves.toMatchObject({ ok: true, value: { provider: 'at-spi2', available: true } });
  });

  it('returns unavailable when the accessibility bus probe hangs', async () => {
    const fixture = transport();
    fixture.available = async (): Promise<boolean> => new Promise<boolean>(() => undefined);
    const provider = new AtSpi2Provider({ transport: fixture, statusTimeoutMs: 10 });

    await expect(provider.status()).resolves.toMatchObject({
      ok: false,
      error: { code: 'CAPABILITY_UNAVAILABLE' },
    });
  });

  it('finds semantic controls and invokes a target by D-Bus identity', async () => {
    const fixture = transport();
    const invoke = vi.spyOn(fixture, 'invoke');
    const provider = new AtSpi2Provider({ transport: fixture });

    await expect(provider.execute({ action: 'find_element', parameters: { name: 'save' } })).resolves.toMatchObject({
      ok: true,
      value: { elements: [{ name: 'Save', busName: 'app', objectPath: '/button' }] },
    });
    await expect(provider.execute({ action: 'click', parameters: { bus_name: 'app', object_path: '/button' } })).resolves.toMatchObject({ ok: true });
    expect(invoke).toHaveBeenCalledWith('click', { busName: 'app', objectPath: '/button' }, undefined);
  });
});

function transport(): AtSpiTransport {
  return {
    available: async () => true,
    snapshot: async () => tree,
    invoke: async () => ({ invoked: true }),
  };
}
