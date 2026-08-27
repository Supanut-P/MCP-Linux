import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UnboundedFileReader } from './unbounded-file-reader.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('UnboundedFileReader', () => {
  it('returns image files as base64 even when they contain no NULs', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-unbounded-'));
    temporaryRoots.push(root);
    const svgPath = path.join(root, 'icon.svg');
    await writeFile(svgPath, '<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8');

    const result = await new UnboundedFileReader().read(svgPath);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.encoding).toBe('base64');
      expect(result.value.mimeType).toBe('image/svg+xml');
      expect(Buffer.from(result.value.content, 'base64').toString('utf8')).toContain('<svg');
    }
  });

  it('maps additional image extensions', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-unbounded-'));
    temporaryRoots.push(root);
    const icoPath = path.join(root, 'app.ico');
    await writeFile(icoPath, Buffer.from([0x00, 0x00, 0x01, 0x00]));

    const result = await new UnboundedFileReader().read(icoPath);

    expect(result).toMatchObject({ ok: true, value: { encoding: 'base64', mimeType: 'image/x-icon' } });
  });
});
