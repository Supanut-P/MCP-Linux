import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import { Redactor } from '@baitonghub-linux-mcp/audit';
import { isWithin, type WorkspacePathGuard, type WorkspaceRepository } from '@baitonghub-linux-mcp/workspace';

export type SupportBundleSection = 'doctor' | 'health' | 'runtime' | 'audit-summary' | 'recent-errors' | 'package-files';

export interface SupportBundleSources {
  readonly doctor: () => Promise<unknown>;
  readonly health: () => Promise<unknown>;
  readonly runtime: () => Promise<unknown>;
  readonly auditSummary: () => Promise<unknown>;
  readonly recentErrors: () => Promise<unknown>;
  readonly packageFiles: () => Promise<unknown>;
}

export interface SupportBundleArchivePort {
  create(sourceDirectory: string, outputPath: string, signal?: AbortSignal): Promise<Result<{ readonly bytes: number }>>;
}

export interface SupportBundleServiceOptions {
  readonly workspaceRepository: Pick<WorkspaceRepository, 'get'>;
  readonly pathGuard: WorkspacePathGuard;
  readonly sources: SupportBundleSources;
  readonly archive: SupportBundleArchivePort;
  readonly now?: () => Date;
}

export const SUPPORT_BUNDLE_MAX_BYTES = 2 * 1024 * 1024;
export const SUPPORT_BUNDLE_MAX_RECENT_EVENTS = 200;
export const SUPPORT_BUNDLE_REDACTION_POLICY = 'audit-redactor-v1';

const SECTIONS: readonly SupportBundleSection[] = ['doctor', 'health', 'runtime', 'audit-summary', 'recent-errors', 'package-files'];
const SECTION_FILES: Readonly<Record<SupportBundleSection, string>> = {
  doctor: 'doctor.txt',
  health: 'health.json',
  runtime: 'runtime.json',
  'audit-summary': 'audit-summary.json',
  'recent-errors': 'recent-errors.json',
  'package-files': 'package-files.txt',
};

/** Creates a bounded, redacted support archive inside one registered workspace. */
export class SupportBundleService {
  private readonly now: () => Date;
  private readonly redactor = new Redactor();

  public constructor(private readonly options: SupportBundleServiceOptions) {
    this.now = options.now ?? ((): Date => new Date());
  }

  public async execute(input: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
    const request = parseRequest(input);
    if (!request.ok) return request;
    if (signal?.aborted === true) return err(appError('PROCESS_TIMEOUT', 'Support bundle creation was cancelled', true));

    const workspace = await this.options.workspaceRepository.get(request.value.workspaceId);
    if (workspace === null) return err(appError('WORKSPACE_NOT_FOUND', 'Workspace was not found'));
    const destination = await this.options.pathGuard.resolveForWrite(workspace, request.value.destination);
    if (!destination.ok) return destination;
    const previewHash = canonicalHash({
      workspaceId: request.value.workspaceId,
      destination: normalizeRelative(destination.value.relativePath),
      include: request.value.include,
      policy: SUPPORT_BUNDLE_REDACTION_POLICY,
      maxBytes: SUPPORT_BUNDLE_MAX_BYTES,
      maxRecentEvents: SUPPORT_BUNDLE_MAX_RECENT_EVENTS,
    });
    const memberNames = ['manifest.json', ...request.value.include.map((section) => SECTION_FILES[section])];
    if (request.value.dryRun) return ok({
      dry_run: true,
      memberNames,
      maxBytes: SUPPORT_BUNDLE_MAX_BYTES,
      maxRecentEvents: SUPPORT_BUNDLE_MAX_RECENT_EVENTS,
      redactionPolicy: SUPPORT_BUNDLE_REDACTION_POLICY,
      previewHash,
    });
    if (request.value.previewHash !== previewHash) return err(appError('PERMISSION_REQUIRED', 'Support bundle previewHash does not match the requested archive', true));
    if (request.value.userConfirmed !== true) return err(appError('PERMISSION_REQUIRED', 'Support bundle creation requires explicit confirmation', true));

    const temporaryDirectory = path.join(workspace.realRootPath, `.baitonghub-support-${randomUUID()}`);
    let outputPath: string | undefined;
    try {
      await mkdir(temporaryDirectory, { mode: 0o700 });
      const temporaryRealPath = await realpath(temporaryDirectory);
      if (!isWithin(workspace.realRootPath, temporaryRealPath)) return err(appError('PATH_OUTSIDE_WORKSPACE', 'Support bundle temporary path escaped the workspace'));
      const files = await this.collectFiles(request.value.include, previewHash, memberNames, request.value.workspaceId, signal);
      if (!files.ok) return files;
      const totalBytes = files.value.reduce((total, entry) => total + Buffer.byteLength(entry.content, 'utf8'), 0);
      if (totalBytes > SUPPORT_BUNDLE_MAX_BYTES) return err(appError('CAPABILITY_UNAVAILABLE', 'Support bundle exceeded the 2 MiB uncompressed limit', true));
      for (const file of files.value) await writeFile(path.join(temporaryDirectory, file.name), file.content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });

      outputPath = destination.value.absolutePath;
      await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
      const archived = await this.options.archive.create(temporaryDirectory, outputPath, signal);
      if (!archived.ok) return archived;
      let outputStats;
      try { outputStats = await stat(outputPath); } catch { return err(appError('CAPABILITY_UNAVAILABLE', 'Support bundle archive was not created', true)); }
      if (!outputStats.isFile() || outputStats.size > SUPPORT_BUNDLE_MAX_BYTES) return err(appError('CAPABILITY_UNAVAILABLE', 'Support bundle archive exceeded the 2 MiB limit', true));
      const bytes = await readFile(outputPath);
      const receiptId = readReceiptId(input);
      return ok({
        path: normalizeRelative(destination.value.relativePath),
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: outputStats.size,
        memberCount: memberNames.length,
        ...(receiptId === undefined ? {} : { receiptId }),
      });
    } catch {
      return err(appError('CAPABILITY_UNAVAILABLE', 'Support bundle could not be created', true));
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
      if (outputPath !== undefined) {
        try {
          const outputStats = await stat(outputPath);
          if (outputStats.size > SUPPORT_BUNDLE_MAX_BYTES) await unlink(outputPath);
        } catch { /* best-effort cleanup only */ }
      }
    }
  }

  private async collectFiles(
    include: readonly SupportBundleSection[],
    previewHash: string,
    memberNames: readonly string[],
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<Result<readonly BundleFile[]>> {
    const files: BundleFile[] = [];
    const manifest = {
      schema: 'baitonghub.support-bundle.v1',
      policy: SUPPORT_BUNDLE_REDACTION_POLICY,
      workspaceId,
      createdAt: this.now().toISOString(),
      previewHash,
      members: memberNames,
      maxBytes: SUPPORT_BUNDLE_MAX_BYTES,
      maxRecentEvents: SUPPORT_BUNDLE_MAX_RECENT_EVENTS,
    };
    files.push({ name: 'manifest.json', content: `${JSON.stringify(manifest, null, 2)}\n` });
    for (const section of include) {
      if (signal?.aborted === true) return err(appError('PROCESS_TIMEOUT', 'Support bundle creation was cancelled', true));
      const provider = this.options.sources[providerName(section)];
      let value: unknown;
      try { value = await provider(); } catch { value = { status: 'unavailable' }; }
      value = boundSection(section, value);
      const sanitized = sanitize(this.redactor, value);
      const content = section === 'doctor' || section === 'package-files'
        ? formatText(sanitized)
        : `${JSON.stringify(sanitized, null, 2)}\n`;
      files.push({ name: SECTION_FILES[section], content });
    }
    return ok(files);
  }
}

interface BundleFile { readonly name: string; readonly content: string }
interface SupportBundleRequest {
  readonly workspaceId: string;
  readonly destination: string;
  readonly include: readonly SupportBundleSection[];
  readonly dryRun: boolean;
  readonly previewHash?: string;
  readonly userConfirmed: boolean;
}

function parseRequest(input: unknown): Result<SupportBundleRequest> {
  if (!isRecord(input)) return err(appError('INVALID_INPUT', 'Support bundle input must be an object'));
  const workspaceId = readString(input.workspaceId);
  const destination = readString(input.destination);
  const include = Array.isArray(input.include) ? input.include.filter((value): value is SupportBundleSection => typeof value === 'string' && SECTIONS.includes(value as SupportBundleSection)) : [];
  const dryRun = input.dry_run === undefined ? true : input.dry_run === true;
  const previewHash = readString(input.previewHash);
  if (workspaceId === undefined || destination === undefined || destination.includes('\0') || include.length < 1 || include.length > SECTIONS.length || new Set(include).size !== include.length) return err(appError('INVALID_INPUT', 'Support bundle workspaceId, destination, and include are invalid'));
  if (input.include !== undefined && (!Array.isArray(input.include) || include.length !== input.include.length)) return err(appError('INVALID_INPUT', 'Support bundle include contains an unknown section'));
  if (input.dry_run !== undefined && typeof input.dry_run !== 'boolean') return err(appError('INVALID_INPUT', 'Support bundle dry_run must be boolean'));
  return ok({ workspaceId, destination, include, dryRun, ...(previewHash === undefined ? {} : { previewHash }), userConfirmed: input.userConfirmed === true });
}

function boundSection(section: SupportBundleSection, value: unknown): unknown {
  if (section !== 'recent-errors') return value;
  if (Array.isArray(value)) return value.slice(0, SUPPORT_BUNDLE_MAX_RECENT_EVENTS);
  if (isRecord(value) && Array.isArray(value.events)) return { ...value, events: value.events.slice(0, SUPPORT_BUNDLE_MAX_RECENT_EVENTS) };
  return value;
}

function providerName(section: SupportBundleSection): keyof SupportBundleSources {
  return section === 'audit-summary' ? 'auditSummary' : section === 'recent-errors' ? 'recentErrors' : section === 'package-files' ? 'packageFiles' : section;
}

function formatText(value: unknown): string {
  return typeof value === 'string' ? `${value}\n` : `${JSON.stringify(value, null, 2)}\n`;
}

function sanitize(redactor: Redactor, value: unknown): unknown {
  const redacted = redactor.redact(value);
  if (typeof redacted === 'string') return redactText(redacted);
  if (Array.isArray(redacted)) return redacted.map((entry) => sanitize(redactor, entry));
  if (isRecord(redacted)) return Object.fromEntries(Object.entries(redacted).map(([key, entry]) => [key, sanitize(redactor, entry)]));
  return redacted;
}

function redactText(value: string): string {
  return value
    .replace(/(authorization\s*:\s*bearer\s+|bearer\s+|\b(?:token|secret|password|api[_-]?key|private[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\b[^\s,;]*secret[^\s,;]*\b/gi, '[REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|AIza[A-Za-z0-9_-]+)\b/g, '[REDACTED]');
}

function canonicalHash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

function normalizeRelative(value: string): string { return value.replaceAll('\\', '/'); }

function readReceiptId(input: unknown): string | undefined {
  const value = isRecord(input)? input._approvalReceiptId : undefined;
  return typeof value === 'string' && /^[A-Za-z0-9-]{8,128}$/.test(value) ? value : undefined;
}

function readString(value: unknown): string | undefined { return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined; }

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
