import { describe, expect, it } from 'vitest';
import type { Workspace, WorkspaceRepository } from '@baitonghub-linux-mcp/workspace';
import { ProjectDetector } from '@baitonghub-linux-mcp/project';
import { ProjectService } from './project-service.js';

const workspace: Workspace = {
  id: 'workspace-1',
  displayName: 'Fixture',
  rootPath: 'C:\\workspace',
  realRootPath: 'C:\\workspace',
  createdAt: new Date(0).toISOString(),
};

function repository(): WorkspaceRepository {
  return {
    async list(): Promise<Workspace[]> { return [workspace]; },
    async get(id: string): Promise<Workspace | null> { return id === workspace.id ? workspace : null; },
    async insert(): Promise<void> {},
    async delete(): Promise<void> {},
  };
}

describe('ProjectService', () => {
  it('resolves the registered workspace root before detection', async () => {
    const detector = new ProjectDetector({
      async readFile(): Promise<string> { return JSON.stringify({ scripts: { test: 'vitest' } }); },
      async exists(name: string): Promise<boolean> { return name.endsWith('package.json') || name.endsWith('package-lock.json'); },
    });
    const service = new ProjectService(repository(), detector);

    const result = await service.detect(workspace.id);

    expect(result).toMatchObject({ ok: true, value: { rootPath: workspace.realRootPath, packageManager: 'npm' } });
  });

  it('returns a structured workspace error for an unknown workspace', async () => {
    const result = await new ProjectService(repository()).getCommand('missing', 'test');

    expect(result).toMatchObject({ ok: false, error: { code: 'WORKSPACE_NOT_FOUND' } });
  });
});
