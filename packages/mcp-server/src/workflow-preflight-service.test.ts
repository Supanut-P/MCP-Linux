import { describe, expect, it } from 'vitest';
import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import { WorkflowPreflightService } from './workflow-preflight-service.js';

const actor = { clientId: 'workflow-preflight-test', clientName: 'workflow-preflight-test', sessionId: 'session-1' };

describe('WorkflowPreflightService', () => {
  it('returns sanitized environment, diagnostics, and optional workspace usage', async () => {
    const service = new WorkflowPreflightService({
      environmentPreflight: { execute: async (): Promise<Result<unknown>> => ok({ operation: 'environment_preflight', status: 'ready', platform: 'linux', displayServer: 'headless', runtime: { nodeVersion: 'v24.14.0', nodeMajor: 24 }, capabilities: { total: 1, available: 1, ready: 1, consentRequired: 0, notReady: [], missingDependencies: [] } }) },
      diagnosticsSnapshot: { execute: async (): Promise<Result<unknown>> => ok({ snapshotAt: '2026-01-01T00:00:00.000Z', status: 'ready', health: { available: true, ready: true, unavailableCount: 0, consentRequiredCount: 0, missingDependencies: [] }, runtime: { available: true, ready: true }, audit: { available: true, ready: true, count: 0, truncated: false }, dependencies: { ready: true, missingDependencies: [] } }) },
      workspaceSnapshot: { execute: async (_actor, input): Promise<Result<unknown>> => ok({ operation: 'usage', workspaceId: input.workspaceId, path: input.path ?? '.', fileCount: 2, totalBytes: 6, scannedEntries: 3, truncated: false }) },
    });

    await expect(service.execute(actor, { workspaceId: 'workspace-1', path: 'src' })).resolves.toMatchObject({
      ok: true,
      value: { operation: 'workflow_preflight', status: 'ready', workspace: { fileCount: 2, totalBytes: 6, truncated: false } },
    });
  });

  it('keeps provider failures truthful and never throws', async () => {
    const service = new WorkflowPreflightService({
      environmentPreflight: { execute: async (): Promise<Result<unknown>> => err(appError('CAPABILITY_UNAVAILABLE', 'private', true)) },
      diagnosticsSnapshot: { execute: async (): Promise<never> => { throw new Error('private'); } },
    });

    const result = await service.execute(actor, {});
    expect(result).toMatchObject({ ok: true, value: { status: 'unavailable' } });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('rejects a path without a workspace and preserves cancellation', async () => {
    const service = new WorkflowPreflightService({});
    await expect(service.execute(actor, { path: 'src' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    const controller = new AbortController();
    controller.abort();
    await expect(service.execute(actor, {}, controller.signal)).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
  });
});
