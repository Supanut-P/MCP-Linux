import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
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
    { taskId: 'first', contractJson: '{"taskId":"first","workspaceId":"workspace-a","dependencies":[]}', dependencies: [], state: 'ready', revision: 0, checkpoint: null },
    { taskId: 'second', contractJson: '{"taskId":"second","workspaceId":"workspace-a","dependencies":["first"]}', dependencies: ['first'], state: 'planned', revision: 0, checkpoint: null },
  ] };
}
const token = 'opaque-claim-token-0123456789abcdef';

describe('SqliteWorkflowRepository', () => {
  it('recovers state across reopen, fences stale claims, promotes dependencies, and orders events', async () => {
    const { file, db, repo } = await setup(); repo.create(workflow());
    expect(repo.get('actor-a', 'wf-1')?.tasks.map((t) => t.state)).toEqual(['ready', 'planned']);
    const secondDb = new SqliteDatabase(file); databases.push(secondDb); const second = new SqliteWorkflowRepository(secondDb);
    expect(repo.claim('actor-a', 'wf-1', 'first', 0, token, '2026-10-03T00:01:00.000Z')).toBe(true);
    expect(second.claim('actor-a', 'wf-1', 'first', 0, 'another-token-0123456789abcdef', '2026-10-03T00:01:01.000Z')).toBe(false);
    const cp = { summary: 'checkpoint', references: ['docs/result.md'], executionUncertain: true };
    expect(second.update('actor-a', 'wf-1', 'first', 1, token, 'verifying', cp, '2026-10-03T00:02:00.000Z')).toBe(true);
    expect(second.update('actor-a', 'wf-1', 'first', 1, token, 'done', cp, '2026-10-03T00:02:01.000Z')).toBe(false);
    expect(second.update('actor-a', 'wf-1', 'first', 2, token, 'done', cp, '2026-10-03T00:03:00.000Z')).toBe(true);
    expect(repo.get('actor-a', 'wf-1')?.tasks.map((t) => t.state)).toEqual(['done', 'ready']);
    db.close(); secondDb.close();
    const reopened = new SqliteDatabase(file); databases.push(reopened); const recovered = new SqliteWorkflowRepository(reopened);
    expect(recovered.get('actor-a', 'wf-1')?.tasks[0]?.checkpoint).toEqual(cp);
    const eventRows = recovered.events('actor-a', 'wf-1', 0, 100);
    expect(eventRows.map((e) => e.sequence)).toEqual([1,2,3,4,5,6,7]);
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
    expect(() => repo.claim('actor-a', 'wf-1', 'first', 0, token, '2026-10-03T00:01:00.000Z')).toThrow();
    expect(repo.get('actor-a', 'wf-1')?.tasks[0]?.state).toBe('ready');
    db.connection.exec('DROP TRIGGER fail_workflow_event');
    for (let i = 1; i < 32; i++) repo.create(workflow(`wf-${i + 1}`));
    expect(() => repo.create(workflow('wf-33'))).toThrow(/quota/i);
    db.close();
  });

  it('cancels nonterminal work and leaves completed tasks done', async () => {
    const { db, repo } = await setup(); repo.create(workflow());
    expect(repo.claim('actor-a', 'wf-1', 'first', 0, token, '2026-10-03T00:01:00.000Z')).toBe(true);
    expect(repo.update('actor-a', 'wf-1', 'first', 1, token, 'verifying', null, '2026-10-03T00:02:00.000Z')).toBe(true);
    expect(repo.update('actor-a', 'wf-1', 'first', 2, token, 'done', null, '2026-10-03T00:03:00.000Z')).toBe(true);
    expect(repo.cancel('actor-a', 'wf-1', '2026-10-03T00:04:00.000Z')).toBe(true);
    expect(repo.get('actor-a', 'wf-1')?.tasks.map((t) => t.state)).toEqual(['done', 'cancelled']);
    expect(repo.claim('actor-a', 'wf-1', 'second', 1, 'another-token-0123456789abcdef', '2026-10-03T00:05:00.000Z')).toBe(false);
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
});
