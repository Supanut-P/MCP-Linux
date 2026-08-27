export type GitStatusKind = 'added' | 'copied' | 'deleted' | 'ignored' | 'modified' | 'renamed' | 'unmerged' | 'untracked';

export interface GitStatusEntry {
  readonly path: string;
  readonly oldPath?: string;
  readonly kind: GitStatusKind;
  readonly indexStatus: string;
  readonly worktreeStatus: string;
}

export function parsePorcelainStatus(output: string): GitStatusEntry[] {
  const tokens = output.split('\0');
  const entries: GitStatusEntry[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const record = tokens[index];
    if (record === undefined || record.length < 4) continue;
    const indexStatus = record[0] ?? ' ';
    const worktreeStatus = record[1] ?? ' ';
    const firstPath = record.slice(3);
    if (firstPath.length === 0) continue;
    const kind = getKind(indexStatus, worktreeStatus);
    if (kind === null) continue;
    const hasRenameTarget = indexStatus === 'R' || indexStatus === 'C' || worktreeStatus === 'R' || worktreeStatus === 'C';
    const secondPath = hasRenameTarget ? tokens[index + 1] : undefined;
    if (hasRenameTarget && secondPath !== undefined) index += 1;
    entries.push({
      path: secondPath ?? firstPath,
      ...(secondPath === undefined ? {} : { oldPath: firstPath }),
      kind,
      indexStatus,
      worktreeStatus,
    });
  }
  return entries;
}

function getKind(indexStatus: string, worktreeStatus: string): GitStatusKind | null {
  const status = indexStatus === '?' || worktreeStatus === '?' ? '?' : indexStatus === '!' || worktreeStatus === '!' ? '!' : indexStatus === 'U' || worktreeStatus === 'U' ? 'U' : indexStatus === 'R' || worktreeStatus === 'R' ? 'R' : indexStatus === 'C' || worktreeStatus === 'C' ? 'C' : indexStatus === 'A' || worktreeStatus === 'A' ? 'A' : indexStatus === 'D' || worktreeStatus === 'D' ? 'D' : indexStatus === 'M' || worktreeStatus === 'M' || indexStatus === 'T' || worktreeStatus === 'T' ? 'M' : null;
  if (status === '?') return 'untracked';
  if (status === '!') return 'ignored';
  if (status === 'U') return 'unmerged';
  if (status === 'R') return 'renamed';
  if (status === 'C') return 'copied';
  if (status === 'A') return 'added';
  if (status === 'D') return 'deleted';
  if (status === 'M') return 'modified';
  return null;
}
