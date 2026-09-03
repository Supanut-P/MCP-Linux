import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import type { FileActor } from '@baitonghub-linux-mcp/application';

const DEFAULT_MAX_ENTRIES = 100;
const MAX_ENTRIES = 1_000;
const MAX_SCAN_ENTRIES = 50_000;
const MAX_SERIALIZED_BYTES = 256 * 1024;
const MAX_HASH_BYTES = 16 * 1024 * 1024;
const CURSOR_VERSION = 1;

export interface WorkspaceSnapshotRootInfo {
  readonly id: string;
  readonly realRootPath: string;
}

export interface WorkspaceSnapshotRootProvider {
  info(actor: FileActor, workspaceId: string): Promise<Result<WorkspaceSnapshotRootInfo>>;
}

export interface WorkspaceSnapshotInput {
  readonly workspaceId: string;
  readonly operation?: 'identity' | 'manifest' | 'diff';
  readonly path?: string;
  readonly maxEntries?: number;
  readonly hashMode?: 'none' | 'sha256';
  readonly cursor?: string;
  readonly baseline?: readonly WorkspaceSnapshotEntry[];
}

export interface WorkspaceSnapshotEntry {
  readonly path: string;
  readonly bytes: number;
  readonly mtimeMs: number;
  readonly sha256?: string;
}

export interface WorkspaceSnapshotOutput {
  readonly workspaceId: string;
  readonly path: string;
  readonly hashMode: 'none' | 'sha256';
  readonly entries: readonly WorkspaceSnapshotEntry[];
  readonly count: number;
  readonly scannedEntries: number;
  readonly truncated: boolean;
  readonly nextCursor?: string;
}

export interface WorkspaceSnapshotDiffOutput {
  readonly operation: 'diff';
  readonly workspaceId: string;
  readonly path: string;
  readonly hashMode: 'none' | 'sha256';
  readonly added: readonly WorkspaceSnapshotEntry[];
  readonly removed: readonly WorkspaceSnapshotEntry[];
  readonly changed: readonly { readonly path: string; readonly before: WorkspaceSnapshotEntry; readonly after: WorkspaceSnapshotEntry }[];
  readonly unchanged: number;
  readonly truncated: boolean;
}

export type WorkspaceSnapshotResult = WorkspaceSnapshotOutput | WorkspaceSnapshotDiffOutput;

interface SnapshotCursor {
  readonly version: 1;
  readonly owner: string;
  readonly filter: string;
  readonly offset: number;
}

interface Candidate {
  readonly path: string;
  readonly bytes: number;
  readonly mtimeMs: number;
  readonly absolutePath: string;
}

export class WorkspaceSnapshotService {
  public constructor(private readonly roots: WorkspaceSnapshotRootProvider) {}

  public async execute(actor: FileActor, input: WorkspaceSnapshotInput, signal?: AbortSignal): Promise<Result<WorkspaceSnapshotResult>> {
    const normalized = normalizeInput(input);
    if (!normalized.ok) return normalized;
    if (signal !== undefined && signal.aborted) return cancelled();
    if (normalized.value.operation === 'diff') return this.executeDiff(actor, normalized.value, signal);

    const rootResult = await this.roots.info(actor, normalized.value.workspaceId);
    if (!rootResult.ok) return rootResult;
    const root = await canonicalRoot(rootResult.value.realRootPath);
    if (!root.ok) return root;
    const requested = path.resolve(root.value, normalized.value.path ?? '.');
    if (!isWithin(root.value, requested)) return err(appError('PATH_OUTSIDE_WORKSPACE', 'Snapshot path is outside the workspace'));
    let start: string;
    try {
      start = await realpath(requested);
    } catch {
      return err(appError('FILE_NOT_FOUND', 'Snapshot path was not found'));
    }
    if (!isWithin(root.value, start)) return err(appError('PATH_OUTSIDE_WORKSPACE', 'Snapshot path is outside the workspace'));
    const startStat = await lstat(start).catch(() => undefined);
    if (startStat === undefined) return err(appError('FILE_NOT_FOUND', 'Snapshot path was not found'));
    if (!startStat.isDirectory()) return err(appError('INVALID_INPUT', 'Snapshot path must be a directory'));

    let cursor: SnapshotCursor | undefined;
    if (normalized.value.cursor !== undefined) {
      const decoded = decodeCursor(normalized.value.cursor, ownerFingerprint(actor), filterFingerprint(normalized.value));
      if (decoded instanceof Error) return err(appError('INVALID_INPUT', decoded.message));
      cursor = decoded;
    }
    const candidates = await collectCandidates(root.value, start, signal);
    if (!candidates.ok) return candidates;
    const offset = cursor?.offset ?? 0;
    if (offset > candidates.value.entries.length) return err(appError('INVALID_INPUT', 'Snapshot cursor is no longer valid'));
    const selected: WorkspaceSnapshotEntry[] = [];
    let truncated = candidates.value.truncated || offset + normalized.value.maxEntries < candidates.value.entries.length;
    for (const candidate of candidates.value.entries.slice(offset, offset + normalized.value.maxEntries)) {
      if (signal !== undefined && signal.aborted) return cancelled();
      const entry = await materialize(candidate, normalized.value.hashMode);
      if (!entry.ok) return entry;
      const next = { workspaceId: normalized.value.workspaceId, path: normalized.value.path ?? '.', hashMode: normalized.value.hashMode, entries: [...selected, entry.value], count: selected.length + 1, scannedEntries: candidates.value.scannedEntries, truncated };
      if (Buffer.byteLength(JSON.stringify(next), 'utf8') > MAX_SERIALIZED_BYTES) {
        truncated = true;
        break;
      }
      selected.push(entry.value);
    }
    const nextOffset = offset + selected.length;
    if (nextOffset < candidates.value.entries.length || candidates.value.truncated) truncated = true;
    const nextCursor = truncated && selected.length > 0
      ? encodeCursor({ version: CURSOR_VERSION, owner: ownerFingerprint(actor), filter: filterFingerprint(normalized.value), offset: nextOffset })
      : undefined;
    return ok({
      workspaceId: normalized.value.workspaceId,
      path: normalized.value.path ?? '.',
      hashMode: normalized.value.hashMode,
      entries: selected,
      count: selected.length,
      scannedEntries: candidates.value.scannedEntries,
      truncated,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    });
  }

  private async executeDiff(actor: FileActor, input: NormalizedSnapshotInput, signal?: AbortSignal): Promise<Result<WorkspaceSnapshotDiffOutput>> {
    const manifest = await this.execute(actor, {
      workspaceId: input.workspaceId,
      operation: 'manifest',
      ...(input.path === undefined ? {} : { path: input.path }),
      maxEntries: MAX_ENTRIES,
      hashMode: input.hashMode,
    }, signal);
    if (!manifest.ok) return manifest;
    if (!('entries' in manifest.value)) return err(appError('CAPABILITY_UNAVAILABLE', 'Workspace diff manifest was unavailable', true));
    const currentManifest = manifest.value;
    const baselineLimited = input.baseline.slice(0, input.maxEntries);
    const currentLimited = currentManifest.entries.slice(0, input.maxEntries);
    const comparisonTruncated = currentManifest.truncated || input.baseline.length > input.maxEntries || currentManifest.entries.length > input.maxEntries;
    const before = new Map(baselineLimited.map((entry) => [entry.path, entry]));
    const after = new Map(currentLimited.map((entry) => [entry.path, entry]));
    const added: WorkspaceSnapshotEntry[] = [];
    const removed: WorkspaceSnapshotEntry[] = [];
    const changed: Array<{ readonly path: string; readonly before: WorkspaceSnapshotEntry; readonly after: WorkspaceSnapshotEntry }> = [];
    let unchanged = 0;
    for (const entry of currentLimited) {
      const prior = before.get(entry.path);
      if (prior === undefined) added.push(entry);
      else if (sameEntry(prior, entry, input.hashMode)) unchanged += 1;
      else changed.push({ path: entry.path, before: prior, after: entry });
    }
    if (!comparisonTruncated) for (const entry of baselineLimited) if (!after.has(entry.path)) removed.push(entry);
    let output: WorkspaceSnapshotDiffOutput = {
      operation: 'diff',
      workspaceId: input.workspaceId,
      path: input.path ?? '.',
      hashMode: input.hashMode,
      added,
      removed,
      changed,
      unchanged,
      truncated: comparisonTruncated,
    };
    while (Buffer.byteLength(JSON.stringify(output), 'utf8') > MAX_SERIALIZED_BYTES && (output.added.length > 0 || output.removed.length > 0 || output.changed.length > 0)) {
      const nextAdded = output.added.slice(0, -1);
      const nextRemoved = output.removed.slice(0, -1);
      const nextChanged = output.changed.slice(0, -1);
      output = { ...output, added: nextAdded, removed: nextRemoved, changed: nextChanged, truncated: true };
    }
    return ok(output);
  }
}

type NormalizedSnapshotInput = Required<Pick<WorkspaceSnapshotInput, 'workspaceId' | 'maxEntries' | 'hashMode' | 'operation' | 'baseline'>> & Pick<WorkspaceSnapshotInput, 'path' | 'cursor'>;

function normalizeInput(input: WorkspaceSnapshotInput): Result<NormalizedSnapshotInput> {
  if (typeof input !== 'object' || input === null || typeof input.workspaceId !== 'string' || input.workspaceId.trim().length === 0 || input.workspaceId.length > 128) {
    return err(appError('INVALID_INPUT', 'Snapshot workspaceId is invalid'));
  }
  const operation = input.operation ?? 'manifest';
  if (operation !== 'manifest' && operation !== 'diff') return err(appError('INVALID_INPUT', 'Snapshot operation must be manifest or diff'));
  const maxEntries = input.maxEntries ?? (operation === 'diff' ? MAX_ENTRIES : DEFAULT_MAX_ENTRIES);
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_ENTRIES) return err(appError('INVALID_INPUT', 'Snapshot maxEntries is invalid'));
  const hashMode = input.hashMode ?? 'none';
  if (hashMode !== 'none' && hashMode !== 'sha256') return err(appError('INVALID_INPUT', 'Snapshot hashMode is invalid'));
  if (input.path !== undefined && (typeof input.path !== 'string' || input.path.length === 0 || input.path.length > 4096 || input.path.includes('\0'))) {
    return err(appError('INVALID_INPUT', 'Snapshot path is invalid'));
  }
  if (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length < 8 || input.cursor.length > 512)) {
    return err(appError('INVALID_INPUT', 'Snapshot cursor is invalid'));
  }
  if (operation === 'diff' && input.cursor !== undefined) return err(appError('INVALID_INPUT', 'Snapshot diff does not support a cursor'));
  if (operation === 'diff' && !Array.isArray(input.baseline)) return err(appError('INVALID_INPUT', 'Snapshot diff baseline is required'));
  if (operation === 'manifest' && input.baseline !== undefined) return err(appError('INVALID_INPUT', 'Snapshot baseline requires operation=diff'));
  const baseline: WorkspaceSnapshotEntry[] = operation === 'diff' ? [...input.baseline!] : [];
  if (baseline.length > MAX_ENTRIES || baseline.some((entry) => !isValidBaselineEntry(entry))) return err(appError('INVALID_INPUT', 'Snapshot diff baseline is invalid'));
  const paths = new Set(baseline.map((entry) => entry.path));
  if (paths.size !== baseline.length) return err(appError('INVALID_INPUT', 'Snapshot diff baseline contains duplicate paths'));
  baseline.sort((left, right) => left.path.localeCompare(right.path));
  return ok({ workspaceId: input.workspaceId.trim(), maxEntries, hashMode, operation, baseline, ...(input.path === undefined ? {} : { path: input.path }), ...(input.cursor === undefined ? {} : { cursor: input.cursor }) });
}

function isValidBaselineEntry(value: unknown): value is WorkspaceSnapshotEntry {
  if (!isRecord(value) || typeof value.path !== 'string' || value.path.length === 0 || value.path.length > 4096 || value.path.includes('\0')) return false;
  if (path.posix.isAbsolute(value.path) || path.win32.isAbsolute(value.path) || value.path.includes('\\') || value.path.split('/').some((part) => part.length === 0 || part === '.' || part === '..')) return false;
  if (typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || typeof value.mtimeMs !== 'number' || !Number.isFinite(value.mtimeMs)) return false;
  return value.sha256 === undefined || (typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(value.sha256));
}

function sameEntry(before: WorkspaceSnapshotEntry, after: WorkspaceSnapshotEntry, hashMode: 'none' | 'sha256'): boolean {
  if (before.bytes !== after.bytes || before.mtimeMs !== after.mtimeMs) return false;
  return hashMode === 'none' || before.sha256 === undefined || after.sha256 === undefined || before.sha256 === after.sha256;
}

async function canonicalRoot(rootPath: string): Promise<Result<string>> {
  try {
    const canonical = await realpath(rootPath);
    const details = await stat(canonical);
    return details.isDirectory() ? ok(canonical) : err(appError('WORKSPACE_NOT_FOUND', 'Workspace root is not a directory'));
  } catch {
    return err(appError('WORKSPACE_NOT_FOUND', 'Workspace root was not found'));
  }
}

async function collectCandidates(root: string, start: string, signal?: AbortSignal): Promise<Result<{ readonly entries: readonly Candidate[]; readonly scannedEntries: number; readonly truncated: boolean }>> {
  const entries: Candidate[] = [];
  let scannedEntries = 0;
  let truncated = false;
  const visit = async (directory: string): Promise<Result<void>> => {
    if (signal !== undefined && signal.aborted) return cancelled();
    let children;
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch {
      return err(appError('CAPABILITY_UNAVAILABLE', 'Workspace snapshot directory could not be read', true));
    }
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (signal !== undefined && signal.aborted) return cancelled();
      scannedEntries += 1;
      if (scannedEntries > MAX_SCAN_ENTRIES) {
        truncated = true;
        return ok(undefined);
      }
      const absolute = path.join(directory, child.name);
      const relative = normalizeRelative(path.relative(root, absolute));
      const metadata = await lstat(absolute).catch(() => undefined);
      if (metadata === undefined) return err(appError('CAPABILITY_UNAVAILABLE', 'Workspace snapshot changed during scan', true));
      if (metadata.isSymbolicLink()) {
        const target = await realpath(absolute).catch(() => undefined);
        if (target !== undefined && !isWithin(root, target)) return err(appError('PATH_OUTSIDE_WORKSPACE', 'Workspace snapshot found a symlink escape'));
        continue;
      }
      if (metadata.isDirectory()) {
        const canonical = await realpath(absolute).catch(() => undefined);
        if (canonical === undefined) return err(appError('CAPABILITY_UNAVAILABLE', 'Workspace snapshot changed during scan', true));
        if (!isWithin(root, canonical)) return err(appError('PATH_OUTSIDE_WORKSPACE', 'Workspace snapshot found a directory escape'));
        const nested = await visit(canonical);
        if (!nested.ok) return nested;
        continue;
      }
      if (!metadata.isFile()) return err(appError('CAPABILITY_UNAVAILABLE', 'Workspace snapshot encountered an unsupported file type', true));
      const canonical = await realpath(absolute).catch(() => undefined);
      if (canonical === undefined || !isWithin(root, canonical)) return err(appError('PATH_OUTSIDE_WORKSPACE', 'Workspace snapshot found a file escape'));
      const latest = await stat(canonical).catch(() => undefined);
      if (latest === undefined || !latest.isFile()) return err(appError('CAPABILITY_UNAVAILABLE', 'Workspace snapshot file changed during scan', true));
      entries.push({ path: relative, bytes: latest.size, mtimeMs: latest.mtimeMs, absolutePath: canonical });
    }
    return ok(undefined);
  };
  const result = await visit(start);
  if (!result.ok) return result;
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return ok({ entries, scannedEntries, truncated });
}

async function materialize(candidate: Candidate, hashMode: 'none' | 'sha256'): Promise<Result<WorkspaceSnapshotEntry>> {
  if (hashMode === 'none') return ok({ path: candidate.path, bytes: candidate.bytes, mtimeMs: candidate.mtimeMs });
  if (candidate.bytes > MAX_HASH_BYTES) return ok({ path: candidate.path, bytes: candidate.bytes, mtimeMs: candidate.mtimeMs });
  try {
    const contents = await readFile(candidate.absolutePath);
    return ok({ path: candidate.path, bytes: candidate.bytes, mtimeMs: candidate.mtimeMs, sha256: createHash('sha256').update(contents).digest('hex') });
  } catch {
    return err(appError('CAPABILITY_UNAVAILABLE', 'Workspace snapshot hash could not be computed', true));
  }
}

function decodeCursor(value: string, owner: string, filter: string): SnapshotCursor | Error {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!isRecord(parsed) || parsed.version !== CURSOR_VERSION || parsed.owner !== owner || parsed.filter !== filter || typeof parsed.offset !== 'number' || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0) return new Error('Snapshot cursor is invalid');
    return { version: CURSOR_VERSION, owner, filter, offset: parsed.offset };
  } catch {
    return new Error('Snapshot cursor is invalid');
  }
}

function encodeCursor(cursor: SnapshotCursor): string { return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url'); }
function ownerFingerprint(actor: FileActor): string { return createHash('sha256').update(`${actor.clientId}\0${actor.sessionId ?? ''}`).digest('hex').slice(0, 32); }
function filterFingerprint(input: { readonly workspaceId: string; readonly path?: string; readonly maxEntries: number; readonly hashMode: string }): string { return createHash('sha256').update(JSON.stringify({ workspaceId: input.workspaceId, path: input.path ?? '.', maxEntries: input.maxEntries, hashMode: input.hashMode })).digest('hex').slice(0, 32); }
function normalizeRelative(value: string): string { return value.split(path.sep).filter((part) => part.length > 0).join('/'); }
function isWithin(root: string, candidate: string): boolean { const relative = path.relative(path.resolve(root), path.resolve(candidate)); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); }
function cancelled(): Result<never> { return err(appError('PROCESS_TIMEOUT', 'Workspace snapshot was cancelled', true)); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
