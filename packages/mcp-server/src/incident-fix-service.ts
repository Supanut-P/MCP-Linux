import { createHash, randomUUID } from 'node:crypto';
import { appError, err, ok, type DurableWorkflow, type Result, type WorkflowRepository } from '@baitonghub-linux-mcp/domain';
import { fleetHostFingerprint, fleetWorkspaceFingerprint, isContextSourcePath, type FileActor, type FileService, type FleetCatalogService, type WorkflowPlanService, type WorkflowOperation, type WorkflowLinkFence } from '@baitonghub-linux-mcp/application';
import { prepareWorkflowContract, type WorkflowTaskContract } from '@baitonghub-linux-mcp/codex';
import { DefaultPermissionEngine, permissionProfiles, type PermissionProfile } from '@baitonghub-linux-mcp/permissions';
import type { WorkspaceRepository } from '@baitonghub-linux-mcp/workspace';
import type { DiagnosisService } from './diagnosis-service.js';
import type { IncidentEvidenceReference, IncidentService, ResolvedIncidentEvidence } from './incident-service.js';
import { incidentFixReference, incidentFixRequestFingerprint, parseIncidentFixReference, parseIncidentFixRequest, type IncidentFixPrepareRequest, type IncidentFixRequest, type IncidentFixSourceRange } from './incident-fix-contract.js';

interface Entry { readonly id:string; readonly ownerKey:string; readonly workflowId:string; readonly requestFingerprint:string; readonly document:unknown; readonly documentHash:string; readonly createdAt:string }
export interface IncidentFixRepositoryPort {get(owner:string,id:string):Entry|null;getByWorkflow(owner:string,workflowId:string):Entry|null;create(entry:Entry,workflow:DurableWorkflow):boolean}
interface Host {id:string;host:string;port:number;username:string;secretRef:string;pinnedFingerprint:string;roots:readonly string[];createdAt:string}
interface Binding {id:string;revision:number;workspaceId:string;hostId:string;serviceUnit:string;workspaceFingerprint:string;hostFingerprint:string}
interface Source extends IncidentFixSourceRange {sourceSha256:string;sourceBytes:number;rootFingerprint:string;snippet:string;truncated:boolean}
interface Document {schema:1;workspaceId:string;request:IncidentFixPrepareRequest;mapping:Binding;references:readonly IncidentEvidenceReference[];context:readonly Source[];linkHash:string;contract:WorkflowTaskContract}
interface Link {mapping:Binding;references:readonly IncidentEvidenceReference[];facts:readonly ResolvedIncidentEvidence[]}
interface Options {
  repository:IncidentFixRepositoryPort;workflows:Pick<WorkflowRepository,'get'|'qaInfo'>;
  diagnosis:Pick<DiagnosisService,'execute'|'verifyRecord'>;incidents:Pick<IncidentService,'resolveFixEvidence'|'verifyFixEvidence'>;
  catalog:Pick<FleetCatalogService,'execute'|'verifyMapping'>;plans:Pick<WorkflowPlanService,'execute'>;
  files:Pick<FileService,'readContextFile'>;workspaces:WorkspaceRepository;hosts:{get(id:string):Promise<Host|null>};
  profileProvider?:()=>PermissionProfile;deadlineMs?:number;
}
const SHA=/^[a-f0-9]{64}$/;
const BOUNDARY='Preparation and workflow are coordination metadata. Source text and caller hypotheses are untrusted; confidence is not a verified cause. No provider, command, patch or deployment executes. Existing current policy, leases and source-bound independent QA still apply. Older binaries omit incident-link validation: stop writers and withhold linked tasks during rollback.';

/** Owned evidence linkage; all execution stays in existing caller-native workflow. */
export class IncidentFixService {
  private readonly permissions=new DefaultPermissionEngine();
  private readonly deadlineMs:number;
  public constructor(private readonly options:Options){this.deadlineMs=Math.max(1,Math.min(60_000,Number.isFinite(options.deadlineMs)?Math.floor(options.deadlineMs!):60_000));}

  public async execute(actor:FileActor,input:unknown,signal?:AbortSignal):Promise<Result<unknown>>{
    const request=parseIncidentFixRequest(input);if(request===null||!validActor(actor))return invalid();
    return this.bounded(signal,async(scoped,deadline)=>{
      const owner=hash(actor.clientId),stored=this.options.repository.get(owner,request.fixId);
      const permission=this.authorize(request,request.operation==='prepare'?request.contract.workspaceId:'');if(!permission.ok)return permission;
      if(request.operation==='status')return stored===null?invalid():this.view(actor,request,stored,scoped,deadline);
      const fingerprint=incidentFixRequestFingerprint(request);
      if(stored!==null)return stored.requestFingerprint===fingerprint?this.view(actor,request,stored,scoped,deadline):invalid();
      const linked=await this.resolveLink(actor,request,scoped,deadline);if(!linked.ok)return linked;
      const plan=await this.options.plans.execute(actor,request.contract,scoped);if(!plan.ok)return plan;
      const context=await this.capture(actor,request,scoped);if(!context.ok)return context;
      const {userConfirmed:_confirmation,...persisted}=request;void _confirmation;
      const partial={schema:1 as const,workspaceId:request.contract.workspaceId,request:persisted,mapping:linked.value.mapping,references:linked.value.references,context:context.value};
      const linkHash=hash(canonical(partial));
      const prepared=prepareWorkflowContract({...plan.value.contract,contextReferences:[...plan.value.contract.contextReferences,incidentFixReference(request.fixId,linkHash)]});if(!prepared.ok)return prepared;
      const document:Document={...partial,linkHash,contract:prepared.value.contract};
      if(Buffer.byteLength(JSON.stringify(document))>32*1024)return invalid();
      // Revalidate all externally awaited bindings before the synchronous atomic insert.
      const fresh=await this.resolveLink(actor,request,scoped,deadline);if(!fresh.ok)return fresh;
      if(canonical(fresh.value)!==canonical(linked.value))return invalid();
      const sourceFresh=await this.checkContext(actor,{...document,request},scoped);if(!sourceFresh.ok)return sourceFresh;
      if(sourceFresh.value.some(item=>item.status!=='current'))return invalid();
      const finalLink=await this.resolveLink(actor,request,scoped,deadline);if(!finalLink.ok)return finalLink;
      if(canonical(finalLink.value)!==canonical(linked.value)||scoped.aborted||Date.now()>=deadline)return invalid();
      const finalContext=await this.checkContext(actor,{...document,request},scoped);if(!finalContext.ok)return finalContext;
      if(finalContext.value.some(item=>item.status!=='current')||scoped.aborted||Date.now()>=deadline)return invalid();
      const fenced=this.verifyLink(actor,request,finalLink.value);if(!fenced.ok)return fenced;
      const current=this.authorize(request,document.workspaceId);if(!current.ok)return current;
      const workflowId=randomUUID(),createdAt=new Date().toISOString();
      const workflow:DurableWorkflow={id:workflowId,ownerKey:owner,workspaceId:document.workspaceId,createdAt,tasks:[{taskId:document.contract.taskId,contractJson:JSON.stringify(document.contract),dependencies:[],state:'ready',revision:0,checkpoint:null}]};
      const entry={id:request.fixId,ownerKey:owner,workflowId,requestFingerprint:fingerprint,document,createdAt};
      const record:Entry={...entry,documentHash:hash(canonical(entry))};
      if(!this.options.repository.create(record,workflow)){
        const raced=this.options.repository.get(owner,request.fixId);
        return raced?.requestFingerprint===fingerprint?this.view(actor,request,raced,scoped,deadline):invalid();
      }
      return this.view(actor,request,record,scoped,deadline);
    });
  }

  /** Called after workflow scope/QA awaits and before claim or completion commit. */
  public async validateWorkflow(actor:FileActor,workflow:DurableWorkflow,operation:WorkflowOperation,userConfirmed:boolean,signal?:AbortSignal):Promise<Result<WorkflowLinkFence|undefined>>{
    if(!validActor(actor)||workflow.ownerKey!==hash(actor.clientId))return invalid();
    const tagged=workflow.tasks.flatMap(task=>{
      try{const prepared=prepareWorkflowContract(JSON.parse(task.contractJson) as unknown);return prepared.ok?prepared.value.contract.contextReferences.filter(ref=>ref.startsWith('incident_fix:')):['malformed'];}catch{return['malformed'];}
    });
    let entry:Entry|null;
    try{entry=this.options.repository.getByWorkflow(workflow.ownerKey,workflow.id);}catch{return invalid();}
    if(tagged.length===0)return entry===null?ok(undefined):invalid();
    if(tagged.length!==1)return invalid();const ref=parseIncidentFixReference(tagged[0]!);if(ref===null)return invalid();
    const document=entry===null?null:this.document(entry);
    if(entry===null||document===null||entry.id!==ref.fixId||document.linkHash!==ref.linkHash||!matchesWorkflow(entry,document,workflow))return invalid();
    return this.bounded(signal,async(scoped,deadline)=>{
      const request={...document.request,userConfirmed};
      const permission=this.authorize(request,document.workspaceId);if(!permission.ok)return permission;
      if(operation==='start'){
        const context=await this.checkContext(actor,{...document,request},scoped);if(!context.ok)return context;
        if(context.value.some(item=>item.status!=='current'))return invalid();
      }
      const current=await this.resolveLink(actor,request,scoped,deadline);if(!current.ok)return current;
      if(!sameLink(document,current.value))return invalid();
      const latest=this.options.repository.get(workflow.ownerKey,entry.id),latestWorkflow=this.options.workflows.get(workflow.ownerKey,workflow.id);
      if(latest===null||latest.documentHash!==entry.documentHash||latestWorkflow===null||!matchesWorkflow(entry,document,latestWorkflow))return invalid();
      const allowed=this.authorize(request,document.workspaceId);if(!allowed.ok)return allowed;
      return ok({verify:():Result<void>=>{
        if(signal?.aborted||Date.now()>=deadline)return cancelled();
        const retained=this.options.repository.get(workflow.ownerKey,entry.id),owned=this.options.workflows.get(workflow.ownerKey,workflow.id);
        if(retained===null||retained.documentHash!==entry.documentHash||owned===null||!matchesWorkflow(entry,document,owned))return invalid();
        const fenced=this.verifyLink(actor,request,current.value);return fenced.ok?this.authorize(request,document.workspaceId):fenced;
      }});
    });
  }

  private async resolveLink(actor:FileActor,request:IncidentFixPrepareRequest,signal:AbortSignal,deadline:number,readOnly=false):Promise<Result<Link>>{
    const confirmation=request.userConfirmed===undefined?{}:{userConfirmed:request.userConfirmed};
    const selected=await this.options.catalog.execute(actor,{operation:'resolve',id:request.mappingId,...confirmation},signal);if(!selected.ok)return selected;
    const value=selected.value;if(!record(value)||value.kind!=='mapping'||value.revision!==request.mappingRevision||value.workspaceStatus!=='resolved'||!record(value.mapping))return invalid();
    const mapping=value.mapping;if(mapping.workspaceId!==request.contract.workspaceId||typeof mapping.hostId!=='string'||typeof mapping.serviceUnit!=='string'||mapping.serviceUnit.startsWith('-'))return invalid();
    const workspace=await this.options.workspaces.get(request.contract.workspaceId),host=await this.options.hosts.get(mapping.hostId);
    if(workspace===null||workspace.archivedAt||host===null||signal.aborted)return invalid();
    const binding:Binding={id:request.mappingId,revision:request.mappingRevision,workspaceId:workspace.id,hostId:host.id,serviceUnit:mapping.serviceUnit,workspaceFingerprint:fleetWorkspaceFingerprint(workspace),hostFingerprint:fleetHostFingerprint(host)};
    const diagnosis=await this.options.diagnosis.execute(actor,{operation:'get',diagnosisId:request.diagnosisId,...confirmation},signal);if(!diagnosis.ok)return diagnosis;
    const data=diagnosis.value;
    if(!record(data)||data.documentHash!==request.diagnosisHash||data.workspaceId!==workspace.id||data.sourceValidation!=='resolved'||!Array.isArray(data.currentSupport)||!Array.isArray(data.observedFacts)||data.currentSupport.length!==data.observedFacts.length||data.currentSupport.some(support=>!record(support)||support.status!=='current'))return invalid();
    const facts=data.observedFacts as ResolvedIncidentEvidence[];
    const references=facts.map(fact=>fact.reference);
    const evidence=await this.options.incidents.resolveFixEvidence(actor,workspace.id,references,binding,request.userConfirmed,signal,deadline);if(!evidence.ok)return evidence;
    if(evidence.value.length!==facts.length||evidence.value.some(fact=>fact.currentSupport!=='current'||!facts.some(old=>canonical(old)===canonical(fact))))return invalid();
    const again=await this.options.catalog.execute(actor,{operation:'resolve',id:request.mappingId,...confirmation},signal);if(!again.ok)return again;
    if(canonical(again.value)!==canonical(selected.value))return invalid();
    const link:Link={mapping:binding,references,facts:evidence.value};
    const pinned=this.verifyLink(actor,request,link);if(!pinned.ok)return pinned;
    const permission=this.authorize(readOnly?{operation:'status',fixId:request.fixId,...(request.userConfirmed===undefined?{}:{userConfirmed:request.userConfirmed})}:request,workspace.id);return permission.ok?ok(link):permission;
  }

  private verifyLink(actor:FileActor,request:IncidentFixPrepareRequest,link:Link):Result<void>{
    const diagnosis=this.options.diagnosis.verifyRecord(actor,request.diagnosisId,request.diagnosisHash,request.userConfirmed);if(!diagnosis.ok)return diagnosis;
    const mapping=this.options.catalog.verifyMapping(actor,link.mapping,request.userConfirmed);if(!mapping.ok)return mapping;
    return this.options.incidents.verifyFixEvidence(actor,request.contract.workspaceId,link.facts,link.mapping,request.userConfirmed);
  }

  private async capture(actor:FileActor,request:IncidentFixPrepareRequest,signal:AbortSignal):Promise<Result<readonly Source[]>>{
    const output:Source[]=[];let bytes=0;
    for(const range of request.context){
      if(!isContextSourcePath(range.path))return invalid();
      const permission=this.authorize(request,request.contract.workspaceId,range.path);if(!permission.ok)return permission;
      const read=await this.options.files.readContextFile(actor,request.contract.workspaceId,{path:range.path,maxBytes:128*1024},signal);if(!read.ok)return read;
      if(read.value.status!=='available'||read.value.path.replaceAll('\\','/')!==range.path)return invalid();
      const lines=read.value.text.split('\n');if(range.startLine>lines.length)return invalid();
      const selected=lines.slice(range.startLine-1,range.endLine).join('\n');
      const available=8*1024-bytes;if(available<1)return invalid();
      const snippet=clipUtf8(selected,available);
      bytes+=Buffer.byteLength(snippet);output.push({...range,sourceSha256:read.value.sourceSha256,sourceBytes:read.value.sourceBytes,rootFingerprint:read.value.rootFingerprint,snippet,truncated:snippet!==selected||range.endLine>lines.length});
    }
    return ok(output);
  }

  private async checkContext(actor:FileActor,document:Document,signal:AbortSignal):Promise<Result<readonly {path:string;status:'current'|'changed'|'unavailable'}[]>>{
    const output:{path:string;status:'current'|'changed'|'unavailable'}[]=[];
    for(const source of document.context){
      if(!isContextSourcePath(source.path))return invalid();
      const permission=this.authorize({operation:'status',fixId:document.request.fixId,...(document.request.userConfirmed===undefined?{}:{userConfirmed:document.request.userConfirmed})},document.workspaceId,source.path);if(!permission.ok)return permission;
      const current=await this.options.files.readContextFile(actor,document.workspaceId,{path:source.path,maxBytes:128*1024},signal);
      if(!current.ok&&['PERMISSION_DENIED','PERMISSION_REQUIRED'].includes(current.error.code))return current;
      output.push({path:source.path,status:!current.ok||current.value.status!=='available'?'unavailable':current.value.sourceSha256!==source.sourceSha256||current.value.sourceBytes!==source.sourceBytes||current.value.rootFingerprint!==source.rootFingerprint?'changed':'current'});
    }
    return ok(output);
  }

  private async view(actor:FileActor,request:IncidentFixRequest,entry:Entry,signal:AbortSignal,deadline:number):Promise<Result<unknown>>{
    const document=this.document(entry);if(document===null||entry.ownerKey!==hash(actor.clientId))return invalid();
    const workflow=this.options.workflows.get(entry.ownerKey,entry.workflowId);if(workflow===null||!matchesWorkflow(entry,document,workflow))return invalid();
    const permission=this.authorize(request,document.workspaceId);if(!permission.ok)return permission;
    const confirmed={...document.request,...(request.userConfirmed===undefined?{}:{userConfirmed:request.userConfirmed})};
    let link=await this.resolveLink(actor,confirmed,signal,deadline,true);
    if(!link.ok&&['PERMISSION_DENIED','PERMISSION_REQUIRED'].includes(link.error.code))return link;
    let context=await this.checkContext(actor,{...document,request:confirmed},signal);if(!context.ok)return context;
    link=await this.resolveLink(actor,confirmed,signal,deadline,true);
    if(!link.ok&&['PERMISSION_DENIED','PERMISSION_REQUIRED'].includes(link.error.code))return link;
    context=await this.checkContext(actor,{...document,request:confirmed},signal);if(!context.ok)return context;
    if(signal.aborted||Date.now()>=deadline)return cancelled();
    if(link.ok){const fenced=this.verifyLink(actor,confirmed,link.value);if(!fenced.ok){if(['PERMISSION_DENIED','PERMISSION_REQUIRED'].includes(fenced.error.code))return fenced;link=fenced;}}
    const latest=this.options.repository.get(entry.ownerKey,entry.id),latestWorkflow=this.options.workflows.get(entry.ownerKey,entry.workflowId);
    if(latest===null||latest.documentHash!==entry.documentHash||latestWorkflow===null||!matchesWorkflow(entry,document,latestWorkflow))return invalid();
    const current=this.authorize(request,document.workspaceId);if(!current.ok)return current;
    return ok({fixId:entry.id,documentHash:entry.documentHash,reference:incidentFixReference(entry.id,document.linkHash),workspaceId:document.workspaceId,workflowId:entry.workflowId,taskId:document.contract.taskId,contract:document.contract,context:document.context,diagnosis:{id:document.request.diagnosisId,hash:document.request.diagnosisHash},mapping:document.mapping,incidentReferences:document.references,currentLink:link.ok&&sameLink(document,link.value)?'current':'unavailable',currentContext:context.value,workflow:latestWorkflow.tasks.map(task=>({taskId:task.taskId,state:task.state,revision:task.revision})),qa:this.options.workflows.qaInfo(entry.ownerKey,entry.workflowId,document.contract.taskId),executionStarted:false,dispatch:'caller_native',boundary:BOUNDARY});
  }

  private document(entry:Entry):Document|null{
    try{
      const value=entry.document;if(!record(value)||Object.keys(value).sort().join(',')!=='context,contract,linkHash,mapping,references,request,schema,workspaceId'||value.schema!==1)return null;
      const request=parseIncidentFixRequest(value.request);if(request===null||request.operation!=='prepare'||request.userConfirmed!==undefined||request.fixId!==entry.id||request.contract.workspaceId!==value.workspaceId||incidentFixRequestFingerprint(request)!==entry.requestFingerprint)return null;
      if(!record(value.mapping)||Object.keys(value.mapping).sort().join(',')!=='hostFingerprint,hostId,id,revision,serviceUnit,workspaceFingerprint,workspaceId'||value.mapping.id!==request.mappingId||value.mapping.revision!==request.mappingRevision||value.mapping.workspaceId!==value.workspaceId||typeof value.mapping.hostId!=='string'||typeof value.mapping.serviceUnit!=='string'||!SHA.test(String(value.mapping.hostFingerprint))||!SHA.test(String(value.mapping.workspaceFingerprint)))return null;
      if(!Array.isArray(value.references)||value.references.length<1||value.references.length>32||value.references.some(ref=>!record(ref)||Object.keys(ref).sort().join(',')!=='hash,incidentId,sequence'||typeof ref.incidentId!=='string'||!Number.isInteger(ref.sequence)||!SHA.test(String(ref.hash))))return null;
      if(!Array.isArray(value.context)||value.context.length!==request.context.length||value.context.some((source,index)=>!validSource(source,request.context[index]!))||value.context.reduce((n,source)=>n+Buffer.byteLength((source as Source).snippet),0)>8*1024)return null;
      const document=value as unknown as Document,{linkHash:_link,contract:_contract,...partial}=document;void _link;void _contract;
      if(document.linkHash!==hash(canonical(partial)))return null;
      const contract=prepareWorkflowContract({...request.contract,contextReferences:[...request.contract.contextReferences,incidentFixReference(entry.id,document.linkHash)]});
      if(!contract.ok||canonical(contract.value.contract)!==canonical(document.contract)||hash(canonical({id:entry.id,ownerKey:entry.ownerKey,workflowId:entry.workflowId,requestFingerprint:entry.requestFingerprint,document:entry.document,createdAt:entry.createdAt}))!==entry.documentHash)return null;
      return {...document,request,contract:contract.value.contract};
    }catch{return null;}
  }

  private authorize(request:IncidentFixRequest,workspaceId:string,target=request.fixId):Result<void>{
    for(const level of request.operation==='prepare'?['READ','WRITE'] as const:['READ'] as const){
      const decision=this.permissions.decide(this.options.profileProvider?.()??permissionProfiles.balanced,{action:`incident_fix_${request.operation}`,level,workspaceId,target,destructive:false});
      if(decision==='DENY'||decision==='ASK'&&request.userConfirmed!==true)return err(appError(decision==='DENY'?'PERMISSION_DENIED':'PERMISSION_REQUIRED','Incident fix requires current policy permission'));
    }return ok(undefined);
  }

  private async bounded<T>(signal:AbortSignal|undefined,run:(signal:AbortSignal,deadline:number)=>Promise<Result<T>>):Promise<Result<T>>{
    const controller=new AbortController(),abort=():void=>controller.abort(),deadline=Date.now()+this.deadlineMs;
    signal?.addEventListener('abort',abort,{once:true});const timer=setTimeout(abort,this.deadlineMs);let listener:(()=>void)|undefined;
    try{
      if(signal?.aborted)return cancelled();
      const stopped=new Promise<Result<T>>(resolve=>{listener=():void=>resolve(cancelled());controller.signal.addEventListener('abort',listener,{once:true});if(controller.signal.aborted)listener();});
      const result=await Promise.race([run(controller.signal,deadline),stopped]);return controller.signal.aborted?cancelled():result;
    }catch{return invalid();}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);if(listener!==undefined)controller.signal.removeEventListener('abort',listener);controller.abort();}
  }
}
function sameLink(document:Document,current:{mapping:Binding;references:readonly IncidentEvidenceReference[]}):boolean{return canonical(document.mapping)===canonical(current.mapping)&&canonical(document.references)===canonical(current.references);}
function matchesWorkflow(entry:Entry,document:Document,workflow:DurableWorkflow):boolean{try{return workflow.id===entry.workflowId&&workflow.ownerKey===entry.ownerKey&&workflow.workspaceId===document.workspaceId&&workflow.createdAt===entry.createdAt&&workflow.tasks.length===1&&workflow.tasks[0]!.taskId===document.contract.taskId&&canonical(JSON.parse(workflow.tasks[0]!.contractJson) as unknown)===canonical(document.contract);}catch{return false;}}
function validSource(value:unknown,range:IncidentFixSourceRange):value is Source{return record(value)&&Object.keys(value).sort().join(',')==='endLine,path,rootFingerprint,snippet,sourceBytes,sourceSha256,startLine,truncated'&&value.path===range.path&&value.startLine===range.startLine&&value.endLine===range.endLine&&typeof value.sourceSha256==='string'&&SHA.test(value.sourceSha256)&&typeof value.rootFingerprint==='string'&&SHA.test(value.rootFingerprint)&&Number.isSafeInteger(value.sourceBytes)&&(value.sourceBytes as number)>=0&&(value.sourceBytes as number)<=128*1024&&typeof value.snippet==='string'&&typeof value.truncated==='boolean';}
function validActor(actor:FileActor):boolean{return typeof actor.clientId==='string'&&actor.clientId.trim().length>0&&!actor.clientId.includes('\0')&&Buffer.byteLength(actor.clientId)<=512;}
function record(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function canonical(value:unknown):string{if(Array.isArray(value))return`[${value.map(canonical).join(',')}]`;if(record(value))return`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;return JSON.stringify(value);}
function hash(value:string):string{return createHash('sha256').update(value).digest('hex');}
function clipUtf8(value:string,max:number):string{const bytes=Buffer.from(value);let end=Math.min(bytes.length,max);while(end>0&&end<bytes.length&&(bytes[end]!&0xc0)===0x80)end--;return bytes.subarray(0,end).toString('utf8');}
function invalid():Result<never>{return err(appError('INVALID_INPUT','Incident fix evidence or scope could not be validated'));}
function cancelled():Result<never>{return err(appError('PROCESS_TIMEOUT','Incident fix request was cancelled or timed out',true));}
