import { randomUUID } from 'node:crypto';

export interface ActivitySinkEvent {
  readonly callId: string;
  readonly toolName: string;
  readonly phase: 'started' | 'completed';
  readonly resultCode: string;
  readonly durationMs: number;
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly targetSummary?: string;
  readonly resultMessage?: string;
  readonly timestamp: string;
  readonly traceId?: string;
  readonly traceParent?: string;
}

export interface TraceContext {
  readonly sessionId?: string;
  readonly traceId?: string;
  readonly traceParent?: string;
}

export interface ActivitySink {
  record(event: ActivitySinkEvent): Promise<void>;
}

export type ActivityRecordErrorHandler = (error: unknown, event: ActivitySinkEvent) => void;

export interface InFlightToolCall {
  readonly callId: string;
  readonly toolName: string;
  readonly startedAt: string;
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly targetSummary?: string;
  readonly traceId?: string;
  readonly traceParent?: string;
}

export class ActivityTracker {
  private readonly inflight = new Map<string, InFlightToolCall>();
  private activityRevision = 0;

  public constructor(
    private readonly sink?: ActivitySink,
    private readonly onRecordError?: ActivityRecordErrorHandler,
  ) {}

  public listInFlight(): readonly InFlightToolCall[] {
    return [...this.inflight.values()];
  }

  public revision(): number {
    return this.activityRevision;
  }

  public async begin(toolName: string, input: unknown, traceContext?: TraceContext): Promise<string> {
    const callId = randomUUID();
    const timestamp = new Date().toISOString();
    const workspaceId = readWorkspaceId(input);
    const targetSummary = summarizeToolTarget(toolName, input);
    const trace = traceContext ?? readTraceContext(input);
    const entry: InFlightToolCall = {
      callId,
      toolName,
      startedAt: timestamp,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(trace.sessionId === undefined ? {} : { sessionId: trace.sessionId }),
      ...(targetSummary === undefined ? {} : { targetSummary }),
      ...(trace.traceId === undefined ? {} : { traceId: trace.traceId }),
      ...(trace.traceParent === undefined ? {} : { traceParent: trace.traceParent }),
    };
    this.inflight.set(callId, entry);
    this.activityRevision += 1;
    await this.safeRecord({
      callId,
      toolName,
      phase: 'started',
      resultCode: 'STARTED',
      durationMs: 0,
      timestamp,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(trace.sessionId === undefined ? {} : { sessionId: trace.sessionId }),
      ...(targetSummary === undefined ? {} : { targetSummary }),
      ...(trace.traceId === undefined ? {} : { traceId: trace.traceId }),
      ...(trace.traceParent === undefined ? {} : { traceParent: trace.traceParent }),
    });
    return callId;
  }

  public async end(callId: string, resultCode: string, durationMs: number, resultMessage?: string): Promise<void> {
    const existing = this.inflight.get(callId);
    this.inflight.delete(callId);
    this.activityRevision += 1;
    const timestamp = new Date().toISOString();
    await this.safeRecord({
      callId,
      toolName: existing?.toolName ?? 'unknown',
      phase: 'completed',
      resultCode,
      durationMs,
      timestamp,
      ...(existing?.workspaceId === undefined ? {} : { workspaceId: existing.workspaceId }),
      ...(existing?.sessionId === undefined ? {} : { sessionId: existing.sessionId }),
      ...(existing?.targetSummary === undefined ? {} : { targetSummary: existing.targetSummary }),
      ...(existing?.traceId === undefined ? {} : { traceId: existing.traceId }),
      ...(existing?.traceParent === undefined ? {} : { traceParent: existing.traceParent }),
      ...(resultMessage === undefined || resultMessage.length === 0 ? {} : { resultMessage }),
    });
  }

  private async safeRecord(event: ActivitySinkEvent): Promise<void> {
    if (this.sink === undefined) return;
    try {
      await this.sink.record(event);
    } catch (error: unknown) {
      // Activity recording must never fail tool execution, but failures must remain observable.
      try {
        this.onRecordError?.(error, event);
      } catch {
        // Diagnostics must not fail tool execution either.
      }
    }
  }
}

export function summarizeToolTarget(toolName: string, input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  const pathValue = firstString(input, ['path', 'relativePath', 'filePath', 'targetPath', 'sourcePath', 'destinationPath']);
  if (pathValue !== undefined) return summarizeForLog(pathValue);
  const query = firstString(input, ['query', 'pattern']);
  if (query !== undefined) return summarizeForLog(query);
  const executable = firstString(input, ['executable', 'command']);
  if (executable !== undefined) {
    const args = Array.isArray(input.arguments)
      ? input.arguments.filter((entry): entry is string => typeof entry === 'string').join(' ')
      : Array.isArray(input.args)
        ? input.args.filter((entry): entry is string => typeof entry === 'string').join(' ')
        : '';
    return summarizeForLog(args.length > 0 ? `${executable} ${args}` : executable);
  }
  const operation = firstString(input, ['operation', 'action', 'mode']);
  if (operation !== undefined) return summarizeForLog(`${toolName}:${operation}`);
  const skillId = firstString(input, ['skillId', 'serverId', 'name']);
  if (skillId !== undefined) return summarizeForLog(skillId);
  return undefined;
}

export function readTraceContext(input: unknown): TraceContext {
  if (!isRecord(input)) return {};
  const metadata = isRecord(input.metadata) ? input.metadata : undefined;
  const traceId = boundedTraceValue(input.trace_id ?? input.traceId ?? metadata?.trace_id ?? metadata?.traceId);
  const traceParent = boundedTraceValue(input.traceparent ?? input.traceParent ?? metadata?.traceparent ?? metadata?.traceParent);
  return {
    ...(traceId === undefined ? {} : { traceId }),
    ...(traceParent === undefined ? {} : { traceParent }),
  };
}

function readWorkspaceId(input: unknown): string | undefined {
  if (!isRecord(input) || typeof input.workspaceId !== 'string' || input.workspaceId.trim().length === 0) {
    return undefined;
  }
  return input.workspaceId;
}

function firstString(input: Readonly<Record<string, unknown>>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
}

const MAX_LOG_TARGET_CHARS = 4_096;

function summarizeForLog(value: string): string {
  return truncate(redactSensitiveLogText(value), MAX_LOG_TARGET_CHARS);
}

function redactSensitiveLogText(value: string): string {
  return value
    .replace(/(\bauthorization\s*:\s*bearer\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/\b(token|secret|password|api[_-]?key|private[_-]?key)\s*[:=]\s*[^\s]+/gi, '$1=[redacted]');
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function boundedTraceValue(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  return truncate(value.trim(), 256);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
