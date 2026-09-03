import { createHash } from 'node:crypto';
import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import type { CapabilityService } from '@baitonghub-linux-mcp/capabilities';
import type { FileActor } from '@baitonghub-linux-mcp/application';
import type { RemoteRolloutTaskPort, RemoteRolloutTaskSnapshot } from './remote-rollout-runtime.js';
import { withCapabilityOwnerMetadata } from './request-scope.js';

export type TaskEventType = 'queued' | 'started' | 'progress' | 'log_available' | 'completed' | 'failed' | 'cancelled';

export interface TaskEvent {
  readonly sequence: number;
  readonly type: TaskEventType;
  readonly timestamp: string;
  readonly state?: string;
  readonly phase?: string;
  readonly attempt?: number;
  readonly resultCode?: string;
}

export interface TaskEventsInput {
  readonly taskId: string;
  readonly cursor?: string;
  readonly limit?: number;
  readonly waitMs?: number;
}

export interface TaskEventsOutput {
  readonly taskId: string;
  readonly state: string;
  readonly events: readonly TaskEvent[];
  readonly count: number;
  readonly truncated: boolean;
  readonly nextCursor?: string;
}

export interface TaskEventsServiceOptions {
  readonly capabilities?: Pick<CapabilityService, 'execute'>;
  readonly remoteRolloutTasks?: RemoteRolloutTaskPort;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

const MAX_EVENTS = 100;
const MAX_WAIT_MS = 30_000;
const MAX_SERIALIZED_BYTES = 128 * 1024;
const CURSOR_PREFIX = 'baitonghub-linux-mcp-events:';
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Projects durable task snapshots into a reconnect-safe, redacted lifecycle
 * stream. The underlying shell/rollout stores remain the source of truth, so
 * no command line, path, output, environment, host key, or secret is copied
 * into this surface.
 */
export class TaskEventsService {
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;

  public constructor(private readonly options: TaskEventsServiceOptions) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds: number, signal?: AbortSignal): Promise<void> => new Promise<void>((resolve, reject) => {
      if (signal?.aborted === true) { reject(new Error('aborted')); return; }
      const timer = setTimeout(resolve, milliseconds);
      signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
    }));
  }

  public async execute(actor: FileActor, input: TaskEventsInput, signal?: AbortSignal): Promise<Result<TaskEventsOutput>> {
    const parsed = normalizeInput(input);
    if (!parsed.ok) return parsed;
    const owner = ownerFingerprint(actor);
    let offset = 0;
    if (parsed.value.cursor !== undefined) {
      const decoded = decodeCursor(parsed.value.cursor);
      if (!decoded.ok) return decoded;
      if (decoded.value.owner !== owner || decoded.value.taskId !== parsed.value.taskId) {
        return err(appError('PERMISSION_DENIED', 'Task event cursor is not owned by this session', false));
      }
      offset = decoded.value.offset;
    }
    const deadline = this.now() + parsed.value.waitMs;
    for (;;) {
      if (signal?.aborted === true) return err(appError('PROCESS_TIMEOUT', 'Task event request was cancelled', true));
      const task = await this.readTask(actor, parsed.value.taskId, signal);
      if (!task.ok) return task;
      const page = pageEvents(task.value.events, offset, parsed.value.limit, owner, parsed.value.taskId);
      if (page.events.length > 0 || parsed.value.waitMs === 0 || this.now() >= deadline) {
        return ok({
          taskId: parsed.value.taskId,
          state: task.value.state,
          events: page.events,
          count: page.events.length,
          truncated: page.truncated,
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        });
      }
      await this.sleep(Math.min(250, Math.max(1, deadline - this.now())), signal).catch(() => undefined);
    }
  }

  private async readTask(actor: FileActor, taskId: string, signal?: AbortSignal): Promise<Result<{ readonly state: string; readonly events: readonly TaskEvent[] }>> {
    if (this.options.remoteRolloutTasks !== undefined) {
      try {
        const remote = await this.options.remoteRolloutTasks.getTask(taskId, actor);
        if (remote !== null) return ok(projectRemote(remote));
      } catch {
        return err(appError('CAPABILITY_UNAVAILABLE', 'Task events are unavailable', true));
      }
    }
    if (this.options.capabilities === undefined) return err(appError('PROCESS_NOT_FOUND', 'Task was not found', false));
    const result = await this.options.capabilities.execute('shell', withCapabilityOwnerMetadata({
      operation: 'status',
      task_id: taskId,
      include_stdout: false,
      include_stderr: false,
    }, actor), signal);
    if (!result.ok) {
      if (result.error.code === 'PROCESS_NOT_FOUND') return err(appError('PROCESS_NOT_FOUND', 'Task was not found', false));
      return err(appError('CAPABILITY_UNAVAILABLE', 'Task events are unavailable', true));
    }
    const projected = projectShell(result.value, taskId);
    return projected === null
      ? err(appError('CAPABILITY_UNAVAILABLE', 'Task events are unavailable', true))
      : ok(projected);
  }
}

function normalizeInput(input: TaskEventsInput): Result<Required<Pick<TaskEventsInput, 'taskId' | 'limit' | 'waitMs'>> & Pick<TaskEventsInput, 'cursor'>> {
  if (typeof input?.taskId !== 'string' || !TASK_ID.test(input.taskId.trim())) return err(appError('INVALID_INPUT', 'Task ID is invalid', false));
  const limit = input.limit ?? 50;
  const waitMs = input.waitMs ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVENTS) return err(appError('INVALID_INPUT', 'Task event limit is invalid', false));
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > MAX_WAIT_MS) return err(appError('INVALID_INPUT', 'Task event wait is invalid', false));
  if (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length < 8 || input.cursor.length > 512)) return err(appError('INVALID_INPUT', 'Task event cursor is invalid', false));
  return ok({ taskId: input.taskId.trim(), limit, waitMs, ...(input.cursor === undefined ? {} : { cursor: input.cursor }) });
}

function projectShell(value: unknown, taskId: string): { readonly state: string; readonly events: readonly TaskEvent[] } | null {
  if (!isRecord(value) || value.task_id !== taskId || typeof value.state !== 'string' || typeof value.started_at !== 'string' || !validTimestamp(value.started_at)) return null;
  const state = value.state;
  const events: TaskEvent[] = [{ sequence: 1, type: 'started', timestamp: value.started_at, state }];
  if (state === 'running' || state === 'termination_unverified') {
    events.push({ sequence: 2, type: 'progress', timestamp: value.started_at, state });
  } else {
    const timestamp = typeof value.finished_at === 'string' && validTimestamp(value.finished_at) ? value.finished_at : value.started_at;
    const type: TaskEventType = state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'failed';
    events.push({ sequence: 2, type, timestamp, state });
  }
  return { state, events };
}

function projectRemote(snapshot: RemoteRolloutTaskSnapshot): { readonly state: string; readonly events: readonly TaskEvent[] } {
  const events: TaskEvent[] = snapshot.events.slice(0, MAX_EVENTS).map((event, index) => {
    const phase = safeToken(event.phase);
    const resultCode = safeToken(event.resultCode);
    return {
      sequence: index + 1,
      type: snapshot.status === 'completed' && index === snapshot.events.length - 1 ? 'completed' : snapshot.status === 'failed' && index === snapshot.events.length - 1 ? 'failed' : snapshot.status === 'cancelled' && index === snapshot.events.length - 1 ? 'cancelled' : 'progress',
      timestamp: validTimestamp(event.timestamp) ? event.timestamp : snapshot.lastUpdatedAt,
      ...(phase === undefined ? {} : { phase }),
      ...(Number.isSafeInteger(event.attempt) && event.attempt >= 0 && event.attempt <= 100 ? { attempt: event.attempt } : {}),
      ...(resultCode === undefined ? {} : { resultCode }),
    };
  });
  return { state: snapshot.status, events };
}

function pageEvents(events: readonly TaskEvent[], offset: number, limit: number, owner: string, taskId: string): { readonly events: readonly TaskEvent[]; readonly truncated: boolean; readonly nextCursor?: string } {
  const page = events.slice(offset, offset + limit);
  let truncated = offset + page.length < events.length;
  let bounded = page;
  while (bounded.length > 0 && Buffer.byteLength(JSON.stringify({ events: bounded }), 'utf8') > MAX_SERIALIZED_BYTES) {
    bounded = bounded.slice(0, -1);
    truncated = true;
  }
  const nextOffset = offset + bounded.length;
  return {
    events: bounded,
    truncated,
    ...(nextOffset < events.length ? { nextCursor: encodeCursor(owner, taskId, nextOffset) } : {}),
  };
}

function encodeCursor(owner: string, taskId: string, offset: number): string {
  return Buffer.from(JSON.stringify({ prefix: CURSOR_PREFIX, owner, taskId, offset }), 'utf8').toString('base64url');
}

function decodeCursor(value: string): Result<{ readonly owner: string; readonly taskId: string; readonly offset: number }> {
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (decoded.prefix !== CURSOR_PREFIX || typeof decoded.owner !== 'string' || typeof decoded.taskId !== 'string' || !TASK_ID.test(decoded.taskId) || typeof decoded.offset !== 'number' || !Number.isSafeInteger(decoded.offset) || decoded.offset < 0) {
      return err(appError('INVALID_INPUT', 'Task event cursor is invalid', false));
    }
    return ok({ owner: decoded.owner, taskId: decoded.taskId, offset: decoded.offset });
  } catch {
    return err(appError('INVALID_INPUT', 'Task event cursor is invalid', false));
  }
}

function ownerFingerprint(actor: FileActor): string {
  return createHash('sha256').update(`${actor.clientId}\n${actor.sessionId ?? actor.clientId}`).digest('hex').slice(0, 32);
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function safeToken(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
