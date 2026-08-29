import { access, lstat, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import { PathExecutableResolver } from '@baitonghub-linux-mcp/process';
import type { NativeCapabilityBackend, NativeCapabilityHealth } from './platform/types.js';
import { LinuxCommandRunner } from './linux-command-runner.js';

export type ArchiveOperation = 'list' | 'extract-plan' | 'extract' | 'create';
export interface ArchiveBackendOptions {
  readonly platform?: NodeJS.Platform;
  readonly resolveExecutable?: (name: string) => Promise<string | null>;
  readonly runner?: LinuxCommandRunner;
  readonly allowedRootsProvider?: () => Promise<readonly string[]> | readonly string[];
}

const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_MEMBERS = 100_000;

/** Bounded archive inspection/extraction. Every path is resolved inside a registered root. */
export class ArchiveBackend implements NativeCapabilityBackend {
  private readonly platform: NodeJS.Platform;
  private readonly resolveExecutable: (name: string) => Promise<string | null>;
  private readonly runner: LinuxCommandRunner;
  private readonly roots: () => Promise<readonly string[]> | readonly string[];

  public constructor(options: ArchiveBackendOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.resolveExecutable = options.resolveExecutable ?? ((name: string): Promise<string | null> => new PathExecutableResolver().resolve(name).then((result) => result.ok ? result.value : null));
    this.runner = options.runner ?? new LinuxCommandRunner({ allowedExecutables: ['tar', 'unzip', 'zip'], maxBytes: 8 * 1024 * 1024 });
    this.roots = options.allowedRootsProvider ?? ((): readonly string[] => []);
  }

  public async health(): Promise<NativeCapabilityHealth> {
    if (this.platform !== 'linux') return { platform: this.platform, available: false, ready: false, requiresConsent: false, missingDependencies: [], reason: 'platform_unsupported' };
    const names = ['tar', 'unzip', 'zip'];
    const resolved = await Promise.all(names.map(async (name) => ({ name, value: await this.resolveExecutable(name) })));
    const missing = resolved.filter((item) => item.value === null).map((item) => item.name);
    return { platform: 'linux', provider: 'tar/unzip/zip', available: missing.length < names.length, ready: missing.length < names.length, requiresConsent: false, missingDependencies: missing, ...(missing.length === names.length ? { reason: 'missing_dependencies' } : {}) };
  }

  public async execute(input: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
    if (this.platform !== 'linux') return err(appError('PLATFORM_UNSUPPORTED', 'Archive operations are available on Linux only', true));
    if (!isRecord(input)) return invalid('Archive input must be an object');
    const operation = readOperation(input.operation);
    if (operation === null) return invalid('Unknown archive operation');
    if (signal?.aborted === true) return cancelled();
    if (operation === 'create') return this.create(input, signal);
    const archive = await this.resolveExisting(input.archive ?? input.path);
    if (!archive.ok) return archive;
    const members = await this.inspectArchive(archive.value, signal);
    if (!members.ok) return members;
    if (operation === 'list' || operation === 'extract-plan') return ok({ operation, archive: archive.value, members: members.value.members, member_count: members.value.members.length, total_bytes: members.value.totalBytes, provider: members.value.provider });
    const destination = await this.resolveDirectory(input.destination ?? input.destinationPath ?? '.');
    if (!destination.ok) return destination;
    const overwrite = await hasExistingMember(destination.value, members.value.members);
    if (!overwrite.ok) return overwrite;
    if (overwrite.value && input.userConfirmed !== true) return err(appError('PERMISSION_REQUIRED', 'Archive extraction overwriting existing files requires explicit user confirmation', true));
    if (input.dry_run === true) return ok({ dry_run: true, operation, archive: archive.value, destination: destination.value, overwrites: overwrite.value });
    const executable = await this.resolveExecutable(members.value.provider === 'zip' ? 'unzip' : 'tar');
    if (executable === null) return unavailable();
    const args = members.value.provider === 'zip'
      ? ['-q', archive.value, '-d', destination.value]
      : ['--extract', '--file', archive.value, '--directory', destination.value, '--no-same-owner', '--no-same-permissions', '--no-overwrite-dir'];
    return this.run(executable, args, operation, members.value.provider, signal);
  }

  private async inspectArchive(archive: string, signal?: AbortSignal): Promise<Result<{ readonly members: readonly string[]; readonly totalBytes: number; readonly provider: 'tar' | 'zip' }>> {
    let archiveStats;
    try { archiveStats = await stat(archive); } catch { return err(appError('FILE_NOT_FOUND', 'Archive was not found')); }
    if (archiveStats.size > MAX_ARCHIVE_BYTES) return invalid('Archive exceeds the 2 GiB size limit');
    const provider = archive.toLowerCase().endsWith('.zip') ? 'zip' : 'tar';
    const executable = await this.resolveExecutable(provider === 'zip' ? 'unzip' : 'tar');
    if (executable === null) return unavailable();
    const args = provider === 'zip' ? ['-Z', '-v', archive] : ['--list', '--verbose', '--file', archive];
    try {
      const result = await this.runner.run(executable, args, signal);
      if (signal?.aborted === true) return cancelled();
      if (result.exitCode !== 0) return unavailable();
      if (result.truncated) return err(appError('FILE_TOO_LARGE', 'Archive listing exceeded the bounded output limit'));
      const listing = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const validation = validateArchiveMembers(listing);
      if (!validation.ok) return validation;
      const members = provider === 'tar' ? listing.map(parseTarMemberName) : parseZipMemberNames(listing);
      if (members.length > MAX_MEMBERS) return invalid('Archive exceeds the 100,000-member limit');
      const memberValidation = validateArchiveMembers(members);
      if (!memberValidation.ok) return memberValidation;
      const totalBytes = listing.reduce((total, line) => total + (provider === 'tar' ? parseTarMemberSize(line) : parseZipMemberSize(line)), 0);
      if (totalBytes > MAX_ARCHIVE_BYTES) return err(appError('FILE_TOO_LARGE', 'Archive expands beyond the 2 GiB size limit'));
      return ok({ members, totalBytes, provider });
    } catch { return unavailable(); }
  }

  private async create(input: Record<string, unknown>, signal?: AbortSignal): Promise<Result<unknown>> {
    const source = await this.resolveExisting(input.source ?? input.directory);
    if (!source.ok) return source;
    const outputValue = input.output ?? input.archive;
    if (typeof outputValue !== 'string' || outputValue.trim().length === 0) return invalid('Archive output is required');
    const output = await this.resolveNewPath(outputValue);
    if (!output.ok) return output;
    const lower = output.value.toLowerCase();
    const format = lower.endsWith('.zip') ? 'zip' : lower.endsWith('.tar.gz') || lower.endsWith('.tgz') ? 'tar-gz' : lower.endsWith('.tar') ? 'tar' : null;
    if (format === null) return invalid('Archive format must be .tar, .tar.gz, .tgz, or .zip');
    if (signal?.aborted === true) return cancelled();
    const executableName = format === 'zip' ? 'zip' : 'tar';
    const executable = await this.resolveExecutable(executableName);
    if (executable === null) return unavailable();
    const args = format === 'zip' ? ['-q', '-r', output.value, source.value] : [format === 'tar-gz' ? '-czf' : '-cf', output.value, source.value];
    return this.run(executable, args, 'create', format === 'zip' ? 'zip' : 'tar', signal);
  }

  private async resolveExisting(value: unknown): Promise<Result<string>> {
    if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) return invalid('Archive path is required');
    const candidate = path.resolve(value);
    return this.resolveInside(candidate, true);
  }

  private async resolveDirectory(value: unknown): Promise<Result<string>> {
    if (typeof value !== 'string' || value.includes('\0')) return invalid('Archive destination is invalid');
    const candidate = path.resolve(value);
    return this.resolveInside(candidate, false);
  }

  private async resolveNewPath(value: string): Promise<Result<string>> {
    if (value.includes('\0')) return invalid('Archive output is invalid');
    const candidate = path.resolve(value);
    try {
      const existing = await lstat(candidate);
      if (existing.isSymbolicLink()) return err(appError('PATH_OUTSIDE_WORKSPACE', 'Archive output symlinks are not allowed'));
    } catch { /* output may be new */ }
    const parent = await this.resolveInside(path.dirname(candidate), false);
    if (!parent.ok) return parent;
    return ok(path.join(parent.value, path.basename(candidate)));
  }

  private async resolveInside(candidate: string, mustExist: boolean): Promise<Result<string>> {
    const roots = await this.roots();
    const existingCandidate = await existingPath(candidate);
    const canonicalCandidate = mustExist ? existingCandidate : existingCandidate ?? await existingPath(path.dirname(candidate));
    if (canonicalCandidate === null) return err(appError(mustExist ? 'FILE_NOT_FOUND' : 'PATH_OUTSIDE_WORKSPACE', mustExist ? 'Archive path was not found' : 'Archive parent directory was not found'));
    for (const root of roots) {
      const canonicalRoot = await existingPath(root);
      if (canonicalRoot !== null && isWithin(canonicalRoot, canonicalCandidate)) return ok(mustExist || existingCandidate !== null ? canonicalCandidate : path.join(canonicalCandidate, path.basename(candidate)));
    }
    return err(appError('PATH_OUTSIDE_WORKSPACE', 'Archive path is outside registered roots'));
  }

  private async run(executable: string, args: readonly string[], operation: ArchiveOperation, provider: string, signal?: AbortSignal): Promise<Result<unknown>> {
    try {
      const result = await this.runner.run(executable, args, signal);
      if (signal?.aborted === true) return cancelled();
      if (result.truncated) return err(appError('FILE_TOO_LARGE', 'Archive extraction output exceeded the bounded output limit'));
      if (result.exitCode !== 0) return unavailable();
      return ok({ operation, provider, output: result.stdout.split(/\r?\n/).filter(Boolean).slice(0, 2_000), truncated: result.truncated });
    } catch { return unavailable(); }
  }
}

function parseTarMemberName(line: string): string {
  // GNU tar verbose output ends with the member name after mode, owner, size, date, and time.
  const match = /^(?:[-dlcbps][rwx-]{9})\s+\S+\s+\S+\s+(?:\d+)\s+\S+\s+\S+\s+(.+)$/.exec(line);
  return match?.[1] ?? line;
}

function parseTarMemberSize(line: string): number {
  const match = /^(?:[-dlcbps][rwx-]{9})\s+\S+\s+\S+\s+(\d+)\s+/.exec(line);
  const size = Number(match?.[1] ?? 0);
  return Number.isSafeInteger(size) && size >= 0 ? size : 0;
}

function parseZipMemberNames(lines: readonly string[]): readonly string[] {
  const names = lines.flatMap((line) => {
    const match = /^file name:\s*(.+)$/i.exec(line);
    return match === null ? [] : [match[1]!.trim()];
  });
  return names.length > 0 ? names : lines.filter((line) => !/^archive:|^zip file size:|^central directory entry|^[-=]+$/i.test(line));
}

function parseZipMemberSize(line: string): number {
  const match = /uncompressed size:\s*(\d+)\s*bytes/i.exec(line);
  const size = Number(match?.[1] ?? 0);
  return Number.isSafeInteger(size) && size >= 0 ? size : 0;
}

export const LinuxArchiveBackend = ArchiveBackend;

/** Validate member names before handing an archive to an extractor. */
export function validateArchiveMembers(members: readonly string[]): Result<void> {
  if (members.length > MAX_MEMBERS) return invalid('Archive exceeds the 100,000-member limit');
  for (const member of members) {
    if (member.length === 0 || member.includes('\0') || path.posix.isAbsolute(member) || path.win32.isAbsolute(member)) return invalid('Archive contains an absolute member path');
    if (/unix file attributes.*(?:\blrwx|\b[cbp][rwx-]{9})/i.test(member) || /external file attributes.*(?:symlink|device)/i.test(member)) return invalid('Archive contains an unsafe symlink or device node');
    const linkSeparator = member.indexOf(' -> ');
    if (linkSeparator >= 0) {
      const linkTarget = member.slice(linkSeparator + 4).replaceAll('\\', '/');
      const linkName = member.slice(0, linkSeparator).replaceAll('\\', '/');
      const resolvedLink = path.posix.normalize(path.posix.join(path.posix.dirname(linkName), linkTarget));
      if (path.posix.isAbsolute(linkTarget) || resolvedLink === '..' || resolvedLink.startsWith('../')) return invalid('Archive contains a symlink that escapes the extraction root');
    }
    // tar verbose listings use a leading type marker; device nodes are never safe to extract.
    if (/^[cbp][rwx-]{9}\s/.test(member)) return invalid('Archive contains an unsafe device node');
    const normalized = (linkSeparator >= 0 ? member.slice(0, linkSeparator) : member).replaceAll('\\', '/');
    if (normalized.split('/').some((part) => part === '..')) return invalid('Archive contains a path traversal member');
  }
  return ok(undefined);
}

async function hasExistingMember(destination: string, members: readonly string[]): Promise<Result<boolean>> {
  for (const member of members) {
    const target = path.join(destination, member);
    const parts = member.replaceAll('\\', '/').split('/').filter(Boolean);
    let current = destination;
    for (const part of parts.slice(0, -1)) {
      current = path.join(current, part);
      try { if ((await lstat(current)).isSymbolicLink()) return err(appError('PATH_OUTSIDE_WORKSPACE', 'Archive extraction would traverse an existing symlink')); } catch { break; }
    }
    try { await lstat(target); return ok(true); } catch { /* missing member */ }
  }
  return ok(false);
}
async function existingPath(value: string): Promise<string | null> { try { await access(value); return await realpath(value); } catch { return null; } }
function isWithin(root: string, candidate: string): boolean { const relative = path.relative(path.resolve(root), path.resolve(candidate)); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); }
function readOperation(value: unknown): ArchiveOperation | null { return value === undefined ? 'list' : typeof value === 'string' && ['list', 'extract-plan', 'extract', 'create'].includes(value) ? value as ArchiveOperation : null; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function invalid(message: string): Result<never> { return err(appError('INVALID_INPUT', message)); }
function unavailable(): Result<never> { return err(appError('CAPABILITY_UNAVAILABLE', 'Archive provider is unavailable', true)); }
function cancelled(): Result<never> { return err(appError('PROCESS_TIMEOUT', 'Archive operation was cancelled', true)); }
