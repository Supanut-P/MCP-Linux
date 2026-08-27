import { appError, ok } from '@baitonghub-linux-mcp/domain';
import type { McpServerOptions } from '@baitonghub-linux-mcp/mcp-server';
import { describe, expect, it } from 'vitest';
import { runMcpStdioCommand, type McpStdioServerHandle, type McpStdioServerStarter } from './mcp-stdio.js';

const workspace = {
  id: 'workspace-1',
  displayName: 'fixture',
  rootPath: '/srv/fixture',
  realRootPath: '/srv/fixture',
  createdAt: '2026-08-10T00:00:00.000Z',
};

describe('mcp stdio command', () => {
  it('resolves the configured workspace before starting the server', async () => {
    let startedWith: McpServerOptions | undefined;
    const starter: McpStdioServerStarter = {
      start(options): McpStdioServerHandle {
        startedWith = options;
        return { close: async (): Promise<void> => {} };
      },
    };

    const result = await runMcpStdioCommand({
      workspaceReference: 'workspace-1',
      resolver: { resolve: async () => ok(workspace) },
      createServerOptions: (selectedWorkspace) => ({
        services: {},
        actor: { clientId: selectedWorkspace.id, clientName: 'baitonghub-linux-mcp-cli' },
      }),
      starter,
    });

    expect(result.ok).toBe(true);
    expect(startedWith?.actor.clientId).toBe('workspace-1');
  });

  it('does not start when the workspace reference is invalid', async () => {
    let starts = 0;
    const result = await runMcpStdioCommand({
      workspaceReference: ' ',
      resolver: { resolve: async () => ok(workspace) },
      createServerOptions: () => ({ services: {}, actor: { clientId: 'unused', clientName: 'unused' } }),
      starter: { start: (): McpStdioServerHandle => { starts += 1; return { close: async (): Promise<void> => {} }; } },
    });

    expect(result).toEqual({ ok: false, error: appError('INVALID_INPUT', 'A workspace reference is required') });
    expect(starts).toBe(0);
  });
});
