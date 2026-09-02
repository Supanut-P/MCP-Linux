import { createHash } from 'node:crypto';
import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_SERIALIZED_BYTES = 256 * 1024;
const MAX_FILTER_LENGTH = 128;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export interface AuditQueryActor {
  readonly clientId: string;
  readonly sessionId?: string;
}

export interface AuditQueryEvent {
  readonly id: string;
  readonly timestamp: string;
  readonly actorId: string;
  readonly sessionId?: string;
  readonly workspaceId?: string;
  readonly action: string;
  readonly resultCode: string;
  readonly durationMs: number;
  readonly targetSummary?: string;
}

export interface AuditQueryCursorPosition {
  readonly timestamp: string;
  readonly id: string;
}

export interface AuditQueryPortQuery {
  readonly actorId: string;
  /** A session is always explicit: undefined is not a wildcard. */
  readonly sessionId: string | null;
  readonly workspaceId?: string;
  readonly actionPrefix?: string;
  readonly resultCode?: string;
  readonly since?: string;
  readonly until?: string;
  readonly before?: AuditQueryCursorPosition;
}

export interface AuditQueryPort {
  list(query: AuditQueryPortQuery, limit: number): Promise<readonly AuditQueryEvent[]>;
}

export interface AuditQueryInput {
  readonly workspaceId?: string | undefined;
  readonly tool?: string | undefined;
  readonly resultCode?: string | undefined;
  readonly since?: string | undefined;
  readonly until?: string | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

export interface AuditQueryEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly tool: string;
  readonly resultCode: string;
  readonly durationMs: number;
  readonly workspaceAlias?: string;
}

export interface AuditQueryOutput {
  readonly entries: readonly AuditQueryEntry[];
  readonly count: number;
  readonly truncated: boolean;
  readonly nextCursor?: string;
}

interface DecodedCursor {
  readonly version: 1;
  readonly owner: string;
  readonly filter: string;
  readonly position: AuditQueryCursorPosition;
}

type NormalizedAuditQueryInput = Omit<AuditQueryInput, 'limit'> & { readonly limit: number };

export class AuditQueryService {
  public constructor(private readonly port: AuditQueryPort) {}

  public async execute(actor: AuditQueryActor, input: AuditQueryInput, signal?: AbortSignal): Promise<Result<AuditQueryOutput>> {
    const normalized = normalizeInput(input);
    if (!normalized.ok) return normalized;
    if (signal !== undefined && signal.aborted) return cancelled();

    const owner = ownerFingerprint(actor);
    const filter = filterFingerprint(normalized.value);
    const position = normalized.value.cursor === undefined
      ? undefined
      : decodeCursor(normalized.value.cursor, owner, filter);
    if (position instanceof Error) return err(appError('INVALID_INPUT', position.message));

    const query: AuditQueryPortQuery = {
      actorId: actor.clientId,
      sessionId: actor.sessionId ?? null,
      ...(normalized.value.workspaceId === undefined ? {} : { workspaceId: normalized.value.workspaceId }),
      actionPrefix: normalized.value.tool === undefined ? 'mcp_tool:' : `mcp_tool:${normalized.value.tool}`,
      ...(normalized.value.resultCode === undefined ? {} : { resultCode: normalized.value.resultCode }),
      ...(normalized.value.since === undefined ? {} : { since: normalized.value.since }),
      ...(normalized.value.until === undefined ? {} : { until: normalized.value.until }),
      ...(position === undefined ? {} : { before: position.position }),
    };

    let events: readonly AuditQueryEvent[];
    try {
      events = await this.port.list(query, normalized.value.limit + 1);
    } catch {
      return err(appError('CAPABILITY_UNAVAILABLE', 'Audit storage is unavailable', true));
    }
    if (signal?.aborted === true) return cancelled();

    const hasMoreRows = events.length > normalized.value.limit;
    const candidates = events.slice(0, normalized.value.limit);
    const entries: AuditQueryEntry[] = [];
    let truncated = hasMoreRows;
    for (const event of candidates) {
      const entry = summarize(event);
      const candidate = { entries: [...entries, entry], count: entries.length + 1, truncated };
      if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > MAX_SERIALIZED_BYTES) {
        truncated = true;
        break;
      }
      entries.push(entry);
    }

    const last = entries.at(-1);
    const nextCursor = last === undefined || (!hasMoreRows && entries.length === candidates.length)
      ? undefined
      : encodeCursor({ version: 1, owner, filter, position: { timestamp: last.timestamp, id: last.id } });
    return ok({ entries, count: entries.length, truncated, ...(nextCursor === undefined ? {} : { nextCursor }) });
  }
}

function normalizeInput(input: AuditQueryInput): Result<NormalizedAuditQueryInput> {
  if (typeof input !== 'object' || input === null) return err(appError('INVALID_INPUT', 'Audit query input must be an object'));
  const limit = input.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return err(appError('INVALID_INPUT', 'Audit query limit is invalid'));
  const workspaceId = input.workspaceId?.trim();
  const tool = input.tool?.trim();
  const resultCode = input.resultCode?.trim();
  const since = input.since === undefined ? undefined : canonicalTimestamp(input.since);
  const until = input.until === undefined ? undefined : canonicalTimestamp(input.until);
  const cursor = input.cursor?.trim();
  if (workspaceId !== undefined && (workspaceId.length === 0 || workspaceId.length > MAX_FILTER_LENGTH || workspaceId.includes('\0'))) {
    return err(appError('INVALID_INPUT', 'Audit query workspaceId is invalid'));
  }
  for (const [name, value] of [['tool', tool], ['resultCode', resultCode]] as const) {
    if (value !== undefined && (!SAFE_IDENTIFIER.test(value) || value.length > MAX_FILTER_LENGTH)) return err(appError('INVALID_INPUT', `Audit query ${name} is invalid`));
  }
  if (input.since !== undefined && since === undefined) return err(appError('INVALID_INPUT', 'Audit query since is invalid'));
  if (input.until !== undefined && until === undefined) return err(appError('INVALID_INPUT', 'Audit query until is invalid'));
  if (since !== undefined && until !== undefined && since > until) return err(appError('INVALID_INPUT', 'Audit query time range is invalid'));
  return ok({
    limit,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(tool === undefined ? {} : { tool }),
    ...(resultCode === undefined ? {} : { resultCode }),
    ...(since === undefined ? {} : { since }),
    ...(until === undefined ? {} : { until }),
    ...(cursor === undefined ? {} : { cursor }),
  });
}

function summarize(event: AuditQueryEvent): AuditQueryEntry {
  const tool = event.action.startsWith('mcp_tool:') ? event.action.slice('mcp_tool:'.length) : event.action;
  return {
    id: safeText(event.id, 128),
    timestamp: validTimestamp(event.timestamp) ? event.timestamp : 'unknown',
    tool: safeText(tool, 128),
    resultCode: safeText(event.resultCode, 64),
    durationMs: Number.isFinite(event.durationMs) && event.durationMs >= 0 ? Math.min(Math.floor(event.durationMs), 86_400_000) : 0,
    ...(event.workspaceId === undefined ? {} : { workspaceAlias: `workspace-${hash(event.workspaceId).slice(0, 16)}` }),
  };
}

function decodeCursor(value: string, owner: string, filter: string): DecodedCursor | Error {
  if (typeof value !== 'string' || value.length < 8 || value.length > 512) return new Error('Audit query cursor is invalid');
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!isRecord(parsed) || parsed.version !== 1 || parsed.owner !== owner || parsed.filter !== filter || !isRecord(parsed.position)) return new Error('Audit query cursor is invalid');
    if (typeof parsed.position.timestamp !== 'string' || !validTimestamp(parsed.position.timestamp) || typeof parsed.position.id !== 'string' || parsed.position.id.length === 0 || parsed.position.id.length > 128) return new Error('Audit query cursor is invalid');
    return parsed as unknown as DecodedCursor;
  } catch {
    return new Error('Audit query cursor is invalid');
  }
}

function encodeCursor(cursor: DecodedCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function ownerFingerprint(actor: AuditQueryActor): string {
  return hash(`${actor.clientId}\0${actor.sessionId ?? ''}`).slice(0, 32);
}

function filterFingerprint(input: Omit<AuditQueryInput, 'cursor'> & { readonly limit: number }): string {
  return hash(JSON.stringify({
    workspaceId: input.workspaceId ?? null,
    tool: input.tool ?? null,
    resultCode: input.resultCode ?? null,
    since: input.since ?? null,
    until: input.until ?? null,
    limit: input.limit,
  })).slice(0, 32);
}

function validTimestamp(value: string): boolean {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function canonicalTimestamp(value: string): string | undefined {
  if (!validTimestamp(value)) return undefined;
  return new Date(value).toISOString();
}

function safeText(value: string, max: number): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, max) || 'unknown';
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function cancelled(): Result<never> {
  return err(appError('PROCESS_TIMEOUT', 'Audit query was cancelled', true));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
