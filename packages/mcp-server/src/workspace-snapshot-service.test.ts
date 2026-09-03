import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { ok } from '@baitonghub-linux-mcp/domain';
import type { FileActor } from '@baitonghub-linux-mcp/application';
import { WorkspaceSnapshotService } from './workspace-snapshot-service.js';

const actor: FileActor = { clientId: 'client-a', clientName: 'test-client', sessionId: 'session-a' };

describe('WorkspaceSnapshotService', () => {
  it('returns sorted bounded regular-file metadata and owner-bound continuation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'baitonghub-linux-mcp-snapshot-'));
    try {
      await mkdir(path.join(root, 'nested'));
      await writeFile(path.join(root, 'z.txt'), 'zulu');
      await writeFile(path.join(root, 'nested', 'a.txt'), 'alpha');
      const service = createService(root);

      const first = await service.execute(actor, { workspaceId: 'workspace-1', operation: 'manifest', maxEntries: 1, hashMode: 'sha256' });
      expect(first).toMatchObject({ ok: true, value: { entries: [{ path: 'nested/a.txt', bytes: 5, sha256: expect.any(String) }], count: 1, truncated: true, nextCursor: expect.any(String) } });
      if (!first.ok || first.value.nextCursor === undefined) throw new Error('missing continuation');

      const second = await service.execute(actor, { workspaceId: 'workspace-1', operation: 'manifest', maxEntries: 1, hashMode: 'sha256', cursor: first.value.nextCursor });
      expect(second).toMatchObject({ ok: true, value: { entries: [{ path: 'z.txt', bytes: 4, sha256: expect.any(String) }], count: 1, truncated: false } });

      const wrongOwner = await service.execute({ ...actor, sessionId: 'session-b' }, { workspaceId: 'workspace-1', operation: 'manifest', cursor: first.value.nextCursor });
      expect(wrongOwner).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('rejects symlink escapes and malformed manifest inputs', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'baitonghub-linux-mcp-snapshot-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'baitonghub-linux-mcp-snapshot-outside-'));
    try {
      await writeFile(path.join(outside, 'secret.txt'), 'secret');
      await symlink(path.join(outside, 'secret.txt'), path.join(root, 'escape.txt'));
      const service = createService(root);
      const escaped = await service.execute(actor, { workspaceId: 'workspace-1', operation: 'manifest' });
      expect(escaped).toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
      await expect(service.execute(actor, { workspaceId: 'workspace-1', operation: 'manifest', maxEntries: 0 })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      await expect(service.execute(actor, { workspaceId: 'workspace-1', operation: 'manifest', hashMode: 'md5' as never })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('fails fast when cancelled and sanitizes missing workspace roots', async () => {
    const controller = new AbortController();
    controller.abort();
    const service = createService(path.join(tmpdir(), 'missing-baitonghub-snapshot'));
    await expect(service.execute(actor, { workspaceId: 'workspace-1', operation: 'manifest' }, controller.signal)).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    await expect(service.execute(actor, { workspaceId: 'workspace-1', operation: 'manifest' })).resolves.toMatchObject({ ok: false, error: { code: 'WORKSPACE_NOT_FOUND' } });
  });

  it('computes a bounded read-only diff against a prior manifest', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'baitonghub-linux-mcp-snapshot-diff-'));
    try {
      await writeFile(path.join(root, 'changed.txt'), 'new');
      await writeFile(path.join(root, 'added.txt'), 'added');
      const service = createService(root);
      const result = await service.execute(actor, {
        workspaceId: 'workspace-1',
        operation: 'diff',
        baseline: [
          { path: 'changed.txt', bytes: 3, mtimeMs: 1 },
          { path: 'removed.txt', bytes: 7, mtimeMs: 1 },
        ],
      });
      expect(result).toMatchObject({ ok: true, value: {
        operation: 'diff',
        added: [{ path: 'added.txt', bytes: 5 }],
        removed: [{ path: 'removed.txt', bytes: 7 }],
        changed: [{ path: 'changed.txt', before: { bytes: 3 }, after: { bytes: 3 } }],
        unchanged: 0,
        truncated: false,
      } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects invalid diff baselines before scanning', async () => {
    const service = createService(path.join(tmpdir(), 'missing-baitonghub-snapshot-diff'));
    await expect(service.execute(actor, { workspaceId: 'workspace-1', operation: 'diff', baseline: [{ path: '../escape', bytes: 1, mtimeMs: 1 }] })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await expect(service.execute(actor, { workspaceId: 'workspace-1', operation: 'diff', baseline: [{ path: 'C:\\secret.txt', bytes: 1, mtimeMs: 1 }] })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await expect(service.execute(actor, { workspaceId: 'workspace-1', operation: 'diff', baseline: [{ path: 'same.txt', bytes: 1, mtimeMs: 1 }, { path: 'same.txt', bytes: 2, mtimeMs: 2 }] })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('marks bounded comparisons truncated instead of inventing removals', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'baitonghub-linux-mcp-snapshot-diff-bound-'));
    try {
      await writeFile(path.join(root, 'a.txt'), 'a');
      await writeFile(path.join(root, 'b.txt'), 'b');
      const service = createService(root);
      const result = await service.execute(actor, {
        workspaceId: 'workspace-1',
        operation: 'diff',
        maxEntries: 1,
        baseline: [
          { path: 'a.txt', bytes: 1, mtimeMs: 1 },
          { path: 'b.txt', bytes: 1, mtimeMs: 1 },
        ],
      });
      expect(result).toMatchObject({ ok: true, value: { removed: [], truncated: true } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function createService(root: string): WorkspaceSnapshotService {
  return new WorkspaceSnapshotService({
    info: async (_actor, workspaceId) => workspaceId === 'workspace-1'
      ? ok({ id: workspaceId, realRootPath: root })
      : ok({ id: workspaceId, realRootPath: root }),
  });
}
