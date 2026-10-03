import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkflowTaskContract } from '@baitonghub-linux-mcp/codex';
import type { Workspace } from '@baitonghub-linux-mcp/workspace';
import { parseWorkflowQaSubmission, verifyWorkflowQaArtifacts, type WorkflowQaSubmission } from './workflow-qa.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const contract: WorkflowTaskContract = { taskId: 'one', goal: 'check', workspaceId: 'ws', allowedFiles: ['code.ts'], dependencies: [], acceptanceCriteria: ['works'], acceptanceCommands: [{ executable: 'node', args: ['test'], expectedExitCode: 0, timeoutSeconds: 10 }], contextReferences: [], workerRole: 'coding', plannerRequired: false, securitySensitive: false, stopConditions: ['stop'] };
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
function submission(): WorkflowQaSubmission { return { reviewerId: 'qa-1', independentReview: true, verdict: 'passed', summary: 'reviewed', verificationBounds: 'caller-reported execution', commands: [{ commandIndex: 0, exitCode: 0, artifact: { path: 'result.log', sha256: digest('passed'), bytes: 6 } }], criteria: [{ criterionIndex: 0, passed: true }] }; }
async function workspace(): Promise<Workspace> { const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'workflow-qa-'))); roots.push(root); return { id: 'ws', rootPath: root, realRootPath: root, displayName: 'fixture', createdAt: new Date(0).toISOString() }; }

describe('QA evidence boundaries', () => {
  it('requires every exact command and criterion for pass, rejecting duplicates and mismatched outcomes', () => {
    expect(parseWorkflowQaSubmission(submission(), contract)).not.toBeNull();
    expect(parseWorkflowQaSubmission({ ...submission(), commands: [] }, contract)).toBeNull();
    expect(parseWorkflowQaSubmission({ ...submission(), commands: [...submission().commands, ...submission().commands] }, contract)).toBeNull();
    expect(parseWorkflowQaSubmission({ ...submission(), commands: [{ ...submission().commands[0], exitCode: 1 }] }, contract)).toBeNull();
    expect(parseWorkflowQaSubmission({ ...submission(), criteria: [{ criterionIndex: 0, passed: false }] }, contract)).toBeNull();
    expect(parseWorkflowQaSubmission({ ...submission(), independentReview: false }, contract)).toBeNull();
    expect(parseWorkflowQaSubmission({ ...submission(), extra: true }, contract)).toBeNull();
  });
  it('allows bounded incomplete failed/blocked review without inventing successful evidence', () => {
    expect(parseWorkflowQaSubmission({ ...submission(), verdict: 'blocked', commands: [], criteria: [] }, contract)).not.toBeNull();
    expect(parseWorkflowQaSubmission({ ...submission(), verdict: 'failed', commands: [{ ...submission().commands[0], exitCode: 1 }] }, contract)).not.toBeNull();
  });
  it('verifies artifact bytes and invalidates changed, missing, oversized or escaped files', async () => {
    const ws = await workspace();
    await writeFile(path.join(ws.realRootPath, 'result.log'), 'passed');
    expect(await verifyWorkflowQaArtifacts(ws, submission())).toBe(true);
    await writeFile(path.join(ws.realRootPath, 'result.log'), 'failed');
    expect(await verifyWorkflowQaArtifacts(ws, submission())).toBe(false);
    expect(await verifyWorkflowQaArtifacts(ws, { ...submission(), commands: [{ commandIndex: 0, exitCode: 0, artifact: { path: '../result.log', sha256: digest('passed'), bytes: 6 } }] })).toBe(false);
    expect(await verifyWorkflowQaArtifacts(ws, { ...submission(), commands: [{ commandIndex: 0, exitCode: 0, artifact: { path: 'missing.log', sha256: digest('passed'), bytes: 6 } }] })).toBe(false);
    expect(await verifyWorkflowQaArtifacts(ws, submission(), AbortSignal.abort())).toBe(false);
  });
  it('rejects hardlinked artifacts and oversized submissions', async () => {
    const ws = await workspace(); await writeFile(path.join(ws.realRootPath, 'result.log'), 'passed');
    await link(path.join(ws.realRootPath, 'result.log'), path.join(ws.realRootPath, 'another.log'));
    expect(await verifyWorkflowQaArtifacts(ws, submission())).toBe(false);
    expect(parseWorkflowQaSubmission({...submission(), commands: [{commandIndex: 0, exitCode: 0, artifact: {path: 'result.log', sha256: digest('passed'), bytes: 2 * 1024 * 1024 + 1}}]}, contract)).toBeNull();
    for (const unsafe of ['./result.log', 'dir/../result.log', 'C:/result.log', '.GIT/result.log']) expect(parseWorkflowQaSubmission({...submission(), commands: [{commandIndex: 0, exitCode: 0, artifact: {path: unsafe, sha256: digest('passed'), bytes: 6}}]}, contract)).toBeNull();
  });
  it('rejects symlink artifacts even when contents match', async () => {
    const ws = await workspace(); await mkdir(path.join(ws.realRootPath, 'logs'));
    await writeFile(path.join(ws.realRootPath, 'logs/result.log'), 'passed');
    await symlink(path.join(ws.realRootPath, 'logs'), path.join(ws.realRootPath, 'alias'), 'junction');
    const receipt = { ...submission(), commands: [{ commandIndex: 0, exitCode: 0, artifact: { path: 'alias/result.log', sha256: digest('passed'), bytes: 6 } }] };
    expect(await verifyWorkflowQaArtifacts(ws, receipt)).toBe(false);
  });
});
