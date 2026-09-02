import { describe, expect, it } from 'vitest';
import { ok, err, type Result } from '@baitonghub-linux-mcp/domain';
import { DiagnosticsSnapshotService } from './diagnostics-snapshot-service.js';

const actor = { clientId: 'diagnostics-test', clientName: 'diagnostics-test', sessionId: 'session-1' };

describe('DiagnosticsSnapshotService', () => {
  it('combines redacted health, runtime pressure, audit, and dependency readiness', async () => {
    const service = new DiagnosticsSnapshotService({
      capabilities: { execute: async (): Promise<Result<unknown>> => ok({ capabilities: {
        shell: { available: true, ready: true },
        portal: { available: false, ready: false, requiresConsent: true, missingDependencies: ['xdg-desktop-portal'] },
      } }) },
      runtimeMetrics: { execute: async (): Promise<Result<unknown>> => ok({ host: { load1: 1 }, runtime: { requestTotal: 2 }, tasks: { total: 1 } }) },
      auditQuery: { execute: async (): Promise<Result<unknown>> => ok({ entries: [], count: 1, truncated: true }) },
    });

    await expect(service.execute(actor)).resolves.toMatchObject({
      ok: true,
      value: {
        status: 'degraded',
        health: { available: false, ready: false, unavailableCount: 1, consentRequiredCount: 1, missingDependencies: ['xdg-desktop-portal'] },
        runtime: { available: true, ready: true, snapshot: { host: { load1: 1 }, runtime: { requestTotal: 2 }, tasks: { total: 1 } } },
        audit: { available: true, ready: true, count: 1, truncated: true },
        dependencies: { ready: false, missingDependencies: ['xdg-desktop-portal'] },
      },
    });
  });

  it('fails closed when every provider is absent or fails', async () => {
    await expect(new DiagnosticsSnapshotService({}).execute(actor)).resolves.toMatchObject({ ok: false, error: { code: 'CAPABILITY_UNAVAILABLE' } });
    const service = new DiagnosticsSnapshotService({
      capabilities: { execute: async (): Promise<Result<unknown>> => err({ code: 'CAPABILITY_UNAVAILABLE', message: 'hidden', recoverable: true }) },
    });
    await expect(service.execute(actor)).resolves.toMatchObject({ ok: true, value: { status: 'unavailable' } });
  });

  it('does not expose provider topology or raw errors', async () => {
    const service = new DiagnosticsSnapshotService({
      capabilities: { execute: async (): Promise<Result<unknown>> => ok({ capabilities: { secret_tool: { available: true, ready: true, path: '/home/private', reason: 'token=secret' } } }) },
    });
    const result = await service.execute(actor);
    expect(JSON.stringify(result)).not.toContain('/home/private');
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});
