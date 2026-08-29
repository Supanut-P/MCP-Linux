import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import { PathExecutableResolver } from '@baitonghub-linux-mcp/process';
import type { NativeCapabilityBackend, NativeCapabilityHealth } from './platform/types.js';
import { LinuxCommandRunner } from './linux-command-runner.js';

export type DependencyAuditProvider = 'pnpm' | 'npm' | 'python' | 'cargo';
export interface DependencyAuditBackendOptions {
  readonly platform?: NodeJS.Platform;
  readonly resolveExecutable?: (name: string) => Promise<string | null>;
  readonly runner?: LinuxCommandRunner;
  readonly allowedRootsProvider?: () => Promise<readonly string[]> | readonly string[];
}
export interface DependencyFinding {
  readonly package: string;
  readonly installed?: string;
  readonly fixed?: string;
  readonly severity?: string;
  readonly advisory?: string;
  readonly source: DependencyAuditProvider;
}

const COMMANDS: Readonly<Record<DependencyAuditProvider, readonly [string, readonly string[]]>> = {
  pnpm: ['pnpm', ['audit', '--json']],
  npm: ['npm', ['audit', '--json']],
  python: ['python3', ['-m', 'pip', 'list', '--outdated', '--format=json']],
  cargo: ['cargo', ['audit', '--json']],
};
const LOCKFILES: readonly [string, DependencyAuditProvider][] = [
  ['pnpm-lock.yaml', 'pnpm'], ['package-lock.json', 'npm'], ['poetry.lock', 'python'], ['requirements.txt', 'python'], ['pyproject.toml', 'python'], ['Cargo.lock', 'cargo'],
];

/** Read-only, lockfile-selected dependency risk audit. No upgrade command is exposed. */
export class DependencyAuditBackend implements NativeCapabilityBackend {
  private readonly platform: NodeJS.Platform;
  private readonly resolveExecutable: (name: string) => Promise<string | null>;
  private readonly runner: LinuxCommandRunner;
  private readonly roots: () => Promise<readonly string[]> | readonly string[];

  public constructor(options: DependencyAuditBackendOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.resolveExecutable = options.resolveExecutable ?? ((name: string): Promise<string | null> => new PathExecutableResolver().resolve(name).then((result) => result.ok ? result.value : null));
    this.runner = options.runner ?? new LinuxCommandRunner({ allowedExecutables: ['pnpm', 'npm', 'python3', 'cargo'], maxBytes: 4 * 1024 * 1024 });
    this.roots = options.allowedRootsProvider ?? ((): readonly string[] => []);
  }

  public async health(): Promise<NativeCapabilityHealth> {
    if (this.platform !== 'linux') return { platform: this.platform, available: false, ready: false, requiresConsent: false, missingDependencies: [], reason: 'platform_unsupported' };
    const names = ['pnpm', 'npm', 'python3', 'cargo'];
    const resolved = await Promise.all(names.map(async (name) => ({ name, value: await this.resolveExecutable(name) })));
    const missing = resolved.filter((item) => item.value === null).map((item) => item.name);
    return { platform: 'linux', provider: 'pnpm/npm/pip/cargo', available: missing.length < names.length, ready: missing.length < names.length, requiresConsent: false, missingDependencies: missing, ...(missing.length === names.length ? { reason: 'missing_dependencies' } : {}) };
  }

  public async execute(input: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
    if (this.platform !== 'linux') return err(appError('PLATFORM_UNSUPPORTED', 'Dependency audits are available on Linux only', true));
    if (!isRecord(input)) return invalid('Dependency audit input must be an object');
    if (input.operation !== undefined && input.operation !== 'audit') return invalid('Unknown dependency audit operation');
    if (input.dry_run === true) return ok({ dry_run: true, capability: 'dependency_audit' });
    const root = await this.resolveRoot(input.path ?? input.cwd ?? '.');
    if (!root.ok) return root;
    const provider = await detectProvider(root.value);
    if (provider === null) return err(appError('INVALID_INPUT', 'No supported dependency lockfile was found in the workspace'));
    const [binary, args] = COMMANDS[provider];
    const executable = await this.resolveExecutable(binary);
    if (executable === null) return err(appError('CAPABILITY_UNAVAILABLE', `Required dependency audit provider is unavailable: ${binary}`, true));
    if (signal?.aborted === true) return cancelled();
    try {
      const result = await this.runner.run(executable, args, signal, root.value);
      if (signal !== undefined && signal.aborted) return cancelled();
      // npm/pnpm use non-zero exit codes when vulnerabilities are found; parse JSON regardless.
      const parsed = parseJson(result.stdout);
      if (parsed === null) return err(appError('CAPABILITY_UNAVAILABLE', 'Dependency audit provider returned invalid JSON', true));
      return ok({ provider, root: root.value, packages: normalizeFindings(provider, parsed), truncated: result.truncated });
    } catch { return err(appError('CAPABILITY_UNAVAILABLE', 'Dependency audit provider failed', true)); }
  }

  private async resolveRoot(value: unknown): Promise<Result<string>> {
    if (typeof value !== 'string' || value.includes('\0')) return invalid('Dependency audit path is invalid');
    const candidate = path.resolve(value);
    const canonical = await existingPath(candidate);
    if (canonical === null) return err(appError('WORKSPACE_NOT_FOUND', 'Dependency audit workspace was not found'));
    for (const root of await this.roots()) {
      const canonicalRoot = await existingPath(root);
      if (canonicalRoot !== null && isWithin(canonicalRoot, canonical)) return ok(canonical);
    }
    return err(appError('PATH_OUTSIDE_WORKSPACE', 'Dependency audit path is outside registered roots'));
  }
}

export const LinuxDependencyAuditBackend = DependencyAuditBackend;

async function detectProvider(root: string): Promise<DependencyAuditProvider | null> {
  for (const [file, provider] of LOCKFILES) {
    try { const info = await stat(path.join(root, file)); if (info.isFile()) return provider; } catch { /* continue */ }
  }
  return null;
}
function normalizeFindings(provider: DependencyAuditProvider, value: unknown): readonly DependencyFinding[] {
  if (provider === 'python' && Array.isArray(value)) return value.flatMap((entry) => isRecord(entry) && typeof entry.name === 'string' ? [{ package: entry.name, ...(typeof entry.version === 'string' ? { installed: entry.version } : {}), ...(typeof entry.latest_version === 'string' ? { fixed: entry.latest_version } : {}), source: provider }] : []);
  if (provider === 'cargo' && isRecord(value)) {
    const vulnerabilities = isRecord(value.vulnerabilities) && Array.isArray(value.vulnerabilities.list) ? value.vulnerabilities.list : Array.isArray(value.vulnerabilities) ? value.vulnerabilities : [];
    return vulnerabilities.flatMap((entry) => cargoFinding(entry));
  }
  if (provider === 'pnpm' && isRecord(value) && isRecord(value.advisories)) return Object.entries(value.advisories).flatMap(([id, entry]) => pnpmFinding(id, entry));
  if (isRecord(value) && isRecord(value.vulnerabilities)) return Object.entries(value.vulnerabilities).flatMap(([name, item]) => genericFinding(provider, name, item));
  if (isRecord(value) && Array.isArray(value.advisories)) return value.advisories.flatMap((entry) => genericFinding(provider, readString(entry, 'package') ?? readString(entry, 'name') ?? 'unknown', entry));
  return [];
}
function cargoFinding(value: unknown): readonly DependencyFinding[] { if (!isRecord(value)) return []; const pkg = isRecord(value.package) ? value.package : {}; const advisory = isRecord(value.advisory) ? value.advisory : {}; const versions = isRecord(value.versions) ? value.versions : {}; const patched = Array.isArray(versions.patched) ? versions.patched.filter((item): item is string => typeof item === 'string').join(', ') : undefined; const name = readString(pkg, 'name'); const installed = readString(pkg, 'version'); const severity = readString(advisory, 'severity'); const advisoryId = readStringOrNumber(advisory, 'id'); return name === undefined ? [] : [{ package: name, ...(installed === undefined ? {} : { installed }), ...(patched === undefined ? {} : { fixed: patched }), ...(severity === undefined ? {} : { severity }), ...(advisoryId === undefined ? {} : { advisory: advisoryId }), source: 'cargo' }]; }
function pnpmFinding(id: string, value: unknown): readonly DependencyFinding[] { if (!isRecord(value)) return []; const name = readString(value, 'module_name') ?? readString(value, 'package') ?? readString(value, 'name'); const installed = readString(value, 'vulnerable_versions'); const fixed = readString(value, 'patched_versions'); const severity = readString(value, 'severity'); return name === undefined ? [] : [{ package: name, ...(installed === undefined ? {} : { installed }), ...(fixed === undefined ? {} : { fixed }), ...(severity === undefined ? {} : { severity }), advisory: id, source: 'pnpm' }]; }
function genericFinding(provider: DependencyAuditProvider, name: string, value: unknown): readonly DependencyFinding[] { const item = isRecord(value) ? value : {}; const via = Array.isArray(item.via) ? item.via : []; const advisoryEntry = via.find((entry) => isRecord(entry) && readStringOrNumber(entry, 'source') !== undefined || typeof entry === 'string' || typeof entry === 'number'); const advisory = isRecord(advisoryEntry) ? readStringOrNumber(advisoryEntry, 'source') : typeof advisoryEntry === 'string' || typeof advisoryEntry === 'number' ? String(advisoryEntry) : undefined; return [{ package: name, ...(typeof item.version === 'string' ? { installed: item.version } : {}), ...(typeof item.fixAvailable === 'object' && item.fixAvailable !== null && typeof (item.fixAvailable as Record<string, unknown>).version === 'string' ? { fixed: (item.fixAvailable as Record<string, unknown>).version as string } : {}), ...(typeof item.severity === 'string' ? { severity: item.severity } : {}), ...(advisory === undefined ? {} : { advisory }), source: provider }]; }
function parseJson(value: string): unknown { try { return JSON.parse(value) as unknown; } catch { return null; } }
function readString(value: Record<string, unknown>, key: string): string | undefined { return typeof value[key] === 'string' ? value[key] : undefined; }
function readStringOrNumber(value: Record<string, unknown>, key: string): string | undefined { return typeof value[key] === 'string' || typeof value[key] === 'number' ? String(value[key]) : undefined; }
async function existingPath(value: string): Promise<string | null> { try { await access(value); return await realpath(value); } catch { return null; } }
function isWithin(root: string, candidate: string): boolean { const relative = path.relative(path.resolve(root), path.resolve(candidate)); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function invalid(message: string): Result<never> { return err(appError('INVALID_INPUT', message)); }
function cancelled(): Result<never> { return err(appError('PROCESS_TIMEOUT', 'Dependency audit was cancelled', true)); }
