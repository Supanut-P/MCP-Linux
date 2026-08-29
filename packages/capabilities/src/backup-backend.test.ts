import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BackupBackend } from './backup-backend.js';

describe('BackupBackend', () => {
  it('plans, creates, verifies, and restores a manifest inside a registered root', async (): Promise<void> => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-backup-'));
    try {
      const source = path.join(root, 'project');
      const destination = path.join(root, 'restored');
      const archive = path.join(root, 'project.bhb');
      await mkdir(source);
      await writeFile(path.join(source, 'hello.txt'), 'hello');
      const backend = new BackupBackend({ allowedRootsProvider: (): readonly string[] => [root], workspaceRootProvider: (): string => root });
      const plan = await backend.execute({ operation: 'plan', workspaceId: 'w', source: 'project' });
      if (!plan.ok) throw new Error('expected backup plan');
      expect(plan.value.entries.some((entry) => entry.path === 'project/hello.txt' && entry.type === 'file' && entry.bytes === 5)).toBe(true);
      await expect(backend.execute({ operation: 'create', workspaceId: 'w', source: 'project', archive, userConfirmed: true })).resolves.toMatchObject({ ok: true, value: { entries: 2 } });
      await expect(backend.execute({ operation: 'verify', archive })).resolves.toMatchObject({ ok: true, value: { entries: 2, bytes: 5 } });
      await expect(backend.execute({ operation: 'restore', workspaceId: 'w', archive, destination: 'restored', userConfirmed: true })).resolves.toMatchObject({ ok: true, value: { entries: 2 } });
      await expect(readFile(path.join(destination, 'project', 'hello.txt'), 'utf8')).resolves.toBe('hello');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('requires confirmation and rejects traversal/escaping symlinks', async (): Promise<void> => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-backup-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-backup-outside-'));
    try {
      await mkdir(path.join(root, 'project'));
      await writeFile(path.join(outside, 'secret'), 'secret');
      try { await symlink(path.join(outside, 'secret'), path.join(root, 'project', 'link')); } catch { return; }
      const backend = new BackupBackend({ allowedRootsProvider: (): readonly string[] => [root], workspaceRootProvider: (): string => root });
      await expect(backend.execute({ operation: 'create', workspaceId: 'w', source: 'project' })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
      await expect(backend.execute({ operation: 'plan', workspaceId: 'w', source: 'project' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      await expect(backend.execute({ operation: 'plan', workspaceId: 'w', source: '../outside' })).resolves.toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
    } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
  });

  it('returns a structured unavailable result when registered roots cannot be read', async (): Promise<void> => {
    const backend = new BackupBackend({
      allowedRootsProvider: (): readonly string[] => { throw new Error('root provider unavailable'); },
      workspaceRootProvider: (): string => '/tmp/workspace',
    });
    await expect(backend.execute({ operation: 'plan', workspaceId: 'w', source: 'project' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'CAPABILITY_UNAVAILABLE' },
    });
  });
});
