import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appError, err, ok, type Result, type DurableWorkflow, type WorkflowCheckpoint, type WorkflowRepository, type WorkflowTaskState } from '@baitonghub-linux-mcp/domain';
import { prepareWorkflowContract } from '@baitonghub-linux-mcp/codex';
import { DefaultPermissionEngine, permissionProfiles, type PermissionProfile } from '@baitonghub-linux-mcp/permissions';
import { WorkspacePathGuard, type WorkspaceRepository } from '@baitonghub-linux-mcp/workspace';
import type { FileActor } from './file-service.js';

export type WorkflowOperation = 'plan' | 'start' | 'status' | 'events' | 'result' | 'resume' | 'checkpoint' | 'complete' | 'cancel';
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
      const mutating = ['plan', 'start', 'checkpoint', 'complete', 'cancel'].includes(request.operation);
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
      // Stored contracts are untrusted after reopen. Revalidate immutable scope.
      for (const task of workflow.tasks) {
        const prepared = prepareWorkflowContract(JSON.parse(task.contractJson) as unknown);
        if (!prepared.ok || prepared.value.contract.workspaceId !== workspace.id || prepared.value.contract.taskId !== task.taskId) return invalid();
        for (const file of prepared.value.contract.allowedFiles) {
          const checked = await this.guard.resolveForWrite(workspace, file);
          if (signal?.aborted) return cancelled();
          if (!checked.ok) return err(appError(checked.error.code, 'Workflow file scope could not be validated'));
        }
      }
      // Awaited scope reads can cross a live policy change: authorize again at commit.
      const currentRead = this.authorize(request, 'READ');
      if (!currentRead.ok) return currentRead;
      if (mutating) {
        const currentWrite = this.authorize(request, 'WRITE');
        if (!currentWrite.ok) return currentWrite;
      }
      if (signal?.aborted) return cancelled();
      const now = new Date().toISOString();
      if (request.operation === 'plan') this.repository.create(workflow);
      if (request.operation === 'start') {
        const token = randomBytes(32).toString('hex');
        if (!this.repository.claim(ownerKey, workflow.id, request.taskId ?? '', request.expectedRevision ?? -1, token, now)) return conflict();
        return ok({ operation: 'start', workflowId: workflow.id, taskId: request.taskId, claimToken: token, revision: (request.expectedRevision ?? 0) + 1, executionStarted: false, dispatch: 'caller_native' });
      }
      if (request.operation === 'checkpoint' || request.operation === 'complete') {
        const task = workflow.tasks.find((item) => item.taskId === request.taskId);
        if (task === undefined) return conflict();
        const state = request.operation === 'checkpoint' ? task.state : request.state;
        if (state === undefined || !this.repository.update(ownerKey, workflow.id, task.taskId, request.expectedRevision ?? -1, request.claimToken ?? '', state, request.checkpoint ?? task.checkpoint, now)) return conflict();
      }
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
      return ok({ operation: request.operation, workflow: view, executionStarted: false, executionControl: 'metadata_only', dispatch: 'caller_native', evidenceVerification: 'caller_supplied_not_verified', interruptedExecution: current.tasks.some((task) => task.state === 'running' || task.state === 'verifying'), executionUncertain: current.tasks.some((task) => task.checkpoint?.executionUncertain === true || task.state === 'running' || task.state === 'verifying'), resumeDispatches: false });
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
    plan: ['contracts'], start: ['workflowId', 'taskId', 'expectedRevision'],
    checkpoint: ['workflowId', 'taskId', 'expectedRevision', 'claimToken', 'checkpoint'],
    complete: ['workflowId', 'taskId', 'expectedRevision', 'claimToken', 'state'],
    status: ['workflowId'], result: ['workflowId'], resume: ['workflowId'], cancel: ['workflowId'], events: ['workflowId', 'after', 'limit'],
  };
  const allowed = keys[operation];
  if (allowed === undefined || Object.keys(value).some((key) => !['operation', 'workspaceId', ...allowed].includes(key))) return null;
  if (operation === 'plan') {
    if (!Array.isArray(value.contracts) || value.contracts.length < 1 || value.contracts.length > 16) return null;
  } else if (!text(value.workflowId, 128)) return null;
  if (['start', 'checkpoint', 'complete'].includes(operation) && (!text(value.taskId, 128) || !integer(value.expectedRevision, 0, 1_000_000))) return null;
  if (['checkpoint', 'complete'].includes(operation) && (typeof value.claimToken !== 'string' || !/^[a-f0-9]{64}$/.test(value.claimToken))) return null;
  if (operation === 'complete' && !['verifying', 'done', 'blocked', 'failed', 'cancelled'].includes(String(value.state))) return null;
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
