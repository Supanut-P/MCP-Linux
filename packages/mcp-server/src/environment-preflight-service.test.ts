import { describe, expect, it } from 'vitest';
import { ok, type Result } from '@baitonghub-linux-mcp/domain';
import { EnvironmentPreflightService } from './environment-preflight-service.js';

describe('EnvironmentPreflightService', () => {
  it('projects a truthful bounded readiness matrix without raw host details', async () => {
    const service = new EnvironmentPreflightService({ nodeVersion: 'v24.14.0', capabilities: {
      execute: async (): Promise<Result<unknown>> => ok({ capabilities: {
        health: { platform: 'linux', displayServer: 'headless', available: true, ready: true },
        shell: { platform: 'linux', displayServer: 'headless', available: true, ready: true },
        journal: { platform: 'linux', displayServer: 'headless', available: false, ready: false, missingDependencies: ['journalctl'], reason: '/private/path' },
        vision: { platform: 'linux', displayServer: 'wayland', available: true, ready: false, requiresConsent: true, missingDependencies: [] },
        secret: 'do-not-return',
      } }),
    } });
    const result = await service.execute();
    expect(result).toMatchObject({ ok: true, value: {
      operation: 'environment_preflight', status: 'degraded', platform: 'linux', displayServer: 'headless',
      runtime: { nodeVersion: 'v24.14.0', nodeMajor: 24 },
      capabilities: { total: 4, available: 3, ready: 2, consentRequired: 1, notReady: ['journal', 'vision'], missingDependencies: ['journalctl'] },
    } });
    expect(JSON.stringify(result)).not.toContain('/private/path');
    expect(JSON.stringify(result)).not.toContain('do-not-return');
  });

  it('maps missing providers and provider errors to sanitized unavailable results', async () => {
    await expect(new EnvironmentPreflightService().execute()).resolves.toMatchObject({ ok: false, error: { code: 'CAPABILITY_UNAVAILABLE' } });
    const service = new EnvironmentPreflightService({ capabilities: { execute: async (): Promise<Result<unknown>> => ({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'private', recoverable: false } }) } });
    const result = await service.execute();
    expect(result).toMatchObject({ ok: false, error: { code: 'CAPABILITY_UNAVAILABLE', message: 'Environment preflight provider is unavailable' } });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('does not dispatch after cancellation', async () => {
    let calls = 0;
    const service = new EnvironmentPreflightService({ capabilities: { execute: async (): Promise<Result<unknown>> => { calls += 1; return ok({ capabilities: {} }); } } });
    const controller = new AbortController();
    controller.abort();
    await expect(service.execute(controller.signal)).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    expect(calls).toBe(0);
  });
});
