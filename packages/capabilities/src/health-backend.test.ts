import { describe, expect, it } from 'vitest';
import { ok, type Result } from '@baitonghub-linux-mcp/domain';
import { HealthCapabilityBackend } from './health-backend.js';

describe('HealthCapabilityBackend', () => {
  it('reports Linux capabilities without executing input actions', async () => {
    const backend = new HealthCapabilityBackend({
      platform: 'linux',
      domCdp: { execute: async (): Promise<Result<unknown>> => ok({ ready: true, port: 9222 }) },
      accessibility: { execute: async (): Promise<Result<unknown>> => ok({ available: true }) },
    });

    const result = await backend.execute({ operation: 'check_all' });

    expect(result).toMatchObject({ ok: true, value: { capabilities: {
      shell: { available: true },
      dom_cdp: { available: true, ready: true },
      accessibility: { available: true },
      input_event: { available: false },
      vision: { available: false },
      window: { available: false },
      health: { available: true },
    } } });
  });

  it('checks one named capability when requested', async () => {
    const backend = new HealthCapabilityBackend({ platform: 'linux' });

    await expect(backend.execute({ operation: 'check_tool', tool: 'input_event' })).resolves.toMatchObject({ ok: true, value: { tool: 'input_event', available: false } });
  });

  it('reports Linux provider metadata from a configured native backend', async () => {
    const backend = new HealthCapabilityBackend({
      platform: 'linux',
      environment: { WAYLAND_DISPLAY: 'wayland-0' },
      backends: {
        clipboard: { execute: async (): Promise<Result<unknown>> => ok({
          provider: 'wl-clipboard', available: false, ready: false,
          requiresConsent: false, missingDependencies: ['wl-copy'], reason: 'missing_dependencies',
        }) },
      },
    });

    await expect(backend.execute({ operation: 'check_tool', tool: 'clipboard' })).resolves.toMatchObject({
      ok: true,
      value: {
        platform: 'linux', displayServer: 'wayland', provider: 'wl-clipboard',
        available: false, ready: false, requiresConsent: false,
        missingDependencies: ['wl-copy'], reason: 'missing_dependencies',
      },
    });
  });
});
