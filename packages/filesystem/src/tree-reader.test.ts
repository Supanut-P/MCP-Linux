import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TreeReader } from './tree-reader.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('TreeReader', () => {
  it('sorts entries without hiding generated, hidden, dependency, or environment paths', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-tree-'));
    temporaryRoots.push(root);
    await mkdir(path.join(root, 'src'));
    await mkdir(path.join(root, '.git'));
    await mkdir(path.join(root, 'dist'));
    await mkdir(path.join(root, 'node_modules'));
    await writeFile(path.join(root, '.env'), 'TOKEN=visible', 'utf8');
    await writeFile(path.join(root, 'z.txt'), 'z', 'utf8');
    await writeFile(path.join(root, 'a.txt'), 'a', 'utf8');
    await writeFile(path.join(root, '.git', 'config'), 'config', 'utf8');
    await writeFile(path.join(root, 'dist', 'app.js'), 'build', 'utf8');
    await writeFile(path.join(root, 'node_modules', 'hidden.txt'), 'hidden', 'utf8');

    const result = await new TreeReader().read(root, { maxDepth: 3, maxEntries: 20 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entries.map((entry) => entry.path.replace(/\\/g, '/'))).toEqual(expect.arrayContaining([
      '.env', '.git', '.git/config', 'a.txt', 'dist', 'dist/app.js', 'node_modules', 'node_modules/hidden.txt', 'src', 'z.txt',
    ]));
    expect(result.value.truncated).toBe(false);
  });

  it('marks the result when the entry cap is reached', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-tree-'));
    temporaryRoots.push(root);
    await writeFile(path.join(root, 'a.txt'), 'a', 'utf8');
    await writeFile(path.join(root, 'b.txt'), 'b', 'utf8');
    await writeFile(path.join(root, 'c.txt'), 'c', 'utf8');

    const result = await new TreeReader().read(root, { maxDepth: 1, maxEntries: 2 });

    expect(result).toEqual({
      ok: true,
      value: {
        entries: [{ path: 'a.txt', type: 'file' }, { path: 'b.txt', type: 'file' }],
        truncated: true,
      },
    });
  });
});
