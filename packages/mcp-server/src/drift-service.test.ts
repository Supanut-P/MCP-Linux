import { createHash } from 'node:crypto';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { ok, err, appError, type Result } from '@baitonghub-linux-mcp/domain';
import { SqliteDatabase, SqliteDriftRepository } from '@baitonghub-linux-mcp/storage';
import { permissionProfiles, type PermissionProfile } from '@baitonghub-linux-mcp/permissions';
import type { Workspace, WorkspaceRepository } from '@baitonghub-linux-mcp/workspace';
import { DriftService } from './drift-service.js';

const actor={clientId:'drift-owner',clientName:'fixture'};
const targets=[{id:'api',hostId:'h1',kind:'service' as const,unit:'api.service'},{id:'config',hostId:'h1',kind:'config' as const,path:'/srv/app.conf'}];
type TestHost={id:string;host:string;port:number;username:string;secretRef:string;pinnedFingerprint:string;roots:string[];createdAt:string};
interface Fixture{db:SqliteDatabase;repository:SqliteDriftRepository;service:DriftService;hosts:Map<string,TestHost>;workspaces:WorkspaceRepository;execute:Mock<(input:unknown,signal?:AbortSignal)=>Promise<Result<unknown>>>;setWorkspace(w:Workspace|null):void;setProfile(p:PermissionProfile):void}
function fixture(deadlineMs=1000):Fixture{
  const db=new SqliteDatabase(':memory:'),repository=new SqliteDriftRepository(db);
  let workspace:Workspace|null={id:'ws',displayName:'fixture',rootPath:'/repo',realRootPath:'/repo',createdAt:'2026-10-03T00:00:00Z'};
  const workspaces:WorkspaceRepository={async get(id){return id==='ws'?workspace:null;},async list(){return workspace?[workspace]:[];},async insert(){},async delete(){}};
  const host={id:'h1',host:'127.0.0.1',port:22,username:'fixture',secretRef:'SECRET_CANARY',pinnedFingerprint:'SHA256:fixture',roots:['/srv'],createdAt:'2026-10-03T00:00:00Z'};
  const hosts=new Map([['h1',host],['h2',{...host,id:'h2'}]]);
  const execute=vi.fn<(input:unknown,signal?:AbortSignal)=>Promise<Result<unknown>>>(async(input:unknown)=>{
    const q=input as {hostIds:string[];operation:string;path?:string};
    const value=q.operation==='service-status'?{output:'LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled',exitCode:0}:{output:`${'a'.repeat(64)}  ${q.path??'/srv/file'}`,exitCode:0};
    return ok({hosts:[{hostId:q.hostIds[0],status:'ok',value}]});
  });
  let profile:PermissionProfile=permissionProfiles.balanced;
  const service=new DriftService({repository,workspaces,hosts:{async get(id:string):Promise<TestHost|null>{return hosts.get(id)??null;}},fleet:{execute},profileProvider:():PermissionProfile=>profile,deadlineMs});
  return{db,repository,service,hosts,workspaces,execute,setWorkspace(w:Workspace|null):void{workspace=w;},setProfile(p:PermissionProfile):void{profile=p;}};
}
const hash=(value:string):string=>createHash('sha256').update(value).digest('hex');
const capture=(snapshotId='capture-1',list:typeof targets[number][]=targets):{operation:string;snapshotId:string;workspaceId:string;targets:typeof targets[number][]}=>({operation:'capture',snapshotId,workspaceId:'ws',targets:list});
const denied:PermissionProfile={...permissionProfiles.safe,defaults:{READ:'DENY',WRITE:'DENY',EXECUTE:'DENY',DANGEROUS:'DENY'}};

describe('DriftService coordinator acceptance',()=>{
  it('preserves timer cancellation even when the wall clock has not reached the deadline',async()=>{const f=fixture(15);const clock=vi.spyOn(Date,'now').mockReturnValue(Date.now());try{
    f.workspaces.get=async():Promise<Workspace|null>=>new Promise(()=>undefined);
    expect(await f.service.execute(actor,capture())).toMatchObject({ok:false,error:{code:'PROCESS_TIMEOUT'}});
    expect(f.execute).not.toHaveBeenCalled();
  }finally{clock.mockRestore();f.db.close();}});
  it('rejects option-shaped service units before any provider dispatch',async()=>{const f=fixture();try{
    for(const unit of ['-Hother.service','-Mcontainer.service'])expect(await f.service.execute(actor,capture(`option-${unit}`, [{id:'api',hostId:'h1',kind:'service',unit}]))).toMatchObject({ok:false});
    expect(f.execute).not.toHaveBeenCalled();
  }finally{f.db.close();}});
  it('retains aggregate host timeout status without its raw error message',async()=>{const f=fixture();try{
    f.execute.mockImplementation(async(input)=>{const q=input as {hostIds:string[]};return ok({hosts:[{hostId:q.hostIds[0],status:'error',error:{code:'PROCESS_TIMEOUT',message:'SECRET_CANARY'}}]});});
    const result=await f.service.execute(actor,capture());
    expect(result).toMatchObject({ok:true,value:{state:'unavailable',observations:[{observation:{status:'timeout'}},{observation:{status:'timeout'}}]}});
    expect(JSON.stringify(result)).not.toContain('SECRET_CANARY');
  }finally{f.db.close();}});
  it('rejects approval after registration replacement and compares stale bindings without probes',async()=>{const f=fixture();try{
    const base=await f.service.execute(actor,capture());const baselineHash=(base as {value:{snapshotHash:string}}).value.snapshotHash;
    const original=f.hosts.get('h1')!;f.hosts.set('h1',{...original,pinnedFingerprint:'SHA256:replacement'});
    expect(await f.service.execute(actor,{operation:'approve',snapshotId:'capture-1',snapshotHash:baselineHash,userConfirmed:true})).toMatchObject({ok:false});
    f.hosts.set('h1',original);
    expect(await f.service.execute(actor,{operation:'approve',snapshotId:'capture-1',snapshotHash:baselineHash,userConfirmed:true})).toMatchObject({ok:true});
    f.hosts.set('h1',{...original,pinnedFingerprint:'SHA256:replacement'});
    expect(await f.service.execute(actor,{operation:'compare',snapshotId:'stale-compare',baselineId:'capture-1',baselineHash})).toMatchObject({ok:true,value:{drift:{summary:{stale:2,unchanged:0}}}});
    expect(f.execute).toHaveBeenCalledTimes(2);
  }finally{f.db.close();}});
  it('captures, requires explicit confirmation, and approves the exact hash after binding checks',async()=>{const f=fixture();try{
    const collected=await f.service.execute(actor,capture());expect(collected).toMatchObject({ok:true,value:{kind:'capture',state:'complete',observations:[expect.any(Object),expect.any(Object)]}});
    const hashValue=(collected as {value:{snapshotHash:string}}).value.snapshotHash;
    expect(await f.service.execute(actor,{operation:'approve',snapshotId:'capture-1',snapshotHash:hashValue})).toMatchObject({ok:false});
    expect(await f.service.execute(actor,{operation:'approve',snapshotId:'capture-1',snapshotHash:'f'.repeat(64),userConfirmed:true})).toMatchObject({ok:false});
    const approved=await f.service.execute(actor,{operation:'approve',snapshotId:'capture-1',snapshotHash:hashValue,userConfirmed:true});expect(approved).toMatchObject({ok:true,value:{state:'complete',snapshotHash:hashValue,approvedAt:expect.any(Number)}});
  }finally{f.db.close();}});
  it('compares changed and unchanged values, and never calls incomplete observations unchanged',async()=>{const f=fixture();try{
    const base=await f.service.execute(actor,capture());const baselineHash=(base as {value:{snapshotHash:string}}).value.snapshotHash;
    await f.service.execute(actor,{operation:'approve',snapshotId:'capture-1',snapshotHash:baselineHash,userConfirmed:true});
    f.execute.mockImplementation(async(input)=>{const q=input as {operation:string;hostIds:string[]};const isService=q.operation==='service-status';return ok({hosts:[{hostId:q.hostIds[0],status:'ok',value:isService?{output:'LoadState=loaded\nActiveState=inactive\nSubState=dead\nUnitFileState=enabled',exitCode:0}:{output:`${'b'.repeat(64)}  /srv/app.conf`,exitCode:0}}]});});
    const changed=await f.service.execute(actor,{operation:'compare',snapshotId:'compare-1',baselineId:'capture-1',baselineHash});expect(changed).toMatchObject({ok:true,value:{drift:{summary:{changed:2,unchanged:0}}}});
    f.execute.mockImplementation(async(input)=>{const q=input as {operation:string;hostIds:string[]};const isService=q.operation==='service-status';return ok({hosts:[{hostId:q.hostIds[0],status:'ok',value:isService?{output:'LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled',exitCode:0}:{output:`${'a'.repeat(64)}  /srv/app.conf`,exitCode:0}}]});});
    const same=await f.service.execute(actor,{operation:'compare',snapshotId:'compare-2',baselineId:'capture-1',baselineHash});expect(same).toMatchObject({ok:true,value:{drift:{summary:{changed:0,unchanged:2}}}});
    f.execute.mockImplementation(async(input)=>{const q=input as {hostIds:string[];operation:string};const value=q.operation==='service-status'?{output:'LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled',exitCode:0}:{output:`${'a'.repeat(64)}  /srv/app.conf`,exitCode:0};return ok({hosts:[{hostId:q.hostIds[0],status:'ok',truncated:true,value}]});});
    const truncated=await f.service.execute(actor,{operation:'compare',snapshotId:'compare-3',baselineId:'capture-1',baselineHash});expect(truncated).toMatchObject({ok:true,value:{drift:{summary:{truncated:2,unchanged:0}}}});
    f.execute.mockImplementation(async(input)=>{const q=input as {hostIds:string[];operation:string};const value=q.operation==='service-status'?{output:'LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled',exitCode:0}:{output:'partial malformed checksum',exitCode:0};return ok({hosts:[{hostId:q.hostIds[0],status:'ok',truncated:true,value}]});});
    const partialTruncated=await f.service.execute(actor,{operation:'compare',snapshotId:'compare-3b',baselineId:'capture-1',baselineHash});expect(partialTruncated).toMatchObject({ok:true,value:{drift:{summary:{truncated:2,unchanged:0}}}});
    f.execute.mockImplementation(async()=>err(appError('CAPABILITY_UNAVAILABLE','SECRET_CANARY')));
    const unavailable=await f.service.execute(actor,{operation:'compare',snapshotId:'compare-4',baselineId:'capture-1',baselineHash});expect(unavailable).toMatchObject({ok:true,value:{drift:{summary:{unavailable:2,unchanged:0}}}});
  }finally{f.db.close();}});
  it('accepts a reordered identical request without replay and rejects changed reuse of an ID',async()=>{const f=fixture();try{
    expect(await f.service.execute(actor,capture())).toMatchObject({ok:true});const calls=f.execute.mock.calls.length;
    expect(await f.service.execute(actor,capture('capture-1',[...targets].reverse()))).toMatchObject({ok:true});expect(f.execute).toHaveBeenCalledTimes(calls);
    expect(await f.service.execute(actor,capture('capture-1',[targets[0]!]))).toMatchObject({ok:false});expect(f.execute).toHaveBeenCalledTimes(calls);
  }finally{f.db.close();}});
  it('isolates owners and rejects unknown hosts and paths outside registered roots',async()=>{const f=fixture();try{
    expect(await f.service.execute(actor,capture())).toMatchObject({ok:true});expect(await f.service.execute({clientId:'other',clientName:'x'},{operation:'status',snapshotId:'capture-1'})).toMatchObject({ok:false});
    expect(await f.service.execute(actor,capture('unknown-host',[{...targets[0]!,hostId:'missing'}]))).toMatchObject({ok:false});
    expect(await f.service.execute(actor,capture('outside-root',[{id:'file',hostId:'h1',kind:'artifact',path:'/etc/shadow'}]))).toMatchObject({ok:false});expect(f.execute).toHaveBeenCalledTimes(2);
  }finally{f.db.close();}});
  it('does not probe when policy is revoked during registry binding',async()=>{const f=fixture();const original=f.workspaces.get.bind(f.workspaces);let reads=0;f.workspaces.get=async(id:string):Promise<Workspace|null>=>{const value=await original(id);if(++reads>0)f.setProfile(denied);return value;};try{
    expect(await f.service.execute(actor,capture())).toMatchObject({ok:false});expect(f.execute).not.toHaveBeenCalled();expect(f.repository.get(hash(actor.clientId),'capture-1')).toBeNull();
  }finally{f.db.close();}});
  it('bounds a hung registry read and a hung probe, and does not replay an interrupted collection',async()=>{const f=fixture(30);let release:(()=>void)|undefined;try{
    const normal=f.workspaces.get.bind(f.workspaces);f.workspaces.get=async():Promise<Workspace|null>=>new Promise<Workspace|null>(()=>undefined);
    const before=Date.now();expect(await f.service.execute(actor,capture())).toMatchObject({ok:false,error:{code:'PROCESS_TIMEOUT'}});expect(Date.now()-before).toBeLessThan(1000);expect(f.execute).not.toHaveBeenCalled();
    f.workspaces.get=normal;f.execute.mockImplementation(async()=>{await new Promise<void>(resolve=>{release=resolve;});return ok({hosts:[]});});
    const start=Date.now();expect(await f.service.execute(actor,capture())).toMatchObject({ok:true,value:{state:'interrupted'}});expect(Date.now()-start).toBeLessThan(1000);
    const owner=hash(actor.clientId),count=f.repository.summary(owner,'capture-1')?.count;release?.();await new Promise(resolve=>setTimeout(resolve,5));expect(f.repository.summary(owner,'capture-1')?.count).toBe(count);
    const calls=f.execute.mock.calls.length;const restarted=new DriftService({repository:f.repository,workspaces:f.workspaces,hosts:{async get(id:string):Promise<TestHost|null>{return f.hosts.get(id)??null;}},fleet:{execute:f.execute},deadlineMs:30});expect(await restarted.execute(actor,capture())).toMatchObject({ok:true,value:{state:'interrupted'}});expect(f.execute).toHaveBeenCalledTimes(calls);
  }finally{release?.();f.db.close();}});
  it('keeps raw host secrets, paths and provider canaries out of returned evidence',async()=>{const f=fixture();f.execute.mockImplementation(async(input)=>{const q=input as {hostIds:string[];operation:string};return ok({hosts:[{hostId:q.hostIds[0],status:'ok',value:q.operation==='service-status'?{output:'LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled SECRET_CANARY',exitCode:0}:{output:`${'a'.repeat(64)}  /srv/SECRET_CANARY`,exitCode:0}}]});});try{
    const result=await f.service.execute(actor,capture('safe-output',[{id:'file',hostId:'h1',kind:'artifact',path:'/srv/app.conf'}]));const text=JSON.stringify(result);expect(text).not.toContain('SECRET_CANARY');expect(text).not.toContain('127.0.0.1');expect(text).not.toContain('/srv/app.conf');expect(text).toContain('pathFingerprint');
  }finally{f.db.close();}});
});
