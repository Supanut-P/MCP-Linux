import { createHash } from 'node:crypto';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { ok, err, appError, type Result } from '@baitonghub-linux-mcp/domain';
import { SqliteDatabase, SqliteIncidentRepository } from '@baitonghub-linux-mcp/storage';
import { permissionProfiles, type PermissionProfile } from '@baitonghub-linux-mcp/permissions';
import type { Workspace, WorkspaceRepository } from '@baitonghub-linux-mcp/workspace';
import { IncidentService } from './incident-service.js';
import { fleetHostFingerprint, fleetWorkspaceFingerprint } from '@baitonghub-linux-mcp/application';

const actor = { clientId: 'owner', clientName: 'fixture' };
const request = { operation: 'collect', incidentId: 'incident-1', workspaceId: 'ws', hostIds: ['h1'], unit: 'app.service' };
type TestHost = { id: string; host: string; port: number; username: string; secretRef: string; pinnedFingerprint: string; roots: string[]; createdAt: string };
interface Fixture { db: SqliteDatabase; repository: SqliteIncidentRepository; service: IncidentService; hosts: Map<string, TestHost>; workspaces: WorkspaceRepository; execute: Mock<(input: unknown) => Promise<Result<unknown>>>; metrics: { execute: Mock<() => Promise<Result<unknown>>> }; changes: { snapshot: Mock<() => Promise<Result<unknown>>> }; setWorkspace(w: Workspace | null): void; setProfile(p: PermissionProfile): void }
function fixture(deadlineMs = 1000): Fixture {
  const db = new SqliteDatabase(':memory:');
  const repository = new SqliteIncidentRepository(db);
  let workspace: Workspace | null = { id: 'ws', displayName: 'fixture', rootPath: '/repo', realRootPath: '/repo', createdAt: '2026-10-03T00:00:00Z' };
  const workspaces: WorkspaceRepository = { async get(id) { return id === 'ws' ? workspace : null; }, async list() { return workspace ? [workspace] : []; }, async insert() {}, async delete() {} };
  const host = { id: 'h1', host: '127.0.0.1', port: 22, username: 'fixture', secretRef: 'SECRET_CANARY', pinnedFingerprint: 'SHA256:fixture', roots: ['/srv'], createdAt: '2026-10-03T00:00:00Z' };
  const hosts = new Map([['h1', host], ['h2', { ...host, id: 'h2' }]]);
  const execute = vi.fn<(input: unknown) => Promise<Result<unknown>>>(async (input: unknown) => {
    const q = input as { hostIds: string[]; operation: string };
    const output = q.operation === 'service-status' ? 'ActiveState=active\nSubState=running' : q.operation === 'disk_usage' ? '12 /srv/SECRET_CANARY' : 'SECRET_CANARY';
    return ok({ hosts: [{ hostId: q.hostIds[0], status: 'ok', value: { output, exitCode: 0 } }] });
  });
  let profile: PermissionProfile = permissionProfiles.balanced;
  const metrics = { execute: vi.fn<() => Promise<Result<unknown>>>(async () => ok({ host: { load1: 0.5 }, runtime: { requestTotal: 1 }, tasks: { total: 0, byState: { running: 0 } } })) };
  const changes = { snapshot: vi.fn<() => Promise<Result<unknown>>>(async () => ok({ workspaceId: 'ws', events: [], latestSequence: 0, truncated: false })) };
  const service = new IncidentService({ repository, workspaces, hosts: { async get(id): Promise<TestHost | null> { return hosts.get(id) ?? null; } }, fleet: { execute }, metrics, changes, profileProvider: (): PermissionProfile => profile, deadlineMs });
  return { db, repository, service, hosts, workspaces, execute, metrics, changes, setWorkspace(w: Workspace | null): void { workspace = w; }, setProfile(p: PermissionProfile): void { profile = p; } };
}

describe('durable bounded incidents', () => {
  it('requires the mapped service and registered identities when resolving fix evidence',async()=>{
    const f=fixture();
    try{
      await f.service.execute(actor,request);
      const report=await f.service.execute(actor,{operation:'report',incidentId:request.incidentId,limit:32});
      const refs=(report as {value:{evidence:{reference:{incidentId:string;sequence:number;hash:string}}[]}}).value.evidence.map(row=>row.reference);
      const ws=(await f.workspaces.get('ws'))!,host=f.hosts.get('h1')!;
      const mapping={hostId:'h1',serviceUnit:'app.service',workspaceFingerprint:fleetWorkspaceFingerprint(ws),hostFingerprint:fleetHostFingerprint(host)};
      expect(await f.service.resolveFixEvidence(actor,'ws',refs,mapping)).toMatchObject({ok:true});
      const probes=f.execute.mock.calls.length;
      for(const changed of [{...mapping,serviceUnit:'other.service'},{...mapping,serviceUnit:'-Hother.service'},{...mapping,hostFingerprint:'0'.repeat(64)},{...mapping,workspaceFingerprint:'0'.repeat(64)},{...mapping,hostId:'h2'}])expect(await f.service.resolveFixEvidence(actor,'ws',refs,changed)).toMatchObject({ok:false});
      expect(f.execute).toHaveBeenCalledTimes(probes);
    }finally{f.db.close();}
  });
  it('classifies real timer expiry as timeout while the wall clock is frozen', async () => {
    const f=fixture(10);const clock=vi.spyOn(Date,'now').mockReturnValue(1790985600000);
    f.workspaces.get=async():Promise<Workspace|null>=>new Promise(()=>undefined);
    try {
      expect(await f.service.execute(actor,request)).toMatchObject({ok:false,error:{code:'PROCESS_TIMEOUT'}});
      expect(f.execute).not.toHaveBeenCalled();
    }finally{clock.mockRestore();f.db.close();}
  });
  it('rejects an earlier source changed during a later incident registry lookup', async () => {
    const f=fixture();
    try {
      await f.service.execute(actor,request);await f.service.execute(actor,{...request,incidentId:'incident-2'});
      const refs=[];
      for(const incidentId of [request.incidentId,'incident-2']){
        const report=await f.service.execute(actor,{operation:'report',incidentId,limit:32});
        refs.push((report as {value:{evidence:{reference:{incidentId:string;sequence:number;hash:string};observation:{source:string}}[]}}).value.evidence.find(row=>row.observation.source==='local_metrics')!.reference);
      }
      const original=f.workspaces.get.bind(f.workspaces);let lookups=0;
      f.workspaces.get=async(id):Promise<Workspace|null>=>{if(++lookups===2)f.db.connection.prepare('DELETE FROM incident_evidence WHERE incident_id=? AND sequence=?').run(refs[0]!.incidentId,refs[0]!.sequence);return original(id);};
      expect(await f.service.resolveEvidence(actor,'ws',refs)).toMatchObject({ok:false});
    }finally{f.db.close();}
  });
  it('resolves owned terminal evidence without probes and distinguishes registration replacement', async () => {
    const f = fixture();
    try {
      await f.service.execute(actor, request);
      const report = await f.service.execute(actor, { operation: 'report', incidentId: request.incidentId, limit: 32 });
      const references = (report as { value: { evidence: { reference: { incidentId: string; sequence: number; hash: string } }[] } }).value.evidence.map(row => row.reference);
      const calls = f.execute.mock.calls.length;
      expect(await f.service.resolveEvidence(actor, 'ws', references)).toMatchObject({ ok: true, value: references.map(reference => ({ reference, currentSupport: 'current', incidentHeaderHash: expect.any(String) })) });
      f.hosts.set('h1', { ...f.hosts.get('h1')!, pinnedFingerprint: 'SHA256:replaced' });
      const stale = await f.service.resolveEvidence(actor, 'ws', references);
      expect(stale.ok && stale.value.filter(row => row.observation.hostId === 'h1').every(row => row.currentSupport === 'stale')).toBe(true);
      expect(await f.service.resolveEvidence(actor, 'other-ws', references)).toMatchObject({ ok: false });
      expect(await f.service.resolveEvidence({ ...actor, clientId: 'other' }, 'ws', references)).toMatchObject({ ok: false });
      expect(await f.service.resolveEvidence(actor, 'ws', [{ ...references[0]!, hash: 'f'.repeat(64) }])).toMatchObject({ ok: false });
      expect(f.execute).toHaveBeenCalledTimes(calls);
    } finally { f.db.close(); }
  });
  it('rejects complete state when a valid evidence tail was deleted', async () => {
    const f = fixture();
    try {
      expect(await f.service.execute(actor, request)).toMatchObject({ ok: true, value: { state: 'complete' } });
      f.db.connection.prepare('DELETE FROM incident_evidence WHERE sequence=6').run();
      expect(await f.service.execute(actor, { operation: 'report', incidentId: request.incidentId })).toMatchObject({ ok: false });
    } finally { f.db.close(); }
  });
  it('does not invoke providers when policy is revoked during registry checks', async () => {
    const f = fixture();
    const original = f.workspaces.get;
    let calls = 0;
    f.workspaces.get = async (id): Promise<Workspace | null> => {
      const value = await original(id);
      if (++calls > 1) f.setProfile({ ...permissionProfiles.safe, defaults: { READ: 'DENY', WRITE: 'DENY', EXECUTE: 'DENY', DANGEROUS: 'DENY' } });
      return value;
    };
    try {
      expect(await f.service.execute(actor, request)).toMatchObject({ ok: false });
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.metrics.execute).not.toHaveBeenCalled();
      expect(f.changes.snapshot).not.toHaveBeenCalled();
    } finally { f.db.close(); }
  });
  it('bounds registry reads before collection and while reporting', async () => {
    const f = fixture(25);
    try {
      const normal = f.workspaces.get;
      f.workspaces.get = async (): Promise<Workspace | null> => new Promise(() => undefined);
      const start = Date.now();
      expect(await f.service.execute(actor, request)).toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
      expect(Date.now() - start).toBeLessThan(1000);
      expect(f.execute).not.toHaveBeenCalled();
      f.workspaces.get = normal;
      await f.service.execute(actor, request);
      f.workspaces.get = async (): Promise<Workspace | null> => new Promise(() => undefined);
      const reportStart = Date.now();
      expect(await f.service.execute(actor, { operation: 'report', incidentId: request.incidentId })).toMatchObject({ ok: true, value: { currentBindings: { registryDeadlineReached: true } } });
      expect(Date.now() - reportStart).toBeLessThan(1000);
    } finally { f.db.close(); }
  });
  it('refuses a stale mapping workspace even when its host remains resolved', async () => {
    const f = fixture();
    const service = new IncidentService({ repository: f.repository, workspaces: f.workspaces, hosts: { async get(id): Promise<TestHost | null> { return f.hosts.get(id) ?? null; } }, fleet: { execute: f.execute }, catalog: { execute: async (): Promise<Result<unknown>> => ok({ kind: 'mapping', workspaceStatus: 'stale', members: [{ hostId: 'h1', status: 'resolved' }] }) } });
    try {
      expect(await service.execute(actor, { operation: 'collect', incidentId: 'mapping-1', workspaceId: 'ws', selectionId: 'mapping', unit: 'app.service' })).toMatchObject({ ok: false });
      expect(f.execute).not.toHaveBeenCalled();
    } finally { f.db.close(); }
  });
  it('collects metadata, pages references, rejects changed requests and never replays', async () => {
    const f = fixture();
    try {
      expect(await f.service.execute(actor, request)).toMatchObject({ ok: true, value: { state: 'complete', retainedSources: 6, missingSources: 0 } });
      const report = await f.service.execute(actor, { operation: 'report', incidentId: request.incidentId, limit: 2 });
      expect(report).toMatchObject({ ok: true, value: { evidence: expect.any(Array), nextAfterSequence: 2 } });
      expect(JSON.stringify(report)).not.toContain('SECRET_CANARY');
      expect(await f.service.execute(actor, request)).toMatchObject({ ok: true });
      expect(f.execute).toHaveBeenCalledTimes(4);
      expect(await f.service.execute(actor, { ...request, unit: 'changed.service' })).toMatchObject({ ok: false });
      expect(await f.service.execute({ ...actor, clientId: 'other' }, { operation: 'report', incidentId: request.incidentId })).toMatchObject({ ok: false });
    } finally { f.db.close(); }
  });
  it('retains partial hosts and explicit gaps without saving provider errors', async () => {
    const f = fixture();
    const normal = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async input => (input as { hostIds: string[] }).hostIds[0] === 'h2' ? err(appError('CAPABILITY_UNAVAILABLE', 'SECRET_CANARY')) : normal(input));
    try {
      expect(await f.service.execute(actor, { ...request, hostIds: ['h1', 'h2'] })).toMatchObject({ ok: true, value: { state: 'partial', retainedSources: 10 } });
      const report = await f.service.execute(actor, { operation: 'report', incidentId: request.incidentId, limit: 32 });
      expect(JSON.stringify(report)).not.toContain('SECRET_CANARY');
      expect(JSON.stringify(report)).toContain('unavailable');
    } finally { f.db.close(); }
  });
  it('bounds a hung provider and fences late results without restarting reads', async () => {
    const f = fixture(25);
    let release: (() => void) | undefined;
    f.execute.mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; }); return ok({ hosts: [] }); });
    try {
      const start = Date.now();
      expect(await f.service.execute(actor, request)).toMatchObject({ ok: true, value: { state: 'interrupted', missingObservations: expect.arrayContaining([expect.objectContaining({ source: 'health', status: 'interrupted' })]) } });
      expect(Date.now() - start).toBeLessThan(1000);
      const count = f.repository.summary(createHash('sha256').update(actor.clientId).digest('hex'), request.incidentId)?.count;
      release?.(); await new Promise(resolve => setTimeout(resolve, 5));
      expect(f.repository.summary(createHash('sha256').update(actor.clientId).digest('hex'), request.incidentId)?.count).toBe(count);
      await f.service.execute(actor, request);
      expect(f.execute).toHaveBeenCalledTimes(1);
    } finally { release?.(); f.db.close(); }
  });
  it('checks confirmation and revoked policy, and rejects unregistered hosts', async () => {
    const f = fixture();
    try {
      f.setProfile(permissionProfiles.safe);
      expect(await f.service.execute(actor, request)).toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
      expect(f.execute).not.toHaveBeenCalled();
      expect(await f.service.execute(actor, { ...request, hostIds: ['unknown'], userConfirmed: true })).toMatchObject({ ok: false });
      f.setProfile(permissionProfiles.balanced);
      f.metrics.execute.mockImplementation(async () => { f.setProfile({ ...permissionProfiles.safe, defaults: { READ: 'DENY', WRITE: 'DENY', EXECUTE: 'DENY', DANGEROUS: 'DENY' } }); return ok({}); });
      expect(await f.service.execute(actor, request)).toMatchObject({ ok: false });
    } finally { f.db.close(); }
  });
  it('reports current registration drift separately and rejects forged stored data', async () => {
    const f = fixture();
    try {
      await f.service.execute(actor, request);
      f.hosts.set('h1', { ...f.hosts.get('h1')!, roots: ['/changed'] });
      expect(await f.service.execute(actor, { operation: 'report', incidentId: request.incidentId })).toMatchObject({ ok: true, value: { currentBindings: { hosts: [{ hostId: 'h1', status: 'stale' }] } } });
      const owner = createHash('sha256').update(actor.clientId).digest('hex');
      const row = f.repository.listEvidence(owner, request.incidentId, 0, 1)[0]!;
      const payload = { ...(row.payload as Record<string, unknown>), secret: 'SECRET_CANARY' };
      const json = JSON.stringify(payload, Object.keys(payload).sort());
      f.db.connection.prepare('UPDATE incident_evidence SET payload_json=?,hash=? WHERE owner_key=? AND sequence=1').run(json, createHash('sha256').update(json).digest('hex'), owner);
      expect(await f.service.execute(actor, { operation: 'report', incidentId: request.incidentId })).toMatchObject({ ok: false });
    } finally { f.db.close(); }
  });
});
