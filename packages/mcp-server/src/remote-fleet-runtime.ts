import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import type { CapabilityService } from '@baitonghub-linux-mcp/capabilities';

export type RemoteFleetOperation = 'health' | 'inventory' | 'service-status';

export interface RemoteFleetRequest {
  readonly hostIds: readonly string[];
  readonly operation: RemoteFleetOperation;
  readonly path?: string;
  readonly unit?: string;
}

interface FleetHostResult {
  readonly hostId: string;
  readonly status: 'ok' | 'error';
  readonly value?: unknown;
  readonly error?: { readonly code: string; readonly message: string; readonly recoverable: boolean };
}

const MAX_HOSTS = 20;
const MAX_CONCURRENCY = 4;
const HOST_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/**
 * Read-only fan-out for registered remote_host records.  Host credentials,
 * addresses, and commands stay inside the remote-host capability boundary;
 * this runtime accepts only registry IDs and fixed operation names.
 */
export class RemoteFleetRuntime {
  public constructor(private readonly capabilities: Pick<CapabilityService, 'execute'> | undefined) {}

  public async execute(input: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
    const request = parseRequest(input);
    if (!request.ok) return request;
    if (this.capabilities === undefined) return err(appError('CAPABILITY_UNAVAILABLE', 'Remote host capability is not configured', true));
    if (signal?.aborted === true) return err(appError('PROCESS_TIMEOUT', 'Remote fleet operation was cancelled', true));

    const results: Array<FleetHostResult | undefined> = Array.from({ length: request.value.hostIds.length });
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        if (signal?.aborted === true) return;
        const index = nextIndex++;
        const hostId = request.value.hostIds[index];
        if (hostId === undefined) return;
        results[index] = await this.inspectHost(hostId, request.value, signal);
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, request.value.hostIds.length) }, () => worker()));

    for (let index = 0; index < request.value.hostIds.length; index += 1) {
      if (results[index] !== undefined) continue;
      const hostId = request.value.hostIds[index]!;
      results[index] = { hostId, status: 'error', error: { code: 'PROCESS_TIMEOUT', message: 'Remote fleet operation was cancelled before this host was inspected', recoverable: true } };
    }
    const hosts = results as FleetHostResult[];
    const failed = hosts.filter((entry) => entry.status === 'error').length;
    const cancelled = hosts.filter((entry) => entry.error?.code === 'PROCESS_TIMEOUT').length;
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
    const remoteRequest: Record<string, unknown> = { hostId, operation: request.operation };
    if (request.path !== undefined) remoteRequest.path = request.path;
    if (request.unit !== undefined) remoteRequest.unit = request.unit;
    try {
      const result = await this.capabilities!.execute('remote_host', remoteRequest, signal);
      if (result.ok) return { hostId, status: 'ok', value: redactRemoteValue(result.value) };
      return result.error === undefined
        ? { hostId, status: 'error', error: { code: 'CAPABILITY_UNAVAILABLE', message: 'Remote host inspection failed', recoverable: true } }
        : { hostId, status: 'error', error: safeError(result.error) };
    } catch {
      return { hostId, status: 'error', error: { code: 'CAPABILITY_UNAVAILABLE', message: 'Remote host inspection failed', recoverable: true } };
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
  if (operation !== 'health' && operation !== 'inventory' && operation !== 'service-status') return err(appError('INVALID_INPUT', 'remote_fleet operation is invalid', false));
  const path = input.path === undefined ? undefined : typeof input.path === 'string' ? input.path : null;
  if (path === null) return err(appError('INVALID_INPUT', 'remote_fleet path is invalid', false));
  const unit = input.unit === undefined ? undefined : typeof input.unit === 'string' ? input.unit : null;
  if (unit === null) return err(appError('INVALID_INPUT', 'remote_fleet unit is invalid', false));
  return ok({ hostIds, operation, ...(path === undefined ? {} : { path }), ...(unit === undefined ? {} : { unit }) });
}

function safeError(error: { readonly code: string; readonly message: string; readonly recoverable: boolean }): NonNullable<FleetHostResult['error']> {
  return { code: error.code, message: redactText(error.message), recoverable: error.recoverable };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const LinuxRemoteFleetRuntime = RemoteFleetRuntime;
