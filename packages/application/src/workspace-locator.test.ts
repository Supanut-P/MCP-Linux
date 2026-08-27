import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Workspace, WorkspaceRepository } from '@baitonghub-linux-mcp/workspace';
import { resolveSharedWorkspace, resolveWorkspaceForPath } from './workspace-locator.js';

function repository(workspaces: readonly Workspace[]): WorkspaceRepository {
  return {
    async list(): Promise<Workspace[]> { return [...workspaces]; },
    async get(id: string): Promise<Workspace | null> { return workspaces.find((entry) => entry.id === id) ?? null; },
    async insert(): Promise<void> {},
    async delete(): Promise<void> {},
  };
}

describe('resolveWorkspaceForPath', () => {
  const drive: Workspace = {
    id: 'drive-c',
    displayName: 'C',
    rootPath: path.resolve('fixture-drive-c'),
    realRootPath: path.resolve('fixture-drive-c'),
    createdAt: new Date(0).toISOString(),
  };
  const nested: Workspace = {
    id: 'project',
    displayName: 'Project',
    rootPath: path.resolve('fixture-drive-c', 'Users', 'me', 'proj'),
    realRootPath: path.resolve('fixture-drive-c', 'Users', 'me', 'proj'),
    createdAt: new Date(0).toISOString(),
  };

  it('requires workspaceId for relative paths', async () => {
    const result = await resolveWorkspaceForPath(repository([drive]), undefined, path.join('src', 'file.ts'));
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('picks the longest matching workspace for an absolute path', async () => {
    const result = await resolveWorkspaceForPath(
      repository([drive, nested]),
      undefined,
      path.join(nested.realRootPath, 'docs', 'plan.md'),
    );
    expect(result).toMatchObject({ ok: true, value: { id: 'project' } });
  });

  it('rejects an absolute path outside the given workspaceId', async () => {
    const result = await resolveWorkspaceForPath(
      repository([drive, nested]),
      nested.id,
      path.join(drive.realRootPath, 'Windows', 'notepad.exe'),
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
  });

  it('requires source and destination to share one workspace', async () => {
    const other: Workspace = {
      id: 'drive-d',
      displayName: 'D',
      rootPath: path.resolve('fixture-drive-d'),
      realRootPath: path.resolve('fixture-drive-d'),
      createdAt: new Date(0).toISOString(),
    };
    const result = await resolveSharedWorkspace(
      repository([drive, other]),
      undefined,
      path.join(drive.realRootPath, 'a.txt'),
      path.join(other.realRootPath, 'a.txt'),
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
  });
});
