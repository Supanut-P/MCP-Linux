import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureParentDirectory } from './ensure-parent.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ensureParentDirectory', () => {
  it('creates missing nested parents', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-parent-'));
    temporaryRoots.push(root);
    const target = path.join(root, 'docs', 'superpowers', 'plans', 'plan.md');

    const result = await ensureParentDirectory(target);

    expect(result).toEqual({ ok: true, value: undefined });
    await writeFile(target, 'ok', 'utf8');
    await expect(readFile(target, 'utf8')).resolves.toBe('ok');
  });

  it('returns INVALID_INPUT when a parent exists as a file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-parent-'));
    temporaryRoots.push(root);
    const blocker = path.join(root, 'docs');
    await writeFile(blocker, 'not a directory', 'utf8');

    const result = await ensureParentDirectory(path.join(blocker, 'plan.md'));

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });
});
