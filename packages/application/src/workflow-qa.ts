import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { WorkflowTaskContract } from '@baitonghub-linux-mcp/codex';
import { WorkspacePathGuard, type Workspace } from '@baitonghub-linux-mcp/workspace';

export interface WorkflowQaSubmission {
  readonly reviewerId: string;
  readonly independentReview: true;
  readonly verdict: 'passed' | 'failed' | 'blocked';
  readonly summary: string;
  readonly verificationBounds: string;
  readonly commands: readonly { readonly commandIndex: number; readonly exitCode: number; readonly artifact: { readonly path: string; readonly sha256: string; readonly bytes: number } }[];
  readonly criteria: readonly { readonly criterionIndex: number; readonly passed: boolean }[];
}

/** Submission is untrusted. Command outcomes and reviewer identity are attestations. */
export function parseWorkflowQaSubmission(value: unknown, contract: WorkflowTaskContract): WorkflowQaSubmission | null {
  if (!record(value) || !keys(value, ['reviewerId', 'independentReview', 'verdict', 'summary', 'verificationBounds', 'commands', 'criteria']) || !text(value.reviewerId, 128) || value.independentReview !== true || !['passed', 'failed', 'blocked'].includes(String(value.verdict)) || !text(value.summary, 2048) || !text(value.verificationBounds, 2048) || !Array.isArray(value.commands) || value.commands.length > 16 || !Array.isArray(value.criteria) || value.criteria.length > 32) return null;
  const commands = new Set<number>();
  for (const command of value.commands) {
    if (!record(command) || !keys(command, ['commandIndex', 'exitCode', 'artifact']) || !index(command.commandIndex, contract.acceptanceCommands.length) || commands.has(command.commandIndex) || !Number.isInteger(command.exitCode) || Number(command.exitCode) < -2147483648 || Number(command.exitCode) > 2147483647 || !record(command.artifact) || !keys(command.artifact, ['path', 'sha256', 'bytes']) || !validArtifactPath(command.artifact.path) || (typeof command.artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(command.artifact.sha256)) || !Number.isSafeInteger(command.artifact.bytes) || Number(command.artifact.bytes) < 0 || Number(command.artifact.bytes) > 2 * 1024 * 1024) return null;
    if (value.verdict === 'passed' && command.exitCode !== contract.acceptanceCommands[command.commandIndex]?.expectedExitCode) return null;
    commands.add(command.commandIndex);
  }
  const criteria = new Set<number>();
  for (const criterion of value.criteria) {
    if (!record(criterion) || !keys(criterion, ['criterionIndex', 'passed']) || !index(criterion.criterionIndex, contract.acceptanceCriteria.length) || criteria.has(criterion.criterionIndex) || typeof criterion.passed !== 'boolean' || (value.verdict === 'passed' && !criterion.passed)) return null;
    criteria.add(criterion.criterionIndex);
  }
  if (value.verdict === 'passed' && (commands.size !== contract.acceptanceCommands.length || criteria.size !== contract.acceptanceCriteria.length)) return null;
  if (Buffer.byteLength(JSON.stringify(value)) > 16 * 1024) return null;
  return value as unknown as WorkflowQaSubmission;
}

/** Hash only stable regular files under the registered root; never execute receipt commands. */
export async function verifyWorkflowQaArtifacts(workspace: Workspace, submission: WorkflowQaSubmission, signal?: AbortSignal): Promise<boolean> {
  try {
    const root = await realpath(workspace.realRootPath);
    if (path.resolve(root) !== path.resolve(workspace.realRootPath)) return false;
    let total = 0;
    for (const command of submission.commands) {
      if (signal?.aborted) return false;
      const artifact = command.artifact;
      total += artifact.bytes;
      if (total > 8 * 1024 * 1024 || !validArtifactPath(artifact.path)) return false;
      const checked = await new WorkspacePathGuard().resolveForRead(workspace, artifact.path);
      if (!checked.ok) return false;
      const target = path.resolve(root, artifact.path);
      const components = path.relative(root, target).split(path.sep);
      let current = root;
      for (const component of components) {
        current = path.join(current, component);
        if ((await lstat(current)).isSymbolicLink()) return false;
      }
      const before = await lstat(target);
      if (!before.isFile() || before.nlink !== 1 || before.size !== artifact.bytes || before.size > 2 * 1024 * 1024 || await realpath(target) !== target) return false;
      const file = await open(target, constants.O_RDONLY | (process.platform === 'linux' ? constants.O_NOFOLLOW | constants.O_NONBLOCK : 0));
      try {
        const initial = await file.stat();
        if (!sameFile(before, initial)) return false;
        const hash = createHash('sha256');
        const buffer = Buffer.alloc(64 * 1024);
        let bytes = 0;
        while (true) {
          if (signal?.aborted) return false;
          const read = await file.read(buffer, 0, buffer.length, bytes);
          if (read.bytesRead === 0) break;
          bytes += read.bytesRead;
          if (bytes > artifact.bytes) return false;
          hash.update(buffer.subarray(0, read.bytesRead));
        }
        if (bytes !== artifact.bytes || hash.digest('hex') !== artifact.sha256 || !sameFile(initial, await file.stat()) || !sameFile(initial, await lstat(target)) || await realpath(target) !== target) return false;
      } finally { await file.close(); }
    }
    return !signal?.aborted;
  } catch { return false; }
}

function sameFile(a: import('node:fs').Stats, b: import('node:fs').Stats): boolean { return b.isFile() && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs; }
function validArtifactPath(value: unknown): value is string { return text(value, 4096) && !path.isAbsolute(value) && !value.includes('\\') && !value.includes(':') && !value.split('/').some((part) => part === '' || part === '.' || part === '..' || part.toLowerCase() === '.git'); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }
function text(value: unknown, max: number): value is string { return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max && ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127); }
function index(value: unknown, size: number): value is number { return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < size; }
