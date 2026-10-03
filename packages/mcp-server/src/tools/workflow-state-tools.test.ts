import { appError, err } from '@baitonghub-linux-mcp/domain';
import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../tool-registry.js';

describe('durable workflow MCP surface', () => {
  it('is additive, optional and rejects forged authority before dispatch', async () => {
    const execute = vi.fn(async () => err(appError('INVALID_INPUT', 'fixture')));
    const actor = { clientId: 'trusted', clientName: 'trusted' };
    expect(new ToolRegistry({}, actor).list().some((tool) => tool.name === 'workflow')).toBe(false);
    const registry = new ToolRegistry({ workflowState: { execute } }, actor, { serverProfileProvider: (): 'core' => 'core' });
    expect(registry.list().find((tool) => tool.name === 'workflow')).toMatchObject({ permission: 'READ', annotations: { readOnlyHint: false, destructiveHint: false } });
    expect((await registry.invoke('workflow', { operation: 'resume', workspaceId: 'ws', workflowId: 'wf', ownerKey: 'trusted' })).isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    await registry.invoke('workflow', { operation: 'resume', workspaceId: 'ws', workflowId: 'wf' });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
