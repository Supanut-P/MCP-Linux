import { appError, ok } from '@baitonghub-linux-mcp/domain';
import type { McpServerOptions } from '@baitonghub-linux-mcp/mcp-server';
import { describe, expect, it } from 'vitest';
import { runMcpHttpCommand, type McpHttpServerHandle, type McpHttpServerStarter } from './mcp-http.js';

const workspace = {
  id: 'workspace-http-1',
  displayName: 'fixture',
  rootPath: '/srv/fixture',
  realRootPath: '/srv/fixture',
  createdAt: '2026-08-10T00:00:00.000Z',
};

describe('mcp http command', () => {
  it('resolves the configured workspace before starting the HTTP server', async () => {
    let startedWith: McpServerOptions | undefined;
    const starter: McpHttpServerStarter = {
      async start(options): Promise<McpHttpServerHandle> {
        startedWith = options;
        return { address: { host: '127.0.0.1', port: 4000 }, endpoint: new URL('http://127.0.0.1:4000/mcp'), close: async (): Promise<void> => {} };
      },
    };

    const result = await runMcpHttpCommand({
      workspaceReference: 'workspace-http-1',
      resolver: { resolve: async () => ok(workspace) },
      createServerOptions: (selectedWorkspace) => ({
        port: 0,
        services: {},
        actor: { clientId: selectedWorkspace.id, clientName: 'baitonghub-linux-mcp-cli' },
      }),
      starter,
    });

    expect(result.ok).toBe(true);
    expect(startedWith?.actor.clientId).toBe('workspace-http-1');
  });

  it('does not start when the workspace reference is invalid', async () => {
    let starts = 0;
    const result = await runMcpHttpCommand({
      workspaceReference: ' ',
      resolver: { resolve: async () => ok(workspace) },
      createServerOptions: () => ({ port: 0, services: {}, actor: { clientId: 'unused', clientName: 'unused' } }),
      starter: { start: async (): Promise<McpHttpServerHandle> => { starts += 1; return { address: { host: '127.0.0.1', port: 4000 }, endpoint: new URL('http://127.0.0.1:4000/mcp'), close: async (): Promise<void> => {} }; } },
    });

    expect(result).toEqual({ ok: false, error: appError('INVALID_INPUT', 'A workspace reference is required') });
    expect(starts).toBe(0);
  });
});
