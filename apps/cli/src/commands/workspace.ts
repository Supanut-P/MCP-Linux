import path from 'node:path';
import { appError, err, type Result } from '@baitonghub-linux-mcp/domain';
import type { Workspace } from '@baitonghub-linux-mcp/workspace';

export interface WorkspaceCommandService {
  add(displayName: string, rootPath: string): Promise<Result<Workspace>>;
  list(): Promise<readonly Workspace[]>;
}

export async function runWorkspaceAdd(
  service: Pick<WorkspaceCommandService, 'add'>,
  rootPath: string,
): Promise<Result<Workspace>> {
  if (rootPath.trim().length === 0) return err(appError('INVALID_INPUT', 'Workspace root path is required'));
  return service.add(displayNameForPath(rootPath), rootPath);
}

export function runWorkspaceList(service: Pick<WorkspaceCommandService, 'list'>): Promise<readonly Workspace[]> {
  return service.list();
}

function displayNameForPath(rootPath: string): string {
  const trimmed = rootPath.trim().replace(/[\\/]+$/, '');
  return path.basename(trimmed) || 'workspace';
}
