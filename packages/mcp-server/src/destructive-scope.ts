import path from 'node:path';
import { isProtectedCriticalPath, type DestructiveAutoApprovalPolicy } from '@baitonghub-linux-mcp/shared';
import type { DestructivePolicyDecision } from './destructive-policy.js';

export interface WorkspaceScope {
  readonly workspaceId: string;
  readonly rootPath: string;
}

/**
 * Auto-approval is intentionally narrower than normal confirmed execution.
 * If the target cannot be proven to remain inside the call workspace, this
 * returns false and the normal chat-confirmation path is used instead.
 */
/** @deprecated Use WorkspaceScope for request-scoped resolution. */
export type ActiveProjectScope = WorkspaceScope;

export function isScopedAutoApprovalAllowed(
  toolName: string,
  input: unknown,
  decision: DestructivePolicyDecision,
  policy: DestructiveAutoApprovalPolicy,
  scope: WorkspaceScope | null,
): boolean {
  if (decision.approvalKey === undefined || policy.approvals[decision.approvalKey] !== true || scope === null) return false;
  const root = path.resolve(scope.rootPath);
  if (root === path.parse(root).root) return false;
  const value = asRecord(input);
  if (value === null) return false;
  const workspaceId = typeof value.workspaceId === 'string' ? value.workspaceId : undefined;
  if (workspaceId !== undefined && workspaceId !== scope.workspaceId) return false;

  if (toolName === 'delete_file') {
    if (typeof value.path !== 'string') return false;
    return safeTarget(root, root, value.path, policy);
  }

  if (toolName === 'git') return gitScopeAllowed(value, root, policy, decision.approvalKey);
  if (toolName === 'shell' || toolName === 'process_start') return directShellScopeAllowed(value, root, policy, decision.approvalKey);
  return false;
}

function gitScopeAllowed(
  value: Record<string, unknown>,
  root: string,
  policy: DestructiveAutoApprovalPolicy,
  approvalKey: string,
): boolean {
  const cwd = resolveCwd(root, value.cwd);
  if (cwd === null) return false;
  const args = stringArray(value.args);
  if (args.length === 0 || hasGitScopeOverride(args)) return false;
  const subcommandIndex = args.findIndex((arg) => !arg.startsWith('-'));
  if (subcommandIndex < 0) return false;
  const tail = args.slice(subcommandIndex + 1);

  if (approvalKey === 'git_rm') {
    if (policy.protectCriticalFiles && hasRecursiveDeleteFlag(tail)) return false;
    const targets = gitPathspecs(tail);
    if (targets.length === 0) return false;
    return targets.every((target) => safeTarget(root, cwd, target, policy));
  }

  if (approvalKey === 'git_clean') {
    if (!policy.protectCriticalFiles) return true;
    if (tail.some((arg) => ['-x', '-X', '--ignored', '-d', '--directories'].includes(arg)) || hasShortFlag(tail, 'd') || hasShortFlag(tail, 'x') || hasShortFlag(tail, 'X')) return false;
    const separator = tail.indexOf('--');
    if (separator < 0 || separator === tail.length - 1) return false;
    return tail.slice(separator + 1).every((target) => safeTarget(root, cwd, target, policy));
  }

  if (approvalKey === 'git_reset_restore') {
    if (!policy.protectCriticalFiles) return true;
    if (tail.some((arg) => ['--hard', '--merge', '--keep'].includes(arg.toLowerCase()))) return false;
    const separator = tail.indexOf('--');
    if (separator < 0 || separator === tail.length - 1) return false;
    return tail.slice(separator + 1).every((target) => safeTarget(root, cwd, target, policy));
  }

  return false;
}

function directShellScopeAllowed(
  value: Record<string, unknown>,
  root: string,
  policy: DestructiveAutoApprovalPolicy,
  approvalKey: string,
): boolean {
  if (!['shell_rm_unlink', 'shell_rmdir'].includes(approvalKey)) return false;
  const cwd = resolveCwd(root, value.cwd);
  if (cwd === null) return false;
  const args = stringArray(value.arguments ?? value.args);
  if (policy.protectCriticalFiles && hasRecursiveDeleteFlag(args)) return false;
  const targets = directDeleteTargets(args);
  if (targets.length === 0) return false;
  return targets.every((target) => safeTarget(root, cwd, target, policy));
}

function safeTarget(root: string, cwd: string, target: string, policy: DestructiveAutoApprovalPolicy): boolean {
  if (hasPatternMagic(target)) return false;
  const relative = relativeProjectPath(root, cwd, target);
  return relative !== null
    && relative.length > 0
    && (!policy.protectCriticalFiles || !isProtectedCriticalPath(relative));
}

function hasPatternMagic(value: string): boolean {
  return ['*', '?', '[', ']', '{', '}'].some((token) => value.includes(token)) || value.startsWith(':(');
}

function hasShortFlag(args: readonly string[], flag: string): boolean {
  return args.some((arg) => arg.startsWith('-') && !arg.startsWith('--') && arg.slice(1).includes(flag));
}

function hasRecursiveDeleteFlag(args: readonly string[]): boolean {
  return args.some((arg) => {
    const lower = arg.toLowerCase();
    return lower === '-r'
      || lower === '--recursive'
      || lower === '/s'
      || /^-[a-z]*r[a-z]*$/i.test(arg);
  });
}

function directDeleteTargets(args: readonly string[]): string[] {
  const targets: string[] = [];
  let afterSeparator = false;
  for (const arg of args) {
    if (arg === '--') {
      afterSeparator = true;
      continue;
    }
    if (!afterSeparator && arg.startsWith('-')) continue;
    if (arg.trim().length > 0) targets.push(arg);
  }
  return targets;
}

function gitPathspecs(args: readonly string[]): string[] {
  const separator = args.indexOf('--');
  const candidates = separator >= 0 ? args.slice(separator + 1) : args.filter((arg) => !arg.startsWith('-'));
  return candidates.filter((arg) => arg.trim().length > 0);
}

function hasGitScopeOverride(args: readonly string[]): boolean {
  return args.some((arg) => arg === '-C' || arg.startsWith('--git-dir') || arg.startsWith('--work-tree'));
}

function resolveCwd(root: string, value: unknown): string | null {
  if (value === undefined) return root;
  if (typeof value !== 'string') return null;
  const candidate = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
  return isWithin(root, candidate) ? candidate : null;
}

function relativeProjectPath(root: string, cwd: string, target: string): string | null {
  if (target.includes('\0')) return null;
  const candidate = path.isAbsolute(target) ? path.resolve(target) : path.resolve(cwd, target);
  if (!isWithin(root, candidate)) return null;
  return path.relative(root, candidate).replaceAll('\\', '/');
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}
