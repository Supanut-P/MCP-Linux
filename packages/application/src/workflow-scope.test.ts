import { mkdtemp, mkdir, writeFile, symlink, link, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import type { Workspace } from '@baitonghub-linux-mcp/workspace';
import { captureWorkflowScope, compareWorkflowSnapshots, type WorkflowSourceSnapshot } from './workflow-scope.js';

const roots: string[] = [];
async function fixture(): Promise<{ root: string; workspace: Workspace }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wf-scope-')); roots.push(root);
  const now = new Date().toISOString();
  return { root, workspace: { id: 'fixture', displayName: 'fixture', rootPath: root, realRootPath: root, createdAt: now } };
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('workflow source scope', () => {
  it.skipIf(process.platform !== 'linux')('rejects scoped FIFOs promptly without waiting for a writer', async () => {
    const {root, workspace} = await fixture();
    execFileSync('mkfifo', [path.join(root, 'source.fifo')]);
    expect(await captureWorkflowScope(workspace, ['source.fifo'], 'disjoint')).toMatchObject({ok: false, error: {code: 'INVALID_INPUT'}});
  }, 1000);

  it('detects identical-content case-only renames outside the allowed scope', () => {
    const old: WorkflowSourceSnapshot = { fingerprint: 'a', gitIdentity: null, files: [{path: 'other.ts', sha256: 'f'.repeat(64), bytes: 1}] };
    const next: WorkflowSourceSnapshot = { fingerprint: 'b', gitIdentity: null, files: [{path: 'Other.ts', sha256: 'f'.repeat(64), bytes: 1}] };
    expect(compareWorkflowSnapshots(old, next, ['allowed.ts'])).toMatchObject({ok: false});
    expect(compareWorkflowSnapshots(old, next, ['other.ts'])).toMatchObject({ok: true, value: {changedFiles: ['Other.ts', 'other.ts']}});
  });

  it('uses real Git inventory and excludes ignored output under allowed directories', async () => {
    const {root, workspace} = await fixture();
    const git = (args: string[]): void => { execFileSync('git', args, {cwd: root, windowsHide: true, stdio: 'pipe'}); };
    git(['init']); await mkdir(path.join(root, 'src')); await writeFile(path.join(root, '.gitignore'), 'src/build/\n');
    await writeFile(path.join(root, 'src/file.ts'), 'source'); git(['add', '.']);
    git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid.test', '-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), 'commit', '-m', 'isolated fixture']);
    await mkdir(path.join(root, 'src/build')); await writeFile(path.join(root, 'src/build/output'), Buffer.alloc(2 * 1024 * 1024 + 1));
    const captured = await captureWorkflowScope(workspace, ['src'], 'disjoint');
    expect(captured.ok).toBe(true); if (!captured.ok) return;
    expect(captured.value.snapshot.files.map((file) => file.path)).toEqual(['.gitignore', 'src/file.ts']);
    await writeFile(path.join(root, 'src/file.ts'), 'dirty change');
    const current = await captureWorkflowScope(workspace, ['src/./file.ts'], 'disjoint');
    expect(current.ok).toBe(true); if (!current.ok) return;
    expect(compareWorkflowSnapshots(captured.value.snapshot, current.value.snapshot, ['src/./file.ts'])).toMatchObject({ok: true});
  });
  it('captures multiple disjoint files, preserves dirty contents, and reports deletion/binary deltas', async () => {
    const { root, workspace } = await fixture();
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src/a.ts'), 'dirty baseline');
    await writeFile(path.join(root, 'src/b.bin'), Buffer.from([0, 255, 4]));
    const baseline = await captureWorkflowScope(workspace, ['src/a.ts', 'src/b.bin'], 'disjoint');
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;
    await writeFile(path.join(root, 'src/a.ts'), 'changed');
    await rm(path.join(root, 'src/b.bin'));
    const current = await captureWorkflowScope(workspace, ['src/a.ts', 'src/b.bin'], 'disjoint');
    expect(current.ok).toBe(true);
    if (!current.ok) return;
    expect(compareWorkflowSnapshots(baseline.value.snapshot, current.value.snapshot, ['src/a.ts', 'src/b.bin'])).toMatchObject({ ok: true, value: { changedFiles: ['src/a.ts', 'src/b.bin'] } });
    expect(compareWorkflowSnapshots(baseline.value.snapshot, current.value.snapshot, ['src/a.ts'])).toMatchObject({ ok: false });
  });

  it('folds path case and resolves symlink aliases for reserved scopes', async () => {
    const { root, workspace } = await fixture();
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src/file.ts'), 'x');
    await symlink(path.join(root, 'src'), path.join(root, 'alias'), 'junction');
    expect((await captureWorkflowScope(workspace, ['src/file.ts', 'SRC/FILE.ts'], 'disjoint')).ok).toBe(false);
    expect((await captureWorkflowScope(workspace, ['src/file.ts', 'alias/file.ts'], 'disjoint')).ok).toBe(false);
  });

  it('rejects hardlinks and out of root paths, permits missing leaves and empty fixtures', async () => {
    const { root, workspace } = await fixture();
    await writeFile(path.join(root, 'one.txt'), 'data');
    expect((await captureWorkflowScope(workspace, ['missing/new.txt'], 'disjoint')).ok).toBe(true);
    const empty = await captureWorkflowScope(workspace, [], 'workspace');
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.value.scopes).toHaveLength(1);
    try { await link(path.join(root, 'one.txt'), path.join(root, 'two.txt')); } catch { /* Platform may disallow hardlinks. */ }
    if (await import('node:fs/promises').then(async (fs) => (await fs.lstat(path.join(root, 'one.txt'))).nlink > 1)) {
      expect((await captureWorkflowScope(workspace, ['one.txt'], 'disjoint')).ok).toBe(false);
    }
    expect((await captureWorkflowScope(workspace, ['../outside.txt'], 'disjoint')).ok).toBe(false);
  });

  it('bounds aborts and rejects git identity drift', async () => {
    const { root, workspace } = await fixture();
    const controller = new AbortController(); controller.abort();
    expect(await captureWorkflowScope(workspace, [], 'workspace', controller.signal)).toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    const old: WorkflowSourceSnapshot = { fingerprint: 'a', gitIdentity: 'head-index-1', files: [] };
    const next: WorkflowSourceSnapshot = { fingerprint: 'b', gitIdentity: 'head-index-2', files: [] };
    expect(compareWorkflowSnapshots(old, next, [])).toMatchObject({ ok: false });
    await writeFile(path.join(root, 'large'), Buffer.alloc(2 * 1024 * 1024 + 1));
    expect((await captureWorkflowScope(workspace, [], 'workspace')).ok).toBe(false);
  });
});
