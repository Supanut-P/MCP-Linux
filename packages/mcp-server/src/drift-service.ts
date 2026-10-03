import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import { fleetHostFingerprint, fleetWorkspaceFingerprint, type FileActor } from '@baitonghub-linux-mcp/application';
import { DefaultPermissionEngine, permissionProfiles, type PermissionProfile } from '@baitonghub-linux-mcp/permissions';
import type { WorkspaceRepository } from '@baitonghub-linux-mcp/workspace';
import type { RemoteFleetRuntime } from './remote-fleet-runtime.js';
import { projectDriftValue, compareDriftObservations, validateDriftObservation, type DriftObservation } from './drift-projection.js';

type State = 'collecting' | 'complete' | 'partial' | 'unavailable' | 'interrupted';
interface Snapshot { id: string; ownerKey: string; kind: 'capture' | 'comparison'; requestFingerprint: string; runToken: string; state: State; header: unknown; createdAt: number; expiresAt: number; updatedAt: number; snapshotHash: string | null; approvedAt: number | null }
interface Evidence { snapshotId: string; sequence: number; hash: string; payload: unknown }
export interface DriftRepositoryPort {
  get(owner: string, id: string): Snapshot | null;
  create(record: Snapshot): boolean;
  append(owner: string, id: string, token: string, payload: unknown, now: number): Evidence | null;
  listEvidence(owner: string, id: string, afterSequence?: number, limit?: number): readonly Evidence[];
  summary(owner: string, id: string): { count: number; bytes: number } | null;
  finish(owner: string, id: string, token: string, state: Exclude<State, 'collecting'>, now: number): Snapshot | null;
  approve(owner: string, id: string, exactHash: string, now: number): Snapshot | null;
}
interface Host { id: string; host: string; port: number; username: string; secretRef: string; pinnedFingerprint: string; roots: readonly string[]; createdAt: string }
interface Target { id: string; hostId: string; kind: 'service' | 'config' | 'artifact'; unit?: string; path?: string }
interface BoundTarget extends Target { hostFingerprint: string }
interface Header { schema: 1; projection: 'drift-states-v1'; workspaceId: string; workspaceFingerprint: string; targets: readonly BoundTarget[]; baseline?: { id: string; hash: string } }
interface Request { operation: 'capture' | 'approve' | 'compare' | 'status'; snapshotId: string; workspaceId?: string; targets?: readonly Target[]; snapshotHash?: string; baselineId?: string; baselineHash?: string; userConfirmed?: boolean }
export interface DriftServiceOptions { repository: DriftRepositoryPort; workspaces: WorkspaceRepository; hosts: { get(id: string): Promise<Host | null> }; fleet?: Pick<RemoteFleetRuntime, 'execute'>; profileProvider?: () => PermissionProfile; /** Harness only; never caller-controlled. */ deadlineMs?: number }
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SHA = /^[a-f0-9]{64}$/;
const UNIT = /^[A-Za-z0-9_.@:-]{1,256}\.(service|socket|timer|path)$/;
const REGISTRY_TIMEOUT = Symbol('registry-timeout');

/** Immutable observations and explicit baseline selection; never remote mutations. */
export class DriftService {
  private readonly permission = new DefaultPermissionEngine();
  private readonly deadlineMs: number;
  public constructor(private readonly options: DriftServiceOptions) { this.deadlineMs = Math.max(1, Math.min(60_000, Number.isFinite(options.deadlineMs) ? Math.floor(options.deadlineMs!) : 60_000)); }

  public async execute(actor: FileActor, input: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
    const deadline = Date.now() + this.deadlineMs;
    try {
      const request = parseRequest(input);
      if (request === null || typeof actor.clientId !== 'string' || !actor.clientId.trim() || actor.clientId.includes('\0') || Buffer.byteLength(actor.clientId) > 512) return invalid();
      const permission = this.authorize(request); if (!permission.ok) return permission;
      if (signal?.aborted) return cancelled();
      const owner = hash(actor.clientId);
      const stored = this.options.repository.get(owner, request.snapshotId);
      if (request.operation === 'status') return stored === null ? invalid() : this.view(request, stored, deadline, signal);
      if (request.operation === 'approve') {
        if (stored === null || stored.kind !== 'capture' || stored.state !== 'complete' || stored.snapshotHash !== request.snapshotHash || request.userConfirmed !== true) return invalid();
        const header = parseHeader(stored.header); if (header === null || !this.readRows(stored, header)) return invalid();
        const bindings = await Promise.all(header.targets.map(target => this.bindingStatus(header, target, deadline, signal)));
        if (bindings.some(value => value !== 'ok') || signal?.aborted || Date.now() >= deadline) return invalid();
        const currentPermission = this.authorize({ ...request, workspaceId: header.workspaceId }); if (!currentPermission.ok) return currentPermission;
        const approved = this.options.repository.approve(owner, stored.id, request.snapshotHash!, Date.now());
        return approved === null ? invalid() : this.view(request, approved, deadline, signal);
      }
      let baseline: Snapshot | null = null;
      if (request.operation === 'compare') {
        baseline = this.options.repository.get(owner, request.baselineId!);
        if (baseline === null || baseline.kind !== 'capture' || baseline.state !== 'complete' || baseline.approvedAt === null || baseline.snapshotHash !== request.baselineHash) return invalid();
      }
      const fingerprint = hash(JSON.stringify(request.operation === 'capture' ? ['capture', request.workspaceId, request.targets!.map(canonicalTarget).sort((a,b) => a.id.localeCompare(b.id))] : ['compare', request.baselineId, request.baselineHash]));
      if (stored !== null) return stored.requestFingerprint !== fingerprint ? invalid() : this.view(request, stored, deadline, signal);
      let header: Header;
      if (baseline !== null) {
        const baselineHeader = parseHeader(baseline.header); if (baselineHeader === null || !this.readRows(baseline, baselineHeader)) return invalid();
        header = { ...baselineHeader, baseline: { id: baseline.id, hash: baseline.snapshotHash! } };
      } else {
        const bound = await this.bind(request, deadline, signal); if (!bound.ok) return bound; header = bound.value;
      }
      if (signal?.aborted || Date.now() >= deadline) return cancelled();
      const currentPermission = this.authorize({ ...request, workspaceId: header.workspaceId }); if (!currentPermission.ok) return currentPermission;
      const now = Date.now();
      const entry: Snapshot = { id: request.snapshotId, ownerKey: owner, kind: request.operation === 'capture' ? 'capture' : 'comparison', requestFingerprint: fingerprint, runToken: randomBytes(32).toString('hex'), state: 'collecting', header, createdAt: now, expiresAt: deadline, updatedAt: now, snapshotHash: null, approvedAt: null };
      if (!this.options.repository.create(entry)) {
        const concurrent = this.options.repository.get(owner, entry.id);
        return concurrent?.requestFingerprint === fingerprint ? this.view(request, concurrent, deadline, signal) : invalid();
      }
      await this.collect(request, entry, header, signal);
      const finalPermission = this.authorize({ ...request, workspaceId: header.workspaceId }); if (!finalPermission.ok) return finalPermission;
      if (signal?.aborted) return cancelled();
      const completed = this.options.repository.get(owner, entry.id);
      return completed === null ? invalid() : this.view(request, completed, deadline, signal);
    } catch { return invalid(); }
  }

  private authorize(request: Request): Result<void> {
    for (const level of request.operation === 'status' ? ['READ'] as const : ['READ','WRITE'] as const) {
      const decision = this.permission.decide(this.options.profileProvider?.() ?? permissionProfiles.balanced, { action: `drift_${request.operation}`, level, workspaceId: request.workspaceId ?? '', target: request.snapshotId, destructive: false });
      if (decision === 'DENY' || (decision === 'ASK' && request.userConfirmed !== true)) return err(appError(decision === 'DENY' ? 'PERMISSION_DENIED' : 'PERMISSION_REQUIRED','Drift access requires current policy permission'));
    }
    return ok(undefined);
  }

  private async bind(request: Request, deadline: number, signal?: AbortSignal): Promise<Result<Header>> {
    const workspace = await deadlineRead(() => this.options.workspaces.get(request.workspaceId!), deadline, signal);
    if (workspace === REGISTRY_TIMEOUT || signal?.aborted || Date.now() >= deadline) return cancelled();
    if (workspace === null || workspace.archivedAt) return invalid();
    const targets: BoundTarget[] = [];
    for (const target of request.targets!) {
      const host = await deadlineRead(() => this.options.hosts.get(target.hostId), deadline, signal);
      if (host === REGISTRY_TIMEOUT || signal?.aborted || Date.now() >= deadline) return cancelled();
      if (host === null || (target.path !== undefined && !host.roots.some(root => within(root,target.path!)))) return invalid();
      targets.push({ ...canonicalTarget(target), hostFingerprint: fleetHostFingerprint(host) });
    }
    return ok({ schema: 1, projection: 'drift-states-v1', workspaceId: workspace.id, workspaceFingerprint: fleetWorkspaceFingerprint(workspace), targets });
  }

  private async bindingStatus(header: Header, target: BoundTarget, deadline: number, signal?: AbortSignal): Promise<'ok' | 'stale' | 'unavailable'> {
    const workspace = await deadlineRead(() => this.options.workspaces.get(header.workspaceId), deadline, signal);
    if (workspace === null || workspace === REGISTRY_TIMEOUT || workspace.archivedAt) return 'unavailable';
    if (fleetWorkspaceFingerprint(workspace) !== header.workspaceFingerprint) return 'stale';
    const host = await deadlineRead(() => this.options.hosts.get(target.hostId), deadline, signal);
    return host === null || host === REGISTRY_TIMEOUT ? 'unavailable' : fleetHostFingerprint(host) !== target.hostFingerprint ? 'stale' : 'ok';
  }

  private async collect(request: Request, entry: Snapshot, header: Header, signal?: AbortSignal): Promise<void> {
    const controller = new AbortController(), abort = (): void => controller.abort();
    signal?.addEventListener('abort',abort,{once:true});
    const timer = setTimeout(abort,Math.max(1,entry.expiresAt-Date.now()));
    let index = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const target = header.targets[index++];
        if (target === undefined || controller.signal.aborted || !this.authorize({ ...request,workspaceId:header.workspaceId }).ok) return;
        let status: DriftObservation['status'] = await this.bindingStatus(header,target,entry.expiresAt,controller.signal);
        if (controller.signal.aborted || !this.authorize({ ...request,workspaceId:header.workspaceId }).ok) return;
        let value: unknown, truncated = false;
        if (status === 'ok') {
          const result = await boundedRead(async () => await this.options.fleet?.execute({ hostIds:[target.hostId], operation:target.kind==='service'?'service-status':'checksum', ...(target.unit===undefined?{}:{unit:target.unit}), ...(target.path===undefined?{}:{path:target.path}), maxParallel:1 },controller.signal) ?? err(appError('CAPABILITY_UNAVAILABLE','Drift source unavailable',true)),controller.signal);
          if (!result.ok || !record(result.value) || !Array.isArray(result.value.hosts)) status = !result.ok && result.error.code==='PROCESS_TIMEOUT'?'timeout':'unavailable';
          else {
            const member = result.value.hosts[0];
            if (!record(member) || member.hostId!==target.hostId || member.status!=='ok') status=record(member)&&member.hostId===target.hostId&&record(member.error)&&member.error.code==='PROCESS_TIMEOUT'?'timeout':'unavailable';
            else { value=member.value; truncated=member.truncated===true; }
          }
          const after = await this.bindingStatus(header,target,entry.expiresAt,controller.signal); if (after!=='ok') status=after;
        }
        if (controller.signal.aborted || !this.authorize({ ...request,workspaceId:header.workspaceId }).ok) return;
        const projected = status==='ok'?(truncated?{status:'truncated' as const,truncated:true,value:null}:projectDriftValue(target.kind,value)):null;
        if (projected?.status==='unavailable') status='unavailable';
        this.options.repository.append(entry.ownerKey,entry.id,entry.runToken,{targetId:target.id,status,observedAt:new Date().toISOString(),sourceTime:null,truncated:truncated||projected?.truncated===true,value:status==='ok'?projected?.value??null:null},Date.now());
      }
    };
    try {
      await Promise.all(Array.from({length:Math.min(4,header.targets.length)},()=>worker()));
      if (!this.authorize({ ...request,workspaceId:header.workspaceId }).ok) return;
      const rows = this.options.repository.listEvidence(entry.ownerKey,entry.id,0,20);
      const good = rows.filter(row=>record(row.payload)&&row.payload.status==='ok'&&row.payload.truncated===false).length;
      this.options.repository.finish(entry.ownerKey,entry.id,entry.runToken,controller.signal.aborted?'interrupted':good===header.targets.length?'complete':good>0?'partial':'unavailable',Date.now());
    } finally { clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort(); }
  }

  private readRows(entry: Snapshot, header: Header): readonly Evidence[] | null {
    const rows=this.options.repository.listEvidence(entry.ownerKey,entry.id,0,20), summary=this.options.repository.summary(entry.ownerKey,entry.id);
    if (summary===null || rows.length!==summary.count || rows.length>header.targets.length) return null;
    const seen=new Set<string>();
    for (const row of rows) {
      if (!record(row.payload) || typeof row.payload.targetId!=='string' || seen.has(row.payload.targetId)) return null;
      const payload=row.payload;
      const target=header.targets.find(item=>item.id===payload.targetId);
      if (target===undefined || !validateDriftObservation(target.kind,payload)) return null;
      seen.add(payload.targetId as string);
    }
    const good=rows.filter(row=>record(row.payload)&&row.payload.status==='ok'&&row.payload.truncated===false).length;
    if ((entry.state==='complete'&&good!==header.targets.length)||(entry.state==='partial'&&(good===0||good>=header.targets.length))||(entry.state==='unavailable'&&good!==0)) return null;
    return rows;
  }

  private async view(request: Request, entry: Snapshot, deadline: number, signal?: AbortSignal): Promise<Result<unknown>> {
    const header=parseHeader(entry.header); if (header===null || (entry.kind==='comparison')!==(header.baseline!==undefined)) return invalid();
    const rows=this.readRows(entry,header); if (rows===null) return invalid();
    const state=entry.state==='collecting'&&Date.now()>entry.expiresAt?'interrupted':entry.state;
    const bindings=await Promise.all(header.targets.map(async target=>({targetId:target.id,status:await this.bindingStatus(header,target,deadline,signal)})));
    if (signal?.aborted) return cancelled();
    const permission=this.authorize({...request,workspaceId:header.workspaceId});if(!permission.ok)return permission;
    let drift:unknown;
    if (header.baseline!==undefined) {
      const baseline=this.options.repository.get(entry.ownerKey,header.baseline.id), baselineHeader=baseline===null?null:parseHeader(baseline.header);
      if (baseline===null||baseline.kind!=='capture'||baseline.state!=='complete'||baseline.approvedAt===null||baseline.snapshotHash!==header.baseline.hash||baselineHeader===null) return invalid();
      const baselineRows=this.readRows(baseline,baselineHeader);if(baselineRows===null)return invalid();
      if (JSON.stringify(header.targets)!==JSON.stringify(baselineHeader.targets)||header.workspaceFingerprint!==baselineHeader.workspaceFingerprint||header.workspaceId!==baselineHeader.workspaceId) return invalid();
      const results=header.targets.map(target=>{
        const previous=baselineRows.find(row=>record(row.payload)&&row.payload.targetId===target.id),current=rows.find(row=>record(row.payload)&&row.payload.targetId===target.id);
        // Historical comparison never changes after capture; current binding drift is separate.
        const result=compareDriftObservations(target.kind,(previous?.payload??null) as DriftObservation|null,(current?.payload??null) as DriftObservation|null,header.projection!==baselineHeader.projection);
        return {targetId:target.id,...result,baselineReference:previous===undefined?null:{snapshotId:baseline.id,sequence:previous.sequence,hash:previous.hash},currentReference:current===undefined?null:{snapshotId:entry.id,sequence:current.sequence,hash:current.hash}};
      });
      const summary=Object.fromEntries(['stale','unavailable','truncated','changed','unchanged'].map(status=>[status,results.filter(row=>row.status===status).length]));
      drift={baselineId:baseline.id,baselineHash:baseline.snapshotHash,results,summary};
    }
    return ok({snapshotId:entry.id,kind:entry.kind,state,snapshotHash:entry.snapshotHash,approvedAt:entry.approvedAt,createdAt:entry.createdAt,expiresAt:entry.expiresAt,updatedAt:entry.updatedAt,workspaceId:header.workspaceId,projection:header.projection,targets:header.targets.map(target=>({id:target.id,hostId:target.hostId,kind:target.kind,...(target.unit===undefined?{}:{unit:target.unit}),...(target.path===undefined?{}:{pathFingerprint:hash(target.path)})})),observations:rows.map(row=>({reference:{snapshotId:entry.id,sequence:row.sequence,hash:row.hash},observation:row.payload})),missingTargets:header.targets.filter(target=>!rows.some(row=>record(row.payload)&&row.payload.targetId===target.id)).map(target=>({targetId:target.id,status:state==='collecting'?'pending':'interrupted',gap:true})),currentBindings:{targets:bindings,registryDeadlineReached:Date.now()>=deadline},...(drift===undefined?{}:{drift}),boundary:'Immutable byte/state observations; approvals are caller-attested baseline selection, not remote write authority or tenant authentication. Config digest equality is not effective configuration equality; raw content, errors and paths omitted.'});
  }
}

function parseRequest(value:unknown):Request|null {
  if(!record(value)||typeof value.snapshotId!=='string'||!ID.test(value.snapshotId)||!['capture','approve','compare','status'].includes(String(value.operation)))return null;
  const allowed=value.operation==='capture'?['workspaceId','targets']:value.operation==='approve'?['snapshotHash']:value.operation==='compare'?['baselineId','baselineHash']:[];
  if(Object.keys(value).some(key=>!['operation','snapshotId','userConfirmed',...allowed].includes(key))||(value.userConfirmed!==undefined&&typeof value.userConfirmed!=='boolean'))return null;
  if(value.operation==='capture'&&(typeof value.workspaceId!=='string'||!ID.test(value.workspaceId)||!Array.isArray(value.targets)||value.targets.length<1||value.targets.length>20||value.targets.some(target=>!validTarget(target))||new Set(value.targets.map(t=>(t as Target).id)).size!==value.targets.length))return null;
  if(value.operation==='approve'&&(typeof value.snapshotHash!=='string'||!SHA.test(value.snapshotHash)))return null;
  if(value.operation==='compare'&&(typeof value.baselineId!=='string'||!ID.test(value.baselineId)||typeof value.baselineHash!=='string'||!SHA.test(value.baselineHash)||value.baselineId===value.snapshotId))return null;
  return value as unknown as Request;
}
function parseHeader(value:unknown):Header|null {
  if(!record(value)||Object.keys(value).some(key=>!['schema','projection','workspaceId','workspaceFingerprint','targets','baseline'].includes(key))||value.schema!==1||value.projection!=='drift-states-v1'||typeof value.workspaceId!=='string'||!ID.test(value.workspaceId)||typeof value.workspaceFingerprint!=='string'||!SHA.test(value.workspaceFingerprint)||!Array.isArray(value.targets)||value.targets.length<1||value.targets.length>20)return null;
  if(value.targets.some(target=>!record(target)||typeof target.hostFingerprint!=='string'||!SHA.test(target.hostFingerprint)||!validTarget(target,true))||new Set(value.targets.map(t=>(t as Target).id)).size!==value.targets.length)return null;
  if(value.baseline!==undefined&&(!record(value.baseline)||Object.keys(value.baseline).some(key=>!['id','hash'].includes(key))||typeof value.baseline.id!=='string'||!ID.test(value.baseline.id)||typeof value.baseline.hash!=='string'||!SHA.test(value.baseline.hash)))return null;
  return value as unknown as Header;
}
function validTarget(value:unknown,bound=false):value is Target {
  if(!record(value)||typeof value.id!=='string'||!ID.test(value.id)||typeof value.hostId!=='string'||!ID.test(value.hostId)||!['service','config','artifact'].includes(String(value.kind)))return false;
  if(Object.keys(value).some(key=>!['id','hostId','kind',value.kind==='service'?'unit':'path',...(bound?['hostFingerprint']:[])].includes(key)))return false;
  if(value.kind==='service')return typeof value.unit==='string'&&!value.unit.startsWith('-')&&UNIT.test(value.unit)&&!/^(shutdown|reboot|emergency|rescue)\.service$/.test(value.unit);
  if(typeof value.path!=='string'||Buffer.byteLength(value.path)>1024||!value.path.startsWith('/')||Array.from(value.path).some(character=>character.charCodeAt(0)<=31||character.charCodeAt(0)===127||character==='\\')||path.posix.normalize(value.path)!==value.path)return false;
  const name=path.posix.basename(value.path).toLowerCase();
  return name!=='.env'&&!name.startsWith('.env.')&&name!=='id_rsa'&&name!=='id_ed25519'&&name!=='credentials'&&!name.startsWith('secret')&&!name.includes('password');
}
function canonicalTarget(target:Target):Target{return{id:target.id,hostId:target.hostId,kind:target.kind,...(target.kind==='service'?{unit:target.unit!}:{path:target.path!})};}
function within(root:string,candidate:string):boolean{const relative=path.posix.relative(root,candidate);return path.posix.isAbsolute(root)&&(relative===''||(relative!=='..'&&!relative.startsWith('../')&&!path.posix.isAbsolute(relative)));}
async function boundedRead(read:()=>Promise<Result<unknown>>,signal:AbortSignal):Promise<Result<unknown>> {
  if(signal.aborted)return cancelled();let abort:(()=>void)|undefined;
  try{const stopped=new Promise<Result<unknown>>(resolve=>{abort=():void=>resolve(cancelled());signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});if(signal.aborted)return cancelled();return await Promise.race([read(),stopped]);}catch{return err(appError('CAPABILITY_UNAVAILABLE','Drift source unavailable',true));}finally{if(abort!==undefined)signal.removeEventListener('abort',abort);}
}
async function deadlineRead<T>(read:()=>Promise<T>,deadline:number,signal?:AbortSignal):Promise<T|null|typeof REGISTRY_TIMEOUT>{if(Date.now()>=deadline||signal?.aborted)return REGISTRY_TIMEOUT;const controller=new AbortController(),abort=():void=>controller.abort();signal?.addEventListener('abort',abort,{once:true});const timer=setTimeout(abort,Math.max(1,deadline-Date.now()));try{const result=await boundedRead(async()=>ok(await read()),controller.signal);return result.ok?result.value as T:result.error.code==='PROCESS_TIMEOUT'?REGISTRY_TIMEOUT:null;}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();}}
function hash(value:string):string{return createHash('sha256').update(value).digest('hex');}
function record(value:unknown):value is Record<string,unknown>{return typeof value==='object'&&value!==null&&!Array.isArray(value);}
function invalid():Result<never>{return err(appError('INVALID_INPUT','Drift request, approved baseline or retained evidence is invalid'));}
function cancelled():Result<never>{return err(appError('PROCESS_TIMEOUT','Drift request cancelled or timed out',true));}
