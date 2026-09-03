import type { SqliteDatabase } from './database.js';

export type RemoteRolloutState = 'planned' | 'running' | 'completed' | 'failed' | 'cancelled' | 'expired';

export interface RemoteRolloutHostPlan {
  readonly hostId: string;
  readonly previewHash: string;
}

export interface RemoteRolloutHostResult {
  readonly hostId: string;
  readonly status: 'ok' | 'error' | 'cancelled' | 'unverified';
  readonly attempt?: number;
  readonly error?: { readonly code: string; readonly message: string; readonly recoverable: boolean };
}

export interface RemoteRolloutResumePreview {
  readonly hostIds: readonly string[];
  readonly hostPlans: readonly RemoteRolloutHostPlan[];
  readonly retryCounts: Readonly<Record<string, number>>;
  readonly previewHash: string;
  readonly expiresAt: string;
}

export interface RemoteRolloutEvent {
  readonly hostId: string;
  readonly phase: string;
  readonly attempt: number;
  readonly status: string;
  readonly resultCode?: string;
  readonly timestamp: string;
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
  readonly resumePreview?: RemoteRolloutResumePreview | null;
  readonly taskOwnerId?: string | null;
  readonly taskState?: 'working' | 'completed' | 'failed' | 'cancelled' | null;
  readonly events?: readonly RemoteRolloutEvent[];
}

export type RemoteRolloutRegistration = Omit<RemoteRollout, 'createdAt' | 'updatedAt' | 'state' | 'results' | 'cancelRequested'> & {
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly state?: RemoteRolloutState;
  readonly results?: readonly RemoteRolloutHostResult[];
  readonly cancelRequested?: boolean;
};

export class SqliteRemoteRolloutRepository {
  private eventQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly database: SqliteDatabase) {}

  public async create(plan: RemoteRolloutRegistration): Promise<void> {
    const normalized: RemoteRollout = { ...plan, state: plan.state ?? 'planned', updatedAt: plan.updatedAt, ...(plan.results === undefined ? {} : { results: plan.results }), ...(plan.cancelRequested === true ? { cancelRequested: true } : {}) };
    validate(normalized);
    this.database.connection.prepare(`INSERT INTO remote_rollouts
      (id, workspace_id, host_ids_json, unit, canary_count, max_parallel, host_plans_json, preview_hash, expires_at, state, created_at, updated_at, results_json, cancel_requested, resume_json, task_owner_id, task_state, events_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(normalized.id, normalized.workspaceId, JSON.stringify(normalized.hostIds), normalized.unit, normalized.canaryCount, normalized.maxParallel, JSON.stringify(normalized.hostPlans), normalized.previewHash, normalized.expiresAt, normalized.state, normalized.createdAt, normalized.updatedAt, normalized.results === undefined ? null : JSON.stringify(normalized.results), normalized.cancelRequested === true ? 1 : 0, normalized.resumePreview === undefined || normalized.resumePreview === null ? null : JSON.stringify(normalized.resumePreview), normalized.taskOwnerId === undefined || normalized.taskOwnerId === null ? null : normalized.taskOwnerId, normalized.taskState === undefined || normalized.taskState === null ? null : normalized.taskState, normalized.events === undefined ? null : JSON.stringify(normalized.events));
  }

  public async get(id: string): Promise<RemoteRollout | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    return this.toRollout(this.database.connection.prepare('SELECT id, workspace_id, host_ids_json, unit, canary_count, max_parallel, host_plans_json, preview_hash, expires_at, state, created_at, updated_at, results_json, cancel_requested, resume_json, task_owner_id, task_state, events_json FROM remote_rollouts WHERE id = ?').get(id));
  }

  public async list(state?: RemoteRolloutState): Promise<readonly RemoteRollout[]> {
    const rows = state === undefined
      ? this.database.connection.prepare('SELECT id, workspace_id, host_ids_json, unit, canary_count, max_parallel, host_plans_json, preview_hash, expires_at, state, created_at, updated_at, results_json, cancel_requested, resume_json, task_owner_id, task_state, events_json FROM remote_rollouts ORDER BY created_at, id').all()
      : this.database.connection.prepare('SELECT id, workspace_id, host_ids_json, unit, canary_count, max_parallel, host_plans_json, preview_hash, expires_at, state, created_at, updated_at, results_json, cancel_requested, resume_json, task_owner_id, task_state, events_json FROM remote_rollouts WHERE state = ? ORDER BY created_at, id').all(state);
    return rows.map((row) => this.toRollout(row)).filter((plan): plan is RemoteRollout => plan !== null);
  }

  /** Claim is atomic so two execute requests cannot both run a plan. */
  public async claim(id: string, state: 'planned'): Promise<boolean> {
    const result = this.database.connection.prepare('UPDATE remote_rollouts SET state = ?, updated_at = ? WHERE id = ? AND state = ?').run('running', new Date().toISOString(), id, state);
    return Number(result.changes) === 1;
  }

  public async claimResume(id: string): Promise<boolean> {
    const result = this.database.connection.prepare("UPDATE remote_rollouts SET state = 'running', updated_at = ? WHERE id = ? AND state IN ('failed', 'cancelled') AND resume_json IS NOT NULL").run(new Date().toISOString(), id);
    return Number(result.changes) === 1;
  }

  public async bindTaskOwner(id: string, ownerId: string): Promise<boolean> {
    if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(ownerId)) return false;
    const result = this.database.connection.prepare("UPDATE remote_rollouts SET task_owner_id = ?, task_state = 'working', updated_at = ? WHERE id = ? AND state = 'planned' AND task_owner_id IS NULL").run(ownerId, new Date().toISOString(), id);
    return Number(result.changes) === 1;
  }

  public async appendEvent(id: string, event: RemoteRolloutEvent): Promise<void> {
    this.eventQueue = this.eventQueue.catch(() => undefined).then(async () => {
      if (!isEvent(event)) return;
      const current = await this.get(id);
      if (current === null) return;
      const events = [...(current.events ?? []), event].slice(-200);
      this.database.connection.prepare('UPDATE remote_rollouts SET events_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(events), new Date().toISOString(), id);
    });
    await this.eventQueue;
  }

  public async update(id: string, patch: Partial<RemoteRollout>): Promise<void> {
    const current = await this.get(id);
    if (current === null) throw new Error('Remote rollout was not found');
    const next: RemoteRollout = { ...current, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
    validate(next);
    this.database.connection.prepare(`UPDATE remote_rollouts SET workspace_id = ?, host_ids_json = ?, unit = ?, canary_count = ?, max_parallel = ?, host_plans_json = ?, preview_hash = ?, expires_at = ?, state = ?, created_at = ?, updated_at = ?, results_json = ?, cancel_requested = ?, resume_json = ?, task_owner_id = ?, task_state = ?, events_json = ? WHERE id = ?`)
      .run(next.workspaceId, JSON.stringify(next.hostIds), next.unit, next.canaryCount, next.maxParallel, JSON.stringify(next.hostPlans), next.previewHash, next.expiresAt, next.state, next.createdAt, next.updatedAt, next.results === undefined ? null : JSON.stringify(next.results), next.cancelRequested === true ? 1 : 0, next.resumePreview === undefined ? null : JSON.stringify(next.resumePreview), next.taskOwnerId === undefined || next.taskOwnerId === null ? null : next.taskOwnerId, next.taskState === undefined || next.taskState === null ? null : next.taskState, next.events === undefined ? null : JSON.stringify(next.events), id);
  }

  private toRollout(value: unknown): RemoteRollout | null {
    if (!isRecord(value) || typeof value.id !== 'string' || typeof value.workspace_id !== 'string' || typeof value.host_ids_json !== 'string' || typeof value.unit !== 'string'
      || typeof value.canary_count !== 'number' || typeof value.max_parallel !== 'number' || typeof value.host_plans_json !== 'string' || typeof value.preview_hash !== 'string'
      || typeof value.expires_at !== 'string' || typeof value.state !== 'string' || typeof value.created_at !== 'string' || typeof value.updated_at !== 'string') return null;
    let hostIds: unknown; let hostPlans: unknown; let results: unknown; let resumePreview: unknown; let events: unknown;
    try { hostIds = JSON.parse(value.host_ids_json); hostPlans = JSON.parse(value.host_plans_json); results = value.results_json === null ? undefined : JSON.parse(String(value.results_json)); resumePreview = value.resume_json === null || value.resume_json === undefined ? undefined : JSON.parse(String(value.resume_json)); events = value.events_json === null || value.events_json === undefined ? undefined : JSON.parse(String(value.events_json)); } catch { return null; }
    if (!Array.isArray(hostIds) || !hostIds.every((entry) => typeof entry === 'string') || !Array.isArray(hostPlans) || !hostPlans.every(isHostPlan)) return null;
    if (results !== undefined && (!Array.isArray(results) || !results.every(isHostResult))) return null;
    if (resumePreview !== undefined && !isResumePreview(resumePreview)) return null;
    if (events !== undefined && (!Array.isArray(events) || events.length > 200 || !events.every(isEvent))) return null;
    if (value.task_state !== null && value.task_state !== undefined && !isTaskState(value.task_state)) return null;
    if (!isState(value.state)) return null;
    return { id: value.id, workspaceId: value.workspace_id, hostIds, unit: value.unit, canaryCount: value.canary_count, maxParallel: value.max_parallel, hostPlans, previewHash: value.preview_hash, expiresAt: value.expires_at, state: value.state, createdAt: value.created_at, updatedAt: value.updated_at, ...(results === undefined ? {} : { results }), ...(value.cancel_requested === 1 ? { cancelRequested: true } : {}), ...(resumePreview === undefined ? {} : { resumePreview }), ...(typeof value.task_owner_id === 'string' ? { taskOwnerId: value.task_owner_id } : {}), ...(value.task_state === null || value.task_state === undefined ? {} : { taskState: value.task_state }), ...(events === undefined ? {} : { events }) };
  }
}

function validate(plan: RemoteRollout): void {
  if (!/^[0-9a-f-]{36}$/i.test(plan.id) || plan.workspaceId.trim().length === 0 || plan.hostIds.length < 1 || plan.hostIds.length > 20 || plan.hostPlans.length !== plan.hostIds.length || !/^[A-Za-z0-9_.@:-]{1,256}\.service$/.test(plan.unit) || !Number.isInteger(plan.canaryCount) || plan.canaryCount < 1 || plan.canaryCount > plan.hostIds.length || !Number.isInteger(plan.maxParallel) || plan.maxParallel < 1 || plan.maxParallel > 4 || !/^[a-f0-9]{64}$/.test(plan.previewHash) || !isState(plan.state) || (plan.resumePreview !== undefined && plan.resumePreview !== null && !isResumePreview(plan.resumePreview)) || (plan.taskOwnerId !== undefined && plan.taskOwnerId !== null && !/^[A-Za-z0-9_.:-]{1,256}$/.test(plan.taskOwnerId)) || (plan.taskState !== undefined && plan.taskState !== null && !isTaskState(plan.taskState)) || (plan.events !== undefined && (plan.events.length > 200 || !plan.events.every(isEvent)))) throw new Error('Remote rollout registration is invalid');
}

function isState(value: unknown): value is RemoteRolloutState { return value === 'planned' || value === 'running' || value === 'completed' || value === 'failed' || value === 'cancelled' || value === 'expired'; }
function isHostPlan(value: unknown): value is RemoteRolloutHostPlan { return isRecord(value) && typeof value.hostId === 'string' && typeof value.previewHash === 'string'; }
function isHostResult(value: unknown): value is RemoteRolloutHostResult {
  if (!isRecord(value) || typeof value.hostId !== 'string' || (value.status !== 'ok' && value.status !== 'error' && value.status !== 'cancelled' && value.status !== 'unverified')) return false;
  const attempt = value.attempt;
  return attempt === undefined || (typeof attempt === 'number' && Number.isInteger(attempt) && attempt > 0);
}
function isResumePreview(value: unknown): value is RemoteRolloutResumePreview {
  if (!isRecord(value) || !Array.isArray(value.hostIds) || !value.hostIds.every((entry) => typeof entry === 'string') || !Array.isArray(value.hostPlans) || !value.hostPlans.every(isHostPlan) || !isRecord(value.retryCounts) || typeof value.previewHash !== 'string' || typeof value.expiresAt !== 'string') return false;
  return Object.values(value.retryCounts).every((entry) => typeof entry === 'number' && Number.isInteger(entry) && entry > 0 && entry <= 2);
}
function isTaskState(value: unknown): value is NonNullable<RemoteRollout['taskState']> { return value === 'working' || value === 'completed' || value === 'failed' || value === 'cancelled'; }
function isEvent(value: unknown): value is RemoteRolloutEvent {
  if (!isRecord(value) || typeof value.hostId !== 'string' || value.hostId.length === 0 || value.hostId.length > 128 || typeof value.phase !== 'string' || value.phase.length === 0 || value.phase.length > 32 || typeof value.status !== 'string' || value.status.length === 0 || value.status.length > 32 || typeof value.timestamp !== 'string' || value.timestamp.length === 0 || value.timestamp.length > 64) return false;
  const attempt = value.attempt;
  return typeof attempt === 'number' && Number.isInteger(attempt) && attempt > 0 && (value.resultCode === undefined || (typeof value.resultCode === 'string' && value.resultCode.length <= 64));
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
