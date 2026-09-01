import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ok } from '@baitonghub-linux-mcp/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startMcpHttp, type McpHttpServerHandle } from './http.js';

const completedTask = {
  task_id: 'task-done',
  state: 'completed',
  exit_code: 0,
  stdout: 'tasks wire ok',
  started_at: '2026-08-22T01:00:00.000Z',
  finished_at: '2026-08-22T01:05:00.000Z',
  deadline_at: '2026-08-23T01:00:00.000Z',
  durable: true,
  truncated: false,
};

const taskResultSchema = z.looseObject({
  taskId: z.string(),
  status: z.string(),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
});

describe('MCP tasks protocol over localhost HTTP', () => {
  let handle: McpHttpServerHandle;
  let createdTask: typeof completedTask | undefined;
  let creationRequest: Record<string, unknown> | undefined;

  beforeEach(async () => {
    createdTask = undefined;
    creationRequest = undefined;
    handle = await startMcpHttp({
      port: 0,
      services: {
        capabilities: {
          async execute(tool: string, request: { operation?: string; task_id?: string; timeout_seconds?: number }) {
            if (tool !== 'shell') return { ok: false, error: { code: 'INVALID_INPUT', message: 'unsupported tool' } } as const;
            if (request.operation === 'run') {
              const startedAt = '2026-09-01T00:00:00.000Z';
              const timeoutSeconds = request.timeout_seconds ?? 86_400;
              const { finished_at, ...baseTask } = completedTask;
              void finished_at;
              createdTask = {
                ...baseTask,
                task_id: 'task-created',
                state: 'running',
                started_at: startedAt,
                deadline_at: new Date(Date.parse(startedAt) + timeoutSeconds * 1_000).toISOString(),
              };
              creationRequest = { ...request };
              return ok(createdTask);
            }
            if (request.operation === 'list') return ok({ tasks: [completedTask] });
            if (request.task_id === 'task-created' && createdTask !== undefined) return ok(createdTask);
            if (request.task_id === 'task-done') return ok(completedTask);
            return { ok: false, error: { code: 'PROCESS_NOT_FOUND', message: 'Task was not found' } } as const;
          },
        },
      },
      actor: { clientId: 'tasks-http-test', clientName: 'tasks-http-test' },
    });
  });

  afterEach(async () => {
    await handle.close();
  });

  it('advertises the tasks capability and serves the four task operations to a 2025-era client', async () => {
    const client = new Client(
      { name: 'baitonghub-linux-mcp-tasks-test-client', version: '0.1.0' },
      { versionNegotiation: { mode: 'legacy' } },
    );
    const transport = new StreamableHTTPClientTransport(handle.endpoint);

    try {
      await client.connect(transport);
      expect(client.getServerCapabilities()?.tasks).toEqual({ list: {}, cancel: {}, requests: { tools: { call: {} } } });

      const listed = await client.request({ method: 'tasks/list', params: {} }, z.looseObject({ tasks: z.array(taskResultSchema) }));
      expect(listed.tasks).toHaveLength(1);
      expect(listed.tasks[0]).toMatchObject({ taskId: 'task-done', status: 'completed', ttl: 86_400_000 });

      const got = await client.request({ method: 'tasks/get', params: { taskId: 'task-done' } }, taskResultSchema);
      expect(got).toMatchObject({ taskId: 'task-done', status: 'completed' });

      const payload = await client.request({ method: 'tasks/result', params: { taskId: 'task-done' } }, z.looseObject({
        content: z.array(z.looseObject({ type: z.string(), text: z.string() })),
        isError: z.boolean(),
        _meta: z.looseObject({}),
      }));
      expect(payload.isError).toBe(false);
      expect(JSON.parse(payload.content[0]!.text)).toMatchObject({ task_id: 'task-done', exit_code: 0 });
      expect(payload._meta?.['io.modelcontextprotocol/related-task']).toEqual({ taskId: 'task-done' });

      await expect(client.request({ method: 'tasks/cancel', params: { taskId: 'task-done' } }, taskResultSchema))
        .rejects.toMatchObject({ code: -32602 });
      await expect(client.request({ method: 'tasks/get', params: { taskId: 'missing' } }, taskResultSchema))
        .rejects.toMatchObject({ code: -32602 });
    } finally {
      await client.close();
    }
  }, 30_000);

  it('creates a durable shell task through task-augmented tools/call and keeps it owner-scoped', async () => {
    const client = new Client(
      { name: 'task-creation-client', version: '0.1.0' },
      {
        capabilities: { tasks: { requests: { tools: { call: {} } } } },
        versionNegotiation: { mode: 'legacy' },
      },
    );
    const transport = new StreamableHTTPClientTransport(handle.endpoint);

    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: 'shell',
        arguments: { executable: 'node', arguments: ['-e', 'setTimeout(()=>{}, 1000)'] },
        task: { ttl: 60_000 },
      });
      expect(result).toMatchObject({ task: { taskId: 'task-created', status: 'working', ttl: 60_000 } });
      expect(result).not.toHaveProperty('resume_token');
      expect(createdTask).toMatchObject({ task_id: 'task-created', state: 'running' });
      expect(creationRequest?.metadata).toMatchObject({
        'baitonghub-linux-mcp.taskOwner.v1': { clientId: 'tasks-http-test', sessionId: expect.any(String) },
      });
    } finally {
      await client.close();
    }
  }, 30_000);

  it('advertises task support only for shell on the legacy task-capable tools/list surface', async () => {
    const client = new Client(
      { name: 'task-metadata-client', version: '0.1.0' },
      { versionNegotiation: { mode: 'legacy' } },
    );
    const transport = new StreamableHTTPClientTransport(handle.endpoint);

    try {
      await client.connect(transport);
      const listed = await client.listTools();
      const shell = listed.tools.find((tool) => tool.name === 'shell');
      const processStart = listed.tools.find((tool) => tool.name === 'process_start');
      expect(shell?.execution).toEqual({ taskSupport: 'required' });
      expect(processStart?.execution).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it('rejects task envelopes for unsupported tools and shell follow-up operations', async () => {
    const client = new Client(
      { name: 'task-rejection-client', version: '0.1.0' },
      { versionNegotiation: { mode: 'legacy' } },
    );
    const transport = new StreamableHTTPClientTransport(handle.endpoint);

    try {
      await client.connect(transport);
      await expect(client.callTool({ name: 'process_start', arguments: {}, task: { ttl: 60_000 } })).rejects.toMatchObject({ code: -32602 });
      await expect(client.callTool({ name: 'shell', arguments: { operation: 'wait' }, task: { ttl: 60_000 } })).rejects.toMatchObject({ code: -32602 });
    } finally {
      await client.close();
    }
  });
});
