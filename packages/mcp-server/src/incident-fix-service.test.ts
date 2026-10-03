import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import { prepareWorkflowContract, type WorkflowTaskContract } from '@baitonghub-linux-mcp/codex';
import { FileService, FleetCatalogService, WorkflowPlanService, fleetWorkspaceFingerprint, type FileActor } from '@baitonghub-linux-mcp/application';
import { permissionProfiles, type PermissionProfile } from '@baitonghub-linux-mcp/permissions';
import { SqliteDatabase, SqliteDiagnosisRepository, SqliteFleetCatalogRepository, SqliteIncidentFixRepository, SqliteWorkflowRepository } from '@baitonghub-linux-mcp/storage';
import type { Workspace, WorkspaceRepository } from '@baitonghub-linux-mcp/workspace';
import type { ResolvedIncidentEvidence } from './incident-service.js';
import { DiagnosisService } from './diagnosis-service.js';
import type { DiagnosisRecordRequest } from './diagnosis-contract.js';
import { IncidentFixService } from './incident-fix-service.js';
import type { IncidentFixPrepareRequest } from './incident-fix-contract.js';

const roots: string[] = [];
const databases: SqliteDatabase[] = [];
const actor: FileActor = { clientId: 'incident-fix-test-owner', clientName: 'fixture' };
const reference = { incidentId: 'incident-1', sequence: 1, hash: 'a'.repeat(64) };
const diagnosisRequest = (): DiagnosisRecordRequest => ({ operation: 'record', diagnosisId: 'diagnosis-1', workspaceId: 'ws-1',
  hypotheses: [{ id: 'h1', statement: 'A possible cause', confidence: 'medium', rationale: 'Based on the retained sample', assumptions: [],
    unknowns: ['The partial capture omits other service sources'], supporting: [reference], contradicting: [] }],
  proposedFix: [{ id: 'proposal-1', hypothesisIds: ['h1'], description: 'Review the affected code path', verification: 'Run the focused regression check' }] });

interface Fixture {
  db: SqliteDatabase; file: string; root: string; workspace: Workspace; workspaces: WorkspaceRepository; host: HostFixture;
  fact: ResolvedIncidentEvidence; diagnosisHash: string; diagnosis: DiagnosisService; resolveEvidence: ReturnType<typeof vi.fn>;
  resolveFixEvidence: ReturnType<typeof vi.fn>; verifyFixEvidence: ReturnType<typeof vi.fn>; resolveMapping: ReturnType<typeof vi.fn>; verifyMapping: ReturnType<typeof vi.fn>; files: Pick<FileService, 'readContextFile'>; profile: PermissionProfile;
  changeMapping(): Promise<Result<unknown>>;
  service(options?: { deadlineMs?: number; plans?: Pick<WorkflowPlanService, 'execute'> }): IncidentFixService; reopen(db: SqliteDatabase): Promise<void>;
  prepare(overrides?: Partial<IncidentFixPrepareRequest>): IncidentFixPrepareRequest;
}
interface HostFixture { id: string; host: string; port: number; username: string; secretRef: string; pinnedFingerprint: string; roots: string[]; createdAt: string }

afterEach(async () => {
  for (const db of databases.splice(0)) { try { db.close(); } catch { /* reopened during the test */ } }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

async function fixture(): Promise<Fixture> {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'incident-fix-service-')); roots.push(temp);
  const root = path.join(temp, 'workspace'); await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'a.ts'), 'export const value = 1;\n');
  const now = '2026-10-03T01:02:03.000Z';
  const workspace: Workspace = { id: 'ws-1', displayName: 'fixture', rootPath: root, realRootPath: await realpath(root), createdAt: now };
  const workspaces: WorkspaceRepository = { async get(id: string): Promise<Workspace | null> { return id === workspace.id ? workspace : null; },
    async list(): Promise<Workspace[]> { return [workspace]; }, async insert(): Promise<void> {}, async delete(): Promise<void> {} };
  const host: HostFixture = { id: 'host-1', host: '127.0.0.1', port: 22, username: 'fixture', secretRef: 'fixture-ref', pinnedFingerprint: 'SHA256:fixture', roots: ['/srv/app'], createdAt: now };
  const db = new SqliteDatabase(path.join(temp, 'state.sqlite')); databases.push(db);
  let activeDb = db;
  const fact: ResolvedIncidentEvidence = { reference, incidentRequestFingerprint: 'b'.repeat(64), incidentHeaderHash: 'c'.repeat(64), workspaceId: workspace.id,
    workspaceFingerprint: fleetWorkspaceFingerprint(workspace), hostFingerprint: null,
    observation: { source: 'local_metrics', workspaceId: workspace.id, observedAt: now, sourceTime: null, status: 'ok', truncated: false, gap: true, data: { locality: 'mcp_server' } },
    incidentState: 'partial', missingSources: 1, currentSupport: 'current' };
  const resolveEvidence = vi.fn(async (): Promise<Result<readonly ResolvedIncidentEvidence[]>> => ok([fact]));
  let diagnosis: DiagnosisService = new DiagnosisService({ repository: new SqliteDiagnosisRepository(db), incidents: { resolveEvidence }, profileProvider: () => permissionProfiles.full });
  const saved = await diagnosis.execute(actor, { ...diagnosisRequest(), userConfirmed: true });
  if (!saved.ok) throw new Error('Fixture diagnosis was not accepted');
  const diagnosisHash = (saved.value as { documentHash: string }).documentHash;
  const resolveFixEvidence = vi.fn(async (): Promise<Result<readonly ResolvedIncidentEvidence[]>> => ok([fact]));
  const verifyFixEvidence = vi.fn((): Result<void> => ok(undefined));
  const resolveMapping = vi.fn(async (mappingActor: FileActor, input: unknown): Promise<Result<unknown>> => fleet.execute(mappingActor, input));
  const fleet = makeFleet(db, workspaces, host);
  const verifyMapping = vi.fn((mappingActor: FileActor, binding: Parameters<FleetCatalogService['verifyMapping']>[1], confirmed?: boolean): Result<void> => fleet.verifyMapping(mappingActor, binding, confirmed));
  const mappingCreated = await fleet.execute(actor, { operation: 'put_mapping', id: 'mapping-1', hostId: host.id, serviceUnit: 'app.service', workspaceId: workspace.id, expectedRevision: 0 });
  if (!mappingCreated.ok) throw new Error('Fixture mapping was not accepted');
  let profile = permissionProfiles.balanced;
  const files = new FileService(workspaces);
  const makeService = (database: SqliteDatabase, deadlineMs: number = 1000, plans: Pick<WorkflowPlanService, 'execute'> = new WorkflowPlanService(workspaces)): IncidentFixService => new IncidentFixService({
    repository: new SqliteIncidentFixRepository(database), workflows: new SqliteWorkflowRepository(database), diagnosis,
    incidents: { resolveFixEvidence, verifyFixEvidence }, catalog: { execute: resolveMapping, verifyMapping }, plans, files, workspaces,
    hosts: { async get(id: string): Promise<HostFixture | null> { return id === host.id ? host : null; } }, profileProvider: () => profile, deadlineMs,
  });
  return {
    db, file: path.join(temp, 'state.sqlite'), root, workspace, workspaces, host, fact, diagnosisHash, diagnosis,
    resolveEvidence, resolveFixEvidence, verifyFixEvidence, resolveMapping, verifyMapping, files, get profile(): PermissionProfile { return profile; }, set profile(value: PermissionProfile) { profile = value; },
    async changeMapping(): Promise<Result<unknown>> { return fleet.execute(actor, { operation: 'put_mapping', id: 'mapping-1', hostId: host.id, serviceUnit: 'changed.service', workspaceId: workspace.id, expectedRevision: 1 }); },
    service: (options?: Parameters<Fixture['service']>[0]): IncidentFixService => makeService(activeDb, options?.deadlineMs, options?.plans === undefined ? new WorkflowPlanService(workspaces) : options.plans),
    async reopen(nextDb: SqliteDatabase): Promise<void> {
      databases.push(nextDb);
      activeDb = nextDb;
      diagnosis = new DiagnosisService({ repository: new SqliteDiagnosisRepository(nextDb), incidents: { resolveEvidence }, profileProvider: (): PermissionProfile => permissionProfiles.full });
      const nextFleet = makeFleet(nextDb, workspaces, host);
      const look = await nextFleet.execute(actor, { operation: 'resolve', id: 'mapping-1' });
      if (!look.ok) throw new Error('Fixture mapping was not available after reopen');
      resolveMapping.mockImplementation(async (mappingActor: FileActor, input: unknown): Promise<Result<unknown>> => nextFleet.execute(mappingActor, input));
      verifyMapping.mockImplementation((mappingActor: FileActor, binding: Parameters<FleetCatalogService['verifyMapping']>[1], confirmed?: boolean): Result<void> => nextFleet.verifyMapping(mappingActor, binding, confirmed));
    },
    prepare(overrides: Partial<IncidentFixPrepareRequest> = {}): IncidentFixPrepareRequest { return { operation: 'prepare', fixId: 'fix-1', diagnosisId: 'diagnosis-1', diagnosisHash, mappingId: 'mapping-1', mappingRevision: 1,
      contract: workflow(workspace.id), context: [{ path: 'src/a.ts', startLine: 1, endLine: 1 }], ...overrides }; },
  };
}

function makeFleet(db: SqliteDatabase, workspaces: WorkspaceRepository, host: HostFixture): FleetCatalogService {
  return new FleetCatalogService(new SqliteFleetCatalogRepository(db), { async get(id: string): Promise<HostFixture | null> { return id === host.id ? host : null; } }, workspaces, () => permissionProfiles.full);
}
function workflow(workspaceId: string, allowedFiles: string[] = ['src/a.ts']): WorkflowTaskContract {
  return { taskId: 'task-1', goal: 'Fix the evidence linked issue', workspaceId, allowedFiles, dependencies: [], acceptanceCriteria: ['Regression check passes'],
    acceptanceCommands: [{ executable: 'pnpm', args: ['test'], expectedExitCode: 0, timeoutSeconds: 30 }], contextReferences: ['docs/issue.md'],
    workerRole: 'coding' as const, plannerRequired: false, securitySensitive: false, stopConditions: ['Stop if scope changes'] };
}
function ownerKey(clientId = actor.clientId): string { return createHash('sha256').update(clientId).digest('hex'); }
function noRecord(f: Fixture, fixId: string = 'fix-1'): void { expect(new SqliteIncidentFixRepository(f.db).get(ownerKey(), fixId)).toBeNull(); }

describe('IncidentFixService', () => {
  it('atomically creates once, reuses the same preparation after reopen, and retains a partial diagnosis unknown', async () => {
    const f = await fixture(), service = f.service(), input = f.prepare();
    const first = await service.execute(actor, input);
    expect(first).toMatchObject({ ok: true, value: { fixId: input.fixId, currentLink: 'current', currentContext: [{ status: 'current' }], workflow: [{ taskId: 'task-1', state: 'ready' }], executionStarted: false } });
    if (!first.ok) return;
    const identity = first.value as { documentHash: string; workflowId: string; reference: string };
    expect(identity.documentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(await service.execute(actor, input)).toEqual(first);
    expect(f.db.connection.prepare('SELECT COUNT(*) n FROM durable_workflows').get()).toMatchObject({ n: 1 });
    const retainedDiagnosis = await f.diagnosis.execute(actor, { operation: 'get', diagnosisId: input.diagnosisId, userConfirmed: true });
    expect(retainedDiagnosis).toMatchObject({ ok: true, value: { documentHash: input.diagnosisHash, interpretations: [{ unknowns: ['The partial capture omits other service sources'] }], observedFacts: [{ incidentState: 'partial', missingSources: 1 }] } });
    f.db.close();
    const reopened = new SqliteDatabase(f.file); await f.reopen(reopened);
    const afterRestart = await f.service().execute(actor, input);
    expect(afterRestart).toMatchObject({ ok: true, value: { documentHash: identity.documentHash, workflowId: identity.workflowId, reference: identity.reference } });
    expect(reopened.connection.prepare('SELECT COUNT(*) n FROM durable_workflows').get()).toMatchObject({ n: 1 });
  });

  it('rejects changed ID reuse, foreign ownership, workspace or mapping drift, diagnosis hash and evidence reference mismatch', async () => {
    const f = await fixture(), service = f.service();
    expect((await service.execute(actor, f.prepare())).ok).toBe(true);
    expect(await service.execute(actor, f.prepare({ diagnosisHash: 'e'.repeat(64) }))).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await service.execute(actor, { operation: 'status', fixId: 'fix-1', userConfirmed: true })).toMatchObject({ ok: true });
    expect(await service.execute({ ...actor, clientId: 'different-owner' }, { operation: 'status', fixId: 'fix-1', userConfirmed: true })).toMatchObject({ ok: false });

    const fresh = await fixture();
    expect(await fresh.service().execute(actor, fresh.prepare({ contract: workflow('other-workspace') }))).toMatchObject({ ok: false });
    noRecord(fresh);
    expect(await fresh.service().execute(actor, fresh.prepare({ mappingId: 'other-mapping' }))).toMatchObject({ ok: false });
    noRecord(fresh);
    expect(await fresh.service().execute(actor, fresh.prepare({ mappingRevision: 2 }))).toMatchObject({ ok: false });
    noRecord(fresh);
    fresh.resolveFixEvidence.mockResolvedValueOnce(ok([{ ...fresh.fact, reference: { ...reference, hash: 'f'.repeat(64) } }]));
    expect(await fresh.service().execute(actor, fresh.prepare())).toMatchObject({ ok: false });
    noRecord(fresh);
  });

  it('requires explicit confirmation under the safe profile and only reads registered non-secret source files', async () => {
    const f = await fixture(); f.profile = permissionProfiles.safe;
    const service = f.service(), read = vi.spyOn(f.files, 'readContextFile');
    const unconfirmed = f.prepare(); delete unconfirmed.userConfirmed;
    expect(await service.execute(actor, unconfirmed)).toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    expect(read).not.toHaveBeenCalled();
    expect(await service.execute(actor, { ...f.prepare(), userConfirmed: true })).toMatchObject({ ok: true });

    const secret = await fixture();
    const sourceRead = vi.spyOn(secret.files, 'readContextFile');
    const secretPlans = { async execute(_actor: FileActor, input: unknown): ReturnType<typeof prepareWorkflowContract> { return prepareWorkflowContract(input); } };
    expect(await secret.service({ plans: secretPlans }).execute(actor, secret.prepare({ contract: workflow(secret.workspace.id, ['.env']), context: [{ path: '.env', startLine: 1, endLine: 1 }] }))).toMatchObject({ ok: false });
    expect(sourceRead).not.toHaveBeenCalled(); noRecord(secret);
  });

  it('permits READ-only status with WRITE denied and rechecks WRITE policy after awaited evidence resolution', async () => {
    const f = await fixture(), service = f.service();
    expect((await service.execute(actor, f.prepare())).ok).toBe(true);
    f.profile = { ...permissionProfiles.balanced, defaults: { ...permissionProfiles.balanced.defaults, WRITE: 'DENY' } };
    expect(await service.execute(actor, { operation: 'status', fixId: 'fix-1' })).toMatchObject({ ok: true });
    expect(await service.execute(actor, f.prepare({ fixId: 'fix-denied' }))).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    noRecord(f, 'fix-denied');

    const changed = await fixture();
    changed.resolveFixEvidence.mockImplementationOnce(async () => {
      changed.profile = { ...permissionProfiles.balanced, defaults: { ...permissionProfiles.balanced.defaults, WRITE: 'DENY' } };
      return ok([changed.fact]);
    });
    expect(await changed.service().execute(actor, { ...changed.prepare(), userConfirmed: true })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    noRecord(changed);
  });

  it('blocks start after source change while leaving a later review to the workflow baseline fence', async () => {
    const f = await fixture(), created = await f.service().execute(actor, f.prepare());
    expect(created.ok).toBe(true); if (!created.ok) return;
    const workflowId = (created.value as { workflowId: string }).workflowId;
    const workflowRepo = new SqliteWorkflowRepository(f.db), stored = workflowRepo.get(ownerKey(), workflowId);
    expect(stored).not.toBeNull(); if (stored === null) return;
    await writeFile(path.join(f.root, 'src', 'a.ts'), 'export const value = 2;\n');
    expect(await f.service().validateWorkflow(actor, stored, 'start', true)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    const firstReview = await f.service().validateWorkflow(actor, stored, 'review', true);
    expect(firstReview).toMatchObject({ ok: true });
    if (firstReview.ok) expect(firstReview.value?.verify()).toMatchObject({ ok: true });
    const oldRoot = `${f.root}-old`;
    await rename(f.root, oldRoot);
    await mkdir(path.join(f.root, 'src'), { recursive: true });
    await writeFile(path.join(f.root, 'src', 'a.ts'), 'export const value = 1;\n');
    expect(await f.service().validateWorkflow(actor, stored, 'start', true)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    const secondReview = await f.service().validateWorkflow(actor, stored, 'review', true);
    expect(secondReview).toMatchObject({ ok: true });
    if (secondReview.ok) expect(secondReview.value?.verify()).toMatchObject({ ok: true });
    const task = stored.tasks[0]!;
    const contract = JSON.parse(task.contractJson) as { contextReferences: string[] };
    contract.contextReferences = contract.contextReferences.map(value => value.startsWith('incident_fix:') ? value.replace('fix-1', 'another-fix') : value);
    expect(await f.service().validateWorkflow(actor, { ...stored, tasks: [{ ...task, contractJson: JSON.stringify(contract) }] }, 'review', true)).toMatchObject({ ok: false });
  });

  it('rejects removed reserved references on owned workflows while allowing genuinely unlinked workflows', async () => {
    const f = await fixture(), created = await f.service().execute(actor, f.prepare());
    expect(created.ok).toBe(true); if (!created.ok) return;
    const workflowId = (created.value as { workflowId: string }).workflowId;
    const repository = new SqliteWorkflowRepository(f.db), stored = repository.get(ownerKey(), workflowId);
    expect(stored).not.toBeNull(); if (stored === null) return;
    const contract = JSON.parse(stored.tasks[0]!.contractJson) as { contextReferences: string[] };
    contract.contextReferences = contract.contextReferences.filter(value => !value.startsWith('incident_fix:'));
    f.db.connection.prepare('UPDATE durable_workflow_tasks SET contract_json=? WHERE workflow_id=? AND task_id=?').run(JSON.stringify(contract), workflowId, stored.tasks[0]!.taskId);
    const stripped = repository.get(ownerKey(), workflowId);
    expect(stripped).not.toBeNull(); if (stripped !== null) expect(await f.service().validateWorkflow(actor, stripped, 'start', true)).toMatchObject({ ok: false });

    const genericContract = { ...workflow(f.workspace.id), taskId: 'generic-task' };
    const generic = { id: 'generic-workflow', ownerKey: ownerKey(), workspaceId: f.workspace.id, createdAt: '2026-10-03T01:02:03.000Z', tasks: [{ taskId: 'generic-task', contractJson: JSON.stringify(genericContract), dependencies: [], state: 'ready' as const, revision: 0, checkpoint: null }] };
    repository.create(generic);
    const unlinked = repository.get(ownerKey(), generic.id);
    expect(unlinked).not.toBeNull(); if (unlinked !== null) expect(await f.service().validateWorkflow(actor, unlinked, 'start', true)).toMatchObject({ ok: true, value: undefined });
  });

  it('rejects preparation when the selected catalog mapping changes during revalidation', async () => {
    const f = await fixture();
    f.resolveMapping.mockImplementationOnce(async (mappingActor: FileActor, input: unknown): Promise<Result<unknown>> => {
      const changed = await f.changeMapping();
      if (!changed.ok) return changed;
      return f.resolveMapping.getMockImplementation()!(mappingActor, input) as Promise<Result<unknown>>;
    });
    expect(await f.service().execute(actor, f.prepare())).toMatchObject({ ok: false });
    noRecord(f);
    expect(f.db.connection.prepare('SELECT COUNT(*) n FROM durable_workflows').get()).toMatchObject({ n: 0 });
  });

  it('rejects preparation when selected source changes during the final awaited catalog resolution', async () => {
    const f = await fixture(), resolve = f.resolveMapping.getMockImplementation()!;
    let calls = 0;
    f.resolveMapping.mockImplementation(async (mappingActor: FileActor, input: unknown): Promise<Result<unknown>> => {
      calls++;
      if (calls === 6) await writeFile(path.join(f.root, 'src', 'a.ts'), 'export const value = 9;\n');
      return resolve(mappingActor, input) as Promise<Result<unknown>>;
    });
    expect(await f.service().execute(actor, f.prepare())).toMatchObject({ ok: false });
    expect(calls).toBe(6);
    noRecord(f);
    expect(f.db.connection.prepare('SELECT COUNT(*) n FROM durable_workflows').get()).toMatchObject({ n: 0 });
  });

  it('clips UTF-8 snippets at the byte bound and rejects late writes after timeout or cancellation', async () => {
    const f = await fixture(); await writeFile(path.join(f.root, 'src', 'a.ts'), '界'.repeat(5000));
    const captured = await f.service().execute(actor, f.prepare({ context: [{ path: 'src/a.ts', startLine: 1, endLine: 1 }] }));
    expect(captured).toMatchObject({ ok: true, value: { context: [{ truncated: true }] } });
    if (captured.ok) expect(Buffer.byteLength((captured.value as { context: [{ snippet: string }] }).context[0].snippet, 'utf8')).toBeLessThanOrEqual(8 * 1024);

    for (const mode of ['timeout', 'cancel'] as const) {
      const pending = await fixture();
      let release!: (value: Result<readonly ResolvedIncidentEvidence[]>) => void;
      const hung = new Promise<Result<readonly ResolvedIncidentEvidence[]>>(resolve => { release = resolve; });
      pending.resolveFixEvidence.mockImplementation(async () => hung);
      const controller = new AbortController();
      const running = pending.service({ deadlineMs: 20 }).execute(actor, pending.prepare(), controller.signal);
      await vi.waitFor(() => expect(pending.resolveFixEvidence).toHaveBeenCalled());
      if (mode === 'cancel') controller.abort();
      expect(await running).toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
      release(ok([pending.fact])); await new Promise(resolve => setTimeout(resolve, 0));
      noRecord(pending);
    }
  });

  it('uses the synchronous incident source fence after awaited mapping resolution and before atomic insertion', async () => {
    const f = await fixture();
    f.verifyFixEvidence.mockImplementation(() => f.verifyFixEvidence.mock.calls.length < 3 ? ok(undefined) : err(appError('INVALID_INPUT', 'Source changed at final fence')));
    expect(await f.service().execute(actor, f.prepare())).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(f.verifyFixEvidence).toHaveBeenCalledTimes(3);
    noRecord(f);
    expect(f.db.connection.prepare('SELECT COUNT(*) n FROM durable_workflows').get()).toMatchObject({ n: 0 });
  });

  it('rechecks retained diagnosis and mapping state in the returned workflow fence', async () => {
    for (const changed of ['diagnosis', 'mapping'] as const) {
      const f = await fixture(), created = await f.service().execute(actor, f.prepare());
      expect(created.ok).toBe(true); if (!created.ok) continue;
      const workflowId = (created.value as { workflowId: string }).workflowId;
      const workflowRepo = new SqliteWorkflowRepository(f.db), stored = workflowRepo.get(ownerKey(), workflowId);
      expect(stored).not.toBeNull(); if (stored === null) continue;
      const checked = await f.service().validateWorkflow(actor, stored, 'review', true);
      expect(checked.ok).toBe(true); if (!checked.ok || checked.value === undefined) continue;
      if (changed === 'diagnosis') {
        f.db.connection.prepare('UPDATE diagnosis_records SET document_hash=? WHERE owner_key=? AND id=?').run('d'.repeat(64), ownerKey(), 'diagnosis-1');
      } else {
        f.db.connection.prepare('UPDATE fleet_catalog SET revision=revision+1 WHERE owner_key=? AND id=?').run(ownerKey(), 'mapping-1');
      }
      expect(checked.value.verify()).toMatchObject({ ok: false });
    }
  });
});
