import * as os from 'node:os';
import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import { ActivityTracker } from './activity-tracker.js';

const MAX_SERIALIZED_BYTES = 64 * 1024;
const MAX_COUNTER = 1_000_000_000;
const MAX_METRIC_VALUE = Number.MAX_SAFE_INTEGER;
const RUNTIME_SCOPES = ['host', 'runtime', 'tasks'] as const;
const TASK_STATES = ['queued', 'running', 'completed', 'failed', 'cancelled', 'timed_out', 'termination_unverified'] as const;

export type RuntimeMetricsScope = (typeof RUNTIME_SCOPES)[number];
export type RuntimeTaskState = (typeof TASK_STATES)[number];

export interface RuntimeMetricsOs {
  loadavg(): readonly number[];
  totalmem(): number;
  freemem(): number;
  uptime(): number;
}

export interface RuntimeTaskSnapshot {
  readonly byState: Partial<Readonly<Record<RuntimeTaskState, number>>>;
}

export interface RuntimeMetricsOptions {
  readonly activity?: ActivityTracker;
  readonly os?: RuntimeMetricsOs;
  readonly taskSnapshot?: () => RuntimeTaskSnapshot | Promise<RuntimeTaskSnapshot>;
}

interface RuntimeMetricsRequest {
  readonly operation: 'snapshot';
  readonly scopes: readonly RuntimeMetricsScope[];
}

export class RuntimeMetricsService {
  private readonly activity: ActivityTracker;
  private readonly operatingSystem: RuntimeMetricsOs;

  public constructor(private readonly options: RuntimeMetricsOptions = {}) {
    this.activity = options.activity ?? new ActivityTracker();
    this.operatingSystem = options.os ?? os;
  }

  public health(): Record<string, unknown> {
    return {
      platform: process.platform,
      displayServer: 'headless',
      provider: 'node:os+activity',
      available: true,
      ready: true,
      requiresConsent: false,
      missingDependencies: [],
    };
  }

  public async execute(input: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
    const request = parseRequest(input);
    if (!request.ok) return request;
    if (signal?.aborted === true) return err(appError('PROCESS_TIMEOUT', 'Runtime metrics snapshot was cancelled', true));

    try {
      const snapshot: Record<string, unknown> = {};
      for (const scope of RUNTIME_SCOPES) {
        if (!request.value.scopes.includes(scope)) continue;
        if (scope === 'host') snapshot.host = this.hostMetrics();
        if (scope === 'runtime') snapshot.runtime = this.activity.snapshot();
        if (scope === 'tasks') {
          const tasks = await this.taskMetrics();
          if (!tasks.ok) return tasks;
          snapshot.tasks = tasks.value;
        }
      }
      const serialized = JSON.stringify(snapshot);
      if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > MAX_SERIALIZED_BYTES) {
        return err(appError('CAPABILITY_UNAVAILABLE', 'Runtime metrics response exceeded the size limit', true));
      }
      return ok(snapshot);
    } catch {
      return err(appError('CAPABILITY_UNAVAILABLE', 'Runtime metrics are unavailable', true));
    }
  }

  private hostMetrics(): Record<string, number> {
    const loads = this.operatingSystem.loadavg();
    return {
      load1: finiteNonNegative(loads[0]),
      load5: finiteNonNegative(loads[1]),
      load15: finiteNonNegative(loads[2]),
      memoryTotalBytes: boundedCounter(this.operatingSystem.totalmem()),
      memoryFreeBytes: boundedCounter(this.operatingSystem.freemem()),
      uptimeSeconds: boundedCounter(this.operatingSystem.uptime()),
    };
  }

  private async taskMetrics(): Promise<Result<Record<string, unknown>>> {
    if (this.options.taskSnapshot === undefined) return err(appError('CAPABILITY_UNAVAILABLE', 'Runtime task metrics are unavailable', true));
    let supplied: RuntimeTaskSnapshot;
    try {
      supplied = await this.options.taskSnapshot();
    } catch {
      return err(appError('CAPABILITY_UNAVAILABLE', 'Runtime task metrics are unavailable', true));
    }
    if (!isTaskSnapshot(supplied)) return err(appError('CAPABILITY_UNAVAILABLE', 'Runtime task metrics are unavailable', true));

    const byState: Record<string, number> = {};
    let total = 0;
    for (const state of TASK_STATES) {
      const count = supplied.byState[state] ?? 0;
      if (!Number.isSafeInteger(count) || count < 0 || count > MAX_COUNTER) {
        return err(appError('CAPABILITY_UNAVAILABLE', 'Runtime task metrics are unavailable', true));
      }
      byState[state] = count;
      total += count;
      if (!Number.isSafeInteger(total) || total > MAX_COUNTER) {
        return err(appError('CAPABILITY_UNAVAILABLE', 'Runtime task metrics are unavailable', true));
      }
    }
    return ok({ total, byState });
  }
}

function parseRequest(input: unknown): Result<RuntimeMetricsRequest> {
  if (!isRecord(input)) return err(appError('INVALID_INPUT', 'Runtime metrics input is invalid'));
  if (input.operation !== undefined && input.operation !== 'snapshot') return err(appError('INVALID_INPUT', 'Runtime metrics operation is invalid'));
  const requestedScopes = input.scopes === undefined ? [...RUNTIME_SCOPES] : input.scopes;
  if (!Array.isArray(requestedScopes) || requestedScopes.length < 1 || requestedScopes.length > RUNTIME_SCOPES.length) {
    return err(appError('INVALID_INPUT', 'Runtime metrics scopes are invalid'));
  }
  const scopes: RuntimeMetricsScope[] = [];
  for (const scope of requestedScopes) {
    if (typeof scope !== 'string' || !(RUNTIME_SCOPES as readonly string[]).includes(scope) || scopes.includes(scope as RuntimeMetricsScope)) {
      return err(appError('INVALID_INPUT', 'Runtime metrics scopes are invalid'));
    }
    scopes.push(scope as RuntimeMetricsScope);
  }
  return ok({ operation: 'snapshot', scopes });
}

function isTaskSnapshot(value: unknown): value is RuntimeTaskSnapshot {
  if (!isRecord(value) || !isRecord(value.byState)) return false;
  if (Object.keys(value).some((key) => key !== 'byState')) return false;
  return Object.keys(value.byState).every((key) => (TASK_STATES as readonly string[]).includes(key));
}

function finiteNonNegative(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function boundedCounter(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.min(MAX_METRIC_VALUE, Math.floor(value)) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
