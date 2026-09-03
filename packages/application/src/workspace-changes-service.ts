import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import type { WorkspaceIndexChanges, WorkspaceIndexService } from './workspace-index.js';

export interface WorkspaceChangesResult extends WorkspaceIndexChanges {
  readonly workspaceId: string;
}

/** Read-only, bounded access to the active workspace watcher journal. */
export class WorkspaceChangesService {
  public constructor(private readonly index: Pick<WorkspaceIndexService, 'changes'>) {}

  public async snapshot(workspaceId: string, maxEvents = 50): Promise<Result<WorkspaceChangesResult>> {
    return this.read(workspaceId, 0, maxEvents);
  }

  public async diff(workspaceId: string, afterSequence: number, maxEvents = 50): Promise<Result<WorkspaceChangesResult>> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) return err(appError('INVALID_INPUT', 'afterSequence must be a non-negative integer'));
    return this.read(workspaceId, afterSequence, maxEvents);
  }

  private async read(workspaceId: string, afterSequence: number, maxEvents: number): Promise<Result<WorkspaceChangesResult>> {
    if (typeof workspaceId !== 'string' || workspaceId.trim().length === 0) return err(appError('INVALID_INPUT', 'workspaceId is required'));
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 200) return err(appError('INVALID_INPUT', 'maxEvents must be between 1 and 200'));
    const result = await this.index.changes(workspaceId, afterSequence, maxEvents);
    if (!result.ok) return result;
    const events = result.value.events.filter((event) => isSafeRelativePath(event.relativePath));
    return ok({ workspaceId, events, latestSequence: result.value.latestSequence, truncated: result.value.truncated });
  }
}

function isSafeRelativePath(value: string): boolean {
  return value.length > 0
    && !value.startsWith('/')
    && !/^[A-Za-z]:\//.test(value)
    && !value.split('/').some((segment) => segment === '..' || segment === '');
}
