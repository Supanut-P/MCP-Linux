import { describe, expect, it, vi } from 'vitest';
import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import type { RemoteRolloutTaskSnapshot } from './remote-rollout-runtime.js';
import { TaskEventsService } from './task-events-service.js';

const actor = { clientId: 'client-1', clientName: 'test', sessionId: 'session-1' };

describe('TaskEventsService', () => {
  it('projects shell lifecycle state without returning output or command metadata', async () => {
    const service = new TaskEventsService({
      capabilities: {
        execute: async (_tool: string, input: unknown): Promise<Result<unknown>> => {
          expect(input).toMatchObject({ operation: 'status', task_id: 'task-1', include_stdout: false, include_stderr: false });
          return ok({ task_id: 'task-1', state: 'completed', started_at: '2026-09-03T00:00:00.000Z', finished_at: '2026-09-03T00:00:01.000Z', stdout: 'secret', command: 'rm -rf /' });
        },
      },
    });
    await expect(service.execute(actor, { taskId: 'task-1' })).resolves.toMatchObject({
      ok: true,
      value: {
        taskId: 'task-1', state: 'completed', count: 2,
        events: [
          { sequence: 1, type: 'started', timestamp: '2026-09-03T00:00:00.000Z' },
          { sequence: 2, type: 'completed', timestamp: '2026-09-03T00:00:01.000Z' },
        ],
      },
    });
    const result = await service.execute(actor, { taskId: 'task-1' });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('rm -rf');
  });

  it('supports owner-bound continuation and rejects a cursor from another session', async () => {
    const execute = vi.fn().mockResolvedValue(ok({ task_id: 'task-1', state: 'running', started_at: '2026-09-03T00:00:00.000Z' }));
    const service = new TaskEventsService({ capabilities: { execute } });
    const first = await service.execute(actor, { taskId: 'task-1', limit: 1 });
    expect(first).toMatchObject({ ok: true, value: { nextCursor: expect.any(String), count: 1 } });
    const cursor = (first as { ok: true; value: { nextCursor: string } }).value.nextCursor;
    await expect(service.execute({ ...actor, sessionId: 'other-session' }, { taskId: 'task-1', cursor })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
  });

  it('maps remote rollout events to sanitized progress and terminal events', async () => {
    const service = new TaskEventsService({
      remoteRolloutTasks: {
        createTask: async (): Promise<Result<never>> => ok({} as never), startTask: (): void => undefined, listTasks: async (): Promise<readonly RemoteRolloutTaskSnapshot[]> => [], cancelTask: async (): Promise<null> => null, resultTask: async (): Promise<null> => null,
        getTask: async (): Promise<RemoteRolloutTaskSnapshot> => ({ taskId: 'rollout-1', status: 'completed', createdAt: '2026-09-03T00:00:00.000Z', lastUpdatedAt: '2026-09-03T00:00:02.000Z', workspaceId: 'ws', events: [{ hostId: 'vm103', phase: 'canary', attempt: 1, status: 'ok', resultCode: 'SUCCESS', timestamp: '2026-09-03T00:00:01.000Z' }, { hostId: 'vm103', phase: 'complete', attempt: 1, status: 'ok', timestamp: '2026-09-03T00:00:02.000Z' }] }),
      },
    });
    await expect(service.execute(actor, { taskId: 'rollout-1' })).resolves.toMatchObject({ ok: true, value: { state: 'completed', count: 2, events: [{ type: 'progress', phase: 'canary' }, { type: 'completed', phase: 'complete' }] } });
  });

  it('returns a sanitized not-found result and validates bounds', async () => {
    const service = new TaskEventsService({ capabilities: { execute: async (): Promise<Result<unknown>> => err(appError('PROCESS_NOT_FOUND', 'private details')) } });
    await expect(service.execute(actor, { taskId: 'missing' })).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_NOT_FOUND', message: 'Task was not found' } });
    await expect(service.execute(actor, { taskId: 'bad task' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await expect(service.execute(actor, { taskId: 'missing', limit: 101 })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });
});
