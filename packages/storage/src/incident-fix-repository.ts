import { createHash } from 'node:crypto';
import type { DurableWorkflow } from '@baitonghub-linux-mcp/domain';
import type { SqliteDatabase } from './database.js';
import { SqliteWorkflowRepository } from './workflow-repository.js';

export interface IncidentFixRecord { readonly id:string; readonly ownerKey:string; readonly workflowId:string; readonly requestFingerprint:string; readonly document:unknown; readonly documentHash:string; readonly createdAt:string; }
export type IncidentFixRecordHashInput=Omit<IncidentFixRecord,'documentHash'>;
interface Row { owner_key:unknown; id:unknown; workflow_id:unknown; request_fingerprint:unknown; document_json:unknown; document_hash:unknown; created_at:unknown; }
const OWNER=/^[a-f0-9]{64}$/, HASH=/^[a-f0-9]{64}$/, ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const DOCUMENT_MAX=32*1024;
const COLS=`CASE WHEN typeof(owner_key)='text' AND length(CAST(owner_key AS BLOB))<=64 THEN owner_key END owner_key,CASE WHEN typeof(id)='text' AND length(CAST(id AS BLOB))<=128 THEN id END id,CASE WHEN typeof(workflow_id)='text' AND length(CAST(workflow_id AS BLOB))<=128 THEN workflow_id END workflow_id,CASE WHEN typeof(request_fingerprint)='text' AND length(CAST(request_fingerprint AS BLOB))<=64 THEN request_fingerprint END request_fingerprint,CASE WHEN typeof(document_json)='text' AND length(CAST(document_json AS BLOB))<=${DOCUMENT_MAX} THEN document_json END document_json,CASE WHEN typeof(document_hash)='text' AND length(CAST(document_hash AS BLOB))<=64 THEN document_hash END document_hash,CASE WHEN typeof(created_at)='text' AND length(CAST(created_at AS BLOB))<=24 THEN created_at END created_at`;
const REJECT=Symbol('incident-fix-insert-rejected');

export function incidentFixRecordHash(input:IncidentFixRecordHashInput):string|null {
  if(!validHashInput(input))return null;
  const json=canonicalJson({id:input.id,ownerKey:input.ownerKey,workflowId:input.workflowId,requestFingerprint:input.requestFingerprint,document:input.document,createdAt:input.createdAt});
  return json===null?null:sha(json);
}

export class SqliteIncidentFixRepository {
  private readonly workflows:SqliteWorkflowRepository;
  public constructor(private readonly database:SqliteDatabase){this.workflows=new SqliteWorkflowRepository(database);}

  public get(owner:string,id:string):IncidentFixRecord|null {
    if(!validOwner(owner)||!validId(id))return null;
    const row=this.database.connection.prepare(`SELECT ${COLS} FROM incident_fix_records WHERE owner_key=? AND id=?`).get(owner,id) as Row|undefined;
    if(!row)return null;const record=decode(row);this.validateWorkflowBinding(record);return record;
  }

  public getByWorkflow(owner:string,workflowId:string):IncidentFixRecord|null {
    if(!validOwner(owner)||!validId(workflowId))return null;
    const rows=this.database.connection.prepare(`SELECT ${COLS} FROM incident_fix_records WHERE owner_key=? AND workflow_id=? LIMIT 2`).all(owner,workflowId) as unknown as Row[];
    if(rows.length>1)throw corrupt();
    if(rows.length===0)return null;const record=decode(rows[0]!);this.validateWorkflowBinding(record);return record;
  }

  public create(record:IncidentFixRecord,workflow:DurableWorkflow):boolean {
    if(!validRecordInput(record))return false;
    const {documentHash:_providedHash,...hashInput}=record;void _providedHash;
    const json=canonicalJson(record.document),expected=incidentFixRecordHash(hashInput);
    if(json===null||bytes(json)>DOCUMENT_MAX||!validHash(record.documentHash)||record.documentHash!==expected
      ||record.workflowId!==workflow.id||record.ownerKey!==workflow.ownerKey||record.createdAt!==workflow.createdAt||!validIsoTime(record.createdAt)
      ||workflow.tasks.length!==1||workflow.tasks[0]!.dependencies.length!==0||documentWorkspace(record.document)!==workflow.workspaceId
      ||!documentContractMatches(record.document,workflow.tasks[0]!))return false;
    try {
      return this.workflows.createLinked(workflow,(db)=>{
        if(db.prepare('SELECT 1 FROM incident_fix_records WHERE (owner_key=? AND id=?) OR workflow_id=?').get(record.ownerKey,record.id,record.workflowId))throw REJECT;
        const own=db.prepare('SELECT COUNT(*) n FROM incident_fix_records WHERE owner_key=?').get(record.ownerKey) as {n:number|bigint};
        const all=db.prepare('SELECT COUNT(*) n FROM incident_fix_records').get() as {n:number|bigint};
        if(Number(own.n)>=32||Number(all.n)>=256)throw REJECT;
        try {db.prepare('INSERT INTO incident_fix_records(owner_key,id,workflow_id,request_fingerprint,document_json,document_hash,created_at) VALUES(?,?,?,?,?,?,?)').run(record.ownerKey,record.id,record.workflowId,record.requestFingerprint,json,record.documentHash,record.createdAt);}
        catch {throw REJECT;}
      });
    } catch(error) {if(error===REJECT)return false;throw error;}
  }

  private validateWorkflowBinding(record:IncidentFixRecord):void {
    const db=this.database.connection;
    const row=db.prepare("SELECT CASE WHEN typeof(id)='text' AND length(CAST(id AS BLOB))<=128 THEN id END id,CASE WHEN typeof(owner_key)='text' AND length(CAST(owner_key AS BLOB))<=64 THEN owner_key END owner_key,CASE WHEN typeof(workspace_id)='text' AND length(CAST(workspace_id AS BLOB))<=128 THEN workspace_id END workspace_id,CASE WHEN typeof(created_at)='text' AND length(CAST(created_at AS BLOB))<=24 THEN created_at END created_at FROM durable_workflows WHERE id=?").get(record.workflowId) as {id:unknown;owner_key:unknown;workspace_id:unknown;created_at:unknown}|undefined;
    const tasks=db.prepare("SELECT CASE WHEN typeof(task_id)='text' AND length(CAST(task_id AS BLOB))<=128 THEN task_id END task_id,CASE WHEN typeof(contract_json)='text' AND length(CAST(contract_json AS BLOB))<=32768 THEN contract_json END contract_json FROM durable_workflow_tasks WHERE workflow_id=? LIMIT 2").all(record.workflowId) as unknown as Array<{task_id:unknown;contract_json:unknown}>;
    if(!row||row.id!==record.workflowId||row.owner_key!==record.ownerKey||row.workspace_id!==documentWorkspace(record.document)||row.created_at!==record.createdAt||tasks.length!==1
      ||typeof tasks[0]!.task_id!=='string'||typeof tasks[0]!.contract_json!=='string'||!documentContractMatches(record.document,{taskId:tasks[0]!.task_id,contractJson:tasks[0]!.contract_json},true))throw corrupt();
  }
}

function decode(row:Row):IncidentFixRecord {
  if(!validOwner(row.owner_key)||!validId(row.id)||!validId(row.workflow_id)||!validHash(row.request_fingerprint)||typeof row.document_json!=='string'||bytes(row.document_json)>DOCUMENT_MAX||!validHash(row.document_hash)||typeof row.created_at!=='string'||!validIsoTime(row.created_at))throw corrupt();
  let document:unknown;try{document=JSON.parse(row.document_json) as unknown;}catch{throw corrupt();}
  const input={id:row.id,ownerKey:row.owner_key,workflowId:row.workflow_id,requestFingerprint:row.request_fingerprint,document,createdAt:row.created_at};
  if(canonicalJson(document)!==row.document_json||documentWorkspace(document)===null||incidentFixRecordHash(input)!==row.document_hash)throw corrupt();
  return {...input,documentHash:row.document_hash};
}

function validRecordInput(value:IncidentFixRecord):boolean {
  if(typeof value!=='object'||value===null||Array.isArray(value)||!plainDataObject(value)||Reflect.ownKeys(value).length!==7
    ||Object.keys(value).sort().join(',')!=='createdAt,document,documentHash,id,ownerKey,requestFingerprint,workflowId')return false;
  return validId(value.id)&&validOwner(value.ownerKey)&&validId(value.workflowId)&&validHash(value.requestFingerprint)&&validIsoTime(value.createdAt);
}
function validHashInput(value:IncidentFixRecordHashInput):boolean {
  if(typeof value!=='object'||value===null||Array.isArray(value)||!plainDataObject(value)||Reflect.ownKeys(value).length!==6
    ||Object.keys(value).sort().join(',')!=='createdAt,document,id,ownerKey,requestFingerprint,workflowId')return false;
  return validId(value.id)&&validOwner(value.ownerKey)&&validId(value.workflowId)&&validHash(value.requestFingerprint)&&validIsoTime(value.createdAt)&&documentWorkspace(value.document)!==null;
}
function documentWorkspace(value:unknown):string|null {return plainRecord(value)&&validId(value.workspaceId)?value.workspaceId:null;}
function documentContractMatches(document:unknown,task:{readonly taskId:string;readonly contractJson:string},persisted=false):boolean {
  if(!plainRecord(document)||!plainRecord(document.contract)||!validId(document.contract.taskId)||document.contract.taskId!==task.taskId)return false;
  try {
    if(!persisted)return JSON.stringify(document.contract)===task.contractJson;
    return canonicalJson(document.contract)===canonicalJson(JSON.parse(task.contractJson) as unknown);
  } catch{return false;}
}
function canonicalJson(value:unknown):string|null {try{const json=JSON.stringify(sort(value,0,new Set()));return typeof json==='string'?json:null;}catch{return null;}}
function sort(value:unknown,depth:number,ancestors:Set<object>):unknown {
  if(depth>32)throw Error();if(value===null||typeof value==='string'||typeof value==='boolean')return value;
  if(typeof value==='number'){if(!Number.isFinite(value))throw Error();return value;}
  if(typeof value!=='object')throw Error();if(ancestors.has(value))throw Error();ancestors.add(value);
  try {
    if(Array.isArray(value)){
      if(Object.getPrototypeOf(value)!==Array.prototype)return bad();
      const keys=Reflect.ownKeys(value);if(keys.length!==value.length+1||!keys.includes('length'))return bad();
      const out:unknown[]=[];for(let i=0;i<value.length;i++){const descriptor=Object.getOwnPropertyDescriptor(value,String(i));if(!descriptor||!descriptor.enumerable||!('value'in descriptor))return bad();out.push(sort(descriptor.value,depth+1,ancestors));}return out;
    }
    if(!plainDataObject(value))return bad();
    const out=Object.create(null) as Record<string,unknown>;
    for(const key of Object.keys(value).sort()){const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor||!descriptor.enumerable||!('value'in descriptor))return bad();out[key]=sort(descriptor.value,depth+1,ancestors);}return out;
  } finally {ancestors.delete(value);}
}
function plainDataObject(value:object):boolean {const proto=Object.getPrototypeOf(value);return (proto===Object.prototype||proto===null)&&Reflect.ownKeys(value).every(key=>typeof key==='string'&&Object.getOwnPropertyDescriptor(value,key)?.enumerable===true&&'value'in Object.getOwnPropertyDescriptor(value,key)!);}
function plainRecord(value:unknown):value is Record<string,unknown>{return typeof value==='object'&&value!==null&&!Array.isArray(value)&&plainDataObject(value);}
function bad():never{throw Error();}
function bytes(value:string):number{return Buffer.byteLength(value,'utf8');}
function sha(value:string):string{return createHash('sha256').update(value,'utf8').digest('hex');}
function validId(value:unknown):value is string{return typeof value==='string'&&ID.test(value);}
function validOwner(value:unknown):value is string{return typeof value==='string'&&OWNER.test(value);}
function validHash(value:unknown):value is string{return typeof value==='string'&&HASH.test(value);}
function validIsoTime(value:unknown):value is string{return typeof value==='string'&&bytes(value)<=24&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;}
function corrupt():Error{return new Error('Incident fix data is corrupt');}
