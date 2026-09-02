import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import type { FileActor } from '@baitonghub-linux-mcp/application';
import type { ProtocolTask, ShellSnapshot, TasksProtocol } from './tasks-protocol.js';
import { mapError, type McpToolResponse } from './result-mapper.js';
import type { RemoteRolloutTaskPort } from './remote-rollout-runtime.js';

const MIN_TASK_TTL_MS = 100;
const MAX_TASK_TTL_MS = 604_800_000;

export interface TaskAugmentedCallRequest {
  readonly params: {
    readonly name: string;
    readonly arguments?: Record<string, unknown>;
    readonly task?: { readonly ttl?: number };
  };
}

export type TaskToolInvoker = (name: string, input: unknown, context: unknown) => Promise<McpToolResponse>;

export interface TaskCreationAdapterOptions {
  readonly tasks: TasksProtocol;
  readonly invoke: TaskToolInvoker;
  readonly isKnownTool: (name: string) => boolean;
  readonly remoteRolloutTasks?: RemoteRolloutTaskPort;
  readonly actor?: FileActor;
}

/**
 * Implements the MCP task-augmented tools/call bridge for durable shell work.
 * The existing tool registry remains the authority for parsing, permissions,
 * ownership, audit, and process cleanup; this adapter only translates the
 * protocol task envelope into a shell run and returns the task projection.
 */
export class TaskCreationAdapter {
  public constructor(private readonly options: TaskCreationAdapterOptions) {}

  public async handle(request: TaskAugmentedCallRequest, context: unknown): Promise<McpToolResponse | CreateTaskResult> {
    const params = request.params;
    if (!this.options.isKnownTool(params.name)) throw invalidParams(`Tool ${params.name} not found`);
    if (params.task === undefined) return this.options.invoke(params.name, params.arguments ?? {}, context);
    if (params.task.ttl !== undefined) normalizeTaskTtl(params.task.ttl);
    if (params.name === 'remote_rollout') return this.handleRemoteRollout(request, context);
    if (params.name !== 'shell') throw invalidParams('MCP task creation is supported only for the shell and remote_rollout tools');

    const input = params.arguments ?? {};
    if (input.operation !== undefined && typeof input.operation !== 'string') {
      throw invalidParams('MCP task creation shell operation must be run');
    }
    const operation = readString(input.operation);
    if (operation !== undefined && operation !== 'run') {
      throw invalidParams('MCP task creation supports shell operation run only');
    }

    const ttlMs = normalizeTaskTtl(params.task.ttl);
    const timeoutSeconds = readNumber(input.timeout_seconds);
    if (ttlMs !== undefined && timeoutSeconds !== undefined && timeoutSeconds * 1_000 > ttlMs) {
      throw invalidParams('shell timeout_seconds cannot exceed the requested task ttl');
    }

    const shellInput: Record<string, unknown> = {
      ...input,
      operation: 'run',
      execution: 'background',
      ...(ttlMs === undefined || timeoutSeconds !== undefined ? {} : { timeout_seconds: ttlMs / 1_000 }),
    };
    const response = await this.options.invoke('shell', shellInput, context);
    if (response.isError === true) return response;
    const snapshot = response.structuredContent as ShellSnapshot | undefined;
    const task = snapshot === undefined ? undefined : this.options.tasks.taskFromSnapshot(snapshot);
    if (task === undefined) throw new ProtocolError(ProtocolErrorCode.InternalError, 'Shell task creation did not return a durable task');
    return { content: [], task };
  }

  private async handleRemoteRollout(request: TaskAugmentedCallRequest, context: unknown): Promise<McpToolResponse | CreateTaskResult> {
    const tasks = this.options.remoteRolloutTasks;
    if (tasks === undefined) throw invalidParams('Remote rollout task support is unavailable');
    const input = request.params.arguments ?? {};
    if (input.operation !== 'execute') throw invalidParams('MCP task creation for remote_rollout requires operation execute');
    const actor = this.options.actor ?? { clientId: 'legacy', clientName: 'legacy' };
    const created = await tasks.createTask(input, actor);
    if (!created.ok) return mapError(created.error);
    tasks.startTask(created.value.taskId, () => this.options.invoke('remote_rollout', input, context));
    return { content: [], task: this.options.tasks.taskFromRemoteSnapshot(created.value) };
  }
}

export interface CreateTaskResult {
  readonly content: readonly [];
  readonly task: ProtocolTask;
}

export function normalizeTaskTtl(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < MIN_TASK_TTL_MS || value > MAX_TASK_TTL_MS) {
    throw invalidParams(`Task ttl must be between ${MIN_TASK_TTL_MS} and ${MAX_TASK_TTL_MS} milliseconds`);
  }
  return Math.round(value);
}

function invalidParams(message: string): ProtocolError {
  return new ProtocolError(ProtocolErrorCode.InvalidParams, message);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
