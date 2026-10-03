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
export interface WorkflowVerification {
  readonly sourceFingerprint: string;
  readonly diffFingerprint: string;
  readonly expiresAt: string;
  readonly acceptedReceiptHash?: string;
}
export interface WorkflowAttempt {
  readonly number: number;
  readonly workerId: string;
  readonly requestedPreset: 'Luna' | 'Sol';
  readonly leaseId: string;
  readonly claimRevision: number;
  readonly verificationRevision: number | null;
  readonly sourceFingerprint: string | null;
  readonly diffFingerprint: string | null;
  readonly createdAt: string;
  readonly state: 'active' | 'accepted' | 'failed' | 'blocked' | 'done' | 'cancelled';
}
export interface WorkflowQAArtifact { readonly path: string; readonly sha256: string; readonly bytes: number }
export interface WorkflowQACommandSubmission {
  readonly commandIndex: number;
  readonly exitCode: number;
  readonly artifact: WorkflowQAArtifact;
}
export interface WorkflowQACriterionSubmission { readonly criterionIndex: number; readonly passed: boolean }
export interface WorkflowQAReceiptInput {
  readonly workerId: string;
  readonly reviewerId: string;
  readonly independentReview: true;
  readonly verdict: 'passed' | 'failed' | 'blocked';
  readonly summary: string;
  readonly verificationBounds: string;
  readonly contractSha256: string;
  readonly baselineFingerprint: string;
  readonly sourceFingerprint: string;
  readonly diffFingerprint: string;
  readonly verificationRevision: number;
  readonly commands: readonly WorkflowQACommandSubmission[];
  readonly criteria: readonly WorkflowQACriterionSubmission[];
}
export interface WorkflowQAReceiptCommand extends WorkflowQACommandSubmission {
  readonly executable: string;
  readonly args: readonly string[];
  readonly expectedExitCode: number;
  readonly timeoutSeconds: number;
}
export interface WorkflowQAReceiptCriterion extends WorkflowQACriterionSubmission { readonly criterion: string }
export interface WorkflowQAReceipt extends WorkflowQAReceiptInput {
  readonly reviewRevision: number;
  readonly id: string;
  readonly workflowId: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly leaseId: string;
  readonly requestedPreset: 'Luna' | 'Sol';
  readonly createdAt: string;
  readonly canonicalHash: string;
  readonly commands: readonly WorkflowQAReceiptCommand[];
  readonly criteria: readonly WorkflowQAReceiptCriterion[];
}
export interface WorkflowQAInfo {
  readonly attempts: readonly WorkflowAttempt[];
  readonly receipts: readonly WorkflowQAReceipt[];
  readonly verificationRevision: number | null;
  readonly sourceFingerprint: string | null;
  readonly diffFingerprint: string | null;
  readonly acceptedReceiptHash: string | null;
}

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
  claim(ownerKey: string, id: string, taskId: string, expectedRevision: number, claimToken: string, now: string, reservation?: WorkflowReservation, workerId?: string): boolean;
  update(ownerKey: string, id: string, taskId: string, expectedRevision: number, claimToken: string, state: WorkflowTaskState, checkpoint: WorkflowCheckpoint | null, now: string, verification?: WorkflowVerification): boolean;
  getLease(ownerKey: string, id: string, taskId: string): WorkflowLease | null;
  concurrentScopes(ownerKey: string, id: string, taskId: string): readonly WorkflowScopeKey[] | null;
  reconcile(ownerKey: string, id: string, taskId: string, leaseId: string, expectedRevision: number, now: string): boolean;
  review(ownerKey: string, id: string, taskId: string, expectedRevision: number, claimToken: string, leaseId: string, receipt: WorkflowQAReceiptInput, now: string): WorkflowQAReceipt | null;
  retry(ownerKey: string, id: string, taskId: string, leaseId: string, expectedRevision: number, now: string): boolean;
  qaInfo(ownerKey: string, id: string, taskId: string): WorkflowQAInfo | null;
  cancel(ownerKey: string, id: string, now: string): boolean;
  events(ownerKey: string, id: string, after: number, limit: number): readonly WorkflowEvent[];
}
