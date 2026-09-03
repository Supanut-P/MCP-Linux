import { describe, expect, it } from 'vitest';
import { ok, type Result } from '@baitonghub-linux-mcp/domain';
import { workflowPreflightTools } from './workflow-preflight-tools.js';

const actor = { clientId: 'workflow-tool-test', clientName: 'workflow-tool-test', sessionId: 'session-1' };
const context = {
  actor,
  services: { workflowPreflight: { execute: async (): Promise<Result<unknown>> => ok({ operation: 'workflow_preflight', status: 'ready' }) } },
  contextEconomy: {} as never,
};

describe('workflowPreflightTools', () => {
  it('parses the strict input and dispatches the service', async () => {
    const [tool] = workflowPreflightTools(context);
    expect(tool.parse({ workspaceId: 'workspace-1', path: 'src' })).toMatchObject({ ok: true });
    expect(tool.parse({ path: 'src' })).toMatchObject({ ok: false });
    await expect(tool.execute({}, new AbortController().signal)).resolves.toMatchObject({ ok: true, value: { operation: 'workflow_preflight' } });
  });
});
