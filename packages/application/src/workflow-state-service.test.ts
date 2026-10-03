import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteDatabase, SqliteWorkflowRepository } from '@baitonghub-linux-mcp/storage';
import { permissionProfiles, type PermissionProfile } from '@baitonghub-linux-mcp/permissions';
import type { Workspace, WorkspaceRepository } from '@baitonghub-linux-mcp/workspace';
import type { WorkflowTaskContract } from '@baitonghub-linux-mcp/codex';
import * as workflowQa from './workflow-qa.js';
import { WorkflowStateService } from './workflow-state-service.js';

const roots: string[] = [];
const databases: SqliteDatabase[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const actor = { clientId: 'trusted-owner', clientName: 'display', sessionId: 'old-session' };
const contract = (taskId: string, dependencies: string[] = []): WorkflowTaskContract => ({ taskId, goal: 'Scoped fixture', workspaceId: 'ws', allowedFiles: ['new.ts'], dependencies, acceptanceCriteria: ['check'], acceptanceCommands: [{ executable: 'node', args: [], expectedExitCode: 0, timeoutSeconds: 10 }], contextReferences: [], workerRole: 'coding', plannerRequired: false, securitySensitive: false, stopConditions: ['Stop before external writes'] });
async function fixture(): Promise<{ open(): WorkflowStateService; setProfile(value: PermissionProfile): void; workspaceRoot: string }> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'durable-workflow-service-'))); roots.push(root);
  const workspaceRoot = path.join(root, 'workspace'); await mkdir(workspaceRoot); await writeFile(path.join(workspaceRoot, 'result.log'), 'passed');
  const ws: Workspace = { id: 'ws', displayName: 'fixture', rootPath: workspaceRoot, realRootPath: workspaceRoot, createdAt: new Date(0).toISOString() };
  const workspaces: WorkspaceRepository = { async get(id) { return id === ws.id ? ws : null; }, async list() { return [ws]; }, async insert() {}, async delete() {} };
  let profile: PermissionProfile = permissionProfiles.balanced;
  const filename = path.join(root, 'state.db');
  const open = (): WorkflowStateService => { const db = new SqliteDatabase(filename); databases.push(db); return new WorkflowStateService(workspaces, new SqliteWorkflowRepository(db), () => profile); };
  return { open, workspaceRoot, setProfile(value: PermissionProfile): void { profile = value; } };
}
function value(result: unknown): Record<string, unknown> {
  expect(result).toMatchObject({ ok: true });
  return (result as { value: Record<string, unknown> }).value;
}

async function review(service: WorkflowStateService, workflowId: string, taskId: string, claimToken: unknown, expectedRevision: number, concurrentAcknowledgement?: unknown): Promise<void> {
  const status = value(await service.execute(actor, { operation: 'status', workspaceId: 'ws', workflowId }));
  const lease = (status.leases as Array<{taskId: string; leaseId: string}>).find((entry) => entry.taskId === taskId)!;
  const qa = (status.qa as Array<{taskId: string; info: {sourceFingerprint: string; diffFingerprint: string}}>).find((entry) => entry.taskId === taskId)!.info;
  value(await service.execute(actor, { operation: 'review', workspaceId: 'ws', workflowId, taskId, claimToken, expectedRevision, leaseId: lease.leaseId, sourceFingerprint: qa.sourceFingerprint, diffFingerprint: qa.diffFingerprint, ...(concurrentAcknowledgement === undefined ? {} : {concurrentAcknowledgement}), review: { reviewerId: 'independent-qa', independentReview: true, verdict: 'passed', summary: 'Reviewed fixture', verificationBounds: 'Caller-reported test fixture', commands: [{commandIndex: 0, exitCode: 0, artifact: {path: 'result.log', sha256: createHash('sha256').update('passed').digest('hex'), bytes: 6}}], criteria: [{criterionIndex: 0, passed: true}] } }));
}

describe('WorkflowStateService real SQLite', () => {
  it('freezes allowed alias targets in default workspace mode while permitting atomic file replacement', async () => {
    const f = await fixture(); const service = f.open();
    await mkdir(path.join(f.workspaceRoot, 'A')); await mkdir(path.join(f.workspaceRoot, 'B'));
    await writeFile(path.join(f.workspaceRoot, 'A/file.ts'), 'old'); await writeFile(path.join(f.workspaceRoot, 'B/file.ts'), 'old');
    await symlink(path.join(f.workspaceRoot, 'A'), path.join(f.workspaceRoot, 'alias'), 'junction');
    const id = (value(await service.execute(actor, { operation: 'plan', workspaceId: 'ws', contracts: [{...contract('one'), allowedFiles: ['alias']}] })).workflow as {id: string}).id;
    const started = value(await service.execute(actor, {operation: 'start', workspaceId: 'ws', workflowId: id, taskId: 'one', expectedRevision: 0}));
    await writeFile(path.join(f.workspaceRoot, 'replacement.tmp'), 'new'); await rename(path.join(f.workspaceRoot, 'replacement.tmp'), path.join(f.workspaceRoot, 'A/file.ts'));
    const complete = {operation: 'complete', workspaceId: 'ws', workflowId: id, taskId: 'one', claimToken: started.claimToken};
    value(await service.execute(actor, {...complete, expectedRevision: 1, state: 'verifying'}));
    await rm(path.join(f.workspaceRoot, 'alias')); await symlink(path.join(f.workspaceRoot, 'B'), path.join(f.workspaceRoot, 'alias'), 'junction');
    await writeFile(path.join(f.workspaceRoot, 'B/file.ts'), 'expanded scope');
    expect(await service.execute(actor, {...complete, expectedRevision: 2, state: 'done'})).toMatchObject({ok: false});
  });

  it('rejects an identical-content root replacement during artifact verification', async () => {
    const f = await fixture(); const service = f.open();
    const id = (value(await service.execute(actor, {operation: 'plan', workspaceId: 'ws', contracts: [contract('one')]})).workflow as {id: string}).id;
    const started = value(await service.execute(actor, {operation: 'start', workspaceId: 'ws', workflowId: id, taskId: 'one', expectedRevision: 0}));
    const handed = value(await service.execute(actor, {operation: 'complete', workspaceId: 'ws', workflowId: id, taskId: 'one', claimToken: started.claimToken, expectedRevision: 1, state: 'verifying'}));
    const leaseId = (handed.leases as Array<{leaseId: string}>)[0]!.leaseId;
    const evidence = handed.sourceEvidence as {sourceFingerprint: string; diffFingerprint: string};
    const source = {sourceFingerprint: evidence.sourceFingerprint, diffFingerprint: evidence.diffFingerprint};
    const original = workflowQa.verifyWorkflowQaArtifacts;
    vi.spyOn(workflowQa, 'verifyWorkflowQaArtifacts').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      await rename(f.workspaceRoot, f.workspaceRoot + '-old'); await mkdir(f.workspaceRoot);
      await writeFile(path.join(f.workspaceRoot, 'result.log'), 'passed');
      return result;
    });
    expect(await service.execute(actor, {operation: 'review', workspaceId: 'ws', workflowId: id, taskId: 'one', claimToken: started.claimToken, expectedRevision: 2, leaseId, ...source, review: {reviewerId: 'qa', independentReview: true, verdict: 'passed', summary: 'review', verificationBounds: 'fixture', commands: [{commandIndex: 0, exitCode: 0, artifact: {path: 'result.log', sha256: createHash('sha256').update('passed').digest('hex'), bytes: 6}}], criteria: [{criterionIndex: 0, passed: true}]}})).toMatchObject({ok: false});
    expect(workflowQa.verifyWorkflowQaArtifacts).toHaveBeenCalledOnce();
  });

  it('rejects self-review and stale artifacts and releases dependencies only after accepted completion', async () => {
    const f = await fixture(); const service = f.open();
    const id = (value(await service.execute(actor, {operation: 'plan', workspaceId: 'ws', contracts: [contract('one'), contract('two', ['one'])]})).workflow as {id: string}).id;
    const started = value(await service.execute(actor, {operation: 'start', workspaceId: 'ws', workflowId: id, taskId: 'one', expectedRevision: 0, workerId: 'worker-a'}));
    const handed = value(await service.execute(actor, {operation: 'complete', workspaceId: 'ws', workflowId: id, taskId: 'one', claimToken: started.claimToken, expectedRevision: 1, state: 'verifying'}));
    const evidence = handed.sourceEvidence as {sourceFingerprint: string; diffFingerprint: string};
    const source = {sourceFingerprint: evidence.sourceFingerprint, diffFingerprint: evidence.diffFingerprint};
    const request = {operation: 'review', workspaceId: 'ws', workflowId: id, taskId: 'one', claimToken: started.claimToken, expectedRevision: 2, leaseId: (handed.leases as Array<{leaseId: string}>)[0]!.leaseId, ...source, review: {reviewerId: 'worker-a', independentReview: true, verdict: 'passed', summary: 'review', verificationBounds: 'fixture', commands: [{commandIndex: 0, exitCode: 0, artifact: {path: 'result.log', sha256: createHash('sha256').update('passed').digest('hex'), bytes: 6}}], criteria: [{criterionIndex: 0, passed: true}]}};
    expect(await service.execute(actor, request)).toMatchObject({ok: false});
    expect(await service.execute(actor, {...request, sourceFingerprint: '0'.repeat(64), review: {...request.review, reviewerId: 'qa'}})).toMatchObject({ok: false});
    value(await service.execute(actor, {...request, review: {...request.review, reviewerId: 'qa'}}));
    await writeFile(path.join(f.workspaceRoot, 'result.log'), 'failed');
    const done = {operation: 'complete', workspaceId: 'ws', workflowId: id, taskId: 'one', claimToken: started.claimToken, expectedRevision: 3, state: 'done'};
    expect(await service.execute(actor, done)).toMatchObject({ok: false});
    const status = value(await service.execute(actor, {operation: 'status', workspaceId: 'ws', workflowId: id}));
    expect(status.workflow).toMatchObject({tasks: [{state: 'verifying'}, {state: 'planned'}]});
    await writeFile(path.join(f.workspaceRoot, 'result.log'), 'passed');
    const completed = value(await service.execute(actor, done));
    expect(completed.workflow).toMatchObject({tasks: [{state: 'done'}, {state: 'ready'}]});
  });

  it('labels legacy completed tasks as unverified without manufacturing a receipt', async () => {
    const f = await fixture(); const service = f.open();
    const id = (value(await service.execute(actor, {operation: 'plan', workspaceId: 'ws', contracts: [contract('one')]})).workflow as {id: string}).id;
    databases.at(-1)!.connection.prepare("UPDATE durable_workflow_tasks SET state='done' WHERE workflow_id=? AND task_id='one'").run(id);
    const status = value(await service.execute(actor, {operation: 'result', workspaceId: 'ws', workflowId: id}));
    expect(status.qa).toMatchObject([{taskId: 'one', verificationState: 'legacy_unverified', info: {attempts: [], receipts: [], acceptedReceiptHash: null}}]);
  });

  it('requires digest-bound acknowledgement for concurrent reserved changes, including released history', async () => {
    const f = await fixture(); const service = f.open();
    const make = async (taskId: string, file: string): Promise<{ id: string; claimToken: unknown; baselineFingerprint: unknown }> => {
      const id = (value(await service.execute(actor, { operation: 'plan', workspaceId: 'ws', contracts: [{ ...contract(taskId), allowedFiles: [file] }] })).workflow as {id: string}).id;
      const started = value(await service.execute(actor, { operation: 'start', workspaceId: 'ws', workflowId: id, taskId, expectedRevision: 0, scopeMode: 'disjoint' }));
      return { id, claimToken: started.claimToken, baselineFingerprint: started.baselineFingerprint };
    };
    const first = await make('first', 'a.ts'); const second = await make('second', 'b.ts');
    await writeFile(path.join(f.workspaceRoot, 'a.ts'), 'a'); await writeFile(path.join(f.workspaceRoot, 'b.ts'), 'b');
    const finish = async (entry: typeof first, taskId: string): Promise<void> => {
      const request = { operation: 'complete', workspaceId: 'ws', workflowId: entry.id, taskId, claimToken: entry.claimToken, expectedRevision: 1, state: 'verifying' };
      const denied = await service.execute(actor, request);
      expect(denied.ok).toBe(false); if (denied.ok) return;
      const sourceFingerprint = denied.error.details?.sourceFingerprint;
      const concurrentAcknowledgement = { baselineFingerprint: entry.baselineFingerprint, sourceFingerprint, userConfirmed: true };
      expect(await service.execute(actor, { ...request, concurrentAcknowledgement: { ...concurrentAcknowledgement, sourceFingerprint: '0'.repeat(64) } })).toMatchObject({ ok: false });
      value(await service.execute(actor, { ...request, concurrentAcknowledgement }));
      await review(service, entry.id, taskId, entry.claimToken, 2, concurrentAcknowledgement);
      const done = value(await service.execute(actor, { ...request, expectedRevision: 3, state: 'done', concurrentAcknowledgement }));
      const lease = (done.leases as Array<{leaseId: string}>)[0]!;
      value(await service.execute(actor, { operation: 'reconcile', workspaceId: 'ws', workflowId: entry.id, taskId, expectedRevision: 4, leaseId: lease.leaseId, writerStopped: true, userConfirmed: true, summary: 'Caller reviewed concurrent changes; writers stopped' }));
    };
    await finish(first, 'first'); await finish(second, 'second');
  });

  it('quarantines cancelled scopes until confirmed owner reconciliation', async () => {
    const f = await fixture(); const service = f.open();
    const plan = async (taskId: string): Promise<string> => (value(await service.execute(actor, { operation: 'plan', workspaceId: 'ws', contracts: [contract(taskId)] })).workflow as { id: string }).id;
    const first = await plan('first'); const second = await plan('second');
    value(await service.execute(actor, { operation: 'start', workspaceId: 'ws', workflowId: first, taskId: 'first', expectedRevision: 0 }));
    expect(await service.execute(actor, { operation: 'start', workspaceId: 'ws', workflowId: second, taskId: 'second', expectedRevision: 0 })).toMatchObject({ ok: false });
    const cancelled = value(await service.execute(actor, { operation: 'cancel', workspaceId: 'ws', workflowId: first }));
    const lease = (cancelled.leases as Array<{leaseId: string}>)[0]!;
    expect(await service.execute(actor, { operation: 'start', workspaceId: 'ws', workflowId: second, taskId: 'second', expectedRevision: 0 })).toMatchObject({ ok: false });
    const reconcile = { operation: 'reconcile', workspaceId: 'ws', workflowId: first, taskId: 'first', expectedRevision: 2, leaseId: lease.leaseId, writerStopped: true, userConfirmed: true, summary: 'Caller inspected stopped writer effects' };
    expect(await service.execute(actor, { ...reconcile, writerStopped: false })).toMatchObject({ ok: false });
    value(await service.execute(actor, reconcile));
    value(await service.execute(actor, { operation: 'start', workspaceId: 'ws', workflowId: second, taskId: 'second', expectedRevision: 0 }));
  });

  it('binds handoff to exact source and rejects changes outside the contract', async () => {
    const f = await fixture(); const service = f.open();
    await writeFile(path.join(f.workspaceRoot, 'existing.ts'), 'dirty baseline');
    const id = (value(await service.execute(actor, { operation: 'plan', workspaceId: 'ws', contracts: [contract('one')] })).workflow as {id: string}).id;
    const started = value(await service.execute(actor, { operation: 'start', workspaceId: 'ws', workflowId: id, taskId: 'one', expectedRevision: 0 }));
    const complete = { operation: 'complete', workspaceId: 'ws', workflowId: id, taskId: 'one', claimToken: started.claimToken };
    await writeFile(path.join(f.workspaceRoot, 'new.ts'), 'first patch');
    value(await service.execute(actor, { ...complete, expectedRevision: 1, state: 'verifying' }));
    await writeFile(path.join(f.workspaceRoot, 'new.ts'), 'changed after review');
    expect(await service.execute(actor, { ...complete, expectedRevision: 2, state: 'done' })).toMatchObject({ ok: false });
    await writeFile(path.join(f.workspaceRoot, 'new.ts'), 'first patch');
    await writeFile(path.join(f.workspaceRoot, 'existing.ts'), 'outside change');
    expect(await service.execute(actor, { ...complete, expectedRevision: 2, state: 'done' })).toMatchObject({ ok: false });
    await writeFile(path.join(f.workspaceRoot, 'existing.ts'), 'dirty baseline');
    expect(await service.execute(actor, { ...complete, expectedRevision: 2, state: 'done' })).toMatchObject({ok: false});
    await review(service, id, 'one', started.claimToken, 2);
    value(await service.execute(actor, { ...complete, expectedRevision: 3, state: 'done' }));
  });

  it('recovers an active claim after reopen/new session without redispatch or granting a new claim', async () => {
    const f = await fixture(); let service = f.open();
    const planned = value(await service.execute(actor, { operation: 'plan', workspaceId: 'ws', contracts: [contract('first'), contract('second', ['first'])] }));
    const id = (planned.workflow as { id: string }).id;
    const started = value(await service.execute(actor, { operation: 'start', workspaceId: 'ws', workflowId: id, taskId: 'first', expectedRevision: 0 }));
    expect(started.executionStarted).toBe(false);
    expect(await service.execute(actor, { operation: 'checkpoint', workspaceId: 'ws', workflowId: id, taskId: 'first', expectedRevision: 1, claimToken: started.claimToken, checkpoint: { summary: 'Partial work', references: ['artifact://fixture'], executionUncertain: true } })).toMatchObject({ ok: true });
    const old = databases.pop(); old?.close(); service = f.open();
    const resumed = value(await service.execute({ ...actor, sessionId: 'new-session' }, { operation: 'resume', workspaceId: 'ws', workflowId: id }));
    expect(resumed).toMatchObject({ executionStarted: false, resumeDispatches: false, interruptedExecution: true });
    expect(resumed).not.toHaveProperty('claimToken');
    expect(resumed.workflow).not.toHaveProperty('ownerKey');
    expect(await service.execute(actor, { operation: 'start', workspaceId: 'ws', workflowId: id, taskId: 'first', expectedRevision: 2 })).toMatchObject({ ok: false });
    expect(await service.execute(actor, { operation: 'start', workspaceId: 'ws', workflowId: id, taskId: 'second', expectedRevision: 0 })).toMatchObject({ ok: false });
    expect(await service.execute(actor, { operation: 'complete', workspaceId: 'ws', workflowId: id, taskId: 'first', expectedRevision: 2, claimToken: started.claimToken, state: 'done' })).toMatchObject({ ok: false });
    expect(await service.execute(actor, { operation: 'complete', workspaceId: 'ws', workflowId: id, taskId: 'first', expectedRevision: 2, claimToken: started.claimToken, state: 'verifying' })).toMatchObject({ ok: true });
    await review(service, id, 'first', started.claimToken, 3);
    expect(await service.execute(actor, { operation: 'complete', workspaceId: 'ws', workflowId: id, taskId: 'first', expectedRevision: 4, claimToken: started.claimToken, state: 'done' })).toMatchObject({ ok: true });
    const status = value(await service.execute(actor, { operation: 'result', workspaceId: 'ws', workflowId: id }));
    expect(status).toMatchObject({ evidenceVerification: 'caller_supplied_not_verified', workflow: { tasks: [{ state: 'done' }, { state: 'ready' }] } });
  });

  it('denies changed owners, revoked policy, aborts and forged authority fields', async () => {
    const f = await fixture(); const service = f.open();
    const planned = value(await service.execute(actor, { operation: 'plan', workspaceId: 'ws', contracts: [contract('one')] }));
    const id = (planned.workflow as { id: string }).id;
    const status = { operation: 'status', workspaceId: 'ws', workflowId: id };
    expect(await service.execute({ ...actor, clientId: 'other' }, status)).toMatchObject({ ok: false });
    expect(await service.execute(actor, { ...status, ownerKey: actor.clientId })).toMatchObject({ ok: false });
    f.setProfile({ ...permissionProfiles.custom, defaults: { READ: 'DENY', WRITE: 'ALLOW', EXECUTE: 'ALLOW', DANGEROUS: 'DENY' } });
    expect(await f.open().execute(actor, { ...status, operation: 'resume' })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    f.setProfile(permissionProfiles.safe);
    expect(await service.execute(actor, { ...status, operation: 'cancel' })).toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    f.setProfile(permissionProfiles.balanced);
    const abort = new AbortController(); abort.abort();
    expect(await service.execute(actor, { ...status, operation: 'cancel' }, abort.signal)).toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    expect(await service.execute(actor, { ...status, operation: 'start', taskId: 'one', expectedRevision: 0 })).toMatchObject({ ok: true });
  });

  it('rejects escaping stored scope and bounds event pagination', async () => {
    const f = await fixture(); const service = f.open();
    expect(await service.execute(actor, { operation: 'plan', workspaceId: 'ws', contracts: [{ ...contract('escape'), allowedFiles: ['../outside.ts'] }] })).toMatchObject({ ok: false });
    const planned = value(await service.execute(actor, { operation: 'plan', workspaceId: 'ws', contracts: [contract('one')] }));
    const id = (planned.workflow as { id: string }).id;
    value(await service.execute(actor, { operation: 'start', workspaceId: 'ws', workflowId: id, taskId: 'one', expectedRevision: 0 }));
    const events = value(await service.execute(actor, { operation: 'events', workspaceId: 'ws', workflowId: id, limit: 1 }));
    expect(events).toMatchObject({ truncated: true });
    expect(events.events).toHaveLength(1);
    expect(await service.execute(actor, { operation: 'events', workspaceId: 'ws', workflowId: id, limit: 100 })).toMatchObject({ ok: false });
  });
});
