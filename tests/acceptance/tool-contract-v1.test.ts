import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Result } from '@baitonghub-linux-mcp/domain';
import { ToolRegistry, canonicalizeToolSchemas } from '@baitonghub-linux-mcp/mcp-server';

describe('v1 stable MCP contract', () => {
  it('matches the reviewed canonical tools/list fixture', async () => {
    const fixture = JSON.parse(await readFile(path.resolve(import.meta.dirname, '..', 'fixtures', 'tool-contract-v1.json'), 'utf8')) as { tools: unknown };
    const registry = new ToolRegistry({
      targetCatalog: {
        list: async (): Promise<Result<unknown>> => ({ ok: true, value: [] }),
        describe: async (): Promise<Result<unknown>> => ({ ok: false, error: { code: 'INVALID_INPUT', message: 'Not available in contract test', recoverable: false } }),
      },
      remoteRollout: { execute: async (): Promise<Result<unknown>> => ({ ok: true, value: {} }) },
      remoteRolloutResume: { resume: async (): Promise<Result<unknown>> => ({ ok: true, value: {} }) },
      supportBundle: { execute: async (): Promise<Result<unknown>> => ({ ok: true, value: {} }) },
      auditQuery: { execute: async (): Promise<Result<unknown>> => ({ ok: true, value: { entries: [], count: 0, truncated: false } }) },
      taskEvents: { execute: async (): Promise<Result<unknown>> => ({ ok: true, value: { taskId: 'contract-task', state: 'completed', events: [], count: 0, truncated: false } }) },
      taskHistory: { execute: async (): Promise<Result<unknown>> => ({ ok: true, value: { entries: [], count: 0, truncated: false } }) },
      diagnosticsSnapshot: { execute: async (): Promise<Result<unknown>> => ({ ok: true, value: { snapshotAt: new Date(0).toISOString(), status: 'ready', health: { available: true, ready: true, unavailableCount: 0, consentRequiredCount: 0, missingDependencies: [] }, runtime: { available: true, ready: true }, audit: { available: true, ready: true, count: 0, truncated: false }, dependencies: { ready: true, missingDependencies: [] } } }) },
      remoteFleetDiff: { execute: async (): Promise<Result<unknown>> => ({ ok: true, value: { operation: 'remote_fleet_diff', hosts: [], summary: { requested: 0, changed: 0, unchanged: 0, unavailable: 0, maxParallel: 4 } } }) },
      releaseVerify: { execute: async (): Promise<Result<unknown>> => ({ ok: true, value: { operation: 'release_verify', verified: true, artifacts: [], reasonCodes: [] } }) },
    }, { clientId: 'contract-test', clientName: 'contract-test' }, { codexToolsEnabled: true });
    expect({ contractVersion: '1.0.0', descriptions: 'non-contractual', tools: canonicalizeToolSchemas(registry.list()) }).toEqual(fixture);
  });
});
