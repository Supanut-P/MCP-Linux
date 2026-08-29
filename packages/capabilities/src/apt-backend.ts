import { createHash } from 'node:crypto';
import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import { PathExecutableResolver } from '@baitonghub-linux-mcp/process';
import type { NativeCapabilityBackend, NativeCapabilityHealth } from './platform/types.js';
import { LinuxCommandRunner, type LinuxCommandResult } from './linux-command-runner.js';

export type AptOperation = 'search' | 'show' | 'installed' | 'updates' | 'install' | 'remove' | 'upgrade';
export interface AptBackendOptions {
  readonly platform?: NodeJS.Platform;
  readonly resolveExecutable?: (name: string) => Promise<string | null>;
  readonly runner?: LinuxCommandRunner;
}

const DEBIAN_PACKAGE = /^[a-z0-9][a-z0-9+.-]{0,127}(?::(amd64|all))?$/;
const MUTATIONS = new Set<AptOperation>(['install', 'remove', 'upgrade']);
const READS = new Set<AptOperation>(['search', 'show', 'installed', 'updates']);
const MAX_PACKAGES = 50;
const MAX_RESULTS = 1000;

export class AptBackend implements NativeCapabilityBackend {
  private readonly platform: NodeJS.Platform;
  private readonly resolveExecutable: (name: string) => Promise<string | null>;
  private readonly runner: LinuxCommandRunner;

  public constructor(options: AptBackendOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.resolveExecutable = options.resolveExecutable ?? defaultResolveExecutable;
    this.runner = options.runner ?? new LinuxCommandRunner({ allowedExecutables: ['apt-cache', 'apt-get', 'apt', 'dpkg-query'], maxBytes: 1024 * 1024 });
  }

  public async health(): Promise<NativeCapabilityHealth> {
    if (this.platform !== 'linux') return { platform: this.platform, available: false, ready: false, requiresConsent: false, missingDependencies: [], reason: 'platform_unsupported' };
    const names = ['apt-get', 'apt-cache', 'apt', 'dpkg-query'];
    const resolved = await Promise.all(names.map(async (name) => ({ name, value: await this.resolveExecutable(name) })));
    const missingDependencies = resolved.filter((item) => item.value === null).map((item) => item.name);
    return { platform: this.platform, provider: 'apt/dpkg', available: missingDependencies.length === 0, ready: missingDependencies.length === 0, requiresConsent: false, missingDependencies, ...(missingDependencies.length === 0 ? {} : { reason: 'missing_dependencies' }) };
  }

  public async execute(input: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
    if (this.platform !== 'linux') return err(appError('PLATFORM_UNSUPPORTED', 'Linux package administration is unavailable on this platform', true));
    if (!isRecord(input)) return invalid('Package input must be an object');
    if (input.action === 'status' || input.operation === 'health') return ok(await this.health());
    const operation = typeof input.operation === 'string' ? input.operation as AptOperation : 'search';
    if (!READS.has(operation) && !MUTATIONS.has(operation)) return invalid(`Unknown package operation: ${operation}`);
    if (hasForbiddenOptions(input)) return invalid('Package manager flags, repository changes, and lock bypasses are not supported');
    if (operation === 'search') {
      const query = typeof input.query === 'string' ? input.query.trim() : '';
      if (!/^[A-Za-z0-9][A-Za-z0-9+_.:@/-]{0,127}$/.test(query)) return invalid('Package search query is invalid');
      return this.read('apt-cache', ['search', query], operation, signal);
    }
    if (operation === 'installed') return this.read('dpkg-query', ['-W', '-f=${Package}\t${Version}\t${Status}\n'], operation, signal);
    if (operation === 'updates') return this.read('apt', ['list', '--upgradable'], operation, signal);
    const packages = readPackages(input.packages);
    if (!packages.ok) return packages;
    if (operation === 'show') {
      if (packages.value.length === 0) return invalid('At least one package is required for show');
      return this.read('apt-cache', ['show', ...packages.value], operation, signal);
    }
    if (packages.value.length === 0) return invalid('At least one package is required');
    if (input.dry_run === true) return this.simulate(operation, packages.value, signal);
    if (!isConfirmed(input)) return err(appError('PERMISSION_REQUIRED', 'Package mutations require explicit user confirmation', true));
    const plan = await this.simulate(operation, packages.value, signal);
    if (!plan.ok) return plan;
    const expectedHash = typeof input.plan_hash === 'string' ? input.plan_hash : typeof input.planHash === 'string' ? input.planHash : undefined;
    if (expectedHash === undefined) return invalid('A matching plan_hash is required to execute package mutations');
    if (expectedHash !== plan.value.plan_hash) return invalid('Package plan hash does not match the current simulation');
    return this.run('apt-get', [operation, ...packages.value], operation, signal, { plan_hash: plan.value.plan_hash });
  }

  private async simulate(operation: AptOperation, packages: readonly string[], signal?: AbortSignal): Promise<Result<Readonly<Record<string, unknown>>>> {
    const result = await this.runRaw(['--simulate', '--assume-no', operation, ...packages], signal);
    if (!result.ok) return result;
    if (result.value.exitCode !== 0) return unavailable();
    const plan = redact(result.value.stdout);
    // Bind the confirmation to the exact operation, ordered package list, and preview output.
    const planHash = createHash('sha256').update(JSON.stringify({ operation, packages, plan }), 'utf8').digest('hex');
    return ok({ operation, packages, plan, plan_hash: planHash, provider: 'apt-get', truncated: result.value.truncated });
  }

  private async read(binary: string, args: readonly string[], operation: AptOperation, signal?: AbortSignal): Promise<Result<unknown>> {
    return this.run(binary, args, operation, signal);
  }

  private async run(binary: string, args: readonly string[], operation: AptOperation, signal?: AbortSignal, extra: Readonly<Record<string, unknown>> = {}): Promise<Result<unknown>> {
    const result = await this.runRawFor(binary, args, signal);
    if (!result.ok) return result;
    if (result.value.exitCode !== 0) return unavailable();
    const lines = redact(result.value.stdout).split(/\r?\n/).filter((line) => line.length > 0).slice(0, MAX_RESULTS);
    return ok({ operation, lines, provider: binary, truncated: result.value.truncated, ...extra });
  }

  private async runRaw(args: readonly string[], signal?: AbortSignal): Promise<Result<LinuxCommandResult>> { return this.runRawFor('apt-get', args, signal); }

  private async runRawFor(binary: string, args: readonly string[], signal?: AbortSignal): Promise<Result<LinuxCommandResult>> {
    if (signal?.aborted === true) return cancelled();
    const executable = await this.resolveExecutable(binary);
    if (executable === null) return err(appError('CAPABILITY_UNAVAILABLE', `Required Linux dependency is unavailable: ${binary}`, true));
    try { const result = await this.runner.run(executable, args, signal); return wasAborted(signal) ? cancelled() : ok(result); }
    catch { return unavailable(); }
  }
}

export const LinuxAptBackend = AptBackend;

function readPackages(value: unknown): Result<readonly string[]> {
  if (value === undefined) return ok([]);
  if (!Array.isArray(value) || value.length > MAX_PACKAGES || value.some((item) => typeof item !== 'string' || !DEBIAN_PACKAGE.test(item))) return invalid('Package names are invalid or exceed the 50-package limit');
  return ok([...new Set(value as string[])]);
}
function hasForbiddenOptions(input: Record<string, unknown>): boolean {
  return Object.keys(input).some((key) => ['flags', 'aptFlags', 'apt_flags', 'repositories', 'repository', 'repo', 'allowUnauthenticated', 'allow_unauthenticated', 'lockTimeout', 'lock_timeout', 'dpkgOptions', 'dpkg_options'].includes(key));
}
function isConfirmed(input: Record<string, unknown>): boolean { return input.userConfirmed === true; }
function wasAborted(signal: AbortSignal | undefined): boolean { return signal?.aborted === true; }
function defaultResolveExecutable(name: string): Promise<string | null> { return new PathExecutableResolver().resolve(name).then((result) => result.ok ? result.value : null); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function invalid(message: string): Result<never> { return err(appError('INVALID_INPUT', message)); }
function unavailable(): Result<never> { return err(appError('CAPABILITY_UNAVAILABLE', 'Package provider failed', true)); }
function cancelled(): Result<never> { return err(appError('PROCESS_TIMEOUT', 'Package operation was cancelled', true)); }
function redact(value: string): string { return value.replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, '$1[redacted]').replace(/\b(token|secret|password|api[_-]?key|private[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]'); }
