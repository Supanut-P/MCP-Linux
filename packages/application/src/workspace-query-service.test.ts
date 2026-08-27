import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceQueryService } from './workspace-query-service.js';
import type { WorkspaceRepository, Workspace } from '@baitonghub-linux-mcp/workspace';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('WorkspaceQueryService', () => {
  it('returns a bounded tree for a registered workspace', async () => {
    const rawRoot = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-query-'));
    temporaryRoots.push(rawRoot);
    const root = await realpath(rawRoot);
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src', 'index.ts'), 'export {};', 'utf8');
    const workspace: Workspace = { id: 'workspace-1', displayName: 'Fixture', rootPath: root, realRootPath: root, createdAt: new Date(0).toISOString() };
    const repository: WorkspaceRepository = {
      async list(): Promise<Workspace[]> { return [workspace]; },
      async get(id: string): Promise<Workspace | null> { return id === workspace.id ? workspace : null; },
      async insert(): Promise<void> {},
      async delete(): Promise<void> {},
    };

    const result = await new WorkspaceQueryService(repository).tree(
      { clientId: 'test', clientName: 'test' },
      workspace.id,
      { path: '.', maxDepth: 4, maxEntries: 20 },
    );

    expect(result).toMatchObject({ ok: true, value: { truncated: false } });
    if (result.ok) expect(result.value.entries.map((entry) => entry.path)).toEqual(['src', path.join('src', 'index.ts')]);
  });
});
