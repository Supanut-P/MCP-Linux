import { describe, expect, it } from 'vitest';
import { appError, err, ok } from '@baitonghub-linux-mcp/domain';
import { CAPABILITY_TASK_OWNER_METADATA_KEY } from '@baitonghub-linux-mcp/capabilities';
import { TasksProtocol } from './tasks-protocol.js';
import type { McpApplicationServices } from './tool-registry.js';

const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

type TaskMap = Record<string, Record<string, unknown>>;

function servicesWithTasks(tasks: TaskMap, log?: string[]): McpApplicationServices {
  return {
    capabilities: {
      async execute(tool: string, request: { operation?: string; task_id?: string }) {
        expect(tool).toBe('shell');
        log?.push(`${request.operation}:${request.task_id ?? ''}`);
        const operation = request.operation ?? 'run';
        if (operation === 'list') return ok({ tasks: Object.values(tasks) });
        const task = request.task_id === undefined ? undefined : tasks[request.task_id];
        if (task === undefined) return err(appError('PROCESS_NOT_FOUND', 'Task was not found'));
        if (operation === 'cancel') {
          return ok({ ...task, state: 'cancelled', finished_at: '2026-08-22T02:30:00.000Z' });
        }
        return ok(task);
      },
    },
  } as unknown as McpApplicationServices;
}

const runningDurable = {
  task_id: 'task-running',
  state: 'running',
  started_at: '2026-08-22T01:00:00.000Z',
  deadline_at: '2026-08-23T01:00:00.000Z',
  durable: true,
};

describe('TasksProtocol', () => {
  it('maps every local task state onto the protocol status lifecycle', async () => {
    const protocol = new TasksProtocol(servicesWithTasks({
      running: { task_id: 'running', state: 'running', started_at: '2026-08-22T01:00:00.000Z' },
      done: { task_id: 'done', state: 'completed', started_at: '2026-08-22T01:00:00.000Z', finished_at: '2026-08-22T01:01:00.000Z', exit_code: 0 },
      timedOut: { task_id: 'timedOut', state: 'timed_out', started_at: '2026-08-22T01:00:00.000Z', finished_at: '2026-08-22T01:01:00.000Z', error: 'Local task timed out' },
      unverified: { task_id: 'unverified', state: 'termination_unverified', started_at: '2026-08-22T01:00:00.000Z', error: 'Worker exited before recording a final state' },
      stopped: { task_id: 'stopped', state: 'cancelled', started_at: '2026-08-22T01:00:00.000Z', finished_at: '2026-08-22T01:01:00.000Z' },
      failed: { task_id: 'failed', state: 'failed', started_at: '2026-08-22T01:00:00.000Z', finished_at: '2026-08-22T01:01:00.000Z', exit_code: 1, error: 'command failed' },
      malformed: { state: 'running' },
    }));
    const { tasks, nextCursor } = await protocol.listTasks({});
    expect(nextCursor).toBeUndefined();
    expect(tasks.map((task) => [task.taskId, task.status])).toEqual([
      ['running', 'working'],
      ['done', 'completed'],
      ['timedOut', 'failed'],
      ['unverified', 'working'],
      ['stopped', 'cancelled'],
      ['failed', 'failed'],
    ]);
    expect(tasks.find((task) => task.taskId === 'timedOut')?.statusMessage).toBe('Local task timed out');
    expect(tasks.find((task) => task.taskId === 'running')?.lastUpdatedAt).toBe('2026-08-22T01:00:00.000Z');
    expect(tasks.every((task) => task.pollInterval === 5_000)).toBe(true);
  });

  it('advertises the live configured poll interval with the 5-60 second guardrails', async () => {
    let configured = 30;
    const services: McpApplicationServices = {
      ...servicesWithTasks({ 'task-running': runningDurable }),
      runtimeTiming: () => ({ mcpPollWaitSeconds: configured }),
    };
    const protocol = new TasksProtocol(services);

    expect((await protocol.getTask({ taskId: 'task-running' })).pollInterval).toBe(30_000);
    configured = 1;
    expect((await protocol.getTask({ taskId: 'task-running' })).pollInterval).toBe(5_000);
    configured = 999;
    expect((await protocol.getTask({ taskId: 'task-running' })).pollInterval).toBe(60_000);
  });

  it('derives ttl from deadline_at and falls back to unlimited', async () => {
    const protocol = new TasksProtocol(servicesWithTasks({ 'task-running': runningDurable }));
    const task = await protocol.getTask({ taskId: 'task-running' });
    expect(task.ttl).toBe(24 * 60 * 60 * 1_000);
    const inMemory = await new TasksProtocol(servicesWithTasks({
      brief: { task_id: 'brief', state: 'running', started_at: '2026-08-22T01:00:00.000Z' },
    })).getTask({ taskId: 'brief' });
    expect(inMemory.ttl).toBeNull();
  });

  it('answers unknown task ids with -32602', async () => {
    const protocol = new TasksProtocol(servicesWithTasks({ 'task-running': runningDurable }));
    await expect(protocol.getTask({ taskId: 'missing' })).rejects.toMatchObject({ code: INVALID_PARAMS });
    await expect(protocol.taskResult({ taskId: 'missing' })).rejects.toMatchObject({ code: INVALID_PARAMS });
    await expect(protocol.cancelTask({ taskId: 'missing' })).rejects.toMatchObject({ code: INVALID_PARAMS });
  });

  it('paginates tasks/list with opaque cursors and rejects malformed cursors', async () => {
    const tasks: TaskMap = {};
    for (let index = 1; index <= 5; index += 1) {
      tasks[`task-${index}`] = { task_id: `task-${index}`, state: 'completed', started_at: '2026-08-22T01:00:00.000Z', finished_at: '2026-08-22T01:01:00.000Z' };
    }
    const protocol = new TasksProtocol(servicesWithTasks(tasks), { pageSize: 2 });
    const first = await protocol.listTasks({});
    expect(first.tasks.map((task) => task.taskId)).toEqual(['task-1', 'task-2']);
    expect(first.nextCursor).toBeDefined();
    const second = await protocol.listTasks({ cursor: first.nextCursor });
    expect(second.tasks.map((task) => task.taskId)).toEqual(['task-3', 'task-4']);
    const third = await protocol.listTasks({ cursor: second.nextCursor! });
    expect(third.tasks.map((task) => task.taskId)).toEqual(['task-5']);
    expect(third.nextCursor).toBeUndefined();
    await expect(protocol.listTasks({ cursor: 'not-a-valid-cursor' })).rejects.toMatchObject({ code: INVALID_PARAMS });
  });

  it('refuses to cancel terminal tasks with -32602', async () => {
    const protocol = new TasksProtocol(servicesWithTasks({
      done: { task_id: 'done', state: 'completed', started_at: '2026-08-22T01:00:00.000Z', finished_at: '2026-08-22T01:01:00.000Z' },
    }));
    await expect(protocol.cancelTask({ taskId: 'done' })).rejects.toMatchObject({
      code: INVALID_PARAMS,
      message: expect.stringContaining("already in terminal status 'completed'"),
    });
  });

  it('cancels a working task through the shell backend', async () => {
    const protocol = new TasksProtocol(servicesWithTasks({ 'task-running': runningDurable }));
    const cancelled = await protocol.cancelTask({ taskId: 'task-running' });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.lastUpdatedAt).toBe('2026-08-22T02:30:00.000Z');
  });

  it('keeps termination_unverified cancellable because a child process may still be alive', async () => {
    const protocol = new TasksProtocol(servicesWithTasks({
      uncertain: { task_id: 'uncertain', state: 'termination_unverified', started_at: '2026-08-22T01:00:00.000Z', error: 'termination could not be verified' },
    }));
    const before = await protocol.getTask({ taskId: 'uncertain' });
    expect(before).toMatchObject({ status: 'working', statusMessage: 'termination could not be verified' });
    const cancelled = await protocol.cancelTask({ taskId: 'uncertain' });
    expect(cancelled.status).toBe('cancelled');
  });

  it('returns task snapshots as task results with related-task metadata', async () => {
    const completed = {
      task_id: 'task-done',
      state: 'completed',
      exit_code: 0,
      stdout: 'build ok',
      started_at: '2026-08-22T01:00:00.000Z',
      finished_at: '2026-08-22T01:05:00.000Z',
      truncated: false,
    };
    const failed = { ...completed, task_id: 'task-failed', state: 'failed', exit_code: 1, error: 'typecheck failed' };
    const protocol = new TasksProtocol(servicesWithTasks({ 'task-done': completed, 'task-failed': failed }));

    const done = await protocol.taskResult({ taskId: 'task-done' });
    expect(done.isError).toBe(false);
    expect(done._meta['io.modelcontextprotocol/related-task']).toEqual({ taskId: 'task-done' });
    expect(JSON.parse(done.content[0]!.text)).toEqual(completed);

    const broken = await protocol.taskResult({ taskId: 'task-failed' });
    expect(broken.isError).toBe(true);
    expect(JSON.parse(broken.content[0]!.text)).toEqual(failed);
  });

  it('bounds tasks/result waiting for non-terminal tasks with -32603', async () => {
    const log: string[] = [];
    const protocol = new TasksProtocol(servicesWithTasks({ 'task-running': runningDurable }, log), {
      maxResultWaitMs: 120,
      pollTickMs: 40,
    });
    await expect(protocol.taskResult({ taskId: 'task-running' })).rejects.toMatchObject({
      code: INTERNAL_ERROR,
      message: expect.stringContaining('still working'),
    });
    expect(log.length).toBeGreaterThanOrEqual(2);
  });

  it('fails closed when the capability service is missing', async () => {
    const protocol = new TasksProtocol({} as McpApplicationServices);
    await expect(protocol.listTasks({})).rejects.toMatchObject({ code: INTERNAL_ERROR });
  });

  it('injects trusted session ownership metadata into protocol task operations', async () => {
    const requests: Record<string, unknown>[] = [];
    const services = { capabilities: { async execute(_tool: string, request: Record<string, unknown>) { requests.push(request); return ok({ tasks: [] }); } } } as unknown as McpApplicationServices;
    const protocol = new TasksProtocol(services, { actor: { clientId: 'client-1', clientName: 'test', sessionId: 'session-a' } });
    await protocol.listTasks({});
    expect(requests[0]).toMatchObject({ metadata: { [CAPABILITY_TASK_OWNER_METADATA_KEY]: { clientId: 'client-1', sessionId: 'session-a' } } });
  });
});
