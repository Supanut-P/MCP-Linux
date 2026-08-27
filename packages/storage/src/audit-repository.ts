import type { AuditEvent, AuditEventQuery, AuditEventRepository } from '@baitonghub-linux-mcp/audit';
import type { SqliteDatabase } from './database.js';

interface AuditEventRow {
  readonly id: string;
  readonly timestamp: string;
  readonly actor_id: string;
  readonly actor_name: string;
  readonly workspace_id: string | null;
  readonly session_id: string | null;
  readonly action: string;
  readonly target_summary: string | null;
  readonly permission_decision: string | null;
  readonly result_code: string;
  readonly duration_ms: number;
  readonly metadata_json: string;
}

const AUDIT_SELECT = 'SELECT id, timestamp, actor_id, actor_name, workspace_id, session_id, action, target_summary, permission_decision, result_code, duration_ms, metadata_json FROM audit_events';

export class SqliteAuditRepository implements AuditEventRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  public async insert(event: AuditEvent): Promise<void> {
    this.database.connection.prepare(
      `INSERT INTO audit_events
        (id, timestamp, actor_id, actor_name, workspace_id, session_id, action, target_summary, permission_decision, result_code, duration_ms, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.id,
      event.timestamp,
      event.actorId,
      event.actorName,
      event.workspaceId ?? null,
      event.sessionId ?? null,
      event.action,
      event.targetSummary ?? null,
      event.permissionDecision ?? null,
      event.resultCode,
      event.durationMs ?? null,
      JSON.stringify(event.metadata),
    );
  }

  public list(limit = 100): Promise<AuditEvent[]> {
    return this.listScoped({}, limit);
  }

  public listByActionPrefix(prefix: string, limit = 100): Promise<AuditEvent[]> {
    return this.listScoped({ actionPrefix: prefix }, limit);
  }

  public async listScoped(query: AuditEventQuery, limit = 100): Promise<AuditEvent[]> {
    const boundedLimit = Number.isInteger(limit) && limit >= 1 && limit <= 500 ? limit : 100;
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (query.actionPrefix !== undefined) {
      clauses.push('action LIKE ?');
      parameters.push(`${query.actionPrefix}%`);
    }
    appendNullableScopeClause(clauses, parameters, 'workspace_id', query.workspaceId);
    appendNullableScopeClause(clauses, parameters, 'session_id', query.sessionId);
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
    const rows = this.database.connection.prepare(
      `${AUDIT_SELECT}${where} ORDER BY timestamp DESC, id DESC LIMIT ?`,
    ).all(...parameters, boundedLimit);
    return this.toEvents(rows);
  }

  private toEvents(rows: unknown[]): AuditEvent[] {
    return rows.flatMap((row) => {
      const event = this.toEvent(row);
      return event === null ? [] : [event];
    });
  }

  private toEvent(value: unknown): AuditEvent | null {
    if (!this.isAuditEventRow(value)) return null;
    let metadata: unknown;
    try {
      metadata = JSON.parse(value.metadata_json) as unknown;
    } catch {
      return null;
    }
    if (!isRecord(metadata)) return null;
    return {
      id: value.id,
      timestamp: value.timestamp,
      actorId: value.actor_id,
      actorName: value.actor_name,
      ...(value.workspace_id === null ? {} : { workspaceId: value.workspace_id }),
      ...(value.session_id === null ? {} : { sessionId: value.session_id }),
      action: value.action,
      ...(value.target_summary === null ? {} : { targetSummary: value.target_summary }),
      ...(value.permission_decision === null ? {} : { permissionDecision: value.permission_decision }),
      resultCode: value.result_code,
      durationMs: typeof value.duration_ms === 'number' ? value.duration_ms : 0,
      metadata,
    };
  }

  private isAuditEventRow(value: unknown): value is AuditEventRow {
    if (typeof value !== 'object' || value === null) return false;
    if (!('id' in value) || !('timestamp' in value) || !('actor_id' in value) || !('actor_name' in value)
      || !('workspace_id' in value) || !('session_id' in value) || !('action' in value) || !('target_summary' in value)
      || !('permission_decision' in value) || !('result_code' in value) || !('duration_ms' in value) || !('metadata_json' in value)) return false;
    return typeof value.id === 'string'
      && typeof value.timestamp === 'string'
      && typeof value.actor_id === 'string'
      && typeof value.actor_name === 'string'
      && (typeof value.workspace_id === 'string' || value.workspace_id === null)
      && (typeof value.session_id === 'string' || value.session_id === null)
      && typeof value.action === 'string'
      && (typeof value.target_summary === 'string' || value.target_summary === null)
      && (typeof value.permission_decision === 'string' || value.permission_decision === null)
      && typeof value.result_code === 'string'
      && (typeof value.duration_ms === 'number' || value.duration_ms === null)
      && typeof value.metadata_json === 'string';
  }
}

function appendNullableScopeClause(
  clauses: string[],
  parameters: Array<string | number>,
  column: 'workspace_id' | 'session_id',
  value: string | null | undefined,
): void {
  if (value === undefined) return;
  if (value === null) {
    clauses.push(`${column} IS NULL`);
    return;
  }
  clauses.push(`${column} = ?`);
  parameters.push(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
