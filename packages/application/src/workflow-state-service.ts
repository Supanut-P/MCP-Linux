import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appError, err, ok, type Result, type DurableWorkflow, type WorkflowCheckpoint, type WorkflowRepository, type WorkflowTaskState, type WorkflowReservation, type WorkflowVerification } from '@baitonghub-linux-mcp/domain';
import { prepareWorkflowContract } from '@baitonghub-linux-mcp/codex';
import { DefaultPermissionEngine, permissionProfiles, type PermissionProfile } from '@baitonghub-linux-mcp/permissions';
import { WorkspacePathGuard, type WorkspaceRepository } from '@baitonghub-linux-mcp/workspace';
import type { FileActor } from './file-service.js';
import { captureWorkflowScope, compareWorkflowSnapshots, type WorkflowSourceSnapshot } from './workflow-scope.js';

export type WorkflowOperation = 'plan' | 'start' | 'status' | 'events' | 'result' | 'resume' | 'checkpoint' | 'complete' | 'cancel' | 'reconcile';
interface Request {
  readonly operation: WorkflowOperation;
  readonly workspaceId: string;
  readonly workflowId?: string;
  readonly contracts?: readonly unknown[];
  readonly taskId?: string;
  readonly expectedRevision?: number;
  readonly claimToken?: string;
  readonly state?: WorkflowTaskState;
  readonly checkpoint?: WorkflowCheckpoint;
  readonly after?: number;
  readonly limit?: number;
  readonly scopeMode?: 'workspace' | 'disjoint';
  readonly leaseSeconds?: number;
  readonly leaseId?: string;
  readonly writerStopped?: boolean;
  readonly userConfirmed?: boolean;
  readonly summary?: string;
  readonly concurrentAcknowledgement?: { readonly baselineFingerprint: string; readonly sourceFingerprint: string; readonly userConfirmed: true };
}

/** Durable coordination only. No executor, process launcher or stored approval. */
export class WorkflowStateService {
  private readonly guard = new WorkspacePathGuard();
  private readonly permissions = new DefaultPermissionEngine();
  public constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly repository: WorkflowRepository,
    private readonly profileProvider: () => PermissionProfile = () => permissionProfiles.balanced,
  ) {}

  public async execute(actor: FileActor, input: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
    try {
      const request = parse(input);
      if (request === null || !text(actor.clientId, 512)) return invalid();
      if (signal?.aborted) return cancelled();
      const ownerKey = createHash('sha256').update(actor.clientId).digest('hex');
      const workspace = await this.workspaces.get(request.workspaceId);
      if (signal?.aborted) return cancelled();
      if (workspace === null) return err(appError('WORKSPACE_NOT_FOUND', 'Registered workspace was not found'));
      const read = this.authorize(request, 'READ');
      if (!read.ok) return read;
      const mutating = ['plan', 'start', 'checkpoint', 'complete', 'cancel', 'reconcile'].includes(request.operation);
      if (mutating) {
        const write = this.authorize(request, 'WRITE');
        if (!write.ok) return write;
      }
      const root = await this.guard.resolveForRead(workspace, '.');
      if (signal?.aborted) return cancelled();
      if (!root.ok) return root;
      let workflow: DurableWorkflow;
      if (request.operation === 'plan') {
        const tasks = [];
        for (const raw of request.contracts ?? []) {
          const prepared = prepareWorkflowContract(raw);
          if (!prepared.ok) return prepared;
          if (prepared.value.contract.workspaceId !== workspace.id) return invalid();
          const contract = prepared.value.contract;
          const contractJson = JSON.stringify(contract);
          if (Buffer.byteLength(contractJson) > 32 * 1024) return invalid();
          tasks.push({ taskId: contract.taskId, contractJson, dependencies: contract.dependencies, state: contract.dependencies.length === 0 ? 'ready' as const : 'planned' as const, revision: 0, checkpoint: null });
        }
        workflow = { id: randomUUID(), ownerKey, workspaceId: workspace.id, createdAt: new Date().toISOString(), tasks };
      } else {
        const stored = this.repository.get(ownerKey, request.workflowId ?? '');
        if (stored === null || stored.workspaceId !== workspace.id) return err(appError('INVALID_INPUT', 'Owned workflow was not found'));
        workflow = stored;
      }
      const contracts = new Map<string, readonly string[]>();
      // Stored contracts are untrusted after reopen. Revalidate immutable scope.
      for (const task of workflow.tasks) {
        const prepared = prepareWorkflowContract(JSON.parse(task.contractJson) as unknown);
        if (!prepared.ok || prepared.value.contract.workspaceId !== workspace.id || prepared.value.contract.taskId !== task.taskId) return invalid();
        contracts.set(task.taskId, prepared.value.contract.allowedFiles);
        for (const file of prepared.value.contract.allowedFiles) {
          const checked = await this.guard.resolveForWrite(workspace, file);
          if (signal?.aborted) return cancelled();
          if (!checked.ok) return err(appError(checked.error.code, 'Workflow file scope could not be validated'));
        }
      }
      let reservation: WorkflowReservation | undefined;
      let verification: WorkflowVerification | undefined;
      let sourceEvidence: unknown;
      let now = new Date().toISOString();
      const expiresAt = new Date(Date.parse(now) + (request.leaseSeconds ?? 300) * 1000).toISOString();
      if (['start', 'checkpoint', 'complete', 'reconcile'].includes(request.operation)) {
        const allowedFiles = contracts.get(request.taskId ?? '');
        if (allowedFiles === undefined) return conflict();
        const lease = request.operation === 'start' ? null : this.repository.getLease(ownerKey, workflow.id, request.taskId ?? '');
        if (request.operation !== 'start' && lease === null) return conflict();
        const captured = await captureWorkflowScope(workspace, allowedFiles, lease?.reservation.mode ?? request.scopeMode ?? 'workspace', signal);
        if (!captured.ok) return captured;
        if (request.operation === 'start') {
          reservation = { mode: request.scopeMode ?? 'workspace', scopes: captured.value.scopes, workspaceFingerprint: captured.value.workspaceFingerprint, baselineJson: JSON.stringify({ ...captured.value.snapshot, canonicalAllowedFiles: captured.value.canonicalAllowedFiles }), expiresAt };
        } else if (request.operation === 'reconcile') {
          // Explicit owner review can reconcile violations too. It is not termination proof.
          sourceEvidence = { sourceFingerprint: captured.value.snapshot.fingerprint, writerStopped: 'caller_attested', effectsReviewed: request.summary };
        } else {
          if (lease === null || lease.state !== 'active' || Date.parse(lease.expiresAt) <= Date.now() || lease.reservation.workspaceFingerprint !== captured.value.workspaceFingerprint || JSON.stringify(lease.reservation.scopes.map((scope) => scope.path)) !== JSON.stringify(captured.value.scopes.map((scope) => scope.path))) return conflict();
          const baseline = JSON.parse(lease.reservation.baselineJson) as WorkflowSourceSnapshot & {canonicalAllowedFiles?: readonly string[]};
          if (JSON.stringify(baseline.canonicalAllowedFiles) !== JSON.stringify(captured.value.canonicalAllowedFiles)) return conflict();
          const ownFiles = [...allowedFiles, ...captured.value.canonicalAllowedFiles];
          let delta = compareWorkflowSnapshots(baseline, captured.value.snapshot, ownFiles);
          let concurrentChangesAcknowledged = false;
          if (!delta.ok && lease.reservation.mode === 'disjoint' && request.concurrentAcknowledgement !== undefined) {
            const acknowledgement = request.concurrentAcknowledgement;
            if (acknowledgement.baselineFingerprint !== baseline.fingerprint || acknowledgement.sourceFingerprint !== captured.value.snapshot.fingerprint) return conflict();
            const concurrent = this.repository.concurrentScopes(ownerKey, workflow.id, request.taskId ?? '');
            if (concurrent === null) return conflict();
            const canonicalRoot = workspace.realRootPath.replaceAll('\\', '/').normalize('NFC').toLocaleLowerCase('en-US').replace(/\/$/, '');
            const otherFiles = concurrent.flatMap((scope) => scope.path.startsWith(`${canonicalRoot}/`) ? [scope.path.slice(canonicalRoot.length + 1)] : []);
            delta = compareWorkflowSnapshots(baseline, captured.value.snapshot, [...ownFiles, ...otherFiles]);
            if (!delta.ok) return delta;
            concurrentChangesAcknowledged = true;
          }
          if (!delta.ok) return err({ ...appError('INVALID_INPUT', 'Source delta is outside scope or requires a digest-bound concurrent-change acknowledgement'), details: { baselineFingerprint: baseline.fingerprint, sourceFingerprint: captured.value.snapshot.fingerprint } });
          verification = { sourceFingerprint: delta.value.sourceFingerprint, expiresAt };
          sourceEvidence = concurrentChangesAcknowledged ? { sourceFingerprint: delta.value.sourceFingerprint, diffFingerprint: delta.value.diffFingerprint, concurrentChangesAcknowledged: true, physicalAuthorship: 'unverified' } : delta.value;
        }
      }
      // Lease lifetime begins at admission, after bounded filesystem capture.
      now = new Date().toISOString();
      const admissionExpiry = new Date(Date.parse(now) + (request.leaseSeconds ?? 300) * 1000).toISOString();
      if (reservation !== undefined) reservation = { ...reservation, expiresAt: admissionExpiry };
      if (verification !== undefined) verification = { ...verification, expiresAt: admissionExpiry };
      // Awaited scope reads can cross a live policy change: authorize again at commit.
      const currentRead = this.authorize(request, 'READ');
      if (!currentRead.ok) return currentRead;
      if (mutating) {
        const currentWrite = this.authorize(request, 'WRITE');
        if (!currentWrite.ok) return currentWrite;
      }
      if (signal?.aborted) return cancelled();
      if (request.operation === 'plan') this.repository.create(workflow);
      if (request.operation === 'start') {
        const token = randomBytes(32).toString('hex');
        if (!this.repository.claim(ownerKey, workflow.id, request.taskId ?? '', request.expectedRevision ?? -1, token, now, reservation)) return conflict();
        return ok({ operation: 'start', workflowId: workflow.id, taskId: request.taskId, claimToken: token, revision: (request.expectedRevision ?? 0) + 1, baselineFingerprint: reservation === undefined ? null : (JSON.parse(reservation.baselineJson) as WorkflowSourceSnapshot).fingerprint, executionStarted: false, dispatch: 'caller_native' });
      }
      if (request.operation === 'checkpoint' || request.operation === 'complete') {
        const task = workflow.tasks.find((item) => item.taskId === request.taskId);
        if (task === undefined) return conflict();
        const state = request.operation === 'checkpoint' ? task.state : request.state;
        if (state === undefined || !this.repository.update(ownerKey, workflow.id, task.taskId, request.expectedRevision ?? -1, request.claimToken ?? '', state, request.checkpoint ?? task.checkpoint, now, verification)) return conflict();
      }
      if (request.operation === 'reconcile' && !this.repository.reconcile(ownerKey, workflow.id, request.taskId ?? '', request.leaseId ?? '', request.expectedRevision ?? -1, now)) return conflict();
      if (request.operation === 'cancel' && !this.repository.cancel(ownerKey, workflow.id, now)) return conflict();
      if (request.operation === 'events') {
        const limit = request.limit ?? 32;
        const events = this.repository.events(ownerKey, workflow.id, request.after ?? 0, limit + 1);
        return ok({ operation: 'events', workflowId: workflow.id, events: events.slice(0, limit), truncated: events.length > limit, nextAfter: events.slice(0, limit).at(-1)?.sequence ?? request.after ?? 0 });
      }
      const current = this.repository.get(ownerKey, workflow.id);
      if (current === null) return conflict();
      const { ownerKey: _owner, ...view } = current;
      void _owner;
      const leases = current.tasks.flatMap((task) => {
        const lease = this.repository.getLease(ownerKey, workflow.id, task.taskId);
        return lease === null ? [] : [{ taskId: task.taskId, leaseId: lease.id, state: lease.state === 'active' && Date.parse(lease.expiresAt) <= Date.now() ? 'quarantined' : lease.state, expiresAt: lease.expiresAt, lastSourceFingerprint: lease.lastSourceFingerprint }];
      });
      return ok({ operation: request.operation, workflow: view, leases, sourceEvidence, scopeVerification: 'bounded_nonignored_source', terminationVerification: 'caller_attested_only', executionStarted: false, executionControl: 'metadata_only', dispatch: 'caller_native', evidenceVerification: 'caller_supplied_not_verified', interruptedExecution: current.tasks.some((task) => task.state === 'running' || task.state === 'verifying'), executionUncertain: current.tasks.some((task) => task.checkpoint?.executionUncertain === true || task.state === 'running' || task.state === 'verifying'), resumeDispatches: false });
    } catch {
      return err(appError('INVALID_INPUT', 'Workflow state operation failed validation, quota or storage checks'));
    }
  }

  private authorize(request: Request, level: 'READ' | 'WRITE'): Result<void> {
    const decision = this.permissions.decide(this.profileProvider(), { action: `workflow_${request.operation}`, level, workspaceId: request.workspaceId, target: '.', destructive: false });
    return decision === 'ALLOW' ? ok(undefined) : err(appError(decision === 'ASK' ? 'PERMISSION_REQUIRED' : 'PERMISSION_DENIED', 'Workflow state access requires current policy permission'));
  }
}

function parse(input: unknown): Request | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (!text(value.workspaceId, 128) || typeof value.operation !== 'string') return null;
  const operation = value.operation;
  const keys: Record<string, readonly string[]> = {
    plan: ['contracts'], start: ['workflowId', 'taskId', 'expectedRevision', 'scopeMode', 'leaseSeconds'],
    checkpoint: ['workflowId', 'taskId', 'expectedRevision', 'claimToken', 'checkpoint', 'leaseSeconds'],
    complete: ['workflowId', 'taskId', 'expectedRevision', 'claimToken', 'state', 'concurrentAcknowledgement'],
    status: ['workflowId'], result: ['workflowId'], resume: ['workflowId'], cancel: ['workflowId'], events: ['workflowId', 'after', 'limit'],
    reconcile: ['workflowId', 'taskId', 'expectedRevision', 'leaseId', 'writerStopped', 'userConfirmed', 'summary'],
  };
  const allowed = keys[operation];
  if (allowed === undefined || Object.keys(value).some((key) => !['operation', 'workspaceId', ...allowed].includes(key))) return null;
  if (operation === 'plan') {
    if (!Array.isArray(value.contracts) || value.contracts.length < 1 || value.contracts.length > 16) return null;
  } else if (!text(value.workflowId, 128)) return null;
  if (['start', 'checkpoint', 'complete', 'reconcile'].includes(operation) && (!text(value.taskId, 128) || !integer(value.expectedRevision, 0, 1_000_000))) return null;
  if (value.scopeMode !== undefined && !['workspace', 'disjoint'].includes(String(value.scopeMode))) return null;
  if (value.leaseSeconds !== undefined && !integer(value.leaseSeconds, 60, 3600)) return null;
  if (operation === 'reconcile' && (!text(value.leaseId, 128) || value.writerStopped !== true || value.userConfirmed !== true || !text(value.summary, 2048))) return null;
  if (['checkpoint', 'complete'].includes(operation) && (typeof value.claimToken !== 'string' || !/^[a-f0-9]{64}$/.test(value.claimToken))) return null;
  if (operation === 'complete' && !['verifying', 'done', 'blocked', 'failed', 'cancelled'].includes(String(value.state))) return null;
  if (value.concurrentAcknowledgement !== undefined) {
    const acknowledgement = value.concurrentAcknowledgement;
    if (typeof acknowledgement !== 'object' || acknowledgement === null || Array.isArray(acknowledgement)) return null;
    const fields = acknowledgement as Record<string, unknown>;
    if (Object.keys(fields).some((key) => !['baselineFingerprint', 'sourceFingerprint', 'userConfirmed'].includes(key)) || fields.userConfirmed !== true || ![fields.baselineFingerprint, fields.sourceFingerprint].every((digest) => typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest))) return null;
  }
  if (operation === 'checkpoint') {
    const point = value.checkpoint;
    if (typeof point !== 'object' || point === null || Array.isArray(point)) return null;
    const checkpoint = point as Record<string, unknown>;
    if (Object.keys(checkpoint).some((key) => !['summary', 'references', 'executionUncertain'].includes(key)) || !text(checkpoint.summary, 2048) || typeof checkpoint.executionUncertain !== 'boolean' || !Array.isArray(checkpoint.references) || checkpoint.references.length > 16 || checkpoint.references.some((ref) => !text(ref, 512))) return null;
  }
  if (operation === 'events' && ((value.after !== undefined && !integer(value.after, 0, 1_000_000)) || (value.limit !== undefined && !integer(value.limit, 1, 64)))) return null;
  return value as unknown as Request;
}
function text(value: unknown, bytes: number): value is string { return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0') && Buffer.byteLength(value) <= bytes; }
function integer(value: unknown, min: number, max: number): boolean { return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max; }
function invalid(): Result<never> { return err(appError('INVALID_INPUT', 'Workflow request or stored contract is invalid')); }
function conflict(): Result<never> { return err(appError('INVALID_INPUT', 'Workflow claim, dependency, state or revision does not match')); }
function cancelled(): Result<never> { return err(appError('PROCESS_TIMEOUT', 'Workflow state operation was cancelled', true)); }
