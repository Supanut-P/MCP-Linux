export type WorkflowTaskState = 'planned' | 'ready' | 'running' | 'verifying' | 'done' | 'blocked' | 'failed' | 'cancelled';

export interface WorkflowCheckpoint {
  readonly summary: string;
  readonly references: readonly string[];
  readonly executionUncertain: boolean;
}

export interface DurableWorkflowTask {
  readonly taskId: string;
  readonly contractJson: string;
  readonly dependencies: readonly string[];
  readonly state: WorkflowTaskState;
  readonly revision: number;
  readonly checkpoint: WorkflowCheckpoint | null;
}

export interface DurableWorkflow {
  readonly id: string;
  readonly ownerKey: string;
  readonly workspaceId: string;
  readonly createdAt: string;
  readonly tasks: readonly DurableWorkflowTask[];
}

export interface WorkflowScopeKey { readonly path: string; readonly inode: string | null }
export interface WorkflowReservation {
  readonly mode: 'workspace' | 'disjoint';
  readonly scopes: readonly WorkflowScopeKey[];
  readonly workspaceFingerprint: string;
  readonly baselineJson: string;
  readonly expiresAt: string;
}
export interface WorkflowLease {
  readonly id: string;
  readonly workflowId: string;
  readonly taskId: string;
  readonly state: 'active' | 'quarantined' | 'released';
  readonly expiresAt: string;
  readonly reservation: WorkflowReservation;
  readonly lastSourceFingerprint: string | null;
}
export interface WorkflowVerification { readonly sourceFingerprint: string; readonly expiresAt: string }

export interface WorkflowEvent {
  readonly sequence: number;
  readonly taskId: string | null;
  readonly type: string;
  readonly timestamp: string;
  readonly revision: number | null;
}

export interface WorkflowRepository {
  create(workflow: DurableWorkflow): void;
  get(ownerKey: string, id: string): DurableWorkflow | null;
  claim(ownerKey: string, id: string, taskId: string, expectedRevision: number, claimToken: string, now: string, reservation?: WorkflowReservation): boolean;
  update(ownerKey: string, id: string, taskId: string, expectedRevision: number, claimToken: string, state: WorkflowTaskState, checkpoint: WorkflowCheckpoint | null, now: string, verification?: WorkflowVerification): boolean;
  getLease(ownerKey: string, id: string, taskId: string): WorkflowLease | null;
  concurrentScopes(ownerKey: string, id: string, taskId: string): readonly WorkflowScopeKey[] | null;
  reconcile(ownerKey: string, id: string, taskId: string, leaseId: string, expectedRevision: number, now: string): boolean;
  cancel(ownerKey: string, id: string, now: string): boolean;
  events(ownerKey: string, id: string, after: number, limit: number): readonly WorkflowEvent[];
}
