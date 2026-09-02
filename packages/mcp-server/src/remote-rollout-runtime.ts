import { createHash, randomUUID } from 'node:crypto';
import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import type { CapabilityService } from '@baitonghub-linux-mcp/capabilities';

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

export interface RemoteRolloutPlan {
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
}

export interface RemoteRolloutRepository {
  create(plan: RemoteRolloutPlan): Promise<void>;
  get(id: string): Promise<RemoteRolloutPlan | null>;
  list?(state?: RemoteRolloutState): Promise<readonly RemoteRolloutPlan[]>;
  claim(id: string, state: 'planned'): Promise<boolean>;
  claimResume?(id: string): Promise<boolean>;
  update(id: string, patch: Partial<RemoteRolloutPlan>): Promise<void>;
}

export interface RemoteRolloutAuditEvent {
  readonly rolloutId: string;
  readonly hostId: string;
  readonly workspaceId: string;
  readonly unit: string;
  readonly phase: 'plan' | 'canary' | 'batch' | 'cancel' | 'resume-preview' | 'resume';
  readonly resultCode: string;
  readonly durationMs: number;
}

export interface RemoteRolloutRuntimeOptions {
  readonly capabilities?: Pick<CapabilityService, 'execute'>;
  readonly repository: RemoteRolloutRepository;
  readonly now?: () => Date;
  readonly audit?: (event: RemoteRolloutAuditEvent) => Promise<void>;
  readonly wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

const MAX_HOSTS = 20;
const MAX_PARALLEL = 4;
const DEFAULT_TTL_MS = 15 * 60_000;
const MAX_TTL_MS = 60 * 60_000;
const MAX_ATTEMPTS = 2;
const HOST_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SERVICE_UNIT = /^[A-Za-z0-9_.@:-]{1,256}\.service$/;
const SHA256 = /^[a-f0-9]{64}$/;

/** Durable, canary-first restart orchestration over registered remote_host IDs. */
export class RemoteRolloutRuntime {
  private readonly now: () => Date;
  private readonly active = new Map<string, AbortController>();
  private readonly wait: (milliseconds: number, signal?: AbortSignal) => Promise<void>;

  public constructor(private readonly options: RemoteRolloutRuntimeOptions) {
    this.now = options.now ?? ((): Date => new Date());
    this.wait = options.wait ?? ((milliseconds, signal): Promise<void> => new Promise<void>((resolve, reject) => {
      if (signal?.aborted === true) { reject(new Error('aborted')); return; }
      const timer = setTimeout(resolve, milliseconds);
      signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
    }));
  }

  /** Marks in-flight plans as interrupted after a process restart. No remote action is inferred as successful. */
  public async reconcile(): Promise<void> {
    if (this.options.repository.list === undefined) return;
    const running = await this.options.repository.list('running');
    for (const plan of running) {
      const results = [...(plan.results ?? [])];
      const recorded = new Set(results.map((entry) => entry.hostId));
      for (const hostId of plan.hostIds) {
        if (recorded.has(hostId)) continue;
        results.push({ hostId, status: 'error', error: { code: 'CAPABILITY_UNAVAILABLE', message: 'execution_interrupted', recoverable: true } });
      }
      await this.options.repository.update(plan.id, { state: 'failed', results, updatedAt: this.now().toISOString() });
    }
  }

  public async execute(input: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
    const parsed = parseRequest(input, this.now());
    if (!parsed.ok) return parsed;
    switch (parsed.value.operation) {
      case 'plan': return this.plan(parsed.value, signal);
      case 'execute': return this.run(parsed.value, signal);
      case 'status': return this.status(parsed.value.rolloutId);
      case 'cancel': return this.cancel(parsed.value.rolloutId, parsed.value.workspaceId);
      case 'resume_preview': return this.resumePreview(parsed.value, signal);
      case 'resume_execute': return this.resumeExecute(parsed.value, signal);
    }
  }

  /** Additive v1.10 resume entry point used by the dedicated MCP tool. */
  public async resume(input: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
    const value = asRecord(input);
    const operation = value?.operation === 'preview' ? 'resume_preview' : value?.operation === 'execute' ? 'resume_execute' : undefined;
    return operation === undefined ? err(appError('INVALID_INPUT', 'remote_rollout_resume operation is invalid', false)) : this.execute({ ...value, operation }, signal);
  }

  private async plan(request: PlanRequest, signal?: AbortSignal): Promise<Result<unknown>> {
    if (this.options.capabilities === undefined) return err(appError('CAPABILITY_UNAVAILABLE', 'Remote host capability is not configured', true));
    const hostPlans: RemoteRolloutHostPlan[] = [];
    for (const hostId of request.hostIds) {
      if (signal?.aborted === true) return err(appError('PROCESS_TIMEOUT', 'Remote rollout planning was cancelled', true));
      const started = Date.now();
      try {
        const response = await this.options.capabilities.execute('remote_host', {
          hostId,
          workspaceId: request.workspaceId,
          operation: 'service-restart',
          unit: request.unit,
          dry_run: true,
        }, signal);
        if (!response.ok) return err(safeError(response.error));
        const value = asRecord(response.value);
        const previewHash = value?.previewHash ?? value?.preview_hash;
        if (typeof previewHash !== 'string' || !SHA256.test(previewHash)) return err(appError('CAPABILITY_UNAVAILABLE', 'Remote host did not return a valid restart preview', true));
        hostPlans.push({ hostId, previewHash });
        await this.recordAudit({ rolloutId: 'planning', hostId, workspaceId: request.workspaceId, unit: request.unit, phase: 'plan', resultCode: 'SUCCESS', durationMs: Date.now() - started });
      } catch {
        return err(appError('CAPABILITY_UNAVAILABLE', 'Remote rollout planning failed', true));
      }
    }
    const id = randomUUID();
    const createdAt = this.now().toISOString();
    const aggregate = canonicalHash({ workspaceId: request.workspaceId, hostIds: request.hostIds, unit: request.unit, canaryCount: request.canaryCount, maxParallel: request.maxParallel, hostPlans, expiresAt: request.expiresAt });
    const plan: RemoteRolloutPlan = {
      id,
      workspaceId: request.workspaceId,
      hostIds: request.hostIds,
      unit: request.unit,
      canaryCount: request.canaryCount,
      maxParallel: request.maxParallel,
      hostPlans,
      previewHash: aggregate,
      expiresAt: request.expiresAt,
      state: 'planned',
      createdAt,
      updatedAt: createdAt,
    };
    await this.options.repository.create(plan);
    return ok(publicPlan(plan, 'plan'));
  }

  private async run(request: ExecuteRequest, parentSignal?: AbortSignal): Promise<Result<unknown>> {
    const plan = await this.options.repository.get(request.rolloutId);
    if (plan === null) return err(appError('INVALID_INPUT', 'Remote rollout was not found', false));
    if (plan.state !== 'planned') return err(appError('PERMISSION_REQUIRED', 'Remote rollout is no longer executable', true));
    if (this.now().getTime() >= Date.parse(plan.expiresAt)) {
      await this.options.repository.update(plan.id, { state: 'expired', updatedAt: this.now().toISOString() });
      return err(appError('PERMISSION_REQUIRED', 'Remote rollout preview has expired', true));
    }
    if (request.workspaceId !== plan.workspaceId) return err(appError('PERMISSION_DENIED', 'Remote rollout workspace does not match the stored plan', true));
    if (request.previewHash !== plan.previewHash) return err(appError('PERMISSION_REQUIRED', 'Remote rollout previewHash does not match the stored plan', true));
    if (request.userConfirmed !== true) return err(appError('PERMISSION_REQUIRED', 'Remote rollout requires explicit confirmation', true));
    const claimed = await this.options.repository.claim(plan.id, 'planned');
    if (!claimed) return err(appError('PERMISSION_REQUIRED', 'Remote rollout is already running or completed', true));
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    parentSignal?.addEventListener('abort', onAbort, { once: true });
    this.active.set(plan.id, controller);
    try {
      const results: RemoteRolloutHostResult[] = [];
      const canary = await this.runHosts(plan, plan.hostIds.slice(0, plan.canaryCount), 'canary', controller.signal, results);
      if (canary.failed || controller.signal.aborted) {
        const state: RemoteRolloutState = controller.signal.aborted ? 'cancelled' : 'failed';
        await this.options.repository.update(plan.id, { state, results, updatedAt: this.now().toISOString() });
        return ok(publicExecution(plan, state, results));
      }
      await this.runHosts(plan, plan.hostIds.slice(plan.canaryCount), 'batch', controller.signal, results);
      const state: RemoteRolloutState = controller.signal.aborted ? 'cancelled' : hasFailure(results) ? 'failed' : 'completed';
      await this.options.repository.update(plan.id, { state, results, updatedAt: this.now().toISOString() });
      return ok(publicExecution(plan, state, results));
    } finally {
      this.active.delete(plan.id);
      parentSignal?.removeEventListener('abort', onAbort);
    }
  }

  private async runHosts(plan: RemoteRolloutPlan, hostIds: readonly string[], phase: 'canary' | 'batch' | 'resume', signal: AbortSignal, results: RemoteRolloutHostResult[], hostPlans: readonly RemoteRolloutHostPlan[] = plan.hostPlans, attempts: Readonly<Record<string, number>> = {}): Promise<{ failed: boolean }> {
    let next = 0;
    let failed = false;
    const worker = async (): Promise<void> => {
      while (!signal.aborted) {
        const index = next++;
        const hostId = hostIds[index];
        if (hostId === undefined) return;
        const hostPlan = hostPlans.find((entry) => entry.hostId === hostId);
        if (hostPlan === undefined) return;
        const started = Date.now();
        try {
          if (this.options.capabilities === undefined) throw new Error('missing capability');
          const response = await this.options.capabilities.execute('remote_host', {
            hostId,
            workspaceId: plan.workspaceId,
            operation: 'service-restart',
            unit: plan.unit,
            previewHash: hostPlan.previewHash,
            userConfirmed: true,
          }, signal);
          if (response.ok) {
            results.push({ hostId, status: 'ok', attempt: attempts[hostId] ?? 1 });
            await this.recordAudit({ rolloutId: plan.id, hostId, workspaceId: plan.workspaceId, unit: plan.unit, phase, resultCode: 'SUCCESS', durationMs: Date.now() - started });
          } else {
            failed = true;
            const error = safeError(response.error);
            results.push({ hostId, status: ambiguous(error.code) ? 'unverified' : 'error', attempt: attempts[hostId] ?? 1, error });
            await this.recordAudit({ rolloutId: plan.id, hostId, workspaceId: plan.workspaceId, unit: plan.unit, phase, resultCode: response.error.code, durationMs: Date.now() - started });
          }
        } catch {
          failed = true;
          const error = { code: signal.aborted ? 'PROCESS_TIMEOUT' : 'CAPABILITY_UNAVAILABLE', message: signal.aborted ? 'Remote restart was cancelled before its outcome was verified' : 'Remote restart outcome was not verified', recoverable: true };
          results.push({ hostId, status: 'unverified', attempt: attempts[hostId] ?? 1, error });
          await this.recordAudit({ rolloutId: plan.id, hostId, workspaceId: plan.workspaceId, unit: plan.unit, phase, resultCode: error.code, durationMs: Date.now() - started });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, Math.max(1, plan.maxParallel), hostIds.length) }, () => worker()));
    return { failed };
  }

  private async status(id: string): Promise<Result<unknown>> {
    const plan = await this.options.repository.get(id);
    return plan === null ? err(appError('INVALID_INPUT', 'Remote rollout was not found', false)) : ok(publicPlan(plan));
  }

  private async cancel(id: string, workspaceId: string): Promise<Result<unknown>> {
    const plan = await this.options.repository.get(id);
    if (plan === null) return err(appError('INVALID_INPUT', 'Remote rollout was not found', false));
    if (workspaceId !== plan.workspaceId) return err(appError('PERMISSION_DENIED', 'Remote rollout workspace does not match the stored plan', true));
    if (plan.state === 'planned') {
      const updatedAt = this.now().toISOString();
      await this.options.repository.update(id, { state: 'cancelled', updatedAt });
      await this.recordAudit({ rolloutId: id, hostId: 'rollout', workspaceId: plan.workspaceId, unit: plan.unit, phase: 'cancel', resultCode: 'CANCELLED', durationMs: 0 });
      return ok(publicPlan({ ...plan, state: 'cancelled', updatedAt }));
    }
    if (plan.state !== 'running') return err(appError('PERMISSION_REQUIRED', 'Remote rollout is already in a terminal state', true));
    this.active.get(id)?.abort();
    await this.options.repository.update(id, { cancelRequested: true, updatedAt: this.now().toISOString() });
    await this.recordAudit({ rolloutId: id, hostId: 'rollout', workspaceId: plan.workspaceId, unit: plan.unit, phase: 'cancel', resultCode: 'CANCEL_REQUESTED', durationMs: 0 });
    return ok(publicPlan({ ...plan, cancelRequested: true }));
  }

  private async resumePreview(request: ResumePreviewRequest, signal?: AbortSignal): Promise<Result<unknown>> {
    const plan = await this.options.repository.get(request.rolloutId);
    if (plan === null) return err(appError('INVALID_INPUT', 'Remote rollout was not found', false));
    if (request.workspaceId !== plan.workspaceId) return err(appError('PERMISSION_DENIED', 'Remote rollout workspace does not match the stored plan', true));
    if (plan.state !== 'failed' && plan.state !== 'cancelled') return err(appError('PERMISSION_REQUIRED', 'Remote rollout is not resumable in its current state', true));
    if (this.options.capabilities === undefined) return err(appError('CAPABILITY_UNAVAILABLE', 'Remote host capability is not configured', true));
    const latest = latestResults(plan.results);
    const selected: string[] = [];
    const retryCounts: Record<string, number> = {};
    for (const hostId of plan.hostIds) {
      const previous = latest.get(hostId);
      if (previous?.status === 'ok') continue;
      if (previous?.status === 'unverified') return err(appError('CAPABILITY_UNAVAILABLE', 'A remote host has an unverified outcome; inspect it before retrying', true));
      const attempt = previous?.attempt ?? (previous === undefined ? 0 : 1);
      if (attempt >= MAX_ATTEMPTS) return err(appError('PERMISSION_REQUIRED', 'Remote rollout retry limit reached for one or more hosts', true));
      selected.push(hostId);
      retryCounts[hostId] = attempt + 1;
    }
    if (selected.length === 0) return err(appError('PERMISSION_REQUIRED', 'Remote rollout has no failed or unattempted hosts to resume', true));
    const hostPlans: RemoteRolloutHostPlan[] = [];
    for (const hostId of selected) {
      if (signal?.aborted === true) return err(appError('PROCESS_TIMEOUT', 'Remote rollout resume preview was cancelled', true));
      const started = Date.now();
      try {
        const response = await this.options.capabilities.execute('remote_host', { hostId, workspaceId: plan.workspaceId, operation: 'service-restart', unit: plan.unit, dry_run: true }, signal);
        if (!response.ok) return err(safeError(response.error));
        const value = asRecord(response.value);
        const previewHash = value?.previewHash ?? value?.preview_hash;
        if (typeof previewHash !== 'string' || !SHA256.test(previewHash)) return err(appError('CAPABILITY_UNAVAILABLE', 'Remote host did not return a valid restart preview', true));
        hostPlans.push({ hostId, previewHash });
        await this.recordAudit({ rolloutId: plan.id, hostId, workspaceId: plan.workspaceId, unit: plan.unit, phase: 'resume-preview', resultCode: 'SUCCESS', durationMs: Date.now() - started });
      } catch { return err(appError('CAPABILITY_UNAVAILABLE', 'Remote rollout resume preview failed', true)); }
    }
    const expiresAt = new Date(this.now().getTime() + DEFAULT_TTL_MS).toISOString();
    const previewHash = canonicalHash({ rolloutId: plan.id, hostIds: selected, hostPlans, retryCounts, expiresAt });
    const resumePreview: RemoteRolloutResumePreview = { hostIds: selected, hostPlans, retryCounts, previewHash, expiresAt };
    await this.options.repository.update(plan.id, { resumePreview, updatedAt: this.now().toISOString() });
    return ok({ operation: 'preview', rolloutId: plan.id, workspaceId: plan.workspaceId, hostIds: selected, retryCounts, previewHash, expiresAt, state: plan.state });
  }

  private async resumeExecute(request: ResumeExecuteRequest, parentSignal?: AbortSignal): Promise<Result<unknown>> {
    const plan = await this.options.repository.get(request.rolloutId);
    if (plan === null) return err(appError('INVALID_INPUT', 'Remote rollout was not found', false));
    if (plan.resumePreview === undefined || plan.resumePreview === null) return err(appError('PERMISSION_REQUIRED', 'Remote rollout needs a fresh resume preview', true));
    if (request.workspaceId !== plan.workspaceId) return err(appError('PERMISSION_DENIED', 'Remote rollout workspace does not match the stored plan', true));
    if (this.now().getTime() >= Date.parse(plan.resumePreview.expiresAt)) return err(appError('PERMISSION_REQUIRED', 'Remote rollout resume preview has expired', true));
    if (request.previewHash !== plan.resumePreview.previewHash) return err(appError('PERMISSION_REQUIRED', 'Remote rollout resume previewHash does not match the stored preview', true));
    if (request.userConfirmed !== true) return err(appError('PERMISSION_REQUIRED', 'Remote rollout resume requires explicit confirmation', true));
    const claimed = this.options.repository.claimResume === undefined ? false : await this.options.repository.claimResume(plan.id);
    if (!claimed) return err(appError('PERMISSION_REQUIRED', 'Remote rollout is already running or no longer resumable', true));
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    parentSignal?.addEventListener('abort', onAbort, { once: true });
    this.active.set(plan.id, controller);
    try {
      const prior = latestResults(plan.results);
      const results: RemoteRolloutHostResult[] = [...prior.values()];
      const attempts = plan.resumePreview.retryCounts;
      try { await this.wait(250, controller.signal); } catch { /* cancellation is reflected by the bounded run */ }
      const run = await this.runHosts(plan, plan.resumePreview.hostIds, 'resume', controller.signal, results, plan.resumePreview.hostPlans, attempts);
      const latest = latestResults(results);
      const state: RemoteRolloutState = controller.signal.aborted ? 'cancelled' : run.failed || hasFailure([...latest.values()]) ? 'failed' : 'completed';
      await this.options.repository.update(plan.id, { state, results: [...latest.values()], resumePreview: null, updatedAt: this.now().toISOString() });
      return ok({ operation: 'resume', rolloutId: plan.id, state, previewHash: request.previewHash, results: [...latest.values()], summary: summarize(plan.hostIds, [...latest.values()]) });
    } finally { this.active.delete(plan.id); parentSignal?.removeEventListener('abort', onAbort); }
  }

  private async recordAudit(event: RemoteRolloutAuditEvent): Promise<void> {
    if (this.options.audit === undefined) return;
    await this.options.audit(event).catch(() => undefined);
  }
}

interface PlanRequest { readonly operation: 'plan'; readonly workspaceId: string; readonly hostIds: readonly string[]; readonly unit: string; readonly canaryCount: number; readonly maxParallel: number; readonly expiresAt: string }
interface ExecuteRequest { readonly operation: 'execute'; readonly rolloutId: string; readonly workspaceId: string; readonly previewHash: string; readonly userConfirmed: true }
interface ResumePreviewRequest { readonly operation: 'resume_preview'; readonly rolloutId: string; readonly workspaceId: string }
interface ResumeExecuteRequest { readonly operation: 'resume_execute'; readonly rolloutId: string; readonly workspaceId: string; readonly previewHash: string; readonly userConfirmed: true }
type RolloutRequest = PlanRequest | ExecuteRequest | ResumePreviewRequest | ResumeExecuteRequest | { readonly operation: 'status'; readonly rolloutId: string } | { readonly operation: 'cancel'; readonly rolloutId: string; readonly workspaceId: string };

function parseRequest(input: unknown, now: Date): Result<RolloutRequest> {
  const value = asRecord(input);
  const operation = value?.operation;
  if (operation === 'plan') {
    const workspaceId = typeof value?.workspaceId === 'string' ? value.workspaceId.trim() : '';
    const hostIds = Array.isArray(value?.hostIds) ? value.hostIds.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()) : [];
    const unit = typeof value?.unit === 'string' ? value.unit.trim() : '';
    const canaryCount = typeof value?.canaryCount === 'number' ? value.canaryCount : 0;
    const maxParallel = typeof value?.maxParallel === 'number' ? value.maxParallel : 2;
    if (workspaceId.length === 0 || hostIds.length < 1 || hostIds.length > MAX_HOSTS || hostIds.some((id) => !HOST_ID.test(id)) || new Set(hostIds).size !== hostIds.length) return err(appError('INVALID_INPUT', 'remote_rollout hostIds/workspaceId are invalid', false));
    if (!SERVICE_UNIT.test(unit) || /^(shutdown|reboot|emergency|rescue)\.service$/.test(unit)) return err(appError('INVALID_INPUT', 'remote_rollout service unit is invalid or blocked', false));
    if (!Number.isInteger(canaryCount) || canaryCount < 1 || canaryCount > hostIds.length || !Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > MAX_PARALLEL) return err(appError('INVALID_INPUT', 'remote_rollout canaryCount/maxParallel are invalid', false));
    const expiresAt = typeof value?.expiresAt === 'string' ? value.expiresAt : undefined;
    const expires = expiresAt === undefined ? new Date(now.getTime() + DEFAULT_TTL_MS) : new Date(expiresAt);
    if (Number.isNaN(expires.getTime()) || expires.getTime() <= now.getTime() || expires.getTime() - now.getTime() > MAX_TTL_MS) return err(appError('INVALID_INPUT', 'remote_rollout expiresAt is invalid', false));
    return ok({ operation, workspaceId, hostIds, unit, canaryCount, maxParallel, expiresAt: expires.toISOString() });
  }
  if (operation === 'execute') {
    const rolloutId = typeof value?.rolloutId === 'string' ? value.rolloutId.trim() : '';
    const workspaceId = typeof value?.workspaceId === 'string' ? value.workspaceId.trim() : '';
    const previewHash = typeof value?.previewHash === 'string' ? value.previewHash.trim() : '';
    if (rolloutId.length === 0 || workspaceId.length === 0 || !SHA256.test(previewHash) || value?.userConfirmed !== true) return err(appError('INVALID_INPUT', 'remote_rollout execute requires rolloutId, workspaceId, previewHash, and userConfirmed', false));
    return ok({ operation, rolloutId, workspaceId, previewHash, userConfirmed: true });
  }
  if (operation === 'resume_preview') {
    const rolloutId = typeof value?.rolloutId === 'string' ? value.rolloutId.trim() : '';
    const workspaceId = typeof value?.workspaceId === 'string' ? value.workspaceId.trim() : '';
    if (rolloutId.length === 0 || workspaceId.length === 0) return err(appError('INVALID_INPUT', 'remote_rollout_resume preview requires rolloutId and workspaceId', false));
    return ok({ operation, rolloutId, workspaceId });
  }
  if (operation === 'resume_execute') {
    const rolloutId = typeof value?.rolloutId === 'string' ? value.rolloutId.trim() : '';
    const workspaceId = typeof value?.workspaceId === 'string' ? value.workspaceId.trim() : '';
    const previewHash = typeof value?.previewHash === 'string' ? value.previewHash.trim() : '';
    if (rolloutId.length === 0 || workspaceId.length === 0 || !SHA256.test(previewHash) || value?.userConfirmed !== true) return err(appError('INVALID_INPUT', 'remote_rollout_resume execute requires rolloutId, workspaceId, previewHash, and userConfirmed', false));
    return ok({ operation, rolloutId, workspaceId, previewHash, userConfirmed: true });
  }
  if (operation === 'status' || operation === 'cancel') {
    const rolloutId = typeof value?.rolloutId === 'string' ? value.rolloutId.trim() : '';
    const workspaceId = typeof value?.workspaceId === 'string' ? value.workspaceId.trim() : '';
    if (rolloutId.length === 0 || (operation === 'cancel' && workspaceId.length === 0)) return err(appError('INVALID_INPUT', 'remote_rollout rolloutId and workspaceId are required', false));
    return operation === 'cancel' ? ok({ operation, rolloutId, workspaceId }) : ok({ operation, rolloutId });
  }
  return err(appError('INVALID_INPUT', 'remote_rollout operation is invalid', false));
}

function publicPlan(plan: RemoteRolloutPlan, operation: 'plan' | 'status' = 'status'): Record<string, unknown> {
  return { operation, rolloutId: plan.id, workspaceId: plan.workspaceId, hostIds: plan.hostIds, unit: plan.unit, canaryCount: plan.canaryCount, maxParallel: plan.maxParallel, previewHash: plan.previewHash, expiresAt: plan.expiresAt, state: plan.state, ...(plan.results === undefined ? {} : { results: plan.results }), ...(plan.cancelRequested === true ? { cancelRequested: true } : {}), ...(plan.resumePreview === undefined || plan.resumePreview === null ? {} : { resumePreview: plan.resumePreview }) };
}

function publicExecution(plan: RemoteRolloutPlan, state: RemoteRolloutState, results: readonly RemoteRolloutHostResult[]): Record<string, unknown> {
  return { operation: 'execute', rolloutId: plan.id, state, previewHash: plan.previewHash, results, summary: summarize(plan.hostIds, results) };
}

function summarize(hostIds: readonly string[], results: readonly RemoteRolloutHostResult[]): { requested: number; completed: number; failed: number; cancelled: number; unverified: number } {
  const latest = latestResults(results);
  return { requested: hostIds.length, completed: [...latest.values()].filter((entry) => entry.status === 'ok').length, failed: [...latest.values()].filter((entry) => entry.status === 'error' || entry.status === 'unverified').length, cancelled: [...latest.values()].filter((entry) => entry.status === 'cancelled').length, unverified: [...latest.values()].filter((entry) => entry.status === 'unverified').length };
}

function latestResults(results: readonly RemoteRolloutHostResult[] | undefined): Map<string, RemoteRolloutHostResult> {
  const latest = new Map<string, RemoteRolloutHostResult>();
  for (const result of results ?? []) latest.set(result.hostId, result);
  return latest;
}

function hasFailure(results: readonly RemoteRolloutHostResult[]): boolean { return results.some((entry) => entry.status === 'error' || entry.status === 'unverified'); }

function ambiguous(code: string): boolean { return code === 'CAPABILITY_UNAVAILABLE' || code === 'PROCESS_TIMEOUT'; }

function canonicalHash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

function safeError(error: { readonly code: string; readonly message: string; readonly recoverable: boolean }): ReturnType<typeof appError> { return appError(error.code as Parameters<typeof appError>[0], redact(error.message), error.recoverable); }

function redact(value: string): string { return value.replace(/(?:password|secret|token|api[_-]?key|private[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]').replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[redacted]'); }

function asRecord(value: unknown): Record<string, unknown> | null { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }

export const LinuxRemoteRolloutRuntime = RemoteRolloutRuntime;
