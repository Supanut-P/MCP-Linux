import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceInfoService } from './workspace-info-service.js';
import { WorkspaceService, type Workspace, type WorkspaceRepository } from '@baitonghub-linux-mcp/workspace';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('WorkspaceInfoService.register', () => {
  it('registers a project under a registered Linux workspace root and is idempotent', async () => {
    const parentRoot = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-register-'));
    temporaryRoots.push(parentRoot);
    const projectRoot = path.join(parentRoot, 'project');
    await mkdir(projectRoot);

    const store = new Map<string, Workspace>();
    const repository: WorkspaceRepository = {
      async list(): Promise<Workspace[]> { return [...store.values()]; },
      async get(id: string): Promise<Workspace | null> { return store.get(id) ?? null; },
      async insert(workspace: Workspace): Promise<void> { store.set(workspace.id, workspace); },
      async delete(id: string): Promise<void> { store.delete(id); },
    };
    const workspaceService = new WorkspaceService(repository);
    const parent = await workspaceService.add('Registered root', parentRoot);
    expect(parent.ok).toBe(true);
    if (!parent.ok) return;

    const service = new WorkspaceInfoService(repository, workspaceService);
    const actor = { clientId: 't', clientName: 't' };
    const first = await service.register(actor, { parentWorkspaceId: parent.value.id, path: projectRoot });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.kind).toBe('project');

    const second = await service.register(actor, { parentWorkspaceId: parent.value.id, path: projectRoot });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.id).toBe(first.value.id);

    const outside = await service.register(actor, {
      parentWorkspaceId: parent.value.id,
      path: path.resolve(parentRoot, '..', 'outside-baitonghub-linux-mcp'),
    });
    expect(outside).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('classifies registered Linux roots as projects rather than unrestricted machine roots', async () => {
    const repository: WorkspaceRepository = {
      async list(): Promise<Workspace[]> {
        return [{
          id: 'linux-root',
          displayName: 'Linux project',
          rootPath: '/srv/project',
          realRootPath: '/srv/project',
          createdAt: new Date(0).toISOString(),
        }];
      },
      async get(): Promise<Workspace | null> { return null; },
      async insert(): Promise<void> {},
      async delete(): Promise<void> {},
    };
    const listed = await new WorkspaceInfoService(repository).list({ clientId: 't', clientName: 't' });
    expect(listed).toMatchObject({ ok: true, value: [{ kind: 'project' }] });
  });
});
