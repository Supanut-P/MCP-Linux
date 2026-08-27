import { describe, expect, it, vi } from 'vitest';
import { ok, type Result } from '@baitonghub-linux-mcp/domain';
import {
  LinuxNativeCapabilityBackend,
  type LinuxCommandRunner,
  type LinuxAtSpiProvider,
  type LinuxPortalProvider,
} from './linux-native-backend.js';

describe('LinuxNativeCapabilityBackend', () => {
  it('reports sanitized Wayland health metadata and missing dependencies', async () => {
    const backend = new LinuxNativeCapabilityBackend('clipboard', {
      platform: 'linux',
      environment: { WAYLAND_DISPLAY: 'wayland-0' },
      resolveExecutable: async (): Promise<string | null> => null,
    });

    await expect(backend.execute({ action: 'status' })).resolves.toMatchObject({
      ok: true,
      value: {
        platform: 'linux',
        displayServer: 'wayland',
        provider: 'wl-clipboard',
        available: false,
        ready: false,
        requiresConsent: false,
        missingDependencies: ['wl-copy', 'wl-paste'],
      },
    });
  });

  it('requires explicit confirmation before Wayland RemoteDesktop input consent', async () => {
    const portal: LinuxPortalProvider = {
      status: async () => ok({ available: true, ready: true, provider: 'xdg-desktop-portal' }),
      screenshot: async () => ok({}),
      fileChooser: async () => ok({}),
      inputEvent: async () => ok({ injected: true }),
    };
    const backend = new LinuxNativeCapabilityBackend('input_event', {
      platform: 'linux',
      environment: { WAYLAND_DISPLAY: 'wayland-0' },
      portal,
    });

    await expect(backend.execute({ operation: 'click', parameters: { x: 1, y: 2 } })).resolves.toMatchObject({
      ok: false,
      error: { code: 'CAPABILITY_CONSENT_REQUIRED' },
    });
  });

  it('delegates confirmed Wayland input to the portal provider', async () => {
    const inputEvent = vi.fn(async (): Promise<Result<unknown>> => ok({ injected: true }));
    const portal: LinuxPortalProvider = {
      status: async () => ok({ available: true, ready: true, provider: 'xdg-desktop-portal' }),
      screenshot: async () => ok({}),
      fileChooser: async () => ok({}),
      inputEvent,
    };
    const backend = new LinuxNativeCapabilityBackend('input_event', {
      platform: 'linux',
      environment: { WAYLAND_DISPLAY: 'wayland-0' },
      portal,
    });

    await expect(backend.execute({ operation: 'click', parameters: { x: 1, y: 2 }, userConfirmed: true })).resolves.toMatchObject({ ok: true });
    expect(inputEvent).toHaveBeenCalledOnce();
  });

  it('uses argv-only X11 tools and sends clipboard text over stdin', async () => {
    const runner = vi.fn<LinuxCommandRunner>().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    const backend = new LinuxNativeCapabilityBackend('clipboard', {
      platform: 'linux',
      environment: { DISPLAY: ':99' },
      resolveExecutable: async (name): Promise<string | null> => `/usr/bin/${name}`,
      runner,
    });

    await expect(backend.execute({ action: 'set_text', text: 'safe text' })).resolves.toMatchObject({ ok: true });
    expect(runner).toHaveBeenCalledWith('/usr/bin/xclip', ['-selection', 'clipboard', '-in'], {
      input: 'safe text',
      signal: undefined,
    });
    expect(runner.mock.calls[0]?.[1]).not.toContain('safe text');
  });

  it('returns PLATFORM_UNSUPPORTED instead of false success outside Linux', async () => {
    const backend = new LinuxNativeCapabilityBackend('window', { platform: 'win32' });
    await expect(backend.execute({ operation: 'list' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'PLATFORM_UNSUPPORTED' },
    });
  });

  it('reports accessibility unavailable without opening D-Bus in a headless session', async () => {
    const atSpi: LinuxAtSpiProvider = {
      status: vi.fn(async () => ok({ available: true })),
      execute: vi.fn(async () => ok({})),
    };
    const backend = new LinuxNativeCapabilityBackend('accessibility', {
      platform: 'linux',
      environment: {},
      atSpi,
    });

    await expect(backend.execute({ action: 'status' })).resolves.toMatchObject({
      ok: true,
      value: { displayServer: 'headless', available: false, reason: 'display_session_unavailable' },
    });
    expect(atSpi.status).not.toHaveBeenCalled();
  });
});
