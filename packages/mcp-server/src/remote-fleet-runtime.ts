import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import type { CapabilityService } from '@baitonghub-linux-mcp/capabilities';

export type RemoteFleetOperation = 'health' | 'inventory' | 'service-status' | 'disk_usage' | 'checksum' | 'network' | 'snapshot';

export interface RemoteFleetRequest {
  readonly hostIds: readonly string[];
  readonly operation: RemoteFleetOperation;
  readonly path?: string;
  readonly unit?: string;
  readonly maxParallel?: number;
}

interface FleetHostResult {
  readonly hostId: string;
  readonly status: 'ok' | 'error';
  readonly value?: unknown;
  readonly error?: { readonly code: string; readonly message: string; readonly recoverable: boolean };
  readonly durationMs?: number;
  readonly truncated?: boolean;
}

export interface RemoteFleetAuditEvent {
  readonly hostId: string;
  readonly operation: RemoteFleetOperation;
  readonly resultCode: string;
  readonly durationMs: number;
  readonly truncated?: boolean;
}

export interface RemoteFleetRuntimeOptions {
  /** Maximum wall-clock time for all fixed reads for one host. */
  readonly hostTimeoutMs?: number;
}

const MAX_HOSTS = 20;
const MAX_CONCURRENCY = 4;
const HOST_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAX_HOST_BYTES = 256 * 1024;

/**
 * Read-only fan-out for registered remote_host records.  Host credentials,
 * addresses, and commands stay inside the remote-host capability boundary;
 * this runtime accepts only registry IDs and fixed operation names.
 */
export class RemoteFleetRuntime {
  private readonly hostTimeoutMs: number;

  public constructor(
    private readonly capabilities: Pick<CapabilityService, 'execute'> | undefined,
    private readonly audit?: (event: RemoteFleetAuditEvent) => Promise<void>,
    options: RemoteFleetRuntimeOptions = {},
  ) {
    this.hostTimeoutMs = typeof options.hostTimeoutMs === 'number' && Number.isFinite(options.hostTimeoutMs)
      ? Math.max(1, Math.min(120_000, Math.floor(options.hostTimeoutMs)))
      : 30_000;
  }

  public async execute(input: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
    const request = parseRequest(input);
    if (!request.ok) return request;
    if (this.capabilities === undefined) return err(appError('CAPABILITY_UNAVAILABLE', 'Remote host capability is not configured', true));
    if (signal?.aborted === true) return err(appError('PROCESS_TIMEOUT', 'Remote fleet operation was cancelled', true));

    const hostIds = request.value.operation === 'snapshot'
      ? [...request.value.hostIds].sort((left, right) => left.localeCompare(right))
      : request.value.hostIds;
    const results: Array<FleetHostResult | undefined> = Array.from({ length: hostIds.length });
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        if (signal?.aborted === true) return;
        const index = nextIndex++;
        const hostId = hostIds[index];
        if (hostId === undefined) return;
        results[index] = await this.inspectHost(hostId, request.value, signal);
      }
    };
    await Promise.all(Array.from({ length: Math.min(request.value.maxParallel ?? MAX_CONCURRENCY, hostIds.length) }, () => worker()));

    for (let index = 0; index < hostIds.length; index += 1) {
      if (results[index] !== undefined) continue;
      const hostId = hostIds[index]!;
      results[index] = { hostId, status: 'error', error: { code: 'PROCESS_TIMEOUT', message: 'Remote fleet operation was cancelled before this host was inspected', recoverable: true } };
    }
    const hosts = results as FleetHostResult[];
    const failed = hosts.filter((entry) => entry.status === 'error').length;
    const cancelled = hosts.filter((entry) => entry.error?.code === 'PROCESS_TIMEOUT').length;
    if (request.value.operation === 'snapshot') {
      return ok({
        operation: 'snapshot',
        hosts,
        completed: hosts.length - failed,
        failed,
        truncated: hosts.some((entry) => entry.truncated === true),
        maxParallel: request.value.maxParallel ?? MAX_CONCURRENCY,
      });
    }
    return ok({
      operation: request.value.operation,
      hosts,
      summary: {
        requested: hosts.length,
        completed: hosts.length - failed,
        failed,
        cancelled,
        maxConcurrency: MAX_CONCURRENCY,
      },
    });
  }

  private async inspectHost(hostId: string, request: RemoteFleetRequest, signal?: AbortSignal): Promise<FleetHostResult> {
    const started = Date.now();
    const deadline = started + this.hostTimeoutMs;
    if (request.operation === 'snapshot') return this.snapshotHost(hostId, request, signal, started, deadline);
    const remoteRequest: Record<string, unknown> = { hostId, operation: request.operation };
    if (request.path !== undefined) remoteRequest.path = request.path;
    if (request.unit !== undefined) remoteRequest.unit = request.unit;
    try {
      const result = await this.executeRemote(remoteRequest, signal, deadline);
      if (result.ok) {
        const durationMs = Date.now() - started;
        const bounded = boundValue(projectRemoteValue(request.operation, result.value));
        await this.recordAudit({ hostId, operation: request.operation, resultCode: 'OK', durationMs, ...(bounded.truncated ? { truncated: true } : {}) });
        return { hostId, status: 'ok', value: bounded.value, durationMs, ...(bounded.truncated ? { truncated: true } : {}) };
      }
      return result.error === undefined
        ? await this.failedHost(hostId, request.operation, started, 'CAPABILITY_UNAVAILABLE', 'Remote host inspection failed')
        : await this.failedHost(hostId, request.operation, started, result.error.code, result.error.message, result.error.recoverable);
    } catch {
      return this.failedHost(hostId, request.operation, started, 'CAPABILITY_UNAVAILABLE', 'Remote host inspection failed');
    }
  }

  private async snapshotHost(hostId: string, request: RemoteFleetRequest, signal: AbortSignal | undefined, started: number, deadline: number): Promise<FleetHostResult> {
    const values: Record<string, unknown> = {};
    let truncated = false;
    for (const operation of ['health', 'inventory', 'service-status'] as const) {
      if (signal?.aborted === true) return this.failedHost(hostId, request.operation, started, 'PROCESS_TIMEOUT', 'Remote fleet operation was cancelled');
      const remoteRequest: Record<string, unknown> = { hostId, operation };
      if (request.path !== undefined) remoteRequest.path = request.path;
      if (request.unit !== undefined) remoteRequest.unit = request.unit;
      const result = await this.executeRemote(remoteRequest, signal, deadline);
      if (!result.ok) return this.failedHost(hostId, request.operation, started, result.error.code, result.error.message, result.error.recoverable);
      const bounded = boundValue(redactRemoteValue(result.value));
      values[operation] = bounded.value;
      truncated = truncated || bounded.truncated;
    }
    const durationMs = Date.now() - started;
    await this.recordAudit({ hostId, operation: request.operation, resultCode: 'OK', durationMs, ...(truncated ? { truncated: true } : {}) });
    return { hostId, status: 'ok', value: values, durationMs, ...(truncated ? { truncated: true } : {}) };
  }

  private async failedHost(hostId: string, operation: RemoteFleetOperation, started: number, code: string, message: string, recoverable = true): Promise<FleetHostResult> {
    const durationMs = Date.now() - started;
    await this.recordAudit({ hostId, operation, resultCode: code, durationMs });
    return { hostId, status: 'error', durationMs, error: { code, message: redactText(message), recoverable } };
  }

  private async recordAudit(event: RemoteFleetAuditEvent): Promise<void> {
    if (this.audit === undefined) return;
    try { await this.audit(event); } catch { /* telemetry must never alter the read result */ }
  }

  private async executeRemote(remoteRequest: Record<string, unknown>, signal: AbortSignal | undefined, deadline: number): Promise<Result<unknown>> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return err(appError('PROCESS_TIMEOUT', 'Remote host inspection timed out', true));
    if (signal?.aborted === true) return err(appError('PROCESS_TIMEOUT', 'Remote fleet operation was cancelled', true));
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const pending = this.capabilities!.execute('remote_host', remoteRequest, controller.signal);
      const timeout = new Promise<Result<unknown>>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(err(appError('PROCESS_TIMEOUT', 'Remote host inspection timed out', true)));
        }, remaining);
      });
      const cancelled = new Promise<Result<unknown>>((resolve) => {
        onAbort = (): void => {
          controller.abort();
          resolve(err(appError('PROCESS_TIMEOUT', 'Remote fleet operation was cancelled', true)));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      return await Promise.race([pending, timeout, cancelled]);
    } catch {
      return err(appError('CAPABILITY_UNAVAILABLE', 'Remote host inspection failed', true));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
    }
  }
}

function parseRequest(input: unknown): Result<RemoteFleetRequest> {
  if (!isRecord(input) || !Array.isArray(input.hostIds)) return err(appError('INVALID_INPUT', 'remote_fleet requires hostIds', false));
  const hostIds = input.hostIds.filter((value): value is string => typeof value === 'string').map((value) => value.trim());
  if (hostIds.length !== input.hostIds.length || hostIds.length < 1 || hostIds.length > MAX_HOSTS || hostIds.some((value) => !HOST_ID.test(value))) {
    return err(appError('INVALID_INPUT', 'remote_fleet hostIds must contain 1-20 valid registered host IDs', false));
  }
  if (new Set(hostIds).size !== hostIds.length) return err(appError('INVALID_INPUT', 'remote_fleet hostIds must not contain duplicates', false));
  const operation = input.operation;
  if (operation !== 'health' && operation !== 'inventory' && operation !== 'service-status' && operation !== 'disk_usage' && operation !== 'checksum' && operation !== 'network' && operation !== 'snapshot') return err(appError('INVALID_INPUT', 'remote_fleet operation is invalid', false));
  const path = input.path === undefined ? undefined : typeof input.path === 'string' ? input.path : null;
  if (path === null) return err(appError('INVALID_INPUT', 'remote_fleet path is invalid', false));
  const unit = input.unit === undefined ? undefined : typeof input.unit === 'string' ? input.unit : null;
  if (unit === null) return err(appError('INVALID_INPUT', 'remote_fleet unit is invalid', false));
  const maxParallel = input.maxParallel === undefined ? MAX_CONCURRENCY : input.maxParallel;
  if (typeof maxParallel !== 'number' || !Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > MAX_CONCURRENCY) return err(appError('INVALID_INPUT', 'remote_fleet maxParallel must be between 1 and 4', false));
  return ok({ hostIds, operation, ...(path === undefined ? {} : { path }), ...(unit === undefined ? {} : { unit }), maxParallel });
}

function redactRemoteValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[redacted]';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((entry) => redactRemoteValue(entry, depth + 1));
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, /(?:secret|password|token|private[_-]?key|api[_-]?key)/i.test(key) ? '[redacted]' : redactRemoteValue(entry, depth + 1)]));
}

function redactText(value: string): string {
  return value
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[redacted]')
    .replace(/\b(token|secret|password|api[_-]?key|private[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]');
}

function projectRemoteValue(operation: RemoteFleetOperation, value: unknown): unknown {
  const redacted = redactRemoteValue(value);
  if (operation !== 'network') return redacted;
  const output = isRecord(redacted) && typeof redacted.output === 'string' ? redacted.output : '';
  try {
    const parsed = JSON.parse(output) as unknown;
    if (!Array.isArray(parsed)) return { network: { status: 'unavailable' } };
    const interfaces = parsed.filter(isRecord);
    const upCount = interfaces.filter((entry) => entry.operstate === 'UP').length;
    const addressCount = interfaces.reduce((total, entry) => total + (Array.isArray(entry.addr_info) ? entry.addr_info.length : 0), 0);
    return { network: { interfaceCount: interfaces.length, upCount, addressCount } };
  } catch {
    return { network: { status: 'unavailable' } };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundValue(value: unknown): { readonly value: unknown; readonly truncated: boolean } {
  let serialized: string;
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) return { value: '[unavailable]', truncated: true };
    serialized = encoded;
  } catch { return { value: '[unavailable]', truncated: true }; }
  if (Buffer.byteLength(serialized, 'utf8') <= MAX_HOST_BYTES) return { value, truncated: false };
  return { value: '[truncated]', truncated: true };
}

export const LinuxRemoteFleetRuntime = RemoteFleetRuntime;
