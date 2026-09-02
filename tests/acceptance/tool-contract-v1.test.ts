import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolRegistry, canonicalizeToolSchemas } from '@baitonghub-linux-mcp/mcp-server';

describe('v1 stable MCP contract', () => {
  it('matches the reviewed canonical tools/list fixture', async () => {
    const fixture = JSON.parse(await readFile(path.resolve(import.meta.dirname, '..', 'fixtures', 'tool-contract-v1.json'), 'utf8')) as { tools: unknown };
    const registry = new ToolRegistry({
      targetCatalog: {
        list: async () => ({ ok: true, value: [] }),
        describe: async () => ({ ok: false, error: { code: 'INVALID_INPUT', message: 'Not available in contract test', recoverable: false } }),
      },
      remoteRollout: { execute: async () => ({ ok: true, value: {} }) },
      remoteRolloutResume: { resume: async () => ({ ok: true, value: {} }) },
      supportBundle: { execute: async () => ({ ok: true, value: {} }) },
      auditQuery: { execute: async () => ({ ok: true, value: { entries: [], count: 0, truncated: false } }) },
      taskEvents: { execute: async () => ({ ok: true, value: { taskId: 'contract-task', state: 'completed', events: [], count: 0, truncated: false } }) },
    }, { clientId: 'contract-test', clientName: 'contract-test' }, { codexToolsEnabled: true });
    expect({ contractVersion: '1.0.0', descriptions: 'non-contractual', tools: canonicalizeToolSchemas(registry.list()) }).toEqual(fixture);
  });
});
