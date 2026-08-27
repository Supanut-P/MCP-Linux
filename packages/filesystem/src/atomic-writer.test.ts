import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AtomicFileWriter } from './atomic-writer.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('AtomicFileWriter', () => {
  it('writes through a temporary file in the target directory and replaces the target', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-write-'));
    temporaryRoots.push(root);
    const target = path.join(root, 'file.txt');
    const result = await new AtomicFileWriter().write(target, 'new content\n');

    expect(result).toEqual({ ok: true, value: undefined });
    await expect(readFile(target, 'utf8')).resolves.toBe('new content\n');
  });

  it('creates missing nested parent directories before writing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-write-'));
    temporaryRoots.push(root);
    const target = path.join(root, 'docs', 'superpowers', 'plans', 'plan.md');
    const result = await new AtomicFileWriter().write(target, 'nested\n');

    expect(result).toEqual({ ok: true, value: undefined });
    await expect(readFile(target, 'utf8')).resolves.toBe('nested\n');
  });
});
