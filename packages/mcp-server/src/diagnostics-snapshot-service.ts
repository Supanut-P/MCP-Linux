import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import type { CapabilityService } from '@baitonghub-linux-mcp/capabilities';
import type { FileActor } from '@baitonghub-linux-mcp/application';
import type { AuditQueryService } from './audit-query-service.js';
import { RuntimeMetricsService } from './runtime-metrics-service.js';

const MAX_SERIALIZED_BYTES = 128 * 1024;
const SAFE_DEPENDENCY = /^[A-Za-z0-9][A-Za-z0-9._:+/@-]{0,127}$/;

export interface DiagnosticsSnapshotOutput {
  readonly snapshotAt: string;
  readonly status: 'ready' | 'degraded' | 'unavailable';
  readonly health: DiagnosticsHealthSummary;
  readonly runtime: DiagnosticsRuntimeSummary;
  readonly audit: DiagnosticsAuditSummary;
  readonly dependencies: DiagnosticsDependencySummary;
}

export interface DiagnosticsHealthSummary {
  readonly available: boolean;
  readonly ready: boolean;
  readonly unavailableCount: number;
  readonly consentRequiredCount: number;
  readonly missingDependencies: readonly string[];
}

export interface DiagnosticsRuntimeSummary {
  readonly available: boolean;
  readonly ready: boolean;
  readonly snapshot?: Record<string, unknown>;
}

export interface DiagnosticsAuditSummary {
  readonly available: boolean;
  readonly ready: boolean;
  readonly count: number;
  readonly truncated: boolean;
}

export interface DiagnosticsDependencySummary {
  readonly ready: boolean;
  readonly missingDependencies: readonly string[];
}

export interface DiagnosticsSnapshotServiceOptions {
  readonly capabilities?: Pick<CapabilityService, 'execute'>;
  readonly runtimeMetrics?: Pick<RuntimeMetricsService, 'execute'>;
  readonly auditQuery?: Pick<AuditQueryService, 'execute'>;
}

/** Aggregates existing read-only health surfaces without exposing raw provider data. */
export class DiagnosticsSnapshotService {
  public constructor(private readonly options: DiagnosticsSnapshotServiceOptions) {}

  public async execute(actor: FileActor, signal?: AbortSignal): Promise<Result<DiagnosticsSnapshotOutput>> {
    if (signal !== undefined && Boolean(signal.aborted)) return err(appError('PROCESS_TIMEOUT', 'Diagnostics snapshot was cancelled', true));
    if (this.options.capabilities === undefined && this.options.runtimeMetrics === undefined && this.options.auditQuery === undefined) {
      return err(appError('CAPABILITY_UNAVAILABLE', 'Diagnostics snapshot is unavailable', true));
    }

    const [health, runtime, audit] = await Promise.all([
      this.readHealth(signal),
      this.readRuntime(signal),
      this.readAudit(actor, signal),
    ]);
    if (signal !== undefined && Boolean(signal.aborted)) return err(appError('PROCESS_TIMEOUT', 'Diagnostics snapshot was cancelled', true));

    const dependencies: DiagnosticsDependencySummary = {
      ready: health.ready && health.missingDependencies.length === 0,
      missingDependencies: health.missingDependencies,
    };
    const status = health.available && health.ready && runtime.ready && audit.ready
      ? 'ready'
      : health.available || runtime.available || audit.available
        ? 'degraded'
        : 'unavailable';
    const value: DiagnosticsSnapshotOutput = {
      snapshotAt: new Date().toISOString(),
      status,
      health,
      runtime,
      audit,
      dependencies,
    };
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_SERIALIZED_BYTES) {
      return err(appError('CAPABILITY_UNAVAILABLE', 'Diagnostics snapshot exceeded the size limit', true));
    }
    return ok(value);
  }

  private async readHealth(signal?: AbortSignal): Promise<DiagnosticsHealthSummary> {
    if (this.options.capabilities === undefined || signal?.aborted === true) return unavailableHealth();
    try {
      const result = await this.options.capabilities.execute('health', { operation: 'check_all' }, signal);
      if (!result.ok) return unavailableHealth();
      return summarizeHealth(result.value);
    } catch {
      return unavailableHealth();
    }
  }

  private async readRuntime(signal?: AbortSignal): Promise<DiagnosticsRuntimeSummary> {
    if (this.options.runtimeMetrics === undefined || signal?.aborted === true) return { available: false, ready: false };
    try {
      const result = await this.options.runtimeMetrics.execute({ operation: 'snapshot', scopes: ['host', 'runtime', 'tasks'] }, signal);
      if (!result.ok || !isRecord(result.value)) return { available: false, ready: false };
      return { available: true, ready: true, snapshot: sanitizeRuntime(result.value) };
    } catch {
      return { available: false, ready: false };
    }
  }

  private async readAudit(actor: FileActor, signal?: AbortSignal): Promise<DiagnosticsAuditSummary> {
    if (this.options.auditQuery === undefined || signal?.aborted === true) return { available: false, ready: false, count: 0, truncated: false };
    try {
      const result = await this.options.auditQuery.execute(actor, { limit: 1 }, signal);
      if (!result.ok || !isRecord(result.value)) return { available: false, ready: false, count: 0, truncated: false };
      const count = boundedCount(result.value.count);
      return { available: true, ready: true, count, truncated: result.value.truncated === true };
    } catch {
      return { available: false, ready: false, count: 0, truncated: false };
    }
  }
}

function summarizeHealth(value: unknown): DiagnosticsHealthSummary {
  const capabilities = isRecord(value) && isRecord(value.capabilities) ? value.capabilities : {};
  const entries = Object.values(capabilities).filter(isRecord);
  let available = entries.length > 0;
  let ready = entries.length > 0;
  let unavailableCount = 0;
  let consentRequiredCount = 0;
  const missingDependencies = new Set<string>();
  for (const entry of entries) {
    if (entry.available !== true) { available = false; unavailableCount += 1; }
    if (entry.ready !== true) ready = false;
    if (entry.requiresConsent === true) consentRequiredCount += 1;
    if (Array.isArray(entry.missingDependencies)) {
      for (const dependency of entry.missingDependencies) {
        if (typeof dependency === 'string' && SAFE_DEPENDENCY.test(dependency)) missingDependencies.add(dependency);
      }
    }
  }
  return {
    available,
    ready: ready && missingDependencies.size === 0,
    unavailableCount,
    consentRequiredCount,
    missingDependencies: [...missingDependencies].sort(),
  };
}

function unavailableHealth(): DiagnosticsHealthSummary {
  return { available: false, ready: false, unavailableCount: 0, consentRequiredCount: 0, missingDependencies: [] };
}

function sanitizeRuntime(value: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const section of ['host', 'runtime', 'tasks'] as const) {
    const candidate = value[section];
    if (isRecord(candidate)) output[section] = candidate;
  }
  return output;
}

function boundedCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1_000_000_000) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
