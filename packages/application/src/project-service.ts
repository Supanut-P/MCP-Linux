import { appError, err, type CommandSpec, type Result } from '@baitonghub-linux-mcp/domain';
import { JsCommandDetector, ProjectDetector, type ProjectCommandKind, type ProjectProfile } from '@baitonghub-linux-mcp/project';
import type { WorkspaceRepository } from '@baitonghub-linux-mcp/workspace';

export class ProjectService {
  public constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly detector: ProjectDetector = new ProjectDetector(),
    private readonly commandDetector: JsCommandDetector = new JsCommandDetector(),
  ) {}

  public async detect(workspaceId: string): Promise<Result<ProjectProfile>> {
    const workspace = await this.workspaces.get(workspaceId);
    if (workspace === null) return err(appError('WORKSPACE_NOT_FOUND', 'Workspace was not found'));
    return this.detector.detect(workspace.realRootPath);
  }

  public async getCommand(workspaceId: string, kind: ProjectCommandKind): Promise<Result<CommandSpec>> {
    const profile = await this.detect(workspaceId);
    if (!profile.ok) return profile;
    return this.commandDetector.getCommand(profile.value, kind);
  }
}
