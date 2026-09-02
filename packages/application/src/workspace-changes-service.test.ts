import { describe, expect, it } from 'vitest';
import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import type { WorkspaceChangeJournal } from './workspace-index-queue.js';
import { WorkspaceChangesService } from './workspace-changes-service.js';

describe('WorkspaceChangesService', () => {
  it('returns bounded watcher events without roots or contents', async () => {
    const service = new WorkspaceChangesService({
      async changes(): Promise<Result<WorkspaceChangeJournal>> {
        return ok({
          events: [
            { sequence: 1, relativePath: 'src/main.ts', kind: 'modified' as const, observedAt: '2026-09-02T00:00:00.000Z' },
            { sequence: 2, relativePath: '/srv/private.txt', kind: 'modified' as const, observedAt: '2026-09-02T00:00:01.000Z' },
          ],
          latestSequence: 2,
          truncated: false,
        });
      },
    });
    await expect(service.snapshot('workspace-1', 10)).resolves.toEqual(ok({
      workspaceId: 'workspace-1',
      events: [{ sequence: 1, relativePath: 'src/main.ts', kind: 'modified', observedAt: '2026-09-02T00:00:00.000Z' }],
      latestSequence: 2,
      truncated: false,
    }));
  });

  it('preserves watcher_not_running and validates cursors', async () => {
    const service = new WorkspaceChangesService({
      async changes(): Promise<Result<WorkspaceChangeJournal>> { return err(appError('WATCHER_NOT_RUNNING', 'Workspace watcher is not running', true)); },
    });
    await expect(service.diff('workspace-1', -1)).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await expect(service.snapshot('workspace-1')).resolves.toMatchObject({ ok: false, error: { code: 'WATCHER_NOT_RUNNING' } });
  });
});
