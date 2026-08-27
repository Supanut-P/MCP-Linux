import { type Result } from '@baitonghub-linux-mcp/domain';
import { TreeReader, type TreeOptions, type TreeResult } from '@baitonghub-linux-mcp/filesystem';
import { WorkspacePathGuard, type WorkspaceRepository } from '@baitonghub-linux-mcp/workspace';
import type { FileActor } from './file-service.js';
import { resolveWorkspaceForPath } from './workspace-locator.js';

export interface TreeRequest extends TreeOptions {
  readonly path?: string;
}

export class WorkspaceQueryService {
  public constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly guard: WorkspacePathGuard = new WorkspacePathGuard(),
    private readonly treeReader: TreeReader = new TreeReader(),
  ) {}

  public async tree(actor: FileActor, workspaceId: string | undefined, request: TreeRequest = {}): Promise<Result<TreeResult>> {
    void actor;
    const hintPath = request.path ?? '.';
    const workspace = await resolveWorkspaceForPath(this.workspaces, workspaceId, hintPath);
    if (!workspace.ok) return workspace;
    const resolved = await this.guard.resolveForRead(workspace.value, hintPath);
    if (!resolved.ok) return resolved;
    return this.treeReader.read(resolved.value.realPath ?? resolved.value.absolutePath, request);
  }
}
