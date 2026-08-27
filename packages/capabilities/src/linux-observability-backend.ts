import { lookup } from 'node:dns/promises';
import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import { PathExecutableResolver } from '@baitonghub-linux-mcp/process';
import type { NativeCapabilityBackend, NativeCapabilityHealth } from './platform/types.js';
import { LinuxCommandRunner, type LinuxCommandResult } from './linux-command-runner.js';

export type LinuxObservabilityCapabilityName = 'system_info' | 'journal' | 'network';

export interface LinuxObservabilityBackendOptions {
  readonly platform?: NodeJS.Platform;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly procRoot?: string;
  readonly resolveExecutable?: (name: string) => Promise<string | null>;
  readonly runner?: LinuxCommandRunner;
}

const SYSTEMD_UNIT = /^[A-Za-z0-9_.@:-]{1,256}\.(service|socket|timer|path)$/;
const JOURNAL_PRIORITY = /^(?:[0-7]|emerg|alert|crit|err|warning|notice|info|debug)$/;
const SAFE_SINCE = /^[A-Za-z0-9_.:+@/ -]{1,128}$/;
const MAX_JOURNAL_LINES = 1_000;
const MAX_PROCESSES = 200;
const MAX_PORTS = 500;

export class LinuxObservabilityBackend implements NativeCapabilityBackend {
  private readonly platform: NodeJS.Platform;
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly procRoot: string;
  private readonly resolveExecutable: (name: string) => Promise<string | null>;
  private readonly runner: LinuxCommandRunner;

  public constructor(
    private readonly capability: LinuxObservabilityCapabilityName,
    options: LinuxObservabilityBackendOptions = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.environment = options.environment ?? process.env;
    this.procRoot = options.procRoot ?? '/proc';
    this.resolveExecutable = options.resolveExecutable ?? defaultResolveExecutable;
    this.runner = options.runner ?? new LinuxCommandRunner({
      allowedExecutables: ['df', 'journalctl', 'ip', 'ss'],
      maxBytes: 512 * 1024,
    });
  }

  public async health(): Promise<NativeCapabilityHealth> {
    const displayServer = detectDisplayServer(this.environment);
    if (this.platform !== 'linux') {
      return { platform: this.platform, displayServer, provider: this.capability, available: false, ready: false, requiresConsent: false, missingDependencies: [], reason: 'platform_unsupported' };
    }
    const dependencies = dependenciesFor(this.capability);
    const resolved = await Promise.all(dependencies.map(async (name) => ({ name, value: await this.resolveExecutable(name) })));
    const missingDependencies = resolved.filter((item) => item.value === null).map((item) => item.name);
    const available = missingDependencies.length === 0;
    return {
      platform: this.platform,
      displayServer,
      provider: providerFor(this.capability),
      available,
      ready: available,
      requiresConsent: false,
      missingDependencies,
      ...(available ? {} : { reason: 'missing_dependencies' }),
    };
  }

  public async execute(input: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
    if (this.platform !== 'linux') return err(appError('PLATFORM_UNSUPPORTED', 'Linux observability is unavailable on this platform', true));
    if (!isRecord(input)) return err(appError('INVALID_INPUT', 'Linux observability input must be an object'));
    if (isStatusRequest(input)) return ok(await this.health());
    if (input.dry_run === true) return ok({ dry_run: true, capability: this.capability, platform: 'linux' });
    if (signal?.aborted === true) return cancelled();
    try {
      if (this.capability === 'system_info') return this.systemInfo(input, signal);
      if (this.capability === 'journal') return this.journal(input, signal);
      return this.network(input, signal);
    } catch {
      return err(appError('CAPABILITY_UNAVAILABLE', 'Linux observability provider failed', true));
    }
  }

  private async systemInfo(input: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<Result<unknown>> {
    const operation = typeof input.operation === 'string' ? input.operation : 'summary';
    if (operation === 'summary' || operation === 'all') {
      return ok({
        platform: 'linux',
        os: { platform: 'linux', release: os.release(), architecture: os.arch(), hostname: os.hostname() },
        cpu: { model: os.cpus()[0]?.model ?? 'unknown', logical_count: os.cpus().length, load_average: os.loadavg() },
        memory: { total_bytes: os.totalmem(), free_bytes: os.freemem() },
        uptime_seconds: os.uptime(),
      });
    }
    if (operation === 'os') return ok({ platform: 'linux', release: os.release(), architecture: os.arch(), hostname: os.hostname() });
    if (operation === 'cpu') return ok({ model: os.cpus()[0]?.model ?? 'unknown', logical_count: os.cpus().length, load_average: os.loadavg() });
    if (operation === 'memory') return ok({ total_bytes: os.totalmem(), free_bytes: os.freemem() });
    if (operation === 'uptime') return ok({ uptime_seconds: os.uptime() });
    if (operation === 'disk' || operation === 'disks') return this.disk(input, signal);
    if (operation === 'processes') return ok({ processes: await this.processes(readLimit(input.limit ?? input.top_count, MAX_PROCESSES)) });
    if (operation === 'ports') return this.listeners(readLimit(input.limit, MAX_PORTS), signal);
    if (operation === 'battery') return ok({ available: false, reason: 'provider_not_configured' });
    return invalid(`Unknown system_info operation: ${operation}`);
  }

  private async disk(input: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<Result<unknown>> {
    const requestedPath = typeof input.path === 'string' && input.path.trim().length > 0 ? input.path : '/';
    if (requestedPath.includes('\0') || !path.isAbsolute(requestedPath)) return invalid('Disk path must be absolute');
    const result = await this.command('df', ['-P', '--output=source,fstype,size,used,avail,pcent,target', requestedPath], signal);
    if (!result.ok) return result;
    if (result.value.exitCode !== 0) return commandUnavailable();
    const mounts = parseDf(result.value.stdout);
    return ok({ mounts, provider: 'df', truncated: result.value.truncated });
  }

  private async processes(limit: number): Promise<readonly Readonly<Record<string, unknown>>[]> {
    try {
      const entries = await readdir(this.procRoot, { withFileTypes: true });
      const pids = entries.filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name)).slice(0, MAX_PROCESSES);
      const processes: Array<Readonly<Record<string, unknown>>> = [];
      for (const entry of pids) {
        const status = await readFile(path.join(this.procRoot, entry.name, 'status'), 'utf8').catch(() => '');
        const command = await readFile(path.join(this.procRoot, entry.name, 'cmdline'), 'utf8').catch(() => '');
        const name = /^Name:\s+(.+)$/m.exec(status)?.[1]?.trim() ?? entry.name;
        const memory = /^(?:VmRSS|VmSize):\s+(\d+)\s+kB$/m.exec(status)?.[1];
        const commandLine = command.replace(/\0/g, ' ').trim() || name;
        processes.push({ pid: Number(entry.name), name, command: redactText(commandLine), ...(memory === undefined ? {} : { memory_kb: Number(memory) }) });
      }
      return processes.sort((left, right) => Number(right.memory_kb ?? 0) - Number(left.memory_kb ?? 0)).slice(0, limit);
    } catch {
      return [];
    }
  }

  private async journal(input: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<Result<unknown>> {
    const unit = optionalString(input.unit);
    const priority = typeof input.priority === 'number' ? String(input.priority) : optionalString(input.priority);
    const since = optionalString(input.since);
    const lines = readLimit(input.lines, MAX_JOURNAL_LINES, 100);
    if (unit !== undefined && !SYSTEMD_UNIT.test(unit)) return invalid('Journal unit is invalid');
    if (priority !== undefined && !JOURNAL_PRIORITY.test(priority)) return invalid('Journal priority is invalid');
    if (since !== undefined && !SAFE_SINCE.test(since)) return invalid('Journal since value is invalid');
    const args = ['--no-pager', '--output=json', '-n', String(lines)];
    if (unit !== undefined) args.push('-u', unit);
    if (priority !== undefined) args.push('-p', priority);
    if (since !== undefined) args.push('--since', since);
    const result = await this.command('journalctl', args, signal);
    if (!result.ok) return result;
    if (result.value.exitCode !== 0) return commandUnavailable();
    const entries = result.value.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(0, lines).map(parseJournalLine);
    return ok({ entries, provider: 'journalctl', truncated: result.value.truncated || entries.length >= lines });
  }

  private async network(input: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<Result<unknown>> {
    const operation = typeof input.operation === 'string' ? input.operation : 'interfaces';
    if (operation === 'dns') return this.dns(input);
    if (operation === 'connectivity') return this.connectivity(input);
    if (operation === 'listeners') return this.listeners(readLimit(input.limit, MAX_PORTS, 100), signal);
    if (operation === 'interfaces' || operation === 'routes') {
      const args = operation === 'interfaces' ? ['-json', 'address', 'show'] : ['-json', 'route', 'show'];
      const result = await this.command('ip', args, signal);
      if (!result.ok) return result;
      if (result.value.exitCode !== 0) return commandUnavailable();
      let value: unknown;
      try { value = JSON.parse(result.value.stdout); } catch { return commandUnavailable(); }
      return ok({ [operation]: Array.isArray(value) ? value : [], provider: 'ip', truncated: result.value.truncated });
    }
    return invalid(`Unknown network operation: ${operation}`);
  }

  private async listeners(limit: number, signal?: AbortSignal): Promise<Result<unknown>> {
    const result = await this.command('ss', ['-H', '-ltnup'], signal);
    if (!result.ok) return result;
    if (result.value.exitCode !== 0) return commandUnavailable();
    return ok({ listeners: parseListeners(result.value.stdout).slice(0, limit), provider: 'ss', truncated: result.value.truncated });
  }

  private async dns(input: Readonly<Record<string, unknown>>): Promise<Result<unknown>> {
    const host = optionalString(input.host);
    if (host === undefined) return ok({ nameservers: await readNameservers(), provider: 'resolv.conf' });
    if (!/^[A-Za-z0-9.-]{1,253}$/.test(host)) return invalid('DNS host is invalid');
    try {
      const addresses = await lookup(host, { all: true });
      return ok({ host, addresses: addresses.map((entry) => entry.address), provider: 'node:dns' });
    } catch {
      return commandUnavailable();
    }
  }

  private async connectivity(input: Readonly<Record<string, unknown>>): Promise<Result<unknown>> {
    const host = optionalString(input.host) ?? 'localhost';
    return this.dns({ host });
  }

  private async command(name: string, args: readonly string[], signal?: AbortSignal): Promise<Result<LinuxCommandResult>> {
    if (signal?.aborted === true) return cancelled();
    const executable = await this.resolveExecutable(name);
    if (executable === null) return err(appError('CAPABILITY_UNAVAILABLE', `Required Linux dependency is unavailable: ${name}`, true));
    try {
      const result = await this.runner.run(executable, args, signal);
      if (signal !== undefined && signal.aborted) return cancelled();
      return ok(result);
    } catch {
      return commandUnavailable();
    }
  }
}

async function defaultResolveExecutable(name: string): Promise<string | null> {
  const result = await new PathExecutableResolver().resolve(name);
  return result.ok ? result.value : null;
}

function dependenciesFor(capability: LinuxObservabilityCapabilityName): readonly string[] {
  if (capability === 'journal') return ['journalctl'];
  if (capability === 'network') return ['ip', 'ss'];
  return [];
}

function providerFor(capability: LinuxObservabilityCapabilityName): string {
  if (capability === 'system_info') return 'node+procfs';
  if (capability === 'journal') return 'journalctl';
  return 'ip+ss+resolv.conf';
}

function detectDisplayServer(environment: Readonly<Record<string, string | undefined>>): string {
  if (environment.WAYLAND_DISPLAY?.trim()) return 'wayland';
  if (environment.DISPLAY?.trim()) return 'x11';
  return 'headless';
}

function parseDf(stdout: string): readonly Readonly<Record<string, unknown>>[] {
  return stdout.split(/\r?\n/).slice(1).flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 7) return [];
    const target = fields.slice(6).join(' ');
    return [{ source: fields[0], filesystem: fields[1], size_bytes: Number(fields[2]), used_bytes: Number(fields[3]), available_bytes: Number(fields[4]), usage_percent: fields[5], target }];
  });
}

function parseListeners(stdout: string): readonly Readonly<Record<string, unknown>>[] {
  return stdout.split(/\r?\n/).flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5) return [];
    return [{ state: fields[0], local_address: fields[3], peer_address: fields[4], process: fields.slice(5).join(' ') || undefined }];
  });
}

function parseJournalLine(line: string): Readonly<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(line);
    return sanitizeRecord(value);
  } catch {
    return { message: redactText(line) };
  }
}

function sanitizeRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) return { value: redactText(String(value)) };
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeValue(entry)]));
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeValue(entry)]));
  return value;
}

function redactText(value: string): string {
  return value
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/\b(token|secret|password|api[_-]?key|private[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]');
}

async function readNameservers(): Promise<readonly string[]> {
  const content = await readFile('/etc/resolv.conf', 'utf8').catch(() => '');
  return content.split(/\r?\n/).flatMap((line) => /^\s*nameserver\s+(\S+)/.exec(line)?.[1] ?? []);
}

function readLimit(value: unknown, max: number, fallback = max): number {
  return typeof value === 'number' && Number.isInteger(value) ? Math.max(1, Math.min(max, value)) : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function isStatusRequest(input: Readonly<Record<string, unknown>>): boolean {
  return input.action === 'status' || input.operation === 'status';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string): Result<never> {
  return err(appError('INVALID_INPUT', message));
}

function commandUnavailable(): Result<never> {
  return err(appError('CAPABILITY_UNAVAILABLE', 'Linux observability provider failed', true));
}

function cancelled(): Result<never> {
  return err(appError('PROCESS_TIMEOUT', 'Linux observability operation was cancelled', true));
}
