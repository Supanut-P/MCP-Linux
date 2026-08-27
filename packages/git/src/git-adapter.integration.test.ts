import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { GitAdapter } from './git-adapter.js';
import { DirectGitRunner } from './git-runner.js';

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function hasGit(): Promise<boolean> {
  try {
    await execFileAsync('git', ['--version'], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

describe('GitAdapter integration', () => {
  let gitAvailable = false;
  beforeAll(async () => {
    gitAvailable = await hasGit();
  });

  it('inspects a temporary repository with spaces and Unicode paths', async () => {
    if (!gitAvailable) return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-git-'));
    temporaryRoots.push(root);
    const filename = 'space file Ω.txt';
    await writeFile(path.join(root, filename), 'initial\n', 'utf8');
    await execFileAsync('git', ['init'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['config', 'user.name', 'baitonghub-linux-mcp test'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['add', '--', filename], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root, windowsHide: true });
    await writeFile(path.join(root, filename), 'changed\n', 'utf8');
    await writeFile(path.join(root, 'untracked file.txt'), 'new\n', 'utf8');

    const adapter = new GitAdapter(new DirectGitRunner());
    const status = await adapter.status(root);
    const diff = await adapter.diff(root, { path: filename });
    const log = await adapter.log(root, { maxCommits: 20 });

    expect(status).toMatchObject({ ok: true, value: { entries: [
      { path: filename, kind: 'modified' },
      { path: 'untracked file.txt', kind: 'untracked' },
    ] } });
    expect(diff).toMatchObject({ ok: true, value: { patch: expect.stringContaining('changed'), truncated: false } });
    expect(log).toMatchObject({ ok: true, value: { entries: [{ subject: 'initial' }], truncated: false } });
  });
});
