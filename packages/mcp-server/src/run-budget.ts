import type { CallToolResult } from '@modelcontextprotocol/server';

export const RUN_BUDGET_WARNING = 'ใกล้หมด budget — อัปเดต tracker + สั่งงานยาวเป็น background เดี๋ยวนี้';
export const DEFAULT_RUN_BUDGET_WARNING_MS = 22 * 60 * 1000;
export const DEFAULT_RUN_BUDGET_IDLE_RESET_MS = 5 * 60 * 1000;

export interface RunBudgetContext {
  readonly sessionId?: string;
  readonly http?: { readonly req?: Request };
  readonly mcpReq?: {
    readonly id?: string | number;
  };
}

export interface RunBudgetGuardOptions {
  readonly warningAfterMs?: number;
  readonly idleResetMs?: number;
  readonly now?: () => number;
}

interface RunBudgetState {
  startedAt: number;
  lastSeenAt: number;
}

/**
 * Tracks a connector run from its first tool call. HTTP/STDIO serving entries
 * share one instance across per-request McpServer factories so the clock does
 * not reset on every tools/call.
 */
export class RunBudgetGuard {
  private readonly states = new Map<string, RunBudgetState>();
  private readonly warningAfterMs: number;
  private readonly idleResetMs: number;
  private readonly now: () => number;

  public constructor(options: RunBudgetGuardOptions = {}) {
    this.warningAfterMs = positiveFinite(options.warningAfterMs, DEFAULT_RUN_BUDGET_WARNING_MS);
    this.idleResetMs = positiveFinite(options.idleResetMs, DEFAULT_RUN_BUDGET_IDLE_RESET_MS);
    this.now = options.now ?? Date.now;
  }

  /** Marks the first tool call before execution so a single >22 minute call is covered. */
  public begin(context: RunBudgetContext | undefined): void {
    const now = this.now();
    const key = resolveRunBudgetKey(context);
    const existing = this.states.get(key);
    // A real MCP session is the run boundary. Idle reset exists only for transports
    // that expose no stable session ID, otherwise a long tool call would reset itself.
    const statelessExpired = key === 'stateless' && existing !== undefined && now - existing.lastSeenAt >= this.idleResetMs;
    if (existing === undefined || statelessExpired) {
      this.states.set(key, { startedAt: now, lastSeenAt: now });
      this.prune(now, key);
      return;
    }
    existing.lastSeenAt = now;
  }

  /** Appends the budget warning as the final content block after the threshold. */
  public finish(context: RunBudgetContext | undefined, result: CallToolResult): CallToolResult {
    const now = this.now();
    const key = resolveRunBudgetKey(context);
    const state = this.states.get(key);
    if (state === undefined) {
      this.states.set(key, { startedAt: now, lastSeenAt: now });
      return result;
    }
    state.lastSeenAt = now;
    if (now - state.startedAt < this.warningAfterMs) return result;
    const last = result.content.at(-1);
    if (last?.type === 'text' && last.text === RUN_BUDGET_WARNING) return result;
    return {
      ...result,
      content: [...result.content, { type: 'text', text: RUN_BUDGET_WARNING }],
    };
  }

  private prune(now: number, currentKey: string): void {
    if (this.states.size < 64) return;
    for (const [key, state] of this.states) {
      if (key === 'stateless' && key !== currentKey && now - state.lastSeenAt >= this.idleResetMs) this.states.delete(key);
    }
  }
}

function resolveRunBudgetKey(context: RunBudgetContext | undefined): string {
  const sessionId = context?.sessionId?.trim();
  if (sessionId !== undefined && sessionId.length > 0) return `session:${sessionId}`;
  const headerSession = context?.http?.req?.headers.get('mcp-session-id')?.trim();
  if (headerSession !== undefined && headerSession.length > 0) return `session:${headerSession}`;
  // Stateless transports do not expose a stable run ID. The shared fallback is
  // deliberately idle-reset, so a new burst of tool calls starts a fresh run.
  return 'stateless';
}

function positiveFinite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
