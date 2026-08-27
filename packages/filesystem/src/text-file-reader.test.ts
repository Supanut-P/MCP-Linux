import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TextFileReader } from './text-file-reader.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('TextFileReader', () => {
  it('reads UTF-8 text and a bounded line range', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-reader-'));
    temporaryRoots.push(root);
    const filePath = path.join(root, 'notes.txt');
    await writeFile(filePath, 'one\ntwo\nthree\n', 'utf8');
    const reader = new TextFileReader();

    await expect(reader.read(filePath)).resolves.toEqual({ ok: true, value: { content: 'one\ntwo\nthree\n', startLine: 1, endLine: 3 } });
    await expect(reader.read(filePath, { startLine: 2, endLine: 2 })).resolves.toEqual({ ok: true, value: { content: 'two\n', startLine: 2, endLine: 2 } });
  });

  it('rejects binary files and files larger than 2 MiB', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-reader-'));
    temporaryRoots.push(root);
    const binaryPath = path.join(root, 'data.bin');
    const largePath = path.join(root, 'large.txt');
    await writeFile(binaryPath, Buffer.from([0x41, 0x00, 0x42]));
    await writeFile(largePath, Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
    const reader = new TextFileReader();

    await expect(reader.read(binaryPath)).resolves.toMatchObject({ ok: false, error: { code: 'BINARY_FILE' } });
    await expect(reader.read(largePath)).resolves.toMatchObject({ ok: false, error: { code: 'FILE_TOO_LARGE' } });
  });
});
