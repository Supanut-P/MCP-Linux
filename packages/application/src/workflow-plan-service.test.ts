import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type Workspace, type WorkspaceRepository } from '@baitonghub-linux-mcp/workspace';
import type { WorkflowTaskContract } from '@baitonghub-linux-mcp/codex';
import { WorkflowPlanService } from './workflow-plan-service.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root,{recursive:true,force:true}))); });
const input = (workspaceId = 'ws-1', allowedFiles = ['new/file.ts']): WorkflowTaskContract => ({ taskId:'t1', goal:'Prepare task', workspaceId, allowedFiles, dependencies:[], acceptanceCriteria:['check'], acceptanceCommands:[{ executable:'node', args:[], expectedExitCode:0, timeoutSeconds:10 }], contextReferences:[], workerRole:'coding', plannerRequired:false, securitySensitive:false, stopConditions:['Stop on scope change'] });
function repo(workspace: Workspace, get?: WorkspaceRepository['get']): WorkspaceRepository {
  return {
    async list(): Promise<Workspace[]> { return [workspace]; },
    async get(id): Promise<Workspace | null> { return get ? get(id) : id === workspace.id ? workspace : null; },
    async insert(): Promise<void> {},
    async delete(): Promise<void> {},
  };
}
async function workspace(): Promise<Workspace> { const root = await realpath(await mkdtemp(path.join(os.tmpdir(),'workflow-plan-'))); roots.push(root); return { id:'ws-1',displayName:'fixture',rootPath:root,realRootPath:root,createdAt:new Date(0).toISOString() }; }

describe('WorkflowPlanService', () => {
  it('accepts guarded new files within a registered workspace', async () => {
    const ws = await workspace();
    await expect(new WorkflowPlanService(repo(ws)).execute({clientId:'c',clientName:'c'},input())).resolves.toMatchObject({ok:true,value:{executionStarted:false,dispatch:'caller_native'}});
  });
  it('rejects missing workspaces and aborts before or after repository lookup', async () => {
    const ws = await workspace();
    await expect(new WorkflowPlanService(repo(ws)).execute({clientId:'c',clientName:'c'},input('missing'))).resolves.toMatchObject({ok:false,error:{code:'WORKSPACE_NOT_FOUND'}});
    const before = new AbortController(); before.abort();
    await expect(new WorkflowPlanService(repo(ws)).execute({clientId:'c',clientName:'c'},input(),before.signal)).resolves.toMatchObject({ok:false,error:{code:'PROCESS_TIMEOUT'}});
    const after = new AbortController();
    const delayed = repo(ws, async () => { after.abort(); return ws; });
    await expect(new WorkflowPlanService(delayed).execute({clientId:'c',clientName:'c'},input(),after.signal)).resolves.toMatchObject({ok:false,error:{code:'PROCESS_TIMEOUT'}});
  });
  it('rejects paths that escape through a symlink without exposing the target path', async () => {
    const ws = await workspace(); const outside = await realpath(await mkdtemp(path.join(os.tmpdir(),'workflow-outside-'))); roots.push(outside);
    await symlink(outside, path.join(ws.rootPath, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(new WorkflowPlanService(repo(ws)).execute({clientId:'c',clientName:'c'},input('ws-1',['escape/file.ts']))).resolves.toMatchObject({ok:false,error:{code:'PATH_OUTSIDE_WORKSPACE'}});
  });
});
