import { describe, expect, it, vi } from 'vitest';
import { ok, type Result } from '@baitonghub-linux-mcp/domain';
import type { RemoteRolloutTaskSnapshot } from './remote-rollout-runtime.js';
import { TaskHistoryService } from './task-history-service.js';

const actor = { clientId: 'client-1', clientName: 'test', sessionId: 'session-1' };

describe('TaskHistoryService', () => {
  it('projects owned shell and rollout summaries without command or path metadata', async () => {
    const execute = vi.fn(async (_tool: string, input: unknown): Promise<Result<unknown>> => {
      expect(input).toMatchObject({ operation: 'list', workspaceId: 'workspace-a', include_stdout: false, include_stderr: false });
      return ok({ tasks: [
        { task_id: 'shell-1', state: 'completed', started_at: '2026-09-03T00:00:00.000Z', finished_at: '2026-09-03T00:00:02.000Z', exit_code: 0, workspace_hash: '0dcf2d98505da17dc4a5eaefb2553d5b', command: 'rm -rf /', cwd: '/secret', stdout: 'token' },
      ] });
    });
    const remote: RemoteRolloutTaskSnapshot = {
      taskId: 'rollout-1', status: 'failed', workspaceId: 'workspace-b', createdAt: '2026-09-03T00:00:03.000Z', lastUpdatedAt: '2026-09-03T00:00:04.000Z',
      events: [{ hostId: 'vm103', phase: 'canary', attempt: 1, status: 'error', resultCode: 'CAPABILITY_UNAVAILABLE', timestamp: '2026-09-03T00:00:04.000Z' }],
      result: { privateKey: 'secret' },
    };
    const service = new TaskHistoryService({ capabilities: { execute }, remoteRolloutTasks: { listTasks: async () => [remote] } as never });
    const result = await service.execute(actor, { workspaceId: 'workspace-a', limit: 10 });

    expect(result).toMatchObject({ ok: true, value: { count: 1, entries: [{ taskId: 'shell-1', kind: 'shell', state: 'completed', resultCode: 'SUCCESS', durationMs: 2_000, workspaceHash: '0dcf2d98505da17dc4a5eaefb2553d5b' }] } });
    expect(JSON.stringify(result)).not.toContain('rm -rf');
    expect(JSON.stringify(result)).not.toContain('/secret');
    expect(JSON.stringify(result)).not.toContain('privateKey');
  });

  it('binds cursors to the owner and filter, and supports state/time filtering', async () => {
    const execute = vi.fn(async (): Promise<Result<unknown>> => ok({ tasks: [
      { task_id: 'task-a', state: 'completed', started_at: '2026-09-03T00:00:00.000Z', finished_at: '2026-09-03T00:00:01.000Z', exit_code: 0 },
      { task_id: 'task-c', state: 'completed', started_at: '2026-09-03T00:30:00.000Z', finished_at: '2026-09-03T00:30:01.000Z', exit_code: 0 },
      { task_id: 'task-b', state: 'failed', started_at: '2026-09-03T01:00:00.000Z', finished_at: '2026-09-03T01:00:01.000Z', exit_code: 1 },
    ] }));
    const service = new TaskHistoryService({ capabilities: { execute } });
    const first = await service.execute(actor, { state: 'completed', since: '2026-09-03T00:00:00+00:00', limit: 1 });
    expect(first).toMatchObject({ ok: true, value: { count: 1, entries: [{ taskId: 'task-c' }] } });
    const cursor = (first as { ok: true; value: { nextCursor: string } }).value.nextCursor;
    await expect(service.execute({ ...actor, sessionId: 'other' }, { state: 'completed', limit: 1, cursor })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await expect(service.execute(actor, { state: 'failed', limit: 1, cursor })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('retains a bounded history and paginates deterministically', async () => {
    const tasks = Array.from({ length: 510 }, (_, index) => ({
      task_id: `task-${String(index).padStart(3, '0')}`,
      state: 'completed',
      started_at: `2026-09-03T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
      finished_at: `2026-09-03T00:${String(index % 60).padStart(2, '0')}:01.000Z`,
      exit_code: 0,
    }));
    const service = new TaskHistoryService({ capabilities: { execute: async (): Promise<Result<unknown>> => ok({ tasks }) } });
    const result = await service.execute(actor, { limit: 100 });
    expect(result).toMatchObject({ ok: true, value: { count: 100, truncated: true, nextCursor: expect.any(String) } });
  });

  it('fails closed when no task provider exists and validates bounds', async () => {
    const service = new TaskHistoryService({});
    await expect(service.execute(actor, {})).resolves.toMatchObject({ ok: false, error: { code: 'CAPABILITY_UNAVAILABLE' } });
    const withProvider = new TaskHistoryService({ capabilities: { execute: async (): Promise<Result<unknown>> => ok({ tasks: [] }) } });
    await expect(withProvider.execute(actor, { limit: 101 })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await expect(withProvider.execute(actor, { workspaceHash: 'not-a-hash' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });
});
