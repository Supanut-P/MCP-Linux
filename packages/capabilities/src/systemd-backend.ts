import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import { PathExecutableResolver } from '@baitonghub-linux-mcp/process';
import type { NativeCapabilityBackend, NativeCapabilityHealth } from './platform/types.js';
import { LinuxCommandRunner, type LinuxCommandResult } from './linux-command-runner.js';

export type SystemdOperation = 'list' | 'status' | 'is-enabled' | 'start' | 'stop' | 'restart' | 'reload' | 'enable' | 'disable';

export interface SystemdBackendOptions {
  readonly platform?: NodeJS.Platform;
  readonly resolveExecutable?: (name: string) => Promise<string | null>;
  readonly runner?: LinuxCommandRunner;
}

const SYSTEMD_UNIT = /^[A-Za-z0-9_.@:-]{1,256}\.(service|socket|timer|path)$/;
const BLOCKED_UNIT = /(?:^|[-_.:])(shutdown|reboot|emergency|rescue)(?:[-_.:]|$)/i;
const SHOW_PROPERTIES = [
  'Id', 'Names', 'Description', 'LoadState', 'ActiveState', 'SubState',
  'UnitFileState', 'FragmentPath', 'MainPID', 'ExecMainStartTimestamp',
].join(',');
const MUTATIONS = new Set<SystemdOperation>(['start', 'stop', 'restart', 'reload', 'enable', 'disable']);

export class SystemdBackend implements NativeCapabilityBackend {
  private readonly platform: NodeJS.Platform;
  private readonly resolveExecutable: (name: string) => Promise<string | null>;
  private readonly runner: LinuxCommandRunner;

  public constructor(options: SystemdBackendOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.resolveExecutable = options.resolveExecutable ?? defaultResolveExecutable;
    this.runner = options.runner ?? new LinuxCommandRunner({ allowedExecutables: ['systemctl'], maxBytes: 512 * 1024 });
  }

  public async health(): Promise<NativeCapabilityHealth> {
    if (this.platform !== 'linux') return { platform: this.platform, available: false, ready: false, requiresConsent: false, missingDependencies: [], reason: 'platform_unsupported' };
    const executable = await this.resolveExecutable('systemctl');
    const available = executable !== null;
    return { platform: this.platform, provider: 'systemctl', available, ready: available, requiresConsent: false, missingDependencies: available ? [] : ['systemctl'], ...(available ? {} : { reason: 'missing_dependencies' }) };
  }

  public async execute(input: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
    if (this.platform !== 'linux') return err(appError('PLATFORM_UNSUPPORTED', 'Linux service administration is unavailable on this platform', true));
    if (!isRecord(input)) return invalid('Service input must be an object');
    if (input.action === 'status' || input.operation === 'health') return ok(await this.health());
    const operation = typeof input.operation === 'string' ? input.operation as SystemdOperation : 'status';
    if (!['list', 'status', 'is-enabled', 'start', 'stop', 'restart', 'reload', 'enable', 'disable'].includes(operation)) return invalid(`Unknown service operation: ${operation}`);
    if (operation === 'list') return this.list(signal);
    const unit = typeof input.unit === 'string' ? input.unit.trim() : '';
    if (!SYSTEMD_UNIT.test(unit)) return invalid('Systemd unit is invalid');
    if (BLOCKED_UNIT.test(unit.replace(/\.(service|socket|timer|path)$/i, ''))) return invalid('Shutdown, reboot, emergency, and rescue units are blocked');
    if (input.dry_run === true) return ok({ dry_run: true, operation, unit, capability: 'service' });
    if (MUTATIONS.has(operation) && !isConfirmed(input)) return err(appError('PERMISSION_REQUIRED', 'Service mutations require explicit user confirmation', true));
    if (signal?.aborted === true) return cancelled();
    if (operation === 'status') return this.status(unit, signal);
    if (operation === 'is-enabled') return this.command(['is-enabled', unit], signal, 'is-enabled');
    return this.command([operation, unit], signal, operation);
  }

  private async list(signal?: AbortSignal): Promise<Result<unknown>> {
    return this.command(['list-units', '--all', '--no-legend', '--no-pager', '--type=service'], signal, 'list');
  }

  private async status(unit: string, signal?: AbortSignal): Promise<Result<unknown>> {
    const result = await this.run(['show', '--no-pager', `--property=${SHOW_PROPERTIES}`, unit], signal);
    if (!result.ok) return result;
    if (result.value.exitCode !== 0) return unavailable();
    const properties: Record<string, string> = {};
    for (const line of result.value.stdout.split(/\r?\n/)) {
      const separator = line.indexOf('=');
      if (separator > 0) properties[line.slice(0, separator)] = redact(line.slice(separator + 1));
    }
    return ok({ unit, properties, provider: 'systemctl', truncated: result.value.truncated });
  }

  private async command(args: readonly string[], signal: AbortSignal | undefined, operation: string): Promise<Result<unknown>> {
    const result = await this.run(args, signal);
    if (!result.ok) return result;
    if (result.value.exitCode !== 0) return unavailable();
    const lines = result.value.stdout.split(/\r?\n/).map((line) => redact(line)).filter((line) => line.length > 0).slice(0, 1000);
    return ok({ operation, unit: args.at(-1), output: lines, provider: 'systemctl', truncated: result.value.truncated });
  }

  private async run(args: readonly string[], signal?: AbortSignal): Promise<Result<LinuxCommandResult>> {
    if (signal?.aborted === true) return cancelled();
    const executable = await this.resolveExecutable('systemctl');
    if (executable === null) return err(appError('CAPABILITY_UNAVAILABLE', 'Required Linux dependency is unavailable: systemctl', true));
    try {
      const result = await this.runner.run(executable, args, signal);
      return wasAborted(signal) ? cancelled() : ok(result);
    } catch { return unavailable(); }
  }
}

export const LinuxSystemdBackend = SystemdBackend;

async function defaultResolveExecutable(name: string): Promise<string | null> {
  const result = await new PathExecutableResolver().resolve(name);
  return result.ok ? result.value : null;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isConfirmed(input: Record<string, unknown>): boolean { return input.userConfirmed === true; }
function wasAborted(signal: AbortSignal | undefined): boolean { return signal?.aborted === true; }
function invalid(message: string): Result<never> { return err(appError('INVALID_INPUT', message)); }
function unavailable(): Result<never> { return err(appError('CAPABILITY_UNAVAILABLE', 'systemd provider failed', true)); }
function cancelled(): Result<never> { return err(appError('PROCESS_TIMEOUT', 'Service operation was cancelled', true)); }
function redact(value: string): string { return value.replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, '$1[redacted]').replace(/\b(token|secret|password|api[_-]?key|private[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]'); }
