import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import type { NativeCapabilityBackend, NativeCapabilityHealth } from './platform/types.js';

export type BackupOperation = 'plan' | 'create' | 'list' | 'verify' | 'restore';
export interface BackupBackendOptions {
  readonly platform?: NodeJS.Platform;
  readonly allowedRootsProvider?: () => Promise<readonly string[]> | readonly string[];
  readonly workspaceRootProvider?: (workspaceId: string) => Promise<string | null> | string | null;
  readonly maxBytes?: number;
  readonly maxEntries?: number;
}

interface BackupEntry {
  readonly path: string;
  readonly type: 'file' | 'directory';
  readonly mode: number;
  readonly bytes: number;
  readonly sha256?: string;
  readonly content?: string;
}
interface BackupBundle {
  readonly format: 'baitonghub-backup';
  readonly version: 1;
  readonly created_at: string;
  readonly source: string;
  readonly entries: readonly BackupEntry[];
}

const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;
const MAX_JSON_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 5_000;

/** Registered-root backup with a self-verifying JSON manifest. It never calls a shell archive utility. */
export class BackupBackend implements NativeCapabilityBackend {
  private readonly platform: NodeJS.Platform;
  private readonly roots: () => Promise<readonly string[]> | readonly string[];
  private readonly workspaceRoot: ((workspaceId: string) => Promise<string | null> | string | null) | undefined;
  private readonly maxBytes: number;
  private readonly maxEntries: number;

  public constructor(options: BackupBackendOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.roots = options.allowedRootsProvider ?? ((): readonly string[] => []);
    this.workspaceRoot = options.workspaceRootProvider;
    this.maxBytes = clamp(options.maxBytes ?? DEFAULT_MAX_BYTES, 1, DEFAULT_MAX_BYTES);
    this.maxEntries = clamp(options.maxEntries ?? DEFAULT_MAX_ENTRIES, 1, DEFAULT_MAX_ENTRIES);
  }

  public async health(): Promise<NativeCapabilityHealth> {
    if (this.platform !== 'linux') return { platform: this.platform, available: false, ready: false, requiresConsent: false, missingDependencies: [], reason: 'platform_unsupported' };
    const ready = this.workspaceRoot !== undefined;
    return { platform: 'linux', available: true, ready, requiresConsent: false, missingDependencies: ready ? [] : ['workspace-provider'], ...(ready ? {} : { reason: 'workspace_root_resolver_missing' }) };
  }

  public async execute(input: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
    if (this.platform !== 'linux') return err(appError('PLATFORM_UNSUPPORTED', 'Backup is available on Linux only', true));
    if (!isRecord(input)) return invalid('backup input must be an object');
    const operation = readOperation(input.operation);
    if (operation === null) return invalid('Unknown backup operation');
    if (signal?.aborted === true) return cancelled();
    if ((operation === 'create' || operation === 'restore') && input.userConfirmed !== true) return err(appError('PERMISSION_REQUIRED', 'Backup mutation requires explicit user confirmation', true));
    if (operation === 'list' || operation === 'verify') {
      const archive = await this.resolveArchive(input.archive ?? input.path);
      if (!archive.ok) return archive;
      const bundle = await this.readBundle(archive.value);
      if (!bundle.ok) return bundle;
      const verified = await verifyBundle(bundle.value, signal);
      if (!verified.ok) return verified;
      return operation === 'list'
        ? ok({ operation, archive: archive.value, version: bundle.value.version, created_at: bundle.value.created_at, source: bundle.value.source, entries: bundle.value.entries.map(publicEntry) })
        : ok({ operation, archive: archive.value, version: bundle.value.version, entries: bundle.value.entries.length, bytes: verified.value.bytes, sha256: verified.value.sha256 });
    }
    if (operation === 'plan' || operation === 'create') {
      const source = await this.resolveWorkspacePath(input.workspaceId, input.source ?? input.path, true);
      if (!source.ok) return source;
      const manifest = await this.collect(source.value.root, source.value.path, signal);
      if (!manifest.ok) return manifest;
      const bundle: BackupBundle = { format: 'baitonghub-backup', version: 1, created_at: new Date().toISOString(), source: relativePath(source.value.root, source.value.path), entries: manifest.value.entries };
      if (operation === 'plan' || input.dry_run === true) return ok({ operation: 'plan', source: bundle.source, version: 1, entries: bundle.entries.map(publicEntry), bytes: manifest.value.bytes, truncated: false });
      const output = await this.resolveArchive(input.archive ?? input.output);
      if (!output.ok) return output;
      const written = await this.writeBundle(output.value, bundle);
      return written.ok ? ok({ operation: 'create', archive: output.value, version: 1, entries: bundle.entries.length, bytes: manifest.value.bytes, sha256: written.value }) : written;
    }
    const archive = await this.resolveArchive(input.archive ?? input.path);
    if (!archive.ok) return archive;
    const bundle = await this.readBundle(archive.value);
    if (!bundle.ok) return bundle;
    const verified = await verifyBundle(bundle.value, signal);
    if (!verified.ok) return verified;
    const destination = await this.resolveWorkspacePath(input.workspaceId, input.destination ?? '.', false);
    if (!destination.ok) return destination;
    if (destination.value.path === destination.value.root) return invalid('Restoring over the registered workspace root is blocked');
    const restored = await this.restoreBundle(bundle.value, destination.value.path, destination.value.root, signal);
    return restored.ok ? ok({ operation: 'restore', archive: archive.value, destination: relativePath(destination.value.root, destination.value.path), entries: bundle.value.entries.length, bytes: verified.value.bytes, sha256: verified.value.sha256 }) : restored;
  }

  private async collect(root: string, source: string, signal?: AbortSignal): Promise<Result<{ readonly entries: readonly BackupEntry[]; readonly bytes: number }>> {
    const sourceStat = await safeLstat(source);
    if (!sourceStat.ok) return sourceStat;
    if (!sourceStat.value.isDirectory() && !sourceStat.value.isFile()) return invalid('Backup source must contain regular files and directories');
    const entries: BackupEntry[] = [];
    let bytes = 0;
    const visit = async (current: string): Promise<Result<void>> => {
      if (signal?.aborted === true) return cancelled();
      if (entries.length >= this.maxEntries) return invalid('Backup contains too many entries');
      const metadata = await safeLstat(current);
      if (!metadata.ok) return metadata;
      if (metadata.value.isSymbolicLink() || (!metadata.value.isDirectory() && !metadata.value.isFile())) return invalid('Backup contains an unsafe symlink or special file');
      const rel = relativePath(root, current);
      if (metadata.value.isDirectory()) {
        entries.push({ path: rel, type: 'directory', mode: Number(metadata.value.mode) & 0o777, bytes: 0 });
        let children: string[];
        try { children = await readdir(current); } catch { return unavailable('Backup directory could not be read'); }
        for (const child of children) { const result = await visit(path.join(current, child)); if (!result.ok) return result; }
        return ok(undefined);
      }
      const size = Number(metadata.value.size);
      bytes += size;
      if (bytes > this.maxBytes) return invalid('Backup exceeds the configured size limit');
      let content: Buffer;
      try { content = await readFile(current); } catch { return unavailable('Backup file could not be read'); }
      const sha256 = createHash('sha256').update(content).digest('hex');
      entries.push({ path: rel, type: 'file', mode: Number(metadata.value.mode) & 0o777, bytes: size, sha256, content: content.toString('base64') });
      return ok(undefined);
    };
    const result = await visit(source);
    return result.ok ? ok({ entries, bytes }) : result;
  }

  private async restoreBundle(bundle: BackupBundle, destination: string, root: string, signal?: AbortSignal): Promise<Result<void>> {
    const parent = path.dirname(destination);
    const staging = path.join(parent, `.baitonghub-restore-${randomUUID()}`);
    const checkpoint = path.join(parent, `.baitonghub-checkpoint-${randomUUID()}`);
    try {
      await mkdir(staging, { recursive: true });
      for (const entry of bundle.entries) {
        if (signal?.aborted === true) return cancelled();
        const target = path.resolve(staging, entry.path);
        if (!isWithin(staging, target)) return invalid('Backup manifest contains a traversal path');
        if (entry.type === 'directory') await mkdir(target, { recursive: true, mode: entry.mode });
        else {
          const parentDir = path.dirname(target); await mkdir(parentDir, { recursive: true });
          if (entry.content === undefined || entry.sha256 === undefined) return invalid('Backup manifest file content is incomplete');
          const content = Buffer.from(entry.content, 'base64');
          if (content.byteLength !== entry.bytes || createHash('sha256').update(content).digest('hex') !== entry.sha256) return invalid('Backup manifest hash verification failed');
          await writeFile(target, content, { mode: entry.mode });
          await chmod(target, entry.mode);
        }
      }
      const stagedReal = await realpath(staging);
      if (!isWithin(root, stagedReal)) return err(appError('PATH_OUTSIDE_WORKSPACE', 'Restore staging escaped the registered root'));
      let hadDestination = false;
      try { await stat(destination); hadDestination = true; } catch { /* new destination */ }
      if (hadDestination) await rename(destination, checkpoint);
      try { await rename(staging, destination); } catch (error) { if (hadDestination) await rename(checkpoint, destination).catch(() => undefined); throw error; }
      if (hadDestination) await rm(checkpoint, { recursive: true, force: true });
      return ok(undefined);
    } catch { await rm(staging, { recursive: true, force: true }).catch(() => undefined); return unavailable('Backup restore could not be completed'); }
  }

  private async resolveWorkspacePath(workspaceIdValue: unknown, requestedValue: unknown, mustExist: boolean): Promise<Result<{ readonly root: string; readonly path: string }>> {
    if (this.workspaceRoot === undefined) return unavailable('Workspace root resolver is not configured');
    if (typeof workspaceIdValue !== 'string' || workspaceIdValue.trim().length === 0 || typeof requestedValue !== 'string' || requestedValue.includes('\0')) return invalid('workspaceId and path are required');
    let configured: string | null;
    try { configured = await this.workspaceRoot(workspaceIdValue); } catch { return unavailable('Workspace root is unavailable'); }
    if (configured === null) return invalid('Workspace is not registered');
    const roots = await this.roots();
    let root: string; try { root = await realpath(configured); } catch { return unavailable('Registered workspace root could not be resolved'); }
    const allowed = await Promise.all(roots.map(async (entry) => { try { return await realpath(entry); } catch { return null; } }));
    if (!allowed.some((entry) => entry !== null && isWithin(entry, root))) return err(appError('PATH_OUTSIDE_WORKSPACE', 'Workspace is outside registered roots'));
    const candidate = path.resolve(root, requestedValue);
    if (!isWithin(root, candidate)) return err(appError('PATH_OUTSIDE_WORKSPACE', 'Path is outside the registered workspace'));
    let resolved: string | null = null;
    try { resolved = await realpath(candidate); } catch { if (mustExist) return err(appError('FILE_NOT_FOUND', 'Path was not found')); const parent = await realpath(path.dirname(candidate)).catch(() => null); if (parent !== null) resolved = path.join(parent, path.basename(candidate)); }
    if (resolved === null || !isWithin(root, resolved)) return err(appError('PATH_OUTSIDE_WORKSPACE', 'Path resolves outside the registered workspace'));
    return ok({ root, path: resolved });
  }

  private async resolveArchive(value: unknown): Promise<Result<string>> {
    if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) return invalid('Backup archive path is required');
    const roots = await this.roots();
    const candidate = path.resolve(value);
    const parent = await realpath(path.dirname(candidate)).catch(() => null);
    if (parent === null) return err(appError('PATH_OUTSIDE_WORKSPACE', 'Backup archive parent does not exist'));
    const resolved = await realpath(candidate).catch(() => path.join(parent, path.basename(candidate)));
    const allowed = await Promise.all(roots.map(async (entry) => realpath(entry).catch(() => null)));
    return allowed.some((root) => root !== null && isWithin(root, resolved)) ? ok(resolved) : err(appError('PATH_OUTSIDE_WORKSPACE', 'Backup archive is outside registered roots'));
  }

  private async readBundle(filename: string): Promise<Result<BackupBundle>> {
    try {
      const data = await readFile(filename);
      if (data.byteLength > MAX_JSON_BYTES) return invalid('Backup manifest is too large');
      const parsed: unknown = JSON.parse(data.toString('utf8'));
      if (!isBundle(parsed)) return invalid('Backup manifest is invalid');
      return ok(parsed);
    } catch { return unavailable('Backup manifest could not be read'); }
  }

  private async writeBundle(filename: string, bundle: BackupBundle): Promise<Result<string>> {
    const temporary = `${filename}.tmp-${randomUUID()}`;
    try {
      const data = Buffer.from(JSON.stringify(bundle));
      if (data.byteLength > MAX_JSON_BYTES) return invalid('Backup manifest is too large');
      await writeFile(temporary, data, { mode: 0o600 }); await rename(temporary, filename);
      return ok(createHash('sha256').update(data).digest('hex'));
    } catch { await rm(temporary, { force: true }).catch(() => undefined); return unavailable('Backup archive could not be written'); }
  }
}

function isBundle(value: unknown): value is BackupBundle {
  if (!isRecord(value) || value.format !== 'baitonghub-backup' || value.version !== 1 || typeof value.created_at !== 'string' || typeof value.source !== 'string' || !Array.isArray(value.entries)) return false;
  return value.entries.every((entry) => isRecord(entry) && typeof entry.path === 'string' && entry.path.length > 0 && !path.isAbsolute(entry.path) && !entry.path.split(/[\\/]/u).includes('..') && (entry.type === 'file' || entry.type === 'directory') && typeof entry.mode === 'number' && Number.isInteger(entry.mode) && entry.mode >= 0 && entry.mode <= 0o777 && typeof entry.bytes === 'number' && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && (entry.type === 'directory' || (typeof entry.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(entry.sha256) && typeof entry.content === 'string')));
}

async function verifyBundle(bundle: BackupBundle, signal?: AbortSignal): Promise<Result<{ readonly bytes: number; readonly sha256: string }>> {
  let bytes = 0; const digest = createHash('sha256');
  for (const entry of bundle.entries) {
    if (signal?.aborted === true) return cancelled();
    if (entry.type === 'file') {
      const content = Buffer.from(entry.content!, 'base64');
      if (content.byteLength !== entry.bytes || createHash('sha256').update(content).digest('hex') !== entry.sha256) return invalid('Backup manifest hash verification failed');
      bytes += content.byteLength; digest.update(content);
    }
  }
  return ok({ bytes, sha256: digest.digest('hex') });
}

function publicEntry(entry: BackupEntry): Record<string, unknown> { return { path: entry.path, type: entry.type, mode: entry.mode, bytes: entry.bytes, ...(entry.sha256 === undefined ? {} : { sha256: entry.sha256 }) }; }
async function safeLstat(filename: string): Promise<Result<Awaited<ReturnType<typeof lstat>>>> { try { return ok(await lstat(filename)); } catch { return unavailable('Backup path could not be inspected'); } }
function readOperation(value: unknown): BackupOperation | null { return typeof value === 'string' && new Set<BackupOperation>(['plan', 'create', 'list', 'verify', 'restore']).has(value as BackupOperation) ? value as BackupOperation : null; }
function clamp(value: number, min: number, max: number): number { return Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : min; }
function isWithin(root: string, candidate: string): boolean { const relative = path.relative(root, candidate); return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); }
function relativePath(root: string, candidate: string): string { const relative = path.relative(root, candidate); return relative.length === 0 ? '.' : relative; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function invalid(message: string): Result<never> { return err(appError('INVALID_INPUT', message)); }
function unavailable(message: string): Result<never> { return err(appError('CAPABILITY_UNAVAILABLE', message, true)); }
function cancelled(): Result<never> { return err(appError('PROCESS_TIMEOUT', 'Backup operation was cancelled', true)); }

export const LinuxBackupBackend = BackupBackend;
