import { describe, expect, it } from 'vitest';
import { DEFAULT_DESTRUCTIVE_AUTO_APPROVAL_POLICY, type DestructiveApprovalKey, type DestructiveAutoApprovalPolicy } from '@baitonghub-linux-mcp/shared';
import { inspectDestructiveOperation } from './destructive-policy.js';
import { isScopedAutoApprovalAllowed } from './destructive-scope.js';

const scope = { workspaceId: 'workspace-1', rootPath: '/srv/project' };

function policy(enabled: readonly DestructiveApprovalKey[], protectCriticalFiles = true): DestructiveAutoApprovalPolicy {
  return {
    ...DEFAULT_DESTRUCTIVE_AUTO_APPROVAL_POLICY,
    protectCriticalFiles,
    approvals: {
      ...DEFAULT_DESTRUCTIVE_AUTO_APPROVAL_POLICY.approvals,
      ...Object.fromEntries(enabled.map((key) => [key, true])),
    },
  };
}

function allowed(toolName: string, input: Record<string, unknown>, activePolicy: DestructiveAutoApprovalPolicy): boolean {
  return isScopedAutoApprovalAllowed(toolName, input, inspectDestructiveOperation(toolName, input), activePolicy, scope);
}

describe('scoped destructive auto approval', () => {
  it('allows a selected delete_file only inside the active project', () => {
    const current = policy(['delete_file']);
    expect(allowed('delete_file', { workspaceId: 'workspace-1', path: 'src/old.txt' }, current)).toBe(true);
    expect(allowed('delete_file', { workspaceId: 'workspace-2', path: 'src/old.txt' }, current)).toBe(false);
    expect(allowed('delete_file', { workspaceId: 'workspace-1', path: '../outside.txt' }, current)).toBe(false);
    expect(allowed('delete_file', { workspaceId: 'workspace-1', path: '.' }, current)).toBe(false);
  });

  it('keeps critical files approval-gated while protection is enabled', () => {
    const current = policy(['delete_file', 'git_rm', 'shell_rm_unlink', 'wsl_rm_unlink']);
    expect(allowed('delete_file', { workspaceId: 'workspace-1', path: '.env' }, current)).toBe(false);
    expect(allowed('git', { workspaceId: 'workspace-1', args: ['rm', '--', 'package.json'] }, current)).toBe(false);
    expect(allowed('shell', { workspaceId: 'workspace-1', operation: 'run', executable: 'rm', arguments: ['secrets.json'] }, current)).toBe(false);
    expect(allowed('wsl_exec', { workspaceId: 'workspace-1', operation: 'run', executable: 'rm', arguments: ['credentials.json'] }, current)).toBe(false);
  });

  it('falls back to approval for recursive, wildcard, broad clean and hard reset while critical protection is enabled', () => {
    const current = policy(['git_clean', 'git_reset_restore', 'shell_rm_unlink']);
    expect(allowed('shell', { workspaceId: 'workspace-1', operation: 'run', executable: 'rm', arguments: ['-rf', 'src'] }, current)).toBe(false);
    expect(allowed('shell', { workspaceId: 'workspace-1', operation: 'run', executable: 'rm', arguments: ['*.tmp'] }, current)).toBe(false);
    expect(allowed('git', { workspaceId: 'workspace-1', args: ['clean', '-fd'] }, current)).toBe(false);
    expect(allowed('git', { workspaceId: 'workspace-1', args: ['reset', '--hard'] }, current)).toBe(false);
    expect(allowed('git', { workspaceId: 'workspace-1', args: ['restore', '--', 'src/safe.ts'] }, current)).toBe(true);
  });

  it('permits explicitly accepted broad git cleanup only when critical protection is disabled', () => {
    const current = policy(['git_clean', 'git_reset_restore'], false);
    expect(allowed('git', { workspaceId: 'workspace-1', args: ['clean', '-fd'] }, current)).toBe(true);
    expect(allowed('git', { workspaceId: 'workspace-1', args: ['reset', '--hard'] }, current)).toBe(true);
  });

  it('never auto-approves the filesystem root as an active project', () => {
    const current = policy(['delete_file']);
    const decision = inspectDestructiveOperation('delete_file', { workspaceId: 'drive', path: 'temp.txt' });
    expect(isScopedAutoApprovalAllowed('delete_file', { workspaceId: 'drive', path: 'temp.txt' }, decision, current, {
      workspaceId: 'drive',
      rootPath: '/',
    })).toBe(false);
  });
});
