import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteDatabase, SqliteWorkflowRepository } from '@baitonghub-linux-mcp/storage';
import { permissionProfiles, type PermissionProfile } from '@baitonghub-linux-mcp/permissions';
import type { Workspace, WorkspaceRepository } from '@baitonghub-linux-mcp/workspace';
import type { WorkflowTaskContract } from '@baitonghub-linux-mcp/codex';
import { WorkflowStateService } from './workflow-state-service.js';

const roots: string[] = [];
const databases: SqliteDatabase[] = [];
afterEach(async () => { for (const db of databases.splice(0)) db.close(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const actor = { clientId: 'trusted-owner', clientName: 'display', sessionId: 'old-session' };
const contract = (taskId: string, dependencies: string[] = []): WorkflowTaskContract => ({ taskId, goal: 'Scoped fixture', workspaceId: 'ws', allowedFiles: ['new.ts'], dependencies, acceptanceCriteria: ['check'], acceptanceCommands: [{ executable: 'node', args: [], expectedExitCode: 0, timeoutSeconds: 10 }], contextReferences: [], workerRole: 'coding', plannerRequired: false, securitySensitive: false, stopConditions: ['Stop before external writes'] });
async function fixture(): Promise<{ open(): WorkflowStateService; setProfile(value: PermissionProfile): void }> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'durable-workflow-service-'))); roots.push(root);
  const ws: Workspace = { id: 'ws', displayName: 'fixture', rootPath: root, realRootPath: root, createdAt: new Date(0).toISOString() };
  const workspaces: WorkspaceRepository = { async get(id) { return id === ws.id ? ws : null; }, async list() { return [ws]; }, async insert() {}, async delete() {} };
  let profile: PermissionProfile = permissionProfiles.balanced;
  const filename = path.join(root, 'state.db');
  const open = (): WorkflowStateService => { const db = new SqliteDatabase(filename); databases.push(db); return new WorkflowStateService(workspaces, new SqliteWorkflowRepository(db), () => profile); };
  return { open, setProfile(value: PermissionProfile): void { profile = value; } };
}
function value(result: unknown): Record<string, unknown> {
  expect(result).toMatchObject({ ok: true });
  return (result as { value: Record<string, unknown> }).value;
}

describe('WorkflowStateService real SQLite', () => {
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
    expect(await service.execute(actor, { operation: 'complete', workspaceId: 'ws', workflowId: id, taskId: 'first', expectedRevision: 3, claimToken: started.claimToken, state: 'done' })).toMatchObject({ ok: true });
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
