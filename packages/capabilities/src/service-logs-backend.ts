import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import { PathExecutableResolver } from '@baitonghub-linux-mcp/process';
import type { NativeCapabilityBackend, NativeCapabilityHealth } from './platform/types.js';
import { LinuxCommandRunner, type LinuxCommandResult } from './linux-command-runner.js';

const SYSTEMD_UNIT = /^[A-Za-z0-9_.@:-]{1,256}\.service$/;
const CURSOR_TOKEN = /^[A-Za-z0-9_-]{1,512}$/;
const MAX_LINES = 500;
const MAX_BYTES = 256 * 1024;

export interface ServiceLogsBackendOptions {
  readonly platform?: NodeJS.Platform;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly resolveExecutable?: (name: string) => Promise<string | null>;
  readonly runner?: LinuxCommandRunner;
}

interface LogCursor {
  readonly version: 1;
  readonly unit: string;
  readonly timestampMs: number;
  readonly sequence: number;
}

interface JournalRecord {
  readonly entry: Readonly<Record<string, unknown>>;
  readonly timestampMs: number;
  readonly sequence: number;
}

/** Read-only, fixed-unit systemd log stream for Linux headless operation. */
export class ServiceLogsBackend implements NativeCapabilityBackend {
  private readonly platform: NodeJS.Platform;
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly resolveExecutable: (name: string) => Promise<string | null>;
  private readonly runner: LinuxCommandRunner;

  public constructor(options: ServiceLogsBackendOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.environment = options.environment ?? process.env;
    this.resolveExecutable = options.resolveExecutable ?? defaultResolveExecutable;
    this.runner = options.runner ?? new LinuxCommandRunner({
      allowedExecutables: ['journalctl'],
      maxBytes: MAX_BYTES,
    });
  }

  public async health(): Promise<NativeCapabilityHealth> {
    const displayServer = detectDisplayServer(this.environment);
    if (this.platform !== 'linux') {
      return {
        platform: this.platform,
        displayServer,
        provider: 'journalctl',
        available: false,
        ready: false,
        requiresConsent: false,
        missingDependencies: ['journalctl'],
        reason: 'platform_unsupported',
      };
    }
    let executable: string | null;
    try {
      executable = await this.resolveExecutable('journalctl');
    } catch {
      executable = null;
    }
    return {
      platform: this.platform,
      displayServer,
      provider: 'journalctl',
      available: executable !== null,
      ready: executable !== null,
      requiresConsent: false,
      missingDependencies: executable === null ? ['journalctl'] : [],
      ...(executable === null ? { reason: 'missing_dependencies' } : {}),
    };
  }

  public async execute(input: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
    if (this.platform !== 'linux') return err(appError('PLATFORM_UNSUPPORTED', 'Service logs are unavailable on this platform', true));
    if (!isRecord(input)) return invalid('Service logs input must be an object');
    if (signal?.aborted === true) return cancelled();

    const operation = input.operation === undefined ? 'read' : input.operation;
    if (operation !== 'read' && operation !== 'tail') return invalid('Service logs operation is invalid');
    const unit = typeof input.unit === 'string' ? input.unit.trim() : '';
    if (!SYSTEMD_UNIT.test(unit)) return invalid('Service logs unit is invalid');
    const lines = readLimit(input.lines, MAX_LINES, 100);
    const maxBytes = readLimit(input.maxBytes, MAX_BYTES, MAX_BYTES, 1_024);
    const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor, unit);
    if (input.cursor !== undefined && cursor === null) return invalid('Service logs cursor is invalid');

    let executable: string | null;
    try {
      executable = await this.resolveExecutable('journalctl');
    } catch {
      executable = null;
    }
    if (executable === null) return unavailable();
    const args = ['--no-pager', '--output=json', '--utc', '-u', unit, '-n', String(lines)];
    if (cursor !== undefined && cursor !== null) args.push('--since', `@${(cursor.timestampMs / 1000).toFixed(3)}`);
    try {
      const result = await this.runner.run(executable, args, signal);
      if (signal !== undefined && signal.aborted) return cancelled();
      if (result.exitCode !== 0) return unavailable();
      return ok(formatResult(unit, result, cursor ?? undefined, maxBytes, lines));
    } catch {
      return unavailable();
    }
  }
}

function formatResult(unit: string, result: LinuxCommandResult, cursor: LogCursor | undefined, maxBytes: number, lines: number): Readonly<Record<string, unknown>> {
  const parsedRecords = result.stdout
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map(parseRecord)
    .filter((record): record is JournalRecord => record !== null)
    .filter((record) => cursor === undefined || isAfter(record, cursor));
  const records = parsedRecords.slice(0, lines);
  const entries: Array<Readonly<Record<string, unknown>>> = [];
  let nextCursor: string | undefined;
  let truncated = result.truncated || parsedRecords.length > records.length;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const candidateEntries = [...entries, record.entry];
    const candidateCursor = encodeCursor({ version: 1, unit, timestampMs: record.timestampMs, sequence: record.sequence });
    const candidate = {
      unit,
      provider: 'journalctl',
      entries: candidateEntries,
      nextCursor: candidateCursor,
      truncated: result.truncated || index < records.length - 1,
    } satisfies Readonly<Record<string, unknown>>;
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > maxBytes) {
      truncated = true;
      break;
    }
    entries.push(record.entry);
    nextCursor = candidateCursor;
  }
  const value: Record<string, unknown> = {
    unit,
    provider: 'journalctl',
    entries,
    truncated,
  };
  if (nextCursor !== undefined) value.nextCursor = nextCursor;
  return value;
}

function parseRecord(line: string): JournalRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { entry: { message: redactText(line) }, timestampMs: 0, sequence: 0 };
  }
  const record = isRecord(value) ? value : { value };
  const timestampMs = readNumber(record._SOURCE_REALTIME_TIMESTAMP) / 1_000;
  const sequence = readNumber(record._SEQNUM);
  return {
    entry: sanitizeRecord(record),
    timestampMs: Number.isSafeInteger(timestampMs) || Number.isFinite(timestampMs) ? Math.max(0, timestampMs) : 0,
    sequence: Number.isSafeInteger(sequence) ? Math.max(0, sequence) : 0,
  };
}

function isAfter(record: JournalRecord, cursor: LogCursor): boolean {
  return record.timestampMs > cursor.timestampMs || (record.timestampMs === cursor.timestampMs && record.sequence > cursor.sequence);
}

function encodeCursor(cursor: LogCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: unknown, unit: string): LogCursor | null {
  if (typeof value !== 'string' || !CURSOR_TOKEN.test(value)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!isRecord(parsed) || parsed.version !== 1 || parsed.unit !== unit) return null;
    const timestampMs = readNumber(parsed.timestampMs);
    const sequence = readNumber(parsed.sequence);
    if (!Number.isFinite(timestampMs) || !Number.isSafeInteger(sequence) || timestampMs < 0 || sequence < 0) return null;
    return { version: 1, unit, timestampMs, sequence };
  } catch {
    return null;
  }
}

function sanitizeRecord(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, isSensitiveKey(key) ? '[redacted]' : sanitizeValue(entry)]));
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry));
  if (isRecord(value)) return sanitizeRecord(value);
  return value;
}

function isSensitiveKey(key: string): boolean {
  return /authorization|token|secret|password|api[_-]?key|private[_-]?key/i.test(key);
}

function redactText(value: string): string {
  return value
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/\b(token|secret|password|api[_-]?key|private[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]');
}

async function defaultResolveExecutable(name: string): Promise<string | null> {
  const result = await new PathExecutableResolver().resolve(name);
  return result.ok ? result.value : null;
}

function detectDisplayServer(environment: Readonly<Record<string, string | undefined>>): string {
  if (environment.WAYLAND_DISPLAY?.trim()) return 'wayland';
  if (environment.DISPLAY?.trim()) return 'x11';
  return 'headless';
}

function readLimit(value: unknown, max: number, fallback: number, min = 1): number {
  return typeof value === 'number' && Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function readNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string): Result<never> {
  return err(appError('INVALID_INPUT', message));
}

function unavailable(): Result<never> {
  return err(appError('CAPABILITY_UNAVAILABLE', 'Service log provider is unavailable', true));
}

function cancelled(): Result<never> {
  return err(appError('PROCESS_TIMEOUT', 'Service log operation was cancelled', true));
}
