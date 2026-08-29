import { access, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import { PathExecutableResolver } from '@baitonghub-linux-mcp/process';
import type { NativeCapabilityBackend, NativeCapabilityHealth } from './platform/types.js';
import { LinuxCommandRunner } from './linux-command-runner.js';

export type ContainerOperation = 'status' | 'list' | 'inspect' | 'logs' | 'stats' | 'compose-config' | 'compose-up' | 'compose-down' | 'restart' | 'stop' | 'remove';
export type ContainerProvider = 'docker' | 'podman';

export interface ContainerBackendOptions {
  readonly platform?: NodeJS.Platform;
  readonly resolveExecutable?: (name: string) => Promise<string | null>;
  readonly runner?: LinuxCommandRunner;
  /** Roots are refreshed for every request so newly registered projects are visible. */
  readonly allowedRootsProvider?: () => Promise<readonly string[]> | readonly string[];
}

const OPERATIONS = new Set<ContainerOperation>(['status', 'list', 'inspect', 'logs', 'stats', 'compose-config', 'compose-up', 'compose-down', 'restart', 'stop', 'remove']);
const MUTATIONS = new Set<ContainerOperation>(['compose-up', 'compose-down', 'restart', 'stop', 'remove']);
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MAX_TAIL = 10_000;

/** Fixed-argv Docker/Podman administration with project-root and volume containment. */
export class ContainerBackend implements NativeCapabilityBackend {
  private readonly platform: NodeJS.Platform;
  private readonly resolveExecutable: (name: string) => Promise<string | null>;
  private readonly runner: LinuxCommandRunner;
  private readonly allowedRootsProvider: () => Promise<readonly string[]> | readonly string[];

  public constructor(options: ContainerBackendOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.resolveExecutable = options.resolveExecutable ?? ((name: string): Promise<string | null> => new PathExecutableResolver().resolve(name).then((result) => result.ok ? result.value : null));
    this.runner = options.runner ?? new LinuxCommandRunner({ allowedExecutables: ['docker', 'podman'], maxBytes: 1024 * 1024 });
    this.allowedRootsProvider = options.allowedRootsProvider ?? ((): readonly string[] => []);
  }

  public async health(): Promise<NativeCapabilityHealth> {
    if (this.platform !== 'linux') return { platform: this.platform, available: false, ready: false, requiresConsent: false, missingDependencies: [], reason: 'platform_unsupported' };
    const provider = await this.provider();
    if (provider === null) return { platform: 'linux', provider: 'docker/podman', available: false, ready: false, requiresConsent: false, missingDependencies: ['docker', 'podman'], reason: 'missing_dependencies' };
    return { platform: 'linux', provider: provider.name, available: true, ready: true, requiresConsent: false, missingDependencies: [] };
  }

  public async execute(input: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
    if (this.platform !== 'linux') return err(appError('PLATFORM_UNSUPPORTED', 'Container operations are available on Linux only', true));
    if (!isRecord(input)) return invalid('Container input must be an object');
    const operation = readOperation(input.operation);
    if (operation === null) return invalid('Unknown container operation');
    if (input.dry_run === true) return ok({ dry_run: true, operation, capability: 'container' });
    if (MUTATIONS.has(operation) && input.userConfirmed !== true) return err(appError('PERMISSION_REQUIRED', 'Container mutations require explicit user confirmation', true));
    if (signal?.aborted === true) return cancelled();
    const provider = await this.provider();
    if (provider === null) return unavailable();
    // Every operation is scoped to a registered Compose file. Direct Docker
    // commands would otherwise expose or mutate unrelated host containers.
    const compose = await this.composeArgs(input, operation);
    if (!compose.ok) return compose;
    return this.run(provider, compose.value, operation, signal);
  }

  private async provider(): Promise<{ readonly name: ContainerProvider; readonly executable: string } | null> {
    // Docker is intentionally checked first when both runtimes are installed.
    const docker = await this.resolveExecutable('docker');
    if (docker !== null) return { name: 'docker', executable: docker };
    const podman = await this.resolveExecutable('podman');
    return podman === null ? null : { name: 'podman', executable: podman };
  }

  private async composeArgs(input: Record<string, unknown>, operation: ContainerOperation): Promise<Result<readonly string[]>> {
    const composeFileValue = input.compose_file ?? input.composeFile ?? input.file;
    if (typeof composeFileValue !== 'string' || composeFileValue.trim().length === 0) return invalid('A compose_file is required');
    const composePath = await this.resolveRegisteredPath(composeFileValue, input.cwd);
    if (!composePath.ok) return composePath;
    const volumeCheck = await this.validateVolumes(input.volumes, path.dirname(composePath.value));
    if (!volumeCheck.ok) return volumeCheck;
    const composeFileCheck = await this.validateComposeFileVolumes(composePath.value, path.dirname(composePath.value));
    if (!composeFileCheck.ok) return composeFileCheck;
    const args: string[] = ['compose', '-f', composePath.value];
    const container = input.container ?? input.name;
    if (operation === 'compose-config') args.push('config');
    else if (operation === 'compose-up') args.push('up', '-d');
    else if (operation === 'compose-down') args.push('down');
    else if (operation === 'status' || operation === 'list' || operation === 'inspect') {
      args.push('ps');
      if (input.all === true && operation === 'list') args.push('--all');
      if (operation === 'inspect' && typeof container === 'string' && CONTAINER_NAME.test(container)) args.push(container);
    } else if (operation === 'logs') {
      const tail = input.tail ?? input.tail_lines ?? 100;
      if (typeof tail !== 'number' || !Number.isInteger(tail) || tail < 1 || tail > MAX_TAIL) return invalid('Container log tail is invalid');
      args.push('logs', '--tail', String(tail));
      if (typeof container === 'string' && CONTAINER_NAME.test(container)) args.push(container);
    } else if (operation === 'stats') {
      args.push('stats');
      if (typeof container === 'string' && CONTAINER_NAME.test(container)) args.push(container);
    } else if (operation === 'restart' || operation === 'stop' || operation === 'remove') {
      if (typeof container !== 'string' || !CONTAINER_NAME.test(container)) return invalid('Container name is invalid');
      args.push(operation === 'remove' ? 'rm' : operation, container);
    }
    return ok(args);
  }

  private async validateComposeFileVolumes(composePath: string, composeDirectory: string): Promise<Result<void>> {
    let source: string;
    try {
      source = await readFile(composePath, 'utf8');
    } catch {
      return err(appError('FILE_NOT_FOUND', 'Compose file was not found'));
    }
    if (Buffer.byteLength(source, 'utf8') > 2 * 1024 * 1024) return invalid('Compose file is too large');
    // Reject features that grant host-level authority or include a second
    // unvalidated file. This conservative gate is intentional without a YAML
    // parser in the minimal headless runtime.
    if (/^\s*(include|extends|devices|volumes_from|cap_add|security_opt)\s*:/im.test(source)
      || /^\s*(device|privileged|pid|ipc|network_mode|userns_mode)\s*:/im.test(source)) {
      return err(appError('INVALID_INPUT', 'Compose file uses unsupported host-authority features'));
    }
    for (const line of source.split(/\r?\n/)) {
      const trimmed = line.trim().replace(/^[- ]+/, '').replace(/^['"]|['"]$/g, '');
      const sourceField = /^source:\s*["']?([^"'#]+)["']?\s*$/.exec(trimmed);
      if (sourceField !== null) {
        const sourceCheck = await this.validateComposeHost(sourceField[1]!.trim(), composeDirectory);
        if (!sourceCheck.ok) return sourceCheck;
      }
      if (trimmed.startsWith('volumes:')) {
        const inlineVolumes = [...trimmed.matchAll(/["']([^"']+:[^"']+)["']/g)].map((match) => match[1]!);
        for (const volume of inlineVolumes) {
          const inlineCheck = await this.validateComposeHost(volume, composeDirectory);
          if (!inlineCheck.ok) return inlineCheck;
        }
      }
      const separator = volumeSeparator(trimmed);
      if (separator < 0) continue;
      const host = trimmed.slice(0, separator).trim().replace(/^['"]|['"]$/g, '');
      const hostCheck = await this.validateComposeHost(host, composeDirectory);
      if (!hostCheck.ok) return hostCheck;
    }
    return ok(undefined);
  }

  private async validateComposeHost(host: string, composeDirectory: string): Promise<Result<void>> {
    if (!looksLikeHostPath(host)) return ok(undefined);
    if (host.includes('${') || host.includes('$')) return err(appError('INVALID_INPUT', 'Compose bind-mount paths using unresolved variables are not allowed'));
    const resolved = await this.resolveRegisteredPath(host, composeDirectory);
    return resolved.ok ? ok(undefined) : err(appError('PATH_OUTSIDE_WORKSPACE', 'Compose bind-mount host path is outside registered roots'));
  }

  private async validateVolumes(value: unknown, composeDirectory: string): Promise<Result<void>> {
    if (value === undefined) return ok(undefined);
    if (!Array.isArray(value) || value.length > 100) return invalid('Container volumes are invalid');
    for (const entry of value) {
      if (typeof entry !== 'string') return invalid('Container volumes are invalid');
      const source = entry.split(':')[0]?.trim() ?? '';
      if (source.length === 0 || source.startsWith('type=')) continue;
      const resolved = await this.resolveRegisteredPath(source, composeDirectory);
      if (!resolved.ok) return err(appError('PATH_OUTSIDE_WORKSPACE', 'Container volume host path is outside registered roots'));
    }
    return ok(undefined);
  }

  private async resolveRegisteredPath(value: string, basePath?: unknown): Promise<Result<string>> {
    if (value.includes('\0')) return err(appError('INVALID_INPUT', 'Container path is invalid'));
    const roots = await this.allowedRootsProvider();
    const candidate = path.resolve(typeof basePath === 'string' && basePath.length > 0 ? basePath : roots[0] ?? '.', value);
    const canonicalCandidate = await existingPath(candidate);
    if (canonicalCandidate === null) return err(appError('FILE_NOT_FOUND', 'Container path was not found'));
    for (const root of roots) {
      const canonicalRoot = await existingPath(root);
      if (canonicalRoot !== null && isWithin(canonicalRoot, canonicalCandidate)) return ok(canonicalCandidate);
    }
    return err(appError('PATH_OUTSIDE_WORKSPACE', 'Container path is outside registered roots'));
  }

  private async run(provider: { readonly name: ContainerProvider; readonly executable: string }, args: readonly string[], operation: ContainerOperation, signal?: AbortSignal): Promise<Result<unknown>> {
    try {
      const result = await this.runner.run(provider.executable, args, signal);
      if (signal?.aborted === true) return cancelled();
      if (result.exitCode !== 0) return err(appError('CAPABILITY_UNAVAILABLE', 'Container provider operation failed', true));
      return ok({ operation, provider: provider.name, output: result.stdout.split(/\r?\n/).filter(Boolean).map(redactSensitive).slice(0, 2_000), truncated: result.truncated });
    } catch { return unavailable(); }
  }
}

export const LinuxContainerBackend = ContainerBackend;

function redactSensitive(value: string): string {
  return value.replace(/((?:password|passwd|token|secret|api[_-]?key|authorization)\s*[:=]\s*)([^\s,;]+)/gi, '$1[REDACTED]');
}

async function existingPath(value: string): Promise<string | null> {
  try { await access(value); return await realpath(value); } catch { return null; }
}
function isWithin(root: string, candidate: string): boolean { const relative = path.relative(path.resolve(root), path.resolve(candidate)); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); }
function volumeSeparator(value: string): number { const match = /:(?=\/|\.\.?\/|~\/|\$\{|[A-Za-z]:[\\/])/.exec(value); return match?.index ?? -1; }
function looksLikeHostPath(value: string): boolean { return value === '.' || value === '..' || value.startsWith('/') || value.startsWith('./') || value.startsWith('../') || value.startsWith('~/') || value.includes('$') || /^[A-Za-z]:[\\/]/.test(value); }
function readOperation(value: unknown): ContainerOperation | null { return value === undefined ? 'list' : typeof value === 'string' && OPERATIONS.has(value as ContainerOperation) ? value as ContainerOperation : null; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function invalid(message: string): Result<never> { return err(appError('INVALID_INPUT', message)); }
function unavailable(): Result<never> { return err(appError('CAPABILITY_UNAVAILABLE', 'Container provider is unavailable', true)); }
function cancelled(): Result<never> { return err(appError('PROCESS_TIMEOUT', 'Container operation was cancelled', true)); }
