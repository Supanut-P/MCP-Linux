import { describe, expect, it, vi } from 'vitest';
import { TaskCreationAdapter, normalizeTaskTtl } from './task-creation.js';
import type { TasksProtocol } from './tasks-protocol.js';

const task = {
  taskId: 'task-1',
  status: 'working' as const,
  createdAt: '2026-09-01T00:00:00.000Z',
  lastUpdatedAt: '2026-09-01T00:00:00.000Z',
  ttl: 60_000,
  pollInterval: 5_000,
};

function adapter(invoke: (name: string, input: unknown, context?: unknown) => Promise<Record<string, unknown>>): TaskCreationAdapter {
  return new TaskCreationAdapter({
    tasks: { taskFromSnapshot: () => task } as unknown as TasksProtocol,
    invoke: async (name, input, context) => invoke(name, input, context) as never,
    isKnownTool: (name) => name === 'shell',
  });
}

describe('TaskCreationAdapter', () => {
  it('keeps ordinary tools/call unchanged when no task envelope is present', async () => {
    const invoke = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
    const result = await adapter(invoke).handle({ params: { name: 'shell', arguments: { operation: 'run' } } }, {});
    expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] });
    expect(invoke).toHaveBeenCalledWith('shell', { operation: 'run' }, {});
  });

  it('creates a standard task for shell/run without exposing a resume token', async () => {
    const invoke = vi.fn(async (_name: string, input: unknown) => {
      expect(input).toMatchObject({ operation: 'run', execution: 'background', timeout_seconds: 60 });
      return { content: [{ type: 'text' as const, text: 'snapshot' }], structuredContent: { task_id: 'task-1', state: 'running' } };
    });
    const result = await adapter(invoke).handle({ params: { name: 'shell', task: { ttl: 60_000 }, arguments: { executable: 'node', arguments: ['-e', 'setTimeout(()=>{}, 1000)'] } } }, {});
    expect(result).toEqual({ content: [], task });
    expect(result).not.toHaveProperty('resume_token');
  });

  it('rejects unsupported task tools and shell follow-up operations before dispatch', async () => {
    const invoke = vi.fn(async () => ({ content: [] }));
    await expect(adapter(invoke).handle({ params: { name: 'process_start', task: {}, arguments: {} } }, {})).rejects.toMatchObject({ code: -32602 });
    await expect(adapter(invoke).handle({ params: { name: 'shell', task: {}, arguments: { operation: 'wait' } } }, {})).rejects.toMatchObject({ code: -32602 });
    await expect(adapter(invoke).handle({ params: { name: 'shell', task: {}, arguments: { operation: 7 } } }, {})).rejects.toMatchObject({ code: -32602 });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('validates TTL and does not hide backend errors', async () => {
    expect(normalizeTaskTtl(undefined)).toBeUndefined();
    expect(normalizeTaskTtl(100)).toBe(100);
    expect(() => normalizeTaskTtl(99)).toThrow(/ttl/i);
    const response = { isError: true, content: [{ type: 'text' as const, text: 'PERMISSION_REQUIRED' }] };
    const result = await adapter(async () => response).handle({ params: { name: 'shell', task: { ttl: 60_000 }, arguments: {} } }, {});
    expect(result).toBe(response);
  });
});
