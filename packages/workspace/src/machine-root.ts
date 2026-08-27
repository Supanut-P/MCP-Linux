import path from 'node:path';

export function normalizeWorkspaceRoot(rootPath: string): string {
  const resolved = path.posix.resolve(rootPath.trim().replaceAll('\\', '/'));
  return resolved.endsWith(path.posix.sep) ? resolved : `${resolved}${path.posix.sep}`;
}

/** Machine roots for the current access mode. */
export function machineRootPaths(
  _unrestricted: boolean,
  preferredPath?: string,
): readonly string[] {
  const registeredRoot = preferredPath?.trim();
  return registeredRoot ? [path.posix.resolve(registeredRoot.replaceAll('\\', '/'))] : [];
}
