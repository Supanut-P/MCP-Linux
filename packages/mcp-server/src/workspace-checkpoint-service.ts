import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import type { FileActor } from '@baitonghub-linux-mcp/application';
import type {
  WorkspaceCheckpointEntry,
  WorkspaceCheckpointRecord,
  WorkspaceCheckpointRepository,
} from '@baitonghub-linux-mcp/workspace';
import type { WorkspaceSnapshotResult } from './workspace-snapshot-service.js';

const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 32;
const DEFAULT_MAX_ENTRIES = 100;
const MAX_ENTRIES = 1_000;
const MAX_CHECKPOINT_BYTES = 256 * 1024;
const MAX_OWNER_BYTES = 2 * 1024 * 1024;
const MAX_OWNER_RECORDS = 32;

export interface WorkspaceCheckpointManifestProvider {
  execute(
    actor: FileActor,
    input: {
      readonly workspaceId: string;
      readonly operation: 'manifest' | 'diff';
      readonly path?: string;
      readonly maxEntries?: number;
      readonly hashMode?: 'none';
      readonly baseline?: readonly WorkspaceCheckpointEntry[];
    },
    signal?: AbortSignal,
  ): Promise<Result<WorkspaceSnapshotResult>>;
}

export interface WorkspaceCheckpointInput {
  readonly operation?: 'create' | 'list' | 'get' | 'diff' | 'compare' | 'delete';
  readonly workspaceId?: string;
  readonly path?: string;
  readonly name?: string;
  readonly maxEntries?: number;
  readonly ttlSeconds?: number;
  readonly checkpointId?: string;
  readonly otherCheckpointId?: string;
  readonly limit?: number;
}

export interface WorkspaceCheckpointSummary {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly path: string;
  readonly count: number;
  readonly scannedEntries: number;
  readonly truncated: boolean;
}

export interface WorkspaceCheckpointDetail extends WorkspaceCheckpointSummary {
  readonly entries: readonly WorkspaceCheckpointEntry[];
}

export type WorkspaceCheckpointOutput =
  | { readonly operation: 'create' | 'get'; readonly checkpoint: WorkspaceCheckpointDetail }
  | { readonly operation: 'diff'; readonly checkpointId: string; readonly workspaceId: string; readonly diff: Extract<WorkspaceSnapshotResult, { readonly operation: 'diff' }> }
  | { readonly operation: 'compare'; readonly checkpointId: string; readonly otherCheckpointId: string; readonly workspaceId: string; readonly diff: Extract<WorkspaceSnapshotResult, { readonly operation: 'diff' }> }
  | { readonly operation: 'list'; readonly checkpoints: readonly WorkspaceCheckpointSummary[]; readonly count: number; readonly truncated: boolean }
  | { readonly operation: 'delete'; readonly checkpointId: string; readonly deleted: true };

export interface WorkspaceCheckpointServiceOptions {
  readonly now?: () => Date;
}

export class WorkspaceCheckpointService {
  private readonly now: () => Date;

  public constructor(
    private readonly repository: WorkspaceCheckpointRepository,
    private readonly manifest: WorkspaceCheckpointManifestProvider,
    options: WorkspaceCheckpointServiceOptions = {},
  ) {
    this.now = options.now ?? ((): Date => new Date());
  }

  public async execute(actor: FileActor, input: WorkspaceCheckpointInput, signal?: AbortSignal): Promise<Result<WorkspaceCheckpointOutput>> {
    const normalized = normalizeInput(input);
    if (!normalized.ok) return normalized;
    if (signal?.aborted === true) return err(appError('PROCESS_TIMEOUT', 'Workspace checkpoint was cancelled', true));
    const ownerKey = ownerFingerprint(actor);
    const now = this.now().toISOString();
    try {
      await this.repository.pruneExpired(ownerKey, now);
      if (normalized.value.operation === 'create') return await this.create(actor, ownerKey, normalized.value, now, signal);
      if (normalized.value.operation === 'list') return await this.list(ownerKey, normalized.value, now);
      const checkpoint = await this.repository.get(ownerKey, normalized.value.checkpointId);
      if (normalized.value.operation === 'get') {
        return checkpoint === null ? err(appError('FILE_NOT_FOUND', 'Workspace checkpoint was not found')) : ok({ operation: 'get', checkpoint: toDetail(checkpoint) });
      }
      if (checkpoint === null) return err(appError('FILE_NOT_FOUND', 'Workspace checkpoint was not found'));
      if (normalized.value.operation === 'diff') return await this.diff(actor, normalized.value, checkpoint, signal);
      if (normalized.value.operation === 'compare') {
        const other = await this.repository.get(ownerKey, normalized.value.otherCheckpointId);
        if (other === null) return err(appError('FILE_NOT_FOUND', 'Workspace checkpoint was not found'));
        if (other.workspaceId !== checkpoint.workspaceId || other.path !== checkpoint.path) {
          return err(appError('INVALID_INPUT', 'Workspace checkpoints must share a workspace and path'));
        }
        return ok({ operation: 'compare', checkpointId: checkpoint.id, otherCheckpointId: other.id, workspaceId: checkpoint.workspaceId, diff: compareEntries(checkpoint, other, normalized.value.maxEntries) });
      }
      const deleted = await this.repository.delete(ownerKey, normalized.value.checkpointId);
      return deleted ? ok({ operation: 'delete', checkpointId: normalized.value.checkpointId, deleted: true }) : err(appError('FILE_NOT_FOUND', 'Workspace checkpoint was not found'));
    } catch {
      return err(appError('CAPABILITY_UNAVAILABLE', 'Workspace checkpoint storage is unavailable', true));
    }
  }

  private async create(actor: FileActor, ownerKey: string, input: NormalizedCreateInput, now: string, signal?: AbortSignal): Promise<Result<WorkspaceCheckpointOutput>> {
    const recordCount = await this.repository.count(ownerKey);
    if (recordCount >= MAX_OWNER_RECORDS) return err(appError('QUOTA_EXCEEDED', 'Workspace checkpoint quota is full', true));
    const snapshot = await this.manifest.execute(actor, {
      workspaceId: input.workspaceId,
      operation: 'manifest',
      ...(input.path === undefined ? {} : { path: input.path }),
      maxEntries: input.maxEntries,
      hashMode: 'none',
    }, signal);
    if (!snapshot.ok) return snapshot;
    if (!('entries' in snapshot.value)) return err(appError('CAPABILITY_UNAVAILABLE', 'Workspace checkpoint manifest is unavailable', true));
    const entries: WorkspaceCheckpointEntry[] = [];
    for (const entry of snapshot.value.entries.slice(0, input.maxEntries)) {
      if (!isSafeEntry(entry)) return err(appError('CAPABILITY_UNAVAILABLE', 'Workspace checkpoint manifest contained invalid metadata', true));
      entries.push({
        path: entry.path,
        bytes: entry.bytes,
        mtimeMs: entry.mtimeMs,
        ...(entry.sha256 === undefined ? {} : { sha256: entry.sha256 }),
      });
    }
    const serializedBytes = Buffer.byteLength(JSON.stringify(entries), 'utf8');
    if (serializedBytes > MAX_CHECKPOINT_BYTES) return err(appError('FILE_TOO_LARGE', 'Workspace checkpoint manifest is too large'));
    const existingBytes = await this.repository.totalBytes(ownerKey);
    if (existingBytes > MAX_OWNER_BYTES - serializedBytes) return err(appError('QUOTA_EXCEEDED', 'Workspace checkpoint storage quota is full', true));
    const createdAt = now;
    const record: WorkspaceCheckpointRecord = {
      id: randomUUID(),
      ownerKey,
      workspaceId: input.workspaceId,
      name: input.name,
      createdAt,
      expiresAt: new Date(this.now().getTime() + input.ttlSeconds * 1000).toISOString(),
      path: input.path ?? '.',
      entries,
      scannedEntries: snapshot.value.scannedEntries,
      truncated: snapshot.value.truncated || snapshot.value.entries.length > entries.length,
    };
    await this.repository.insert(record);
    return ok({ operation: 'create', checkpoint: toDetail(record) });
  }

  private async list(ownerKey: string, input: NormalizedListInput, now: string): Promise<Result<WorkspaceCheckpointOutput>> {
    const records = await this.repository.list(ownerKey, input.workspaceId, input.limit + 1);
    const visible = records.filter((record) => record.expiresAt > now);
    const truncated = visible.length > input.limit;
    const checkpoints = visible.slice(0, input.limit).map(toSummary);
    return ok({ operation: 'list', checkpoints, count: checkpoints.length, truncated });
  }

  private async diff(
    actor: FileActor,
    input: NormalizedDiffInput,
    checkpoint: WorkspaceCheckpointRecord,
    signal?: AbortSignal,
  ): Promise<Result<WorkspaceCheckpointOutput>> {
    const snapshot = await this.manifest.execute(actor, {
      workspaceId: checkpoint.workspaceId,
      operation: 'diff',
      path: checkpoint.path,
      maxEntries: input.maxEntries,
      hashMode: 'none',
      baseline: checkpoint.entries,
    }, signal);
    if (!snapshot.ok) return snapshot;
    if (!('operation' in snapshot.value) || snapshot.value.operation !== 'diff') {
      return err(appError('CAPABILITY_UNAVAILABLE', 'Workspace checkpoint diff was unavailable', true));
    }
    return ok({ operation: 'diff', checkpointId: checkpoint.id, workspaceId: checkpoint.workspaceId, diff: snapshot.value });
  }
}

type NormalizedCreateInput = {
  readonly operation: 'create';
  readonly workspaceId: string;
  readonly path?: string;
  readonly name: string;
  readonly maxEntries: number;
  readonly ttlSeconds: number;
};
type NormalizedListInput = { readonly operation: 'list'; readonly workspaceId?: string; readonly limit: number };
type NormalizedDiffInput = { readonly operation: 'diff'; readonly checkpointId: string; readonly maxEntries: number };
type NormalizedCompareInput = { readonly operation: 'compare'; readonly checkpointId: string; readonly otherCheckpointId: string; readonly maxEntries: number };
type NormalizedLookupInput = { readonly operation: 'get' | 'delete'; readonly checkpointId: string };
type NormalizedInput = NormalizedCreateInput | NormalizedListInput | NormalizedDiffInput | NormalizedCompareInput | NormalizedLookupInput;

function normalizeInput(input: WorkspaceCheckpointInput): Result<NormalizedInput> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return err(appError('INVALID_INPUT', 'Workspace checkpoint input is invalid'));
  const operation = input.operation ?? 'create';
  if (operation === 'create') {
    if (input.checkpointId !== undefined || input.otherCheckpointId !== undefined) return err(appError('INVALID_INPUT', 'Workspace checkpoint create does not accept checkpoint IDs'));
    if (!isSafeWorkspaceId(input.workspaceId)) return err(appError('INVALID_INPUT', 'Workspace checkpoint workspaceId is invalid'));
    const pathResult = normalizePath(input.path);
    if (!pathResult.ok) return pathResult;
    const name = input.name?.trim() || 'checkpoint';
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) return err(appError('INVALID_INPUT', 'Workspace checkpoint name is invalid'));
    const maxEntries = input.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_ENTRIES) return err(appError('INVALID_INPUT', 'Workspace checkpoint maxEntries is invalid'));
    const ttlSeconds = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < MIN_TTL_SECONDS || ttlSeconds > MAX_TTL_SECONDS) return err(appError('INVALID_INPUT', 'Workspace checkpoint ttlSeconds is invalid'));
    return ok({ operation, workspaceId: input.workspaceId.trim(), ...(pathResult.value === undefined ? {} : { path: pathResult.value }), name, maxEntries, ttlSeconds });
  }
  if (operation === 'list') {
    if (input.otherCheckpointId !== undefined || input.checkpointId !== undefined) return err(appError('INVALID_INPUT', 'Workspace checkpoint list does not accept checkpoint IDs'));
    if (input.workspaceId !== undefined && !isSafeWorkspaceId(input.workspaceId)) return err(appError('INVALID_INPUT', 'Workspace checkpoint workspaceId is invalid'));
    const limit = input.limit ?? DEFAULT_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) return err(appError('INVALID_INPUT', 'Workspace checkpoint limit is invalid'));
    return ok({ operation, ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId.trim() }), limit });
  }
  if (!isSafeId(input.checkpointId)) return err(appError('INVALID_INPUT', 'Workspace checkpoint id is invalid'));
  if (operation === 'diff') {
    if (input.workspaceId !== undefined || input.path !== undefined || input.name !== undefined || input.ttlSeconds !== undefined || input.limit !== undefined || input.otherCheckpointId !== undefined) {
      return err(appError('INVALID_INPUT', 'Workspace checkpoint diff accepts checkpointId and maxEntries only'));
    }
    const maxEntries = input.maxEntries ?? MAX_ENTRIES;
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_ENTRIES) return err(appError('INVALID_INPUT', 'Workspace checkpoint maxEntries is invalid'));
    return ok({ operation, checkpointId: input.checkpointId, maxEntries });
  }
  if (operation === 'compare') {
    if (!isSafeId(input.otherCheckpointId)) return err(appError('INVALID_INPUT', 'Workspace checkpoint other id is invalid'));
    if (input.workspaceId !== undefined || input.path !== undefined || input.name !== undefined || input.ttlSeconds !== undefined || input.limit !== undefined) {
      return err(appError('INVALID_INPUT', 'Workspace checkpoint compare accepts checkpointId, otherCheckpointId, and maxEntries only'));
    }
    const maxEntries = input.maxEntries ?? MAX_ENTRIES;
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_ENTRIES) return err(appError('INVALID_INPUT', 'Workspace checkpoint maxEntries is invalid'));
    return ok({ operation, checkpointId: input.checkpointId, otherCheckpointId: input.otherCheckpointId, maxEntries });
  }
  if (input.workspaceId !== undefined || input.path !== undefined || input.name !== undefined || input.maxEntries !== undefined || input.ttlSeconds !== undefined || input.otherCheckpointId !== undefined || input.limit !== undefined) {
    return err(appError('INVALID_INPUT', `${operation} accepts checkpointId only`));
  }
  return ok({ operation, checkpointId: input.checkpointId });
}

function normalizePath(value: unknown): Result<string | undefined> {
  if (value === undefined) return ok(undefined);
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || value.includes('\0')) return err(appError('INVALID_INPUT', 'Workspace checkpoint path is invalid'));
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || value.split(/[\\/]/).some((part) => part === '..')) return err(appError('PATH_OUTSIDE_WORKSPACE', 'Workspace checkpoint path must stay inside the workspace'));
  return ok(value);
}

function isSafeWorkspaceId(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= 128 && !value.includes('\0'); }
function isSafeId(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(value); }
function isSafeEntry(value: unknown): value is WorkspaceCheckpointEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.path === 'string'
    && entry.path.length > 0 && entry.path.length <= 4096 && !entry.path.includes('\0')
    && !path.posix.isAbsolute(entry.path) && !path.win32.isAbsolute(entry.path)
    && !entry.path.includes('\\') && entry.path.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
    && typeof entry.bytes === 'number' && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0
    && typeof entry.mtimeMs === 'number' && Number.isFinite(entry.mtimeMs)
    && (entry.sha256 === undefined || (typeof entry.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(entry.sha256)));
}

function compareEntries(
  before: WorkspaceCheckpointRecord,
  after: WorkspaceCheckpointRecord,
  maxEntries: number,
): Extract<WorkspaceSnapshotResult, { readonly operation: 'diff' }> {
  const baseline = before.entries.slice(0, maxEntries);
  const current = after.entries.slice(0, maxEntries);
  const comparisonTruncated = before.truncated || after.truncated || before.entries.length > maxEntries || after.entries.length > maxEntries;
  const baselineByPath = new Map(baseline.map((entry) => [entry.path, entry]));
  const currentByPath = new Map(current.map((entry) => [entry.path, entry]));
  const added: WorkspaceCheckpointEntry[] = [];
  const removed: WorkspaceCheckpointEntry[] = [];
  const changed: Array<{ readonly path: string; readonly before: WorkspaceCheckpointEntry; readonly after: WorkspaceCheckpointEntry }> = [];
  let unchanged = 0;
  for (const entry of current) {
    const prior = baselineByPath.get(entry.path);
    if (prior === undefined) added.push(entry);
    else if (sameEntry(prior, entry)) unchanged += 1;
    else changed.push({ path: entry.path, before: prior, after: entry });
  }
  if (!comparisonTruncated) for (const entry of baseline) if (!currentByPath.has(entry.path)) removed.push(entry);
  let output: Extract<WorkspaceSnapshotResult, { readonly operation: 'diff' }> = {
    operation: 'diff',
    workspaceId: after.workspaceId,
    path: after.path,
    hashMode: 'none',
    added,
    removed,
    changed,
    unchanged,
    truncated: comparisonTruncated,
  };
  while (Buffer.byteLength(JSON.stringify(output), 'utf8') > MAX_CHECKPOINT_BYTES && (output.added.length > 0 || output.removed.length > 0 || output.changed.length > 0)) {
    output = { ...output, added: output.added.slice(0, -1), removed: output.removed.slice(0, -1), changed: output.changed.slice(0, -1), truncated: true };
  }
  return output;
}

function sameEntry(before: WorkspaceCheckpointEntry, after: WorkspaceCheckpointEntry): boolean {
  return before.bytes === after.bytes && before.mtimeMs === after.mtimeMs
    && (before.sha256 === undefined || after.sha256 === undefined || before.sha256 === after.sha256);
}

function ownerFingerprint(actor: FileActor): string { return createHash('sha256').update(`${actor.clientId}\0${actor.sessionId ?? ''}`).digest('hex'); }
function toSummary(record: WorkspaceCheckpointRecord): WorkspaceCheckpointSummary { return { id: record.id, workspaceId: record.workspaceId, name: record.name, createdAt: record.createdAt, expiresAt: record.expiresAt, path: record.path, count: record.entries.length, scannedEntries: record.scannedEntries, truncated: record.truncated }; }
function toDetail(record: WorkspaceCheckpointRecord): WorkspaceCheckpointDetail { return { ...toSummary(record), entries: record.entries }; }
