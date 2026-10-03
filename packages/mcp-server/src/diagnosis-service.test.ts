import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ok, type Result } from '@baitonghub-linux-mcp/domain';
import { permissionProfiles, type PermissionProfile } from '@baitonghub-linux-mcp/permissions';
import { SqliteDatabase, SqliteDiagnosisRepository } from '@baitonghub-linux-mcp/storage';
import type { FileActor } from '@baitonghub-linux-mcp/application';
import type { ResolvedIncidentEvidence } from './incident-service.js';
import { DiagnosisService } from './diagnosis-service.js';
import type { DiagnosisRecordRequest } from './diagnosis-contract.js';

const roots:string[]=[], databases:SqliteDatabase[]=[];
afterEach(async()=>{for(const db of databases.splice(0)){try{db.close();}catch{/* closed before reopen */}}await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));vi.restoreAllMocks();});
async function setup():Promise<{file:string;db:SqliteDatabase;repository:SqliteDiagnosisRepository}>{const root=await mkdtemp(path.join(os.tmpdir(),'diagnosis-service-'));roots.push(root);const file=path.join(root,'records.sqlite'),db=new SqliteDatabase(file);databases.push(db);return{file,db,repository:new SqliteDiagnosisRepository(db)};}

const actor:FileActor={clientId:'diagnosis-test-client',clientName:'test'};
const ref={incidentId:'incident-1',sequence:1,hash:'a'.repeat(64)};
const fact:ResolvedIncidentEvidence={
  reference:ref,incidentRequestFingerprint:'b'.repeat(64),incidentHeaderHash:'c'.repeat(64),workspaceId:'workspace-1',workspaceFingerprint:'d'.repeat(64),hostFingerprint:null,
  observation:{source:'local_metrics',workspaceId:'workspace-1',observedAt:'2026-10-03T01:02:03.000Z',sourceTime:null,status:'ok',truncated:false,gap:false,data:{locality:'mcp_server',host:{load1:0.125},runtime:{requestTotal:2,activeCount:1,revision:4},tasks:{total:3,byState:{queued:1,running:2}}}},
  incidentState:'complete',missingSources:0,currentSupport:'current',
};
function request(overrides:Partial<DiagnosisRecordRequest>={}):DiagnosisRecordRequest{return{operation:'record',diagnosisId:'diagnosis-1',workspaceId:'workspace-1',hypotheses:[{id:'h1',statement:'Disk pressure may explain the delay',confidence:'high',rationale:'The retained metrics are consistent with pressure',assumptions:['The sample reflects the affected period'],unknowns:[],supporting:[ref],contradicting:[]}],proposedFix:[{id:'fix-1',hypothesisIds:['h1'],description:'Review disk capacity settings',verification:'Collect a new incident and compare metrics'}],...overrides};}
type Resolve = (actor:FileActor,workspaceId:string,references:readonly {incidentId:string;sequence:number;hash:string}[],confirmed:boolean|undefined,signal:AbortSignal,deadline:number)=>Promise<Result<readonly ResolvedIncidentEvidence[]>>;
function harness(repository:SqliteDiagnosisRepository,resolve:Resolve,profileProvider:()=>PermissionProfile=()=>permissionProfiles.balanced,deadlineMs=1000):DiagnosisService{return new DiagnosisService({repository,incidents:{resolveEvidence:resolve},profileProvider,deadlineMs});}
function resolved(value:readonly ResolvedIncidentEvidence[]= [fact]):Resolve{return async()=>ok(value);}

describe('DiagnosisService',()=>{
  it.each(['partial','interrupted'] as const)('requires unknowns for a good row from a %s incident even with no missing rows',async(incidentState)=>{
    const {repository}=await setup();const incomplete={...fact,incidentState,missingSources:0};
    const service=harness(repository,resolved([incomplete]));
    expect(await service.execute(actor,request())).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});
    expect(await service.execute(actor,request({hypotheses:[{...request().hypotheses[0]!,unknowns:['Other incident sources are incomplete']}]}))).toMatchObject({ok:true});
  });
  it('records once and returns the same immutable hash after reopening SQLite',async()=>{const{file,repository}=await setup();const resolve=vi.fn(resolved());const service=harness(repository,resolve);const created=await service.execute(actor,request());expect(created.ok).toBe(true);if(!created.ok)return;const output=created.value as {documentHash:string;observedFacts:ResolvedIncidentEvidence[];interpretations:unknown[];proposedFix:unknown[]};expect(output.documentHash).toMatch(/^[a-f0-9]{64}$/);expect(output.observedFacts).toEqual([fact]);expect(output.interpretations).toEqual(request().hypotheses);expect(output.proposedFix).toEqual(request().proposedFix);expect(resolve).toHaveBeenCalledTimes(2);
    const db=new SqliteDatabase(file);databases.push(db);const reopened=harness(new SqliteDiagnosisRepository(db),resolved());const fetched=await reopened.execute(actor,{operation:'get',diagnosisId:'diagnosis-1'});expect(fetched.ok).toBe(true);if(fetched.ok)expect(fetched.value).toMatchObject({documentHash:output.documentHash,observedFacts:[fact],proposedFix:request().proposedFix});});

  it('reuses exact requests, rejects changed ID reuse and hides records from another owner',async()=>{const{repository}=await setup();const resolve=vi.fn(resolved());const service=harness(repository,resolve);const first=await service.execute(actor,request());expect(first.ok).toBe(true);const repeat=await service.execute(actor,request());expect(repeat).toEqual(first);expect(resolve).toHaveBeenCalledTimes(3);const changed=await service.execute(actor,request({hypotheses:[{...request().hypotheses[0]!,statement:'A changed interpretation'}]}));expect(changed).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});const hidden=await service.execute({...actor,clientId:'different-client'},{operation:'get',diagnosisId:'diagnosis-1'});expect(hidden).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});});

  it('keeps confidence and fix prose caller asserted and never executes a proposal',async()=>{const{repository}=await setup();const resolve=vi.fn(resolved());const result=await harness(repository,resolve).execute(actor,request());expect(result.ok).toBe(true);if(result.ok){const output=JSON.stringify(result.value);expect(output).toContain('high');expect(output).toContain('Review disk capacity settings');expect(output).toContain('caller assertions');expect(output).toContain('never execute');}expect(resolve).toHaveBeenCalledTimes(2);expect(resolve.mock.calls[0]?.[2]).toEqual([ref]);});

  it('requires an unknown explanation when the only supporting source is incomplete',async()=>{const{repository}=await setup();const partial={...fact,currentSupport:'stale' as const};const result=await harness(repository,resolved([partial])).execute(actor,request());expect(result).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});expect(repository.get('f'.repeat(64),'diagnosis-1')).toBeNull();});

  it('reports current registration staleness and withdraws support when pinned source metadata changes',async()=>{const{repository}=await setup();expect((await harness(repository,resolved()).execute(actor,request())).ok).toBe(true);const stale=await harness(repository,resolved([{...fact,currentSupport:'stale'}])).execute(actor,{operation:'get',diagnosisId:'diagnosis-1'});expect(stale).toMatchObject({ok:true,value:{currentSupport:[{status:'stale',reasons:['registration_stale']}]}});const unavailable=await harness(repository,resolved([{...fact,currentSupport:'unavailable'}])).execute(actor,{operation:'get',diagnosisId:'diagnosis-1'});expect(unavailable).toMatchObject({ok:true,value:{currentSupport:[{status:'unavailable',reasons:['registration_unavailable']}]}});
    for(const changed of [{...fact,incidentHeaderHash:'e'.repeat(64)},{...fact,incidentRequestFingerprint:'f'.repeat(64)},{...fact,observation:{...fact.observation,observedAt:'2026-10-03T01:02:04.000Z'}}]){const result=await harness(repository,resolved([changed])).execute(actor,{operation:'get',diagnosisId:'diagnosis-1'});expect(result).toMatchObject({ok:true,value:{currentSupport:[{status:'unavailable',reasons:['source_unverified']}]}});}});

  it('rechecks policy after evidence resolution before creating a record',async()=>{const{repository}=await setup();let profile:PermissionProfile=permissionProfiles.balanced;const denied:PermissionProfile={...permissionProfiles.safe,defaults:{...permissionProfiles.safe.defaults,WRITE:'DENY'}};const resolve:Resolve=async()=>{profile=denied;return ok([fact]);};const result=await harness(repository,resolve,()=>profile).execute(actor,{...request(),userConfirmed:true});expect(result).toMatchObject({ok:false,error:{code:'PERMISSION_DENIED'}});expect(repository.get('0'.repeat(64),'diagnosis-1')).toBeNull();});

  it('times out a hanging evidence resolver and writes no record',async()=>{const{repository}=await setup();let received:AbortSignal|undefined;const resolve:Resolve=async(_actor,_workspace,_refs,_confirmed,signal)=>{received=signal;return await new Promise(()=>undefined);};const result=await harness(repository,resolve,undefined,15).execute(actor,request());expect(result).toMatchObject({ok:false,error:{code:'PROCESS_TIMEOUT'}});expect(received?.aborted).toBe(true);expect(repository.get('0'.repeat(64),'diagnosis-1')).toBeNull();});

  it('honors caller cancellation while evidence is pending and writes no record',async()=>{const{repository}=await setup();let received:AbortSignal|undefined;const resolve:Resolve=async(_actor,_workspace,_refs,_confirmed,signal)=>{received=signal;return await new Promise(()=>undefined);};const controller=new AbortController(),pending=harness(repository,resolve).execute(actor,request(),controller.signal);await new Promise<void>(resolveNext=>setTimeout(resolveNext,0));controller.abort();const result=await pending;expect(result).toMatchObject({ok:false,error:{code:'PROCESS_TIMEOUT'}});expect(received?.aborted).toBe(true);expect(repository.get('0'.repeat(64),'diagnosis-1')).toBeNull();});

  it('rejects malformed trusted facts and a corrupted retained document',async()=>{const{repository,db}=await setup();const malformed={...fact,observation:{...fact.observation,data:{secret:'raw-provider-string'}}};const rejected=await harness(repository,resolved([malformed])).execute(actor,request());expect(rejected).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});expect(repository.get('0'.repeat(64),'diagnosis-1')).toBeNull();expect((await harness(repository,resolved()).execute(actor,request())).ok).toBe(true);db.connection.prepare('UPDATE diagnosis_records SET document_json=? WHERE id=?').run('{"schema":2}', 'diagnosis-1');const fetched=await harness(repository,resolved()).execute(actor,{operation:'get',diagnosisId:'diagnosis-1'});expect(fetched).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});});
});
