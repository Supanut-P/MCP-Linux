import type { PermissionDecision, PermissionProfile } from './types.js';

export type PermissionV2Class =
  | 'filesystem.read' | 'filesystem.write' | 'filesystem.delete'
  | 'shell.safe' | 'shell.destructive'
  | 'git.read' | 'git.write' | 'git.destructive'
  | 'process.read' | 'process.control'
  | 'browser.read' | 'browser.write'
  | 'network.read' | 'network.write'
  | 'system.read' | 'system.admin';

export interface PermissionV2Operation {
  readonly permission: PermissionV2Class;
  readonly action: string;
  readonly workspaceId: string;
  readonly target?: string;
  readonly contextRead?: boolean;
  readonly hardBlocked?: boolean;
}

export interface PermissionV2Result {
  readonly decision: PermissionDecision;
  readonly permission: PermissionV2Class;
  readonly contextAccess: 'unrestricted' | 'not-applicable';
  readonly reason: string;
}

/**
 * Permission v2 protects side effects while keeping permitted workspace reads
 * unrestricted. Ranking, indexing, and response size are never authorization.
 */
export class PermissionV2Engine {
  public decide(profile: PermissionProfile, operation: PermissionV2Operation): PermissionV2Result {
    if (operation.hardBlocked === true) return { decision: 'DENY', permission: operation.permission, contextAccess: contextAccess(operation), reason: 'hard-blocked action' };
    if (operation.contextRead === true || operation.permission === 'filesystem.read') {
      return { decision: 'ALLOW', permission: operation.permission, contextAccess: 'unrestricted', reason: 'allowed workspace context read' };
    }
    const level = levelFor(operation.permission);
    return { decision: profile.defaults[level], permission: operation.permission, contextAccess: contextAccess(operation), reason: `${profile.name} profile ${level} default` };
  }
}

function levelFor(permission: PermissionV2Class): 'READ' | 'WRITE' | 'EXECUTE' | 'DANGEROUS' {
  if (permission.endsWith('.read') || permission === 'shell.safe') return 'READ';
  if (permission.endsWith('.write')) return 'WRITE';
  if (permission === 'process.control' || permission === 'browser.write') return 'EXECUTE';
  return 'DANGEROUS';
}

function contextAccess(operation: PermissionV2Operation): 'unrestricted' | 'not-applicable' {
  return operation.contextRead === true || operation.permission === 'filesystem.read' ? 'unrestricted' : 'not-applicable';
}
