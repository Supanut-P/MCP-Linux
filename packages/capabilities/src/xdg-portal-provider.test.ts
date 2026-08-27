import { describe, expect, it, vi } from 'vitest';
import { Variant } from 'dbus-next';
import { XdgPortalProvider, type XdgPortalTransport } from './xdg-portal-provider.js';

describe('XdgPortalProvider', () => {
  it('reports portal availability and consent metadata', async () => {
    const provider = new XdgPortalProvider({ transport: fakeTransport() });
    await expect(provider.status('input_event')).resolves.toMatchObject({
      ok: true,
      value: { provider: 'xdg-desktop-portal', available: true, requiresConsent: true },
    });
  });

  it('returns unavailable when a portal availability probe hangs', async () => {
    const fixture = fakeTransport();
    fixture.available = async (): Promise<boolean> => new Promise<boolean>(() => undefined);
    const provider = new XdgPortalProvider({ transport: fixture, statusTimeoutMs: 10 });

    await expect(provider.status('file_dialog')).resolves.toMatchObject({
      ok: false,
      error: { code: 'CAPABILITY_UNAVAILABLE' },
    });
  });

  it('creates a consented RemoteDesktop session before injecting a pointer click', async () => {
    const request = vi.fn(async (_interfaceName: string, method: string): Promise<Readonly<Record<string, unknown>>> => (
      method === 'CreateSession' ? { session_handle: new Variant('o', '/org/freedesktop/portal/desktop/session/1') } : {}
    ));
    const call = vi.fn(async (): Promise<void> => undefined);
    const provider = new XdgPortalProvider({ transport: { available: async (): Promise<boolean> => true, request, call } });

    await expect(provider.inputEvent({ operation: 'click' })).resolves.toMatchObject({ ok: true, value: { injected: true } });
    expect(request.mock.calls.map((entry) => entry[1])).toEqual(['CreateSession', 'SelectDevices', 'Start']);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('returns a consent state when the portal rejects input', async () => {
    const transport = fakeTransport();
    transport.request = async (): Promise<Readonly<Record<string, unknown>>> => { throw new Error('portal_denied'); };
    await expect(new XdgPortalProvider({ transport }).inputEvent({ operation: 'click' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'CAPABILITY_CONSENT_REQUIRED' },
    });
  });

  it('sends Wayland text through RemoteDesktop keysyms after consent', async () => {
    const request = vi.fn(async (_interfaceName: string, method: string): Promise<Readonly<Record<string, unknown>>> => (
      method === 'CreateSession' ? { session_handle: new Variant('o', '/org/freedesktop/portal/desktop/session/2') } : {}
    ));
    const call = vi.fn(async (): Promise<void> => undefined);
    const provider = new XdgPortalProvider({ transport: { available: async (): Promise<boolean> => true, request, call } });

    await expect(provider.inputEvent({ operation: 'type_text', parameters: { text: 'A' } })).resolves.toMatchObject({ ok: true });
    expect(call.mock.calls.slice(-2).map((entry) => entry[2])).toEqual([
      ['/org/freedesktop/portal/desktop/session/2', {}, 65, 1],
      ['/org/freedesktop/portal/desktop/session/2', {}, 65, 0],
    ]);
  });
});

function fakeTransport(): XdgPortalTransport {
  return {
    available: async () => true,
    request: async () => ({}),
    call: async () => undefined,
  };
}
