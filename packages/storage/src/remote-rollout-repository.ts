import type { SqliteDatabase } from './database.js';

export type RemoteRolloutState = 'planned' | 'running' | 'completed' | 'failed' | 'cancelled' | 'expired';

export interface RemoteRolloutHostPlan {
  readonly hostId: string;
  readonly previewHash: string;
}

export interface RemoteRolloutHostResult {
  readonly hostId: string;
  readonly status: 'ok' | 'error' | 'cancelled';
  readonly error?: { readonly code: string; readonly message: string; readonly recoverable: boolean };
}

export interface RemoteRollout {
  readonly id: string;
  readonly workspaceId: string;
  readonly hostIds: readonly string[];
  readonly unit: string;
  readonly canaryCount: number;
  readonly maxParallel: number;
  readonly hostPlans: readonly RemoteRolloutHostPlan[];
  readonly previewHash: string;
  readonly expiresAt: string;
  readonly state: RemoteRolloutState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly results?: readonly RemoteRolloutHostResult[];
  readonly cancelRequested?: boolean;
}

export type RemoteRolloutRegistration = Omit<RemoteRollout, 'createdAt' | 'updatedAt' | 'state' | 'results' | 'cancelRequested'> & {
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly state?: RemoteRolloutState;
  readonly results?: readonly RemoteRolloutHostResult[];
  readonly cancelRequested?: boolean;
};

export class SqliteRemoteRolloutRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  public async create(plan: RemoteRolloutRegistration): Promise<void> {
    const normalized: RemoteRollout = { ...plan, state: plan.state ?? 'planned', updatedAt: plan.updatedAt, ...(plan.results === undefined ? {} : { results: plan.results }), ...(plan.cancelRequested === true ? { cancelRequested: true } : {}) };
    validate(normalized);
    this.database.connection.prepare(`INSERT INTO remote_rollouts
      (id, workspace_id, host_ids_json, unit, canary_count, max_parallel, host_plans_json, preview_hash, expires_at, state, created_at, updated_at, results_json, cancel_requested)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(normalized.id, normalized.workspaceId, JSON.stringify(normalized.hostIds), normalized.unit, normalized.canaryCount, normalized.maxParallel, JSON.stringify(normalized.hostPlans), normalized.previewHash, normalized.expiresAt, normalized.state, normalized.createdAt, normalized.updatedAt, normalized.results === undefined ? null : JSON.stringify(normalized.results), normalized.cancelRequested === true ? 1 : 0);
  }

  public async get(id: string): Promise<RemoteRollout | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    return this.toRollout(this.database.connection.prepare('SELECT id, workspace_id, host_ids_json, unit, canary_count, max_parallel, host_plans_json, preview_hash, expires_at, state, created_at, updated_at, results_json, cancel_requested FROM remote_rollouts WHERE id = ?').get(id));
  }

  public async list(state?: RemoteRolloutState): Promise<readonly RemoteRollout[]> {
    const rows = state === undefined
      ? this.database.connection.prepare('SELECT id, workspace_id, host_ids_json, unit, canary_count, max_parallel, host_plans_json, preview_hash, expires_at, state, created_at, updated_at, results_json, cancel_requested FROM remote_rollouts ORDER BY created_at, id').all()
      : this.database.connection.prepare('SELECT id, workspace_id, host_ids_json, unit, canary_count, max_parallel, host_plans_json, preview_hash, expires_at, state, created_at, updated_at, results_json, cancel_requested FROM remote_rollouts WHERE state = ? ORDER BY created_at, id').all(state);
    return rows.map((row) => this.toRollout(row)).filter((plan): plan is RemoteRollout => plan !== null);
  }

  /** Claim is atomic so two execute requests cannot both run a plan. */
  public async claim(id: string, state: 'planned'): Promise<boolean> {
    const result = this.database.connection.prepare('UPDATE remote_rollouts SET state = ?, updated_at = ? WHERE id = ? AND state = ?').run('running', new Date().toISOString(), id, state);
    return Number(result.changes) === 1;
  }

  public async update(id: string, patch: Partial<RemoteRollout>): Promise<void> {
    const current = await this.get(id);
    if (current === null) throw new Error('Remote rollout was not found');
    const next: RemoteRollout = { ...current, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
    validate(next);
    this.database.connection.prepare(`UPDATE remote_rollouts SET workspace_id = ?, host_ids_json = ?, unit = ?, canary_count = ?, max_parallel = ?, host_plans_json = ?, preview_hash = ?, expires_at = ?, state = ?, created_at = ?, updated_at = ?, results_json = ?, cancel_requested = ? WHERE id = ?`)
      .run(next.workspaceId, JSON.stringify(next.hostIds), next.unit, next.canaryCount, next.maxParallel, JSON.stringify(next.hostPlans), next.previewHash, next.expiresAt, next.state, next.createdAt, next.updatedAt, next.results === undefined ? null : JSON.stringify(next.results), next.cancelRequested === true ? 1 : 0, id);
  }

  private toRollout(value: unknown): RemoteRollout | null {
    if (!isRecord(value) || typeof value.id !== 'string' || typeof value.workspace_id !== 'string' || typeof value.host_ids_json !== 'string' || typeof value.unit !== 'string'
      || typeof value.canary_count !== 'number' || typeof value.max_parallel !== 'number' || typeof value.host_plans_json !== 'string' || typeof value.preview_hash !== 'string'
      || typeof value.expires_at !== 'string' || typeof value.state !== 'string' || typeof value.created_at !== 'string' || typeof value.updated_at !== 'string') return null;
    let hostIds: unknown; let hostPlans: unknown; let results: unknown;
    try { hostIds = JSON.parse(value.host_ids_json); hostPlans = JSON.parse(value.host_plans_json); results = value.results_json === null ? undefined : JSON.parse(String(value.results_json)); } catch { return null; }
    if (!Array.isArray(hostIds) || !hostIds.every((entry) => typeof entry === 'string') || !Array.isArray(hostPlans) || !hostPlans.every(isHostPlan)) return null;
    if (results !== undefined && (!Array.isArray(results) || !results.every(isHostResult))) return null;
    if (!isState(value.state)) return null;
    return { id: value.id, workspaceId: value.workspace_id, hostIds, unit: value.unit, canaryCount: value.canary_count, maxParallel: value.max_parallel, hostPlans, previewHash: value.preview_hash, expiresAt: value.expires_at, state: value.state, createdAt: value.created_at, updatedAt: value.updated_at, ...(results === undefined ? {} : { results }), ...(value.cancel_requested === 1 ? { cancelRequested: true } : {}) };
  }
}

function validate(plan: RemoteRollout): void {
  if (!/^[0-9a-f-]{36}$/i.test(plan.id) || plan.workspaceId.trim().length === 0 || plan.hostIds.length < 1 || plan.hostIds.length > 20 || plan.hostPlans.length !== plan.hostIds.length || !/^[A-Za-z0-9_.@:-]{1,256}\.service$/.test(plan.unit) || !Number.isInteger(plan.canaryCount) || plan.canaryCount < 1 || plan.canaryCount > plan.hostIds.length || !Number.isInteger(plan.maxParallel) || plan.maxParallel < 1 || plan.maxParallel > 4 || !/^[a-f0-9]{64}$/.test(plan.previewHash) || !isState(plan.state)) throw new Error('Remote rollout registration is invalid');
}

function isState(value: unknown): value is RemoteRolloutState { return value === 'planned' || value === 'running' || value === 'completed' || value === 'failed' || value === 'cancelled' || value === 'expired'; }
function isHostPlan(value: unknown): value is RemoteRolloutHostPlan { return isRecord(value) && typeof value.hostId === 'string' && typeof value.previewHash === 'string'; }
function isHostResult(value: unknown): value is RemoteRolloutHostResult { return isRecord(value) && typeof value.hostId === 'string' && (value.status === 'ok' || value.status === 'error' || value.status === 'cancelled'); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
