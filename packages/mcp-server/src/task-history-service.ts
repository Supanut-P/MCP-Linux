import { createHash } from 'node:crypto';
import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import type { CapabilityService } from '@baitonghub-linux-mcp/capabilities';
import type { FileActor } from '@baitonghub-linux-mcp/application';
import type { RemoteRolloutTaskPort, RemoteRolloutTaskSnapshot } from './remote-rollout-runtime.js';
import { withCapabilityOwnerMetadata } from './request-scope.js';

export type TaskHistoryState = 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled' | 'termination_unverified' | 'expired';

export interface TaskHistoryInput {
  readonly workspaceId?: string;
  readonly workspaceHash?: string;
  readonly state?: TaskHistoryState;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface TaskHistoryEntry {
  readonly taskId: string;
  readonly kind: 'shell' | 'remote_rollout';
  readonly state: TaskHistoryState;
  readonly createdAt: string;
  readonly lastUpdatedAt: string;
  readonly workspaceHash?: string;
  readonly resultCode: string;
  readonly durationMs?: number;
}

export interface TaskHistoryOutput {
  readonly entries: readonly TaskHistoryEntry[];
  readonly count: number;
  readonly truncated: boolean;
  readonly nextCursor?: string;
}

export interface TaskHistoryServiceOptions {
  readonly capabilities?: Pick<CapabilityService, 'execute'>;
  readonly remoteRolloutTasks?: RemoteRolloutTaskPort;
}

const MAX_HISTORY_ENTRIES = 500;
const MAX_PAGE_SIZE = 100;
const MAX_SERIALIZED_BYTES = 256 * 1024;
const CURSOR_PREFIX = 'baitonghub-linux-mcp-history:';
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_WORKSPACE_HASH = /^[a-f0-9]{32}$/;
const SAFE_RESULT_CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const VALID_STATES = new Set<TaskHistoryState>(['running', 'completed', 'failed', 'timed_out', 'cancelled', 'termination_unverified', 'expired']);

/**
 * Provides a bounded, redacted view over retained owned task snapshots. The
 * underlying stores remain the source of truth; this service deliberately
 * projects no command, cwd, output, environment, host, or secret metadata.
 */
export class TaskHistoryService {
  public constructor(private readonly options: TaskHistoryServiceOptions) {}

  public async execute(actor: FileActor, input: TaskHistoryInput, signal?: AbortSignal): Promise<Result<TaskHistoryOutput>> {
    const normalized = normalizeInput(input);
    if (!normalized.ok) return normalized;
    const owner = ownerFingerprint(actor);
    const filter = filterFingerprint(normalized.value);
    const offset = normalized.value.cursor === undefined
      ? 0
      : decodeCursor(normalized.value.cursor, owner, filter);
    if (!Number.isSafeInteger(offset) || offset < 0) return err(appError('INVALID_INPUT', 'Task history cursor is invalid', false));

    if (this.options.capabilities === undefined && this.options.remoteRolloutTasks === undefined) {
      return err(appError('CAPABILITY_UNAVAILABLE', 'Task history is unavailable', true));
    }
    const entries: TaskHistoryEntry[] = [];
    if (this.options.capabilities !== undefined) {
      try {
        const response = await this.options.capabilities.execute('shell', withCapabilityOwnerMetadata({
          operation: 'list',
          ...(normalized.value.workspaceId === undefined ? {} : { workspaceId: normalized.value.workspaceId }),
          include_stdout: false,
          include_stderr: false,
        }, actor), signal);
        if (response.ok) entries.push(...projectShellTasks(response.value));
      } catch {
        // A missing or failing optional provider is represented by the
        // aggregate result below; provider details never cross this boundary.
      }
    }
    if (this.options.remoteRolloutTasks !== undefined) {
      try {
        const remote = await this.options.remoteRolloutTasks.listTasks(actor);
        entries.push(...remote.map(projectRemoteTask).filter((entry): entry is TaskHistoryEntry => entry !== undefined));
      } catch {
        // Keep local results if the optional remote provider is unavailable.
      }
    }
    const filtered = entries
      .filter((entry) => matchesFilter(entry, normalized.value))
      .sort(compareEntries);
    const retained = filtered.slice(0, MAX_HISTORY_ENTRIES);
    const retentionTruncated = filtered.length > retained.length;
    let page = retained.slice(offset, offset + normalized.value.limit);
    let truncated = retentionTruncated || offset + page.length < retained.length;
    while (page.length > 0 && Buffer.byteLength(JSON.stringify({ entries: page }), 'utf8') > MAX_SERIALIZED_BYTES) {
      page = page.slice(0, -1);
      truncated = true;
    }
    const nextOffset = offset + page.length;
    return ok({
      entries: page,
      count: page.length,
      truncated,
      ...(nextOffset < retained.length ? { nextCursor: encodeCursor(owner, filter, nextOffset) } : {}),
    });
  }
}

function normalizeInput(input: TaskHistoryInput): Result<Required<Pick<TaskHistoryInput, 'limit'>> & Omit<TaskHistoryInput, 'limit'>> {
  const value = input ?? {};
  const limit = value.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) return err(appError('INVALID_INPUT', 'Task history limit is invalid', false));
  const workspaceId = value.workspaceId === undefined ? undefined : value.workspaceId.trim();
  if (workspaceId !== undefined && (workspaceId.length === 0 || workspaceId.length > 128)) return err(appError('INVALID_INPUT', 'Workspace ID is invalid', false));
  const workspaceHash = value.workspaceHash === undefined ? undefined : value.workspaceHash.trim();
  if (workspaceHash !== undefined && !SAFE_WORKSPACE_HASH.test(workspaceHash)) return err(appError('INVALID_INPUT', 'Workspace hash is invalid', false));
  const derivedHash = workspaceId === undefined ? undefined : hashWorkspaceId(workspaceId);
  if (workspaceHash !== undefined && derivedHash !== undefined && workspaceHash !== derivedHash) return err(appError('INVALID_INPUT', 'Workspace filters do not match', false));
  if (value.state !== undefined && !VALID_STATES.has(value.state)) return err(appError('INVALID_INPUT', 'Task history state is invalid', false));
  const since = normalizeTimestamp(value.since, 'since');
  if (!since.ok) return since;
  const until = normalizeTimestamp(value.until, 'until');
  if (!until.ok) return until;
  if (since.value !== undefined && until.value !== undefined && Date.parse(since.value) > Date.parse(until.value)) return err(appError('INVALID_INPUT', 'Task history time range is invalid', false));
  if (value.cursor !== undefined && (typeof value.cursor !== 'string' || value.cursor.length < 8 || value.cursor.length > 768)) return err(appError('INVALID_INPUT', 'Task history cursor is invalid', false));
  return ok({
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(workspaceHash === undefined ? {} : { workspaceHash }),
    ...(value.state === undefined ? {} : { state: value.state }),
    ...(since.value === undefined ? {} : { since: since.value }),
    ...(until.value === undefined ? {} : { until: until.value }),
    limit,
    ...(value.cursor === undefined ? {} : { cursor: value.cursor }),
  });
}

function normalizeTimestamp(value: string | undefined, label: string): Result<string | undefined> {
  if (value === undefined) return ok(undefined);
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return err(appError('INVALID_INPUT', `Task history ${label} timestamp is invalid`, false));
  return ok(new Date(value).toISOString());
}

function projectShellTasks(value: unknown): TaskHistoryEntry[] {
  if (!isRecord(value) || !Array.isArray(value.tasks)) return [];
  return value.tasks.map((task) => projectShellTask(task)).filter((entry): entry is TaskHistoryEntry => entry !== undefined);
}

function projectShellTask(value: unknown): TaskHistoryEntry | undefined {
  if (!isRecord(value) || typeof value.task_id !== 'string' || !SAFE_TASK_ID.test(value.task_id) || typeof value.state !== 'string' || !VALID_STATES.has(value.state as TaskHistoryState) || typeof value.started_at !== 'string' || !validTimestamp(value.started_at)) return undefined;
  const lastUpdatedAt = typeof value.finished_at === 'string' && validTimestamp(value.finished_at) ? value.finished_at : value.started_at;
  const workspaceHash = typeof value.workspace_hash === 'string' && SAFE_WORKSPACE_HASH.test(value.workspace_hash) ? value.workspace_hash : undefined;
  const resultCode = shellResultCode(value.state, value.exit_code);
  const durationMs = duration(value.started_at, lastUpdatedAt);
  return {
    taskId: value.task_id,
    kind: 'shell',
    state: value.state as TaskHistoryState,
    createdAt: new Date(value.started_at).toISOString(),
    lastUpdatedAt: new Date(lastUpdatedAt).toISOString(),
    ...(workspaceHash === undefined ? {} : { workspaceHash }),
    resultCode,
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

function projectRemoteTask(snapshot: RemoteRolloutTaskSnapshot): TaskHistoryEntry | undefined {
  if (!SAFE_TASK_ID.test(snapshot.taskId)) return undefined;
  const createdAt = validTimestamp(snapshot.createdAt) ? new Date(snapshot.createdAt).toISOString() : new Date(0).toISOString();
  const lastUpdatedAt = validTimestamp(snapshot.lastUpdatedAt) ? new Date(snapshot.lastUpdatedAt).toISOString() : createdAt;
  const lastResult = snapshot.events.at(-1)?.resultCode;
  const resultCode = typeof lastResult === 'string' && SAFE_RESULT_CODE.test(lastResult) ? lastResult : remoteResultCode(snapshot.status);
  const durationMs = duration(createdAt, lastUpdatedAt);
  return {
    taskId: snapshot.taskId,
    kind: 'remote_rollout',
    state: remoteState(snapshot.status),
    createdAt,
    lastUpdatedAt,
    workspaceHash: hashWorkspaceId(snapshot.workspaceId),
    resultCode,
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

function matchesFilter(entry: TaskHistoryEntry, input: Omit<TaskHistoryInput, 'limit'> & { readonly limit: number }): boolean {
  const workspaceHash = input.workspaceHash ?? (input.workspaceId === undefined ? undefined : hashWorkspaceId(input.workspaceId));
  if (workspaceHash !== undefined && entry.workspaceHash !== workspaceHash) return false;
  if (input.state !== undefined && entry.state !== input.state) return false;
  const created = Date.parse(entry.createdAt);
  if (input.since !== undefined && created < Date.parse(input.since)) return false;
  if (input.until !== undefined && created > Date.parse(input.until)) return false;
  return true;
}

function compareEntries(left: TaskHistoryEntry, right: TaskHistoryEntry): number {
  const time = Date.parse(right.lastUpdatedAt) - Date.parse(left.lastUpdatedAt);
  if (time !== 0) return time;
  const kind = left.kind.localeCompare(right.kind);
  if (kind !== 0) return kind;
  return left.taskId.localeCompare(right.taskId);
}

function shellResultCode(state: string, exitCode: unknown): string {
  if (state === 'running') return 'RUNNING';
  if (state === 'completed') return exitCode === 0 ? 'SUCCESS' : 'FAILED';
  if (state === 'timed_out') return 'TIMED_OUT';
  if (state === 'cancelled') return 'CANCELLED';
  if (state === 'termination_unverified') return 'TERMINATION_UNVERIFIED';
  return 'FAILED';
}

function remoteResultCode(status: RemoteRolloutTaskSnapshot['status']): string {
  if (status === 'working') return 'RUNNING';
  if (status === 'completed') return 'SUCCESS';
  if (status === 'cancelled') return 'CANCELLED';
  return 'FAILED';
}

function remoteState(status: RemoteRolloutTaskSnapshot['status']): TaskHistoryState {
  return status === 'working' ? 'running' : status;
}

function duration(startedAt: string, finishedAt: string): number | undefined {
  const value = Date.parse(finishedAt) - Date.parse(startedAt);
  return Number.isSafeInteger(value) && value >= 0 && value <= 604_800_000 ? value : undefined;
}

function filterFingerprint(input: Omit<TaskHistoryInput, 'limit' | 'cursor'> & { readonly limit: number }): string {
  return createHash('sha256').update(JSON.stringify({ workspaceHash: input.workspaceHash ?? (input.workspaceId === undefined ? undefined : hashWorkspaceId(input.workspaceId)), state: input.state, since: input.since, until: input.until }), 'utf8').digest('hex').slice(0, 32);
}

function ownerFingerprint(actor: FileActor): string {
  return createHash('sha256').update(`${actor.clientId}\n${actor.sessionId ?? actor.clientId}`, 'utf8').digest('hex').slice(0, 32);
}

function encodeCursor(owner: string, filter: string, offset: number): string {
  return Buffer.from(JSON.stringify({ prefix: CURSOR_PREFIX, owner, filter, offset }), 'utf8').toString('base64url');
}

function decodeCursor(value: string, owner: string, filter: string): number {
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (decoded.prefix !== CURSOR_PREFIX || decoded.owner !== owner || decoded.filter !== filter || typeof decoded.offset !== 'number' || !Number.isSafeInteger(decoded.offset) || decoded.offset < 0) return -1;
    return decoded.offset;
  } catch {
    return -1;
  }
}

function hashWorkspaceId(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32);
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
