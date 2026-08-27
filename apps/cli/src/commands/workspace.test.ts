import { ok } from '@baitonghub-linux-mcp/domain';
import { describe, expect, it } from 'vitest';
import { runWorkspaceAdd, runWorkspaceList } from './workspace.js';

const workspace = {
  id: 'workspace-1',
  displayName: 'demo',
  rootPath: '/srv/project/demo',
  realRootPath: '/srv/project/demo',
  createdAt: '2026-08-10T00:00:00.000Z',
};

describe('workspace CLI commands', () => {
  it('derives a display name from a Linux path for workspace add', async () => {
    let receivedName = '';
    const result = await runWorkspaceAdd({
      add: async (displayName, rootPath) => {
        receivedName = `${displayName}|${rootPath}`;
        return ok(workspace);
      },
    }, '/srv/project/demo/');

    expect(result.ok).toBe(true);
    expect(receivedName).toBe('demo|/srv/project/demo/');
  });

  it('lists configured workspaces through the injected service', async () => {
    await expect(runWorkspaceList({ list: async () => [workspace] })).resolves.toEqual([workspace]);
  });
});
