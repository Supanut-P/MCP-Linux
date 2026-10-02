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
  claim(ownerKey: string, id: string, taskId: string, expectedRevision: number, claimToken: string, now: string): boolean;
  update(ownerKey: string, id: string, taskId: string, expectedRevision: number, claimToken: string, state: WorkflowTaskState, checkpoint: WorkflowCheckpoint | null, now: string): boolean;
  cancel(ownerKey: string, id: string, now: string): boolean;
  events(ownerKey: string, id: string, after: number, limit: number): readonly WorkflowEvent[];
}
