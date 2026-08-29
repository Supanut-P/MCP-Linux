import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OperatorProbeBackend } from './operator-probe-backend.js';

describe('OperatorProbeBackend', () => {
  it('hashes a registered regular file without using a shell provider', async (): Promise<void> => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-operator-'));
    try {
      const file = path.join(root, 'artifact.bin');
      const content = 'bounded artifact';
      await writeFile(file, content);
      const expected = createHash('sha256').update(content).digest('hex');
      const backend = new OperatorProbeBackend('artifact_verify', {
        allowedRootsProvider: (): readonly string[] => [root],
        workspaceRootProvider: (): string => root,
      });
      await expect(backend.execute({ workspaceId: 'workspace-1', path: 'artifact.bin', expected_sha256: expected })).resolves.toMatchObject({
        ok: true,
        value: { algorithm: 'sha256', digest: expected, matches: true, bytes: content.length },
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects traversal and symlink escape before reading', async (): Promise<void> => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-operator-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-operator-outside-'));
    try {
      await writeFile(path.join(outside, 'secret.txt'), 'secret');
      const link = path.join(root, 'outside');
      try { await symlink(outside, link, 'dir'); } catch { return; }
      const backend = new OperatorProbeBackend('artifact_verify', {
        allowedRootsProvider: (): readonly string[] => [root],
        workspaceRootProvider: (): string => root,
      });
      await expect(backend.execute({ workspaceId: 'workspace-1', path: 'outside/secret.txt' })).resolves.toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
      await expect(backend.execute({ workspaceId: 'workspace-1', path: '../secret.txt' })).resolves.toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('probes bounded HTTP and validates every redirect destination', async (): Promise<void> => {
    const calls: string[] = [];
    const backend = new OperatorProbeBackend('http_probe', {
      lookupImpl: async (): Promise<readonly string[]> => ['93.184.216.34'],
      fetchImpl: async (input: RequestInfo | URL): Promise<Response> => {
        calls.push(String(input));
        return calls.length === 1
          ? new Response(null, { status: 302, headers: { location: '/health' } })
          : new Response('ok', { status: 200, headers: { 'content-type': 'text/plain', 'x-probe': 'yes' } });
      },
    });
    await expect(backend.execute({ url: 'https://example.test/', method: 'GET', max_bytes: 64 })).resolves.toMatchObject({
      ok: true,
      value: { status: 200, headers: { 'content-type': 'text/plain', 'x-probe': 'yes' }, redirect_chain: ['https://example.test/', 'https://example.test/health'], body_bytes: 2, body_truncated: false },
    });
    expect(calls).toEqual(['https://example.test/', 'https://example.test/health']);
  });

  it('rejects credentials and private/link-local HTTP destinations', async (): Promise<void> => {
    const backend = new OperatorProbeBackend('http_probe', { lookupImpl: async (): Promise<readonly string[]> => ['127.0.0.1'] });
    await expect(backend.execute({ url: 'https://user:password@example.test/' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await expect(backend.execute({ url: 'http://example.test/' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    const mapped = new OperatorProbeBackend('http_probe', { fetchImpl: async (): Promise<Response> => new Response('not reached') });
    await expect(mapped.execute({ url: 'http://[::ffff:7f00:1]/' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('reports statfs and caps largest-file directory walking', async (): Promise<void> => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-operator-'));
    try {
      await mkdir(path.join(root, 'nested'));
      await writeFile(path.join(root, 'small.txt'), 'small');
      await writeFile(path.join(root, 'nested', 'large.txt'), 'large-large');
      const backend = new OperatorProbeBackend('storage_usage', {
        allowedRootsProvider: (): readonly string[] => [root],
        workspaceRootProvider: (): string => root,
      });
      await expect(backend.execute({ workspaceId: 'workspace-1', path: '.', operation: 'filesystem' })).resolves.toMatchObject({ ok: true, value: { operation: 'filesystem', truncated: false, bytes: { total: expect.any(Number), free: expect.any(Number), available: expect.any(Number), used: expect.any(Number) } } });
      await expect(backend.execute({ workspaceId: 'workspace-1', path: '.', operation: 'largest_files' })).resolves.toMatchObject({ ok: true, value: { operation: 'largest_files', truncated: false, files: expect.arrayContaining([{ path: expect.stringContaining('nested'), bytes: 11 }]) } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
