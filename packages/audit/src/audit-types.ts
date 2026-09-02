export interface AuditEventInput {
  readonly timestamp?: string;
  readonly actorId: string;
  readonly actorName: string;
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly action: string;
  readonly targetSummary?: string;
  readonly permissionDecision?: string;
  readonly resultCode: string;
  readonly durationMs: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AuditEvent {
  readonly id: string;
  readonly timestamp: string;
  readonly actorId: string;
  readonly actorName: string;
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly action: string;
  readonly targetSummary?: string;
  readonly permissionDecision?: string;
  readonly resultCode: string;
  readonly durationMs: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface AuditEventQuery {
  readonly actionPrefix?: string;
  /** Scope queries to one authenticated actor; omitted means all actors for internal callers. */
  readonly actorId?: string;
  /** undefined = all workspaces; null = global/unscoped events only. */
  readonly workspaceId?: string | null;
  /** undefined = all sessions; null = legacy/unscoped events only. */
  readonly sessionId?: string | null;
  readonly resultCode?: string;
  readonly since?: string;
  readonly until?: string;
  /** Return events strictly older than this descending-order position. */
  readonly before?: { readonly timestamp: string; readonly id: string };
}

export interface AuditEventRepository {
  insert(event: AuditEvent): Promise<void>;
  list(limit?: number): Promise<AuditEvent[]>;
  listByActionPrefix(prefix: string, limit?: number): Promise<AuditEvent[]>;
  listScoped(query: AuditEventQuery, limit?: number): Promise<AuditEvent[]>;
}

export interface CodexRunAuditInput {
  readonly timestamp?: string;
  readonly actorId: string;
  readonly actorName: string;
  readonly workspaceId?: string;
  readonly codexTaskId: string;
  readonly instruction: string;
  readonly resultCode: string;
  readonly durationMs: number;
}

export interface McpToolAuditInput {
  readonly timestamp?: string;
  readonly actorId: string;
  readonly actorName: string;
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly toolName: string;
  readonly callId: string;
  readonly phase: 'started' | 'completed';
  readonly targetSummary?: string;
  readonly resultCode: string;
  readonly resultMessage?: string;
  readonly durationMs: number;
  readonly traceId?: string;
  readonly traceParent?: string;
  readonly approvalReceipt?: unknown;
}
