import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Workspace, WorkspaceRepository } from '@baitonghub-linux-mcp/workspace';
import { JsonWorkspaceIndexStore, WorkspaceIndexService } from './workspace-index.js';

function fixtureRepository(workspace: Workspace): WorkspaceRepository {
  return {
    async list(): Promise<Workspace[]> { return [workspace]; },
    async get(id: string): Promise<Workspace | null> { return id === workspace.id ? workspace : null; },
    async insert(): Promise<void> { return undefined; },
    async delete(): Promise<void> { return undefined; },
  };
}

describe('WorkspaceIndexService', () => {
  it('indexes source and metadata paths by default while allowing an explicit ignored subtree', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-index-'));
    await mkdir(path.join(root, '.git'), { recursive: true });
    await mkdir(path.join(root, 'dist'), { recursive: true });
    await mkdir(path.join(root, 'node_modules', 'fixture'), { recursive: true });
    await writeFile(path.join(root, '.env'), 'TOKEN=fixture\n');
    await writeFile(path.join(root, '.git', 'config'), '[core]\n');
    await writeFile(path.join(root, 'dist', 'app.js'), 'export const built = true;\n');
    await writeFile(path.join(root, 'node_modules', 'fixture', 'index.js'), 'module.exports = 1;\n');
    await writeFile(path.join(root, 'src.ts'), 'export function answer(): number { return 42; }\n');
    const workspace: Workspace = {
      id: 'workspace-1', displayName: 'fixture', rootPath: root, realRootPath: root, createdAt: new Date().toISOString(),
    };
    const store = new JsonWorkspaceIndexStore(path.join(root, 'index-store'));
    const service = new WorkspaceIndexService(fixtureRepository(workspace), store);

    const result = await service.indexWorkspace(workspace.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = result.value.entries.map((entry) => entry.relativePath);
    expect(paths).toEqual(expect.arrayContaining(['.env', 'src.ts']));
    expect(paths).not.toEqual(expect.arrayContaining(['.git', '.git/config', 'dist', 'dist/app.js', 'node_modules', 'node_modules/fixture/index.js']));
    expect(result.value.entries.find((entry) => entry.relativePath === 'src.ts')?.functions).toContain('answer');
    expect((await service.snapshot(workspace.id)).ok).toBe(true);

    await writeFile(path.join(root, 'src.ts'), 'export function updated(): string { return "ok"; }\n');
    const update = await service.indexPath(workspace.id, 'src.ts');
    expect(update.ok).toBe(true);
    if (!update.ok) return;
    expect(update.value.entries.find((entry) => entry.relativePath === 'src.ts')?.functions).toContain('updated');
    expect(update.value.entries.find((entry) => entry.relativePath === 'src.ts')?.functions).not.toContain('answer');

    const explicit = await service.indexPath(workspace.id, 'node_modules', { discovery: 'explicit' });
    expect(explicit.ok).toBe(true);
    if (!explicit.ok) return;
    expect(explicit.value.entries.map((entry) => entry.relativePath)).toEqual(expect.arrayContaining(['node_modules', 'node_modules/fixture/index.js']));
  });

  it('captures bounded relative change events while a watcher is active', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-watch-'));
    const workspace: Workspace = { id: 'workspace-watch', displayName: 'watch', rootPath: root, realRootPath: root, createdAt: new Date().toISOString() };
    const service = new WorkspaceIndexService(fixtureRepository(workspace), new JsonWorkspaceIndexStore(path.join(root, 'index-store')));
    try {
      const started = await service.startWatch(workspace.id, { debounceMs: 5, concurrency: 1 });
      expect(started.ok).toBe(true);
      await writeFile(path.join(root, 'observed.txt'), 'hello\n');
      let changes = await service.changes(workspace.id, 0, 20);
      for (let attempt = 0; attempt < 20 && changes.ok && changes.value.events.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        changes = await service.changes(workspace.id, 0, 20);
      }
      expect(changes.ok).toBe(true);
      if (changes.ok) {
        expect(changes.value.events.some((event) => event.relativePath === 'observed.txt')).toBe(true);
        expect(changes.value.events.every((event) => !path.isAbsolute(event.relativePath) && !('content' in event))).toBe(true);
      }
      await expect(service.stopWatch(workspace.id)).resolves.toMatchObject({ ok: true });
      await expect(service.changes(workspace.id)).resolves.toMatchObject({ ok: false, error: { code: 'WATCHER_NOT_RUNNING' } });
    } finally {
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not follow a symlinked directory while incrementally indexing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-link-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-outside-'));
    const workspace: Workspace = { id: 'workspace-link', displayName: 'link', rootPath: root, realRootPath: root, createdAt: new Date().toISOString() };
    const service = new WorkspaceIndexService(fixtureRepository(workspace), new JsonWorkspaceIndexStore(path.join(root, 'index-store')));
    try {
      await writeFile(path.join(outside, 'secret.txt'), 'outside-secret\n');
      try { await symlink(outside, path.join(root, 'linked')); } catch { return; }
      const result = await service.indexPath(workspace.id, 'linked');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.entries.find((entry) => entry.relativePath === 'linked')?.kind).toBe('symlink');
        expect(result.value.entries.some((entry) => entry.relativePath.includes('secret.txt'))).toBe(false);
      }
    } finally {
      await service.close();
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
