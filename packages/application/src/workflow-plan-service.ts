import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import { WorkspacePathGuard, type WorkspaceRepository } from '@baitonghub-linux-mcp/workspace';
import { prepareWorkflowContract, type PreparedWorkflow } from '@baitonghub-linux-mcp/codex';
import type { FileActor } from './file-service.js';

export class WorkflowPlanService {
  public constructor(private readonly workspaces: WorkspaceRepository, private readonly guard = new WorkspacePathGuard()) {}

  public async execute(actor: FileActor, input: unknown, signal?: AbortSignal): Promise<Result<PreparedWorkflow>> {
    void actor;
    if (signal?.aborted) return cancelled();
    const prepared = prepareWorkflowContract(input);
    if (!prepared.ok) return prepared;
    try {
      const workspace = await this.workspaces.get(prepared.value.contract.workspaceId);
      if (signal?.aborted) return cancelled();
      if (workspace === null) return err(appError('WORKSPACE_NOT_FOUND', 'Workspace was not found'));
      const root = await this.guard.resolveForRead(workspace, '.');
      if (signal?.aborted) return cancelled();
      if (!root.ok) return err(appError('PATH_OUTSIDE_WORKSPACE', 'Workspace root could not be validated'));
      for (const file of prepared.value.contract.allowedFiles) {
        const checked = await this.guard.resolveForWrite(workspace, file);
        if (signal?.aborted) return cancelled();
        if (!checked.ok) return err(appError(checked.error.code, 'An allowed file path could not be validated'));
      }
      return ok(prepared.value);
    } catch {
      return err(appError('INTERNAL_ERROR', 'Workflow preparation failed'));
    }
  }
}

function cancelled(): Result<never> { return err(appError('PROCESS_TIMEOUT', 'Workflow preparation was cancelled', true)); }
