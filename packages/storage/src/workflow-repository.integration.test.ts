import { mkdtemp, rm } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DurableWorkflow } from '@baitonghub-linux-mcp/domain';
import { SqliteDatabase } from './database.js';
import { SqliteWorkflowRepository } from './workflow-repository.js';

const roots: string[] = [];
const databases: SqliteDatabase[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) { try { db.close(); } catch { /* A test may already have closed it. */ } }
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});
async function setup(): Promise<{ file: string; db: SqliteDatabase; repo: SqliteWorkflowRepository }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-state-')); roots.push(root);
  const file = path.join(root, 'state.sqlite');
  const db = new SqliteDatabase(file); databases.push(db); const repo = new SqliteWorkflowRepository(db);
  return { file, db, repo };
}
function workflow(id = 'wf-1'): DurableWorkflow {
  return { id, ownerKey: 'actor-a', workspaceId: 'workspace-a', createdAt: '2026-10-03T00:00:00.000Z', tasks: [
    { taskId: 'first', contractJson: '{"taskId":"first","workspaceId":"workspace-a","dependencies":[],"acceptanceCommands":[{"executable":"node","args":["--version"],"expectedExitCode":0,"timeoutSeconds":10}],"acceptanceCriteria":["valid"]}', dependencies: [], state: 'ready', revision: 0, checkpoint: null },
    { taskId: 'second', contractJson: '{"taskId":"second","workspaceId":"workspace-a","dependencies":["first"],"acceptanceCommands":[{"executable":"node","args":["--version"],"expectedExitCode":0,"timeoutSeconds":10}],"acceptanceCriteria":["valid"]}', dependencies: ['first'], state: 'planned', revision: 0, checkpoint: null },
  ] };
}
const token = 'opaque-claim-token-0123456789abcdef';
const tokenB = 'b'.repeat(64);
const fingerprint = 'f'.repeat(64);
function reservation(now: string, base = '/tmp/workflow'): import('@baitonghub-linux-mcp/domain').WorkflowReservation {
  return { mode: 'workspace', scopes: [{ path: base, inode: null }], workspaceFingerprint: 'a'.repeat(64), baselineJson: '{"fingerprint":"' + 'b'.repeat(64) + '","files":[]}', expiresAt: new Date(Date.parse(now) + 600_000).toISOString() };
}
function verification(now: string, sourceFingerprint = fingerprint): import('@baitonghub-linux-mcp/domain').WorkflowVerification {
  return { sourceFingerprint, diffFingerprint: 'd'.repeat(64), expiresAt: new Date(Date.parse(now) + 600_000).toISOString() };
}
function qaReceipt(contractJson: string): import('@baitonghub-linux-mcp/domain').WorkflowQAReceiptInput {
  return { workerId: 'caller-unspecified', reviewerId: 'independent-reviewer', independentReview: true, verdict: 'passed', summary: 'review passed', verificationBounds: 'local bounded check', contractSha256: createHash('sha256').update(contractJson).digest('hex'), baselineFingerprint: 'b'.repeat(64), sourceFingerprint: fingerprint, diffFingerprint: 'd'.repeat(64), verificationRevision: 2, commands: [{commandIndex:0,exitCode:0,artifact:{path:'artifacts/check.txt',sha256:'c'.repeat(64),bytes:12}}], criteria: [{criterionIndex:0,passed:true}] };
}
function approve(repo: SqliteWorkflowRepository, owner: string, workflowId: string, taskId: string, now: string): string {
  const task = repo.get(owner, workflowId)!.tasks.find((item)=>item.taskId===taskId)!;
  const lease = repo.getLease(owner, workflowId, taskId)!;
  const receipt = repo.review(owner, workflowId, taskId, task.revision, token, lease.id, qaReceipt(task.contractJson), now);
  expect(receipt).not.toBeNull();
  expect(repo.qaInfo(owner,workflowId,taskId)?.acceptedReceiptHash).toBe(receipt!.canonicalHash);
  return receipt!.canonicalHash;
}

describe('SqliteWorkflowRepository', () => {
  it('preserves historic receipts across reverification but requires the fresh review to complete', async () => {
    const {repo, db, file} = await setup(); repo.create(workflow());
    const started = '2026-10-03T00:01:00.000Z';
    expect(repo.claim('actor-a','wf-1','first',0,token,started,reservation(started))).toBe(true);
    expect(repo.update('actor-a','wf-1','first',1,token,'verifying',null,'2026-10-03T00:02:00.000Z',verification('2026-10-03T00:02:00.000Z'))).toBe(true);
    const oldHash = approve(repo,'actor-a','wf-1','first','2026-10-03T00:02:30.000Z');
    const freshSource = 'e'.repeat(64);
    expect(repo.update('actor-a','wf-1','first',3,token,'verifying',null,'2026-10-03T00:03:00.000Z',verification('2026-10-03T00:03:00.000Z',freshSource))).toBe(true);
    db.close(); const reopened = new SqliteDatabase(file); databases.push(reopened); const next = new SqliteWorkflowRepository(reopened);
    const info = next.qaInfo('actor-a','wf-1','first');
    expect(info).not.toBeNull(); expect(info!.receipts).toHaveLength(1); expect(info!.acceptedReceiptHash).toBeNull();
    const task = next.get('actor-a','wf-1')!.tasks[0]!; const lease = next.getLease('actor-a','wf-1','first')!;
    const freshReceipt = next.review('actor-a','wf-1','first',4,token,lease.id,{...qaReceipt(task.contractJson),sourceFingerprint:freshSource,verificationRevision:4},'2026-10-03T00:03:30.000Z');
    expect(freshReceipt).not.toBeNull(); expect(freshReceipt!.reviewRevision).toBe(5);
    expect(next.qaInfo('actor-a','wf-1','first')!.receipts.map((receipt)=>receipt.canonicalHash)).toEqual([oldHash,freshReceipt!.canonicalHash]);
    expect(next.update('actor-a','wf-1','first',5,token,'done',null,'2026-10-03T00:04:00.000Z',{...verification('2026-10-03T00:04:00.000Z',freshSource),acceptedReceiptHash:oldHash})).toBe(false);
    expect(next.update('actor-a','wf-1','first',5,token,'done',null,'2026-10-03T00:04:00.000Z',{...verification('2026-10-03T00:04:00.000Z',freshSource),acceptedReceiptHash:freshReceipt!.canonicalHash})).toBe(true);
    expect(next.reconcile('actor-a','wf-1','first',lease.id,6,'2026-10-03T00:05:00.000Z')).toBe(true);
    reopened.close(); const terminalDb=new SqliteDatabase(file); databases.push(terminalDb); const terminal=new SqliteWorkflowRepository(terminalDb);
    expect(terminal.get('actor-a','wf-1')!.tasks[0]!.state).toBe('done');
    expect(terminal.getLease('actor-a','wf-1','first')!.state).toBe('released');
    expect(terminal.qaInfo('actor-a','wf-1','first')!.acceptedReceiptHash).toBe(freshReceipt!.canonicalHash);
    expect(terminal.qaInfo('actor-a','wf-1','first')!.receipts.map((receipt)=>receipt.canonicalHash)).toEqual([oldHash,freshReceipt!.canonicalHash]);
  });
  it('rejects an accepted receipt after stored task revision drift', async () => {
    const {repo, db} = await setup(); repo.create(workflow()); const started='2026-10-03T00:01:00.000Z';
    expect(repo.claim('actor-a','wf-1','first',0,token,started,reservation(started))).toBe(true);
    expect(repo.update('actor-a','wf-1','first',1,token,'verifying',null,'2026-10-03T00:02:00.000Z',verification('2026-10-03T00:02:00.000Z'))).toBe(true);
    const hash = approve(repo,'actor-a','wf-1','first','2026-10-03T00:02:30.000Z');
    db.connection.prepare("UPDATE durable_workflow_tasks SET revision=13 WHERE workflow_id='wf-1' AND task_id='first'").run();
    expect(repo.qaInfo('actor-a','wf-1','first')!.acceptedReceiptHash).toBeNull();
    expect(repo.update('actor-a','wf-1','first',13,token,'done',null,'2026-10-03T00:03:00.000Z',{...verification('2026-10-03T00:03:00.000Z'),acceptedReceiptHash:hash})).toBe(false);
    expect(repo.get('actor-a','wf-1')!.tasks[0]!.state).toBe('verifying');
  });

  it('rejects scope-table disagreement before overlapping admission or concurrent acknowledgement', async () => {
    const {db, repo} = await setup(); const now = new Date().toISOString();
    repo.create(workflow()); repo.create({...workflow('other'), ownerKey: 'actor-b'});
    expect(repo.claim('actor-a', 'wf-1', 'first', 0, token, now, reservation(now, '/workspace/source'))).toBe(true);
    const lease = repo.getLease('actor-a', 'wf-1', 'first'); expect(lease).not.toBeNull();
    db.connection.prepare('UPDATE durable_workflow_lease_scopes SET scope_path=? WHERE lease_id=?').run('/elsewhere', lease!.id);
    expect(repo.getLease('actor-a', 'wf-1', 'first')).toBeNull();
    expect(repo.claim('actor-b', 'other', 'first', 0, tokenB, now, reservation(now, '/workspace/source'))).toBe(false);
    expect(repo.update('actor-a', 'wf-1', 'first', 1, token, 'verifying', null, now, verification(now))).toBe(false);
    db.connection.prepare('UPDATE durable_workflow_lease_scopes SET scope_path=? WHERE lease_id=?').run('/workspace/source', lease!.id);
    expect(repo.claim('actor-b', 'other', 'first', 0, tokenB, now, reservation(now, '/workspace/second'))).toBe(true);
    db.connection.prepare('UPDATE durable_workflow_lease_scopes SET scope_path=? WHERE lease_id=?').run('/elsewhere', lease!.id);
    expect(repo.concurrentScopes('actor-b', 'other', 'first')).toBeNull();
  });

  it('recovers state across reopen, fences stale claims, promotes dependencies, and orders events', async () => {
    const { file, db, repo } = await setup(); repo.create(workflow());
    expect(repo.get('actor-a', 'wf-1')?.tasks.map((t) => t.state)).toEqual(['ready', 'planned']);
    const secondDb = new SqliteDatabase(file); databases.push(secondDb); const second = new SqliteWorkflowRepository(secondDb);
    expect(repo.claim('actor-a', 'wf-1', 'first', 0, token, '2026-10-03T00:01:00.000Z', reservation('2026-10-03T00:01:00.000Z'))).toBe(true);
    expect(second.claim('actor-a', 'wf-1', 'first', 0, 'another-token-0123456789abcdef', '2026-10-03T00:01:01.000Z', reservation('2026-10-03T00:01:01.000Z'))).toBe(false);
    const cp = { summary: 'checkpoint', references: ['docs/result.md'], executionUncertain: true };
    expect(second.update('actor-a', 'wf-1', 'first', 1, token, 'verifying', cp, '2026-10-03T00:02:00.000Z', verification('2026-10-03T00:02:00.000Z'))).toBe(true);
    expect(second.update('actor-a', 'wf-1', 'first', 1, token, 'done', cp, '2026-10-03T00:02:01.000Z')).toBe(false);
    const receiptHash = approve(second, 'actor-a', 'wf-1', 'first', '2026-10-03T00:02:30.000Z');
    expect(second.update('actor-a', 'wf-1', 'first', 3, token, 'done', cp, '2026-10-03T00:03:00.000Z', {...verification('2026-10-03T00:03:00.000Z'),acceptedReceiptHash:receiptHash})).toBe(true);
    expect(repo.get('actor-a', 'wf-1')?.tasks.map((t) => t.state)).toEqual(['done', 'ready']);
    db.close(); secondDb.close();
    const reopened = new SqliteDatabase(file); databases.push(reopened); const recovered = new SqliteWorkflowRepository(reopened);
    expect(recovered.get('actor-a', 'wf-1')?.tasks[0]?.checkpoint).toEqual(cp);
    const eventRows = recovered.events('actor-a', 'wf-1', 0, 100);
    expect(eventRows.map((e) => e.sequence)).toEqual([1,2,3,4,5,6,7,8]);
    expect(eventRows.at(-1)?.taskId).toBe('second');
    expect(recovered.get('other-owner', 'wf-1')).toBeNull();
    reopened.connection.prepare("UPDATE durable_workflow_events SET type='corrupt' WHERE workflow_id='wf-1' AND sequence=1").run();
    expect(recovered.get('actor-a', 'wf-1')).toBeNull();
    expect(recovered.events('actor-a', 'wf-1', 0, 100)).toEqual([]);
    reopened.close();
  });

  it('rejects cycles and quotas, and rolls back a failed event write atomically', async () => {
    const { db, repo } = await setup();
    expect(() => repo.create({ ...workflow(), tasks: [
      { taskId: 'a', contractJson: '{"taskId":"a","workspaceId":"workspace-a","dependencies":["b"]}', dependencies: ['b'], state: 'planned', revision: 0, checkpoint: null },
      { taskId: 'b', contractJson: '{"taskId":"b","workspaceId":"workspace-a","dependencies":["a"]}', dependencies: ['a'], state: 'planned', revision: 0, checkpoint: null },
    ] })).toThrow();
    repo.create(workflow());
    db.connection.exec("CREATE TRIGGER fail_workflow_event BEFORE INSERT ON durable_workflow_events WHEN NEW.type='running' BEGIN SELECT RAISE(ABORT, 'injected failure'); END;");
    expect(() => repo.claim('actor-a', 'wf-1', 'first', 0, token, '2026-10-03T00:01:00.000Z', reservation('2026-10-03T00:01:00.000Z'))).toThrow();
    expect(repo.get('actor-a', 'wf-1')?.tasks[0]?.state).toBe('ready');
    expect(repo.getLease('actor-a', 'wf-1', 'first')).toBeNull();
    db.connection.exec('DROP TRIGGER fail_workflow_event');
    for (let i = 1; i < 32; i++) repo.create(workflow(`wf-${i + 1}`));
    expect(() => repo.create(workflow('wf-33'))).toThrow(/quota/i);
    db.close();
  });

  it('cancels nonterminal work and leaves completed tasks done', async () => {
    const { db, repo } = await setup(); repo.create(workflow());
    expect(repo.claim('actor-a', 'wf-1', 'first', 0, token, '2026-10-03T00:01:00.000Z', reservation('2026-10-03T00:01:00.000Z'))).toBe(true);
    expect(repo.update('actor-a', 'wf-1', 'first', 1, token, 'verifying', null, '2026-10-03T00:02:00.000Z', verification('2026-10-03T00:02:00.000Z'))).toBe(true);
    const receiptHash = approve(repo, 'actor-a', 'wf-1', 'first', '2026-10-03T00:02:30.000Z');
    expect(repo.update('actor-a', 'wf-1', 'first', 3, token, 'done', null, '2026-10-03T00:03:00.000Z', {...verification('2026-10-03T00:03:00.000Z'),acceptedReceiptHash:receiptHash})).toBe(true);
    expect(repo.cancel('actor-a', 'wf-1', '2026-10-03T00:04:00.000Z')).toBe(true);
    expect(repo.get('actor-a', 'wf-1')?.tasks.map((t) => t.state)).toEqual(['done', 'cancelled']);
    expect(repo.claim('actor-a', 'wf-1', 'second', 1, 'another-token-0123456789abcdef', '2026-10-03T00:05:00.000Z', reservation('2026-10-03T00:05:00.000Z'))).toBe(false);
    db.connection.prepare("UPDATE durable_workflow_tasks SET contract_json='{}' WHERE workflow_id='wf-1' AND task_id='first'").run();
    expect(repo.get('actor-a', 'wf-1')).toBeNull();
    db.close();
  });

  it('rejects corrupted bounded state before exposing events or accepting a mutation', async () => {
    const { db, repo } = await setup(); repo.create(workflow());
    db.connection.prepare('UPDATE durable_workflow_events SET type=? WHERE workflow_id=? AND sequence=1').run('x'.repeat(64 * 1024), 'wf-1');
    expect(repo.get('actor-a', 'wf-1')).toBeNull();
    expect(repo.events('actor-a', 'wf-1', 0, 32)).toEqual([]);
    expect(repo.claim('actor-a', 'wf-1', 'first', 0, token, '2026-10-03T00:01:00.000Z')).toBe(false);
    db.connection.prepare("UPDATE durable_workflow_events SET type='created' WHERE workflow_id='wf-1' AND sequence=1").run();
    expect(repo.get('actor-a', 'wf-1')).not.toBeNull();
    db.connection.prepare('UPDATE durable_workflow_tasks SET contract_json=? WHERE workflow_id=? AND task_id=?').run('x'.repeat(64 * 1024), 'wf-1', 'first');
    expect(repo.get('actor-a', 'wf-1')).toBeNull();
    expect(repo.cancel('actor-a', 'wf-1', '2026-10-03T00:02:00.000Z')).toBe(false);
  });

  it('fences overlapping scopes across workflows and owners while allowing disjoint scopes', async () => {
    const { repo, db } = await setup();
    repo.create(workflow()); repo.create({ ...workflow('wf-other'), ownerKey: 'actor-b' });
    const now = new Date().toISOString();
    expect(repo.claim('actor-a', 'wf-1', 'first', 0, token, now, reservation(now, '/workspace/tree'))).toBe(true);
    expect(repo.claim('actor-b', 'wf-other', 'first', 0, tokenB, now, reservation(now, '/workspace/tree/child'))).toBe(false);
    expect(repo.claim('actor-b', 'wf-other', 'first', 0, tokenB, now, reservation(now, '/workspace/tree-sibling'))).toBe(true);
    expect(repo.concurrentScopes('actor-a', 'wf-1', 'first')).toContainEqual({ path: '/workspace/tree-sibling', inode: null });
    db.close();
  });

  it('quarantines expired and cancelled leases until reconciliation', async () => {
    const { repo, db } = await setup(); repo.create(workflow()); repo.create(workflow('wf-2'));
    const start = '2026-10-03T00:01:00.000Z';
    expect(repo.claim('actor-a', 'wf-1', 'first', 0, token, start, reservation(start, '/workspace/locked'))).toBe(true);
    const expired = '2026-10-03T00:11:01.000Z';
    expect(repo.update('actor-a', 'wf-1', 'first', 1, token, 'running', null, expired)).toBe(false);
    expect(repo.claim('actor-a', 'wf-2', 'first', 0, tokenB, expired, reservation(expired, '/workspace/locked'))).toBe(false);
    expect(repo.cancel('actor-a', 'wf-1', expired)).toBe(true);
    const lease = repo.getLease('actor-a', 'wf-1', 'first');
    expect(lease?.state).toBe('quarantined');
    expect(repo.reconcile('actor-a', 'wf-1', 'first', lease?.id ?? '', 2, expired)).toBe(true);
    expect(repo.claim('actor-a', 'wf-2', 'first', 0, tokenB, expired, reservation(expired, '/workspace/locked'))).toBe(true);
    db.close();
  });

  it('denies writes from SQLite connections without the connection-local guard', async () => {
    const { file, db, repo } = await setup(); repo.create(workflow());
    const now='2026-10-03T00:01:00.000Z';
    expect(repo.claim('actor-a','wf-1','first',0,token,now,reservation(now))).toBe(true);
    expect(repo.update('actor-a','wf-1','first',1,token,'verifying',null,'2026-10-03T00:02:00.000Z',verification('2026-10-03T00:02:00.000Z'))).toBe(true);
    approve(repo,'actor-a','wf-1','first','2026-10-03T00:03:00.000Z');
    expect(() => db.connection.prepare("UPDATE durable_workflow_qa_receipts SET verdict='failed'").run()).toThrow();
    expect(() => db.connection.prepare('DELETE FROM durable_workflow_qa_receipts').run()).toThrow();
    const old = new DatabaseSync(file);
    old.function('workflow_v143_guard', () => 143);
    expect(() => old.prepare("UPDATE durable_workflows SET cancelled=1 WHERE id='wf-1'").run()).toThrow();
    const guarded = [
      'UPDATE durable_workflow_tasks SET revision=revision WHERE workflow_id=\'wf-1\'',
      'UPDATE durable_workflow_events SET type=type WHERE workflow_id=\'wf-1\'',
      'UPDATE durable_workflow_leases SET state=state WHERE workflow_id=\'wf-1\'',
      'UPDATE durable_workflow_lease_scopes SET scope_path=scope_path WHERE lease_id IN (SELECT lease_id FROM durable_workflow_leases WHERE workflow_id=\'wf-1\')',
      'UPDATE durable_workflow_attempts SET state=state WHERE workflow_id=\'wf-1\'',
      'UPDATE durable_workflow_qa_receipts SET verdict=verdict WHERE workflow_id=\'wf-1\'',
    ];
    for (const sql of guarded) expect(() => old.exec(sql)).toThrow();
    old.close(); db.close(); void repo;
  });

  it('rejects an accepted receipt after its task contract or bound baseline changes', async () => {
    const {repo,db}=await setup();
    for (const [workflowId,at] of [['wf-contract-drift','2026-10-03T00:01:00.000Z'],['wf-baseline-drift','2026-10-03T00:11:00.000Z']] as const) {
      repo.create(workflow(workflowId));
      expect(repo.claim('actor-a',workflowId,'first',0,token,at,reservation(at,`/tmp/${workflowId}`))).toBe(true);
      const verifyingAt=new Date(Date.parse(at)+60_000).toISOString();
      expect(repo.update('actor-a',workflowId,'first',1,token,'verifying',null,verifyingAt,verification(verifyingAt))).toBe(true);
      const hash=approve(repo,'actor-a',workflowId,'first',new Date(Date.parse(at)+120_000).toISOString());
      if (workflowId==='wf-contract-drift') {
        db.connection.prepare('UPDATE durable_workflow_tasks SET contract_json=? WHERE workflow_id=? AND task_id=?').run(workflow('unused').tasks[0]!.contractJson.replace('"valid"','"changed"'),workflowId,'first');
      } else {
        const lease=repo.getLease('actor-a',workflowId,'first')!;
        const changed={...lease.reservation,baselineJson:lease.reservation.baselineJson.replace('b'.repeat(64),'e'.repeat(64))};
        db.connection.prepare('UPDATE durable_workflow_leases SET reservation_json=? WHERE lease_id=?').run(JSON.stringify(changed),lease.id);
      }
      expect(repo.qaInfo('actor-a',workflowId,'first')).toBeNull();
      const workflowState=repo.get('actor-a',workflowId)!;
      expect(repo.update('actor-a',workflowId,'first',3,token,'done',null,new Date(Date.parse(at)+180_000).toISOString(),{...verification(new Date(Date.parse(at)+180_000).toISOString()),acceptedReceiptHash:hash})).toBe(false);
      expect(workflowState.tasks[0]?.state).toBe('verifying');
    }
  });

  it('stores an immutable failed review, requires reconciliation before retry, and caps attempts', async () => {
    const {repo, db} = await setup(); repo.create(workflow());
    const t0='2026-10-03T00:01:00.000Z';
    expect(repo.claim('actor-a','wf-1','first',0,token,t0,reservation(t0),'worker-one')).toBe(true);
    expect(repo.update('actor-a','wf-1','first',1,token,'verifying',null,'2026-10-03T00:02:00.000Z',verification('2026-10-03T00:02:00.000Z'))).toBe(true);
    const failed={...qaReceipt(repo.get('actor-a','wf-1')!.tasks[0]!.contractJson),workerId:'worker-one',reviewerId:'worker-reviewer',verdict:'failed' as const,commands:[],criteria:[]};
    const lease=repo.getLease('actor-a','wf-1','first')!;
    expect(repo.review('actor-a','wf-1','first',2,token,lease.id,failed,'2026-10-03T00:03:00.000Z')?.verdict).toBe('failed');
    const stored=repo.qaInfo('actor-a','wf-1','first')!;
    expect(stored.receipts).toHaveLength(1);
    expect(stored.receipts[0]?.commands).toEqual([]);
    expect(repo.retry('actor-a','wf-1','first',lease.id,3,'2026-10-03T00:04:00.000Z')).toBe(false);
    expect(repo.reconcile('actor-a','wf-1','first',lease.id,3,'2026-10-03T00:04:00.000Z')).toBe(true);
    expect(repo.retry('actor-a','wf-1','first',lease.id,4,'2026-10-03T00:05:00.000Z')).toBe(true);
    expect(repo.claim('actor-a','wf-1','first',5,tokenB,'2026-10-03T00:06:00.000Z',reservation('2026-10-03T00:06:00.000Z'), 'worker-two')).toBe(true);
    expect(repo.qaInfo('actor-a','wf-1','first')?.attempts.map((a)=>[a.number,a.requestedPreset])).toEqual([[1,'Luna'],[2,'Luna']]);
    expect(repo.update('actor-a','wf-1','first',6,tokenB,'failed',null,'2026-10-03T00:07:00.000Z')).toBe(true);
    const secondLease=repo.getLease('actor-a','wf-1','first')!;
    expect(repo.reconcile('actor-a','wf-1','first',secondLease.id,7,'2026-10-03T00:08:00.000Z')).toBe(true);
    expect(repo.retry('actor-a','wf-1','first',secondLease.id,8,'2026-10-03T00:09:00.000Z')).toBe(true);
    expect(repo.claim('actor-a','wf-1','first',9,'c'.repeat(64),'2026-10-03T00:10:00.000Z',reservation('2026-10-03T00:10:00.000Z'),'worker-three')).toBe(true);
    expect(repo.qaInfo('actor-a','wf-1','first')?.attempts.map((a)=>[a.number,a.requestedPreset])).toEqual([[1,'Luna'],[2,'Luna'],[3,'Sol']]);
    expect(repo.update('actor-a','wf-1','first',10,'c'.repeat(64),'failed',null,'2026-10-03T00:11:00.000Z')).toBe(true);
    const thirdLease=repo.getLease('actor-a','wf-1','first')!;
    expect(repo.reconcile('actor-a','wf-1','first',thirdLease.id,11,'2026-10-03T00:12:00.000Z')).toBe(true);
    expect(repo.retry('actor-a','wf-1','first',thirdLease.id,12,'2026-10-03T00:13:00.000Z')).toBe(false);
    db.close();
  });

  it('imports pre-lease active tasks as global quarantines until owner reconciliation', async () => {
    const { file, db, repo } = await setup(); repo.create(workflow());
    db.connection.prepare("UPDATE durable_workflow_tasks SET state='running',revision=1,claim_token=? WHERE workflow_id='wf-1' AND task_id='first'").run(token);
    db.connection.exec(`DROP TRIGGER workflow_v143_workflows_insert; DROP TRIGGER workflow_v143_workflows_update; DROP TRIGGER workflow_v143_workflows_delete;
      DROP TRIGGER workflow_v143_tasks_insert; DROP TRIGGER workflow_v143_tasks_update; DROP TRIGGER workflow_v143_tasks_delete;
      DROP TRIGGER workflow_v143_events_insert; DROP TRIGGER workflow_v143_events_update; DROP TRIGGER workflow_v143_events_delete;
      DROP TABLE durable_workflow_lease_scopes; DROP TABLE durable_workflow_leases;
      DELETE FROM schema_migrations WHERE id='012_workflow_scope';`);
    db.close();
    const upgraded = new SqliteDatabase(file); databases.push(upgraded); const next = new SqliteWorkflowRepository(upgraded);
    next.create(workflow('wf-next'));
    const legacy = next.getLease('actor-a', 'wf-1', 'first');
    expect(legacy?.state).toBe('quarantined');
    const now = '2026-10-03T00:01:00.000Z';
    expect(next.claim('actor-a', 'wf-next', 'first', 0, tokenB, now, reservation(now, '/unrelated'))).toBe(false);
    expect(next.cancel('actor-a', 'wf-1', now)).toBe(true);
    expect(next.reconcile('actor-a', 'wf-1', 'first', legacy?.id ?? '', 2, now)).toBe(true);
    expect(next.claim('actor-a', 'wf-next', 'first', 0, tokenB, now, reservation(now, '/unrelated'))).toBe(true);
    upgraded.close();
  });

  it('serializes overlapping claim admission across independent Node processes', async () => {
    const { file, repo, db } = await setup();
    repo.create(workflow('wf-process-a'));
    repo.create({ ...workflow('wf-process-b'), ownerKey: 'actor-b' });
    const directory = path.dirname(file);
    const results = [path.join(directory, 'race-a.json'), path.join(directory, 'race-b.json')];
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const worker = fileURLToPath(new URL('./workflow-repository.worker.test.ts', import.meta.url));
    const run = (workflowId: string, ownerKey: string, claimToken: string, resultPath: string): Promise<number> => new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', worker, '--pool=forks', '--maxWorkers=1'], {
        cwd: root, stdio: 'ignore', env: { ...process.env, WORKFLOW_RACE_DB: file, WORKFLOW_RACE_ID: workflowId, WORKFLOW_RACE_OWNER: ownerKey, WORKFLOW_RACE_TOKEN: claimToken, WORKFLOW_RACE_RESULT: resultPath },
      });
      child.once('error', reject); child.once('close', (code) => resolve(code ?? 1));
    });
    expect(await Promise.all([run('wf-process-a', 'actor-a', token, results[0]!), run('wf-process-b', 'actor-b', tokenB, results[1]!)] )).toEqual([0, 0]);
    const outcomes = await Promise.all(results.map(async (resultPath) => JSON.parse(await readFile(resultPath, 'utf8')) as {claimed:boolean}));
    expect(outcomes.filter((outcome) => outcome.claimed)).toHaveLength(1);
    db.close();
  });
});
