import { createHash } from 'node:crypto';
import { mkdir, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import { PathExecutableResolver } from '@baitonghub-linux-mcp/process';
import type { NativeCapabilityBackend, NativeCapabilityHealth } from './platform/types.js';
import { LinuxCommandRunner } from './linux-command-runner.js';

export type ScheduleOperation = 'list' | 'plan' | 'create' | 'enable' | 'disable' | 'remove';
export interface ScheduleBackendOptions {
  readonly platform?: NodeJS.Platform;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly allowedRootsProvider?: () => Promise<readonly string[]>;
  readonly configHome?: string;
  readonly packagedCliPath?: string;
  readonly resolveExecutable?: (name: string) => Promise<string | null>;
  readonly runner?: LinuxCommandRunner;
}

const UNIT_NAME = /^[A-Za-z0-9_.@:-]{1,200}$/;
const BLOCKED_NAME = /(?:^|[-_.:])(shutdown|reboot|emergency|rescue)(?:[-_.:]|$)/i;
const CALENDAR = /^[A-Za-z0-9_*/,:+?%~.-]{1,128}(?:\s+[A-Za-z0-9_*/,:+?%~.-]{1,128})*$/;
const MAX_ARGS = 64;

export class ScheduleBackend implements NativeCapabilityBackend {
  private readonly platform: NodeJS.Platform;
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly allowedRootsProvider: () => Promise<readonly string[]>;
  private readonly configHome: string;
  private readonly packagedCliPath: string;
  private readonly resolveExecutable: (name: string) => Promise<string | null>;
  private readonly runner: LinuxCommandRunner;

  public constructor(options: ScheduleBackendOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.environment = options.environment ?? process.env;
    this.allowedRootsProvider = options.allowedRootsProvider ?? (async (): Promise<readonly string[]> => []);
    this.configHome = options.configHome ?? this.environment.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
    this.packagedCliPath = options.packagedCliPath ?? '/opt/baitonghub-linux-mcp/baitonghub-linux-mcp';
    this.resolveExecutable = options.resolveExecutable ?? defaultResolveExecutable;
    this.runner = options.runner ?? new LinuxCommandRunner({ allowedExecutables: ['systemctl'], maxBytes: 512 * 1024 });
  }

  public async health(): Promise<NativeCapabilityHealth> {
    if (this.platform !== 'linux') return { platform: this.platform, available: false, ready: false, requiresConsent: false, missingDependencies: [], reason: 'platform_unsupported' };
    const executable = await this.resolveExecutable('systemctl');
    const available = executable !== null;
    return { platform: this.platform, provider: 'systemd-user', available, ready: available, requiresConsent: false, missingDependencies: available ? [] : ['systemctl'], ...(available ? {} : { reason: 'missing_dependencies' }) };
  }

  public async execute(input: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
    if (this.platform !== 'linux') return err(appError('PLATFORM_UNSUPPORTED', 'Linux scheduling is unavailable on this platform', true));
    if (!isRecord(input)) return invalid('Schedule input must be an object');
    if (input.action === 'status' || input.operation === 'health') return ok(await this.health());
    const operation = typeof input.operation === 'string' ? input.operation as ScheduleOperation : 'list';
    if (!['list', 'plan', 'create', 'enable', 'disable', 'remove'].includes(operation)) return invalid(`Unknown schedule operation: ${operation}`);
    if (Object.keys(input).some((key) => ['cron', 'cronFile', 'cron_file', 'systemCron', 'system_cron'].includes(key))) return invalid('System-level cron scheduling is not supported');
    if (operation === 'list') return this.list();
    const unit = normalizeUnit(input.unit ?? input.name);
    if (unit === null) return invalid('Schedule unit name is invalid');
    if (BLOCKED_NAME.test(unit)) return invalid('Shutdown, reboot, emergency, and rescue schedules are blocked');
    if (operation === 'plan' || operation === 'create') {
      const planned = await this.plan(input, unit);
      if (!planned.ok) return planned;
      if (operation === 'plan' || input.dry_run === true) return planned;
      if (!isConfirmed(input)) return err(appError('PERMISSION_REQUIRED', 'Creating schedules requires explicit user confirmation', true));
      const expectedHash = typeof input.plan_hash === 'string' ? input.plan_hash : typeof input.planHash === 'string' ? input.planHash : undefined;
      if (expectedHash === undefined || expectedHash !== planned.value.plan_hash) return invalid('A matching plan_hash is required to create a schedule');
      return this.createFiles(unit, planned.value, signal);
    }
    if (input.dry_run === true) return ok({ dry_run: true, operation, unit, capability: 'schedule' });
    if (!isConfirmed(input)) return err(appError('PERMISSION_REQUIRED', 'Schedule mutations require explicit user confirmation', true));
    if (operation === 'remove') return this.remove(unit, signal);
    if (!(await this.hasUnitFiles(unit))) return invalid('Schedule unit was not created by the user schedule provider');
    return this.systemctl(operation, `${unit}.timer`, signal);
  }

  private async list(): Promise<Result<unknown>> {
    const directory = this.userUnitDirectory();
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    const units = entries.filter((entry) => entry.isFile() && UNIT_NAME.test(entry.name) && (entry.name.endsWith('.timer') || entry.name.endsWith('.service'))).map((entry) => entry.name).sort();
    return ok({ units, directory, provider: 'systemd-user' });
  }

  private async plan(input: Record<string, unknown>, unit: string): Promise<Result<Readonly<Record<string, unknown>>>> {
    const executable = typeof input.executable === 'string' ? input.executable.trim() : typeof input.command === 'string' ? input.command.trim() : '';
    if (executable.length === 0) return invalid('Schedule executable is required');
    const executablePath = await this.validateExecutable(executable);
    if (!executablePath.ok) return executablePath;
    const rawArgs = input.arguments ?? input.args;
    if (rawArgs !== undefined && (!Array.isArray(rawArgs) || rawArgs.length > MAX_ARGS || rawArgs.some((arg) => typeof arg !== 'string' || arg.length > 4096 || hasControlCharacters(arg)))) return invalid('Schedule arguments are invalid');
    const args = (rawArgs as string[] | undefined) ?? [];
    const calendar = typeof input.onCalendar === 'string' ? input.onCalendar.trim() : typeof input.calendar === 'string' ? input.calendar.trim() : '';
    if (!CALENDAR.test(calendar)) return invalid('Schedule onCalendar value is invalid');
    const persistent = input.persistent === true;
    const service = `[Unit]\nDescription=Baitonghub user schedule ${unit}\n\n[Service]\nType=oneshot\nExecStart=${systemdQuote(executablePath.value, args)}\n`;
    const timer = `[Unit]\nDescription=Baitonghub user timer ${unit}\n\n[Timer]\nOnCalendar=${calendar}\nPersistent=${persistent ? 'true' : 'false'}\nUnit=${unit}.service\n\n[Install]\nWantedBy=timers.target\n`;
    const planText = `${unit}.service\n${service}${unit}.timer\n${timer}`;
    const planHash = createHash('sha256').update(planText, 'utf8').digest('hex');
    return ok({ unit: `${unit}.timer`, executable: executablePath.value, arguments: args, on_calendar: calendar, service, timer, plan_hash: planHash, directory: this.userUnitDirectory(), provider: 'systemd-user' });
  }

  private async validateExecutable(executable: string): Promise<Result<string>> {
    if (hasControlCharacters(executable)) return invalid('Schedule executable contains control characters');
    if (executable === this.packagedCliPath) return ok(executable);
    if (!path.isAbsolute(executable) || executable.includes('\0')) return invalid('Schedule executable must be packaged CLI or an absolute registered-root path');
    const candidate = path.resolve(executable);
    const roots = await this.allowedRootsProvider();
    for (const root of roots) {
      if (!isInside(root, candidate)) continue;
      const resolved = await realpath(candidate).catch(() => null);
      if (resolved !== null && isInside(root, resolved)) {
        const metadata = await stat(resolved).catch(() => null);
        if (metadata?.isFile() === true && (metadata.mode & 0o111) !== 0) return ok(resolved);
        return invalid('Schedule executable must be a regular executable file');
      }
    }
    return err(appError('PATH_OUTSIDE_WORKSPACE', 'Schedule executable is outside registered roots'));
  }

  private async createFiles(unit: string, plan: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<Result<unknown>> {
    if (signal?.aborted === true) return cancelled();
    const directory = this.userUnitDirectory();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(directory, `${unit}.service`), String(plan.service), { encoding: 'utf8', mode: 0o600 });
    await writeFile(path.join(directory, `${unit}.timer`), String(plan.timer), { encoding: 'utf8', mode: 0o600 });
    return ok({ created: [`${unit}.service`, `${unit}.timer`], directory, plan_hash: plan.plan_hash, provider: 'systemd-user' });
  }

  private async systemctl(operation: 'enable' | 'disable', unit: string, signal?: AbortSignal): Promise<Result<unknown>> {
    const executable = await this.resolveExecutable('systemctl');
    if (executable === null) return err(appError('CAPABILITY_UNAVAILABLE', 'Required Linux dependency is unavailable: systemctl', true));
    if (signal?.aborted === true) return cancelled();
    try {
      const result = await this.runner.run(executable, ['--user', operation, unit], signal);
      if (wasAborted(signal)) return cancelled();
      if (result.exitCode !== 0) return unavailable();
      return ok({ operation, unit, provider: 'systemd-user', truncated: result.truncated });
    } catch { return unavailable(); }
  }

  private async remove(unit: string, signal?: AbortSignal): Promise<Result<unknown>> {
    const disabled = await this.systemctl('disable', `${unit}.timer`, signal);
    if (!disabled.ok && disabled.error.code !== 'CAPABILITY_UNAVAILABLE') return disabled;
    const directory = this.userUnitDirectory();
    await Promise.all([rm(path.join(directory, `${unit}.service`), { force: true }), rm(path.join(directory, `${unit}.timer`), { force: true })]);
    return ok({ removed: [`${unit}.service`, `${unit}.timer`], directory, provider: 'systemd-user' });
  }

  private userUnitDirectory(): string { return path.join(this.configHome, 'systemd', 'user'); }

  private async hasUnitFiles(unit: string): Promise<boolean> {
    const entries = await readdir(this.userUnitDirectory()).catch(() => []);
    const names = new Set(entries);
    return names.has(`${unit}.service`) && names.has(`${unit}.timer`);
  }
}

export const LinuxScheduleBackend = ScheduleBackend;

function normalizeUnit(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const unit = value.trim().replace(/\.(timer|service)$/i, '');
  return UNIT_NAME.test(unit) ? unit : null;
}
function systemdQuote(executable: string, args: readonly string[]): string { return [executable, ...args].map((value) => { const escaped = value.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll("'", "\\'"); return /[\s"'\\]/.test(value) ? `'${escaped}'` : escaped; }).join(' '); }
function isInside(root: string, candidate: string): boolean { const relative = path.relative(path.resolve(root), path.resolve(candidate)); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); }
function hasControlCharacters(value: string): boolean { return [...value].some((character) => { const code = character.codePointAt(0) ?? 0; return code < 0x20 || code === 0x7f; }); }
function defaultResolveExecutable(name: string): Promise<string | null> { return new PathExecutableResolver().resolve(name).then((result) => result.ok ? result.value : null); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isConfirmed(input: Record<string, unknown>): boolean { return input.userConfirmed === true; }
function wasAborted(signal: AbortSignal | undefined): boolean { return signal?.aborted === true; }
function invalid(message: string): Result<never> { return err(appError('INVALID_INPUT', message)); }
function unavailable(): Result<never> { return err(appError('CAPABILITY_UNAVAILABLE', 'systemd user provider failed', true)); }
function cancelled(): Result<never> { return err(appError('PROCESS_TIMEOUT', 'Schedule operation was cancelled', true)); }
