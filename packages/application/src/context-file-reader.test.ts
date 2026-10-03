import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rename, rm, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type Workspace, type WorkspaceRepository } from '@baitonghub-linux-mcp/workspace';
import { FileService } from './file-service.js';
import { readContextFile } from './context-file-reader.js';

const roots: string[] = [];
const actor = { clientId: 'test', clientName: 'test' };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; workspace: Workspace; service: FileService }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'context-reader-'));
  roots.push(root);
  const canonical = await realpath(root);
  const workspace: Workspace = { id: 'registered', displayName: 'fixture', rootPath: root, realRootPath: canonical, createdAt: new Date(0).toISOString() };
  const repository: WorkspaceRepository = {
    async list() { return [workspace]; },
    async get(id) { return id === workspace.id ? workspace : null; },
    async insert() {},
    async delete() {},
  };
  return { root, workspace, service: new FileService(repository) };
}

describe('FileService.readContextFile', () => {
  it('hashes exact raw bytes and preserves CRLF/LF text', async () => {
    const { root, workspace, service } = await fixture();
    const raw = Buffer.from('first\r\nsecond\n', 'utf8');
    await writeFile(path.join(root, 'notes.txt'), raw);
    const result = await service.readContextFile(actor, workspace.id, { path: 'notes.txt' });
    expect(result).toMatchObject({ ok: true, value: {
      status: 'available', path: 'notes.txt', sourceBytes: raw.byteLength,
      sourceSha256: createHash('sha256').update(raw).digest('hex'), text: 'first\r\nsecond\n',
    } });
  });

  it('marks oversized, binary, and invalid UTF-8 files unavailable without hashes', async () => {
    const { root, workspace, service } = await fixture();
    await writeFile(path.join(root, 'large'), Buffer.alloc(8, 0x61));
    await writeFile(path.join(root, 'binary'), Buffer.from([0x61, 0x00, 0x62]));
    await writeFile(path.join(root, 'invalid'), Buffer.from([0xc3, 0x28]));
    const large = await service.readContextFile(actor, workspace.id, { path: 'large', maxBytes: 4 });
    const binary = await service.readContextFile(actor, workspace.id, { path: 'binary' });
    const invalid = await service.readContextFile(actor, workspace.id, { path: 'invalid' });
    expect(large).toMatchObject({ ok: true, value: { status: 'unavailable', reason: 'too_large', sourceBytes: 8 } });
    expect(binary).toMatchObject({ ok: true, value: { status: 'unavailable', reason: 'binary' } });
    expect(invalid).toMatchObject({ ok: true, value: { status: 'unavailable', reason: 'invalid_utf8' } });
    for (const result of [large, binary, invalid]) {
      if (result.ok) expect(result.value).not.toHaveProperty('sourceSha256');
    }
  });

  it('uses an explicit workspace id and the default secret guard', async () => {
    const { root, workspace, service } = await fixture();
    await writeFile(path.join(root, '.env'), 'TOKEN=hidden');
    expect(await service.readContextFile(actor, 'missing', { path: 'notes.txt' }))
      .toMatchObject({ ok: false, error: { code: 'WORKSPACE_NOT_FOUND' } });
    expect(await service.readContextFile(actor, workspace.id, { path: '.env' }))
      .toMatchObject({ ok: false, error: { code: 'SECRET_ACCESS_DENIED' } });
    expect(await service.readContextFile(actor, workspace.id, { path: '../outside' }))
      .toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
  });

  it.skipIf(process.platform === 'win32')('rejects symlinks that leave the registered root', async () => {
    const { root, workspace, service } = await fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), 'context-reader-outside-'));
    roots.push(outside);
    await writeFile(path.join(outside, 'secret.txt'), 'secret');
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'escape.txt'));
    expect(await service.readContextFile(actor, workspace.id, { path: 'escape.txt' }))
      .toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
  });

  it('returns PROCESS_TIMEOUT for an already-cancelled request and validates the bound', async () => {
    const { root, workspace, service } = await fixture();
    await writeFile(path.join(root, 'notes.txt'), 'ok');
    const controller = new AbortController();
    controller.abort();
    expect(await service.readContextFile(actor, workspace.id, { path: 'notes.txt' }, controller.signal))
      .toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    expect(await service.readContextFile(actor, workspace.id, { path: 'notes.txt', maxBytes: 0 }))
      .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });
});

describe('readContextFile race detection', () => {
  it.skipIf(process.platform !== 'linux')('rejects a FIFO without waiting for a writer', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'context-reader-fifo-'));
    roots.push(root);
    const fifoPath = path.join(root, 'source.fifo');
    execFileSync('mkfifo', [fifoPath]);
    const result = await readContextFile({
      path: fifoPath, relativePath: 'source.fifo', rootPath: root,
      maxBytes: 128, revalidate: async () => fifoPath,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    const controller = new AbortController(); controller.abort();
    expect(await readContextFile({ path: fifoPath, relativePath: 'source.fifo', rootPath: root,
      maxBytes: 128, revalidate: async () => fifoPath, signal: controller.signal,
    })).toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
  }, 1000);

  it.skipIf(process.platform === 'win32')('detects atomic same-path replacement during revalidation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'context-reader-race-'));
    roots.push(root);
    const filePath = path.join(root, 'source.txt');
    const replacementPath = path.join(root, 'replacement.txt');
    await writeFile(filePath, 'original');
    await writeFile(replacementPath, 'replacement');
    const result = await readContextFile({
      path: filePath,
      relativePath: 'source.txt',
      rootPath: root,
      maxBytes: 128,
      revalidate: async () => {
        await rename(replacementPath, filePath);
        return filePath;
      },
    });
    expect(result).toMatchObject({ ok: true, value: { status: 'unavailable', reason: 'changed' } });
    if (result.ok) expect(result.value).not.toHaveProperty('sourceSha256');
  });

  it.skipIf(process.platform === 'win32')('detects root replacement during revalidation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'context-reader-root-race-'));
    const movedRoot = `${root}-old`;
    roots.push(root, movedRoot);
    const filePath = path.join(root, 'source.txt');
    await writeFile(filePath, 'content');
    const replacedRoot = await readContextFile({
      path: filePath,
      relativePath: 'source.txt',
      rootPath: root,
      maxBytes: 128,
      revalidate: async () => {
        await rename(root, movedRoot);
        await mkdir(root);
        await writeFile(filePath, 'content');
        return filePath;
      },
    });
    expect(replacedRoot).toMatchObject({ ok: true, value: { status: 'unavailable', reason: 'changed' } });

  });

  it('returns PROCESS_TIMEOUT when cancellation occurs during revalidation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'context-reader-cancel-'));
    roots.push(root);
    const filePath = path.join(root, 'source.txt');
    await writeFile(filePath, 'content');
    const controller = new AbortController();
    const cancelled = await readContextFile({
      path: filePath,
      relativePath: 'source.txt',
      rootPath: root,
      maxBytes: 128,
      signal: controller.signal,
      revalidate: async () => { controller.abort(); return filePath; },
    });
    expect(cancelled).toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
  });
});
