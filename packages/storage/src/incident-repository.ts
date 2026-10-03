import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { SqliteDatabase } from './database.js';

export interface IncidentRecord {
  readonly id: string;
  readonly ownerKey: string;
  readonly requestFingerprint: string;
  readonly runToken: string;
  readonly state: 'collecting' | 'complete' | 'partial' | 'unavailable' | 'interrupted';
  readonly header: unknown;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly updatedAt: number;
}
export interface IncidentEvidenceRecord { readonly incidentId: string; readonly sequence: number; readonly hash: string; readonly payload: unknown; }
interface HeaderRow { owner_key: unknown; id: unknown; request_fingerprint: unknown; run_token: unknown; state: unknown; header_json: unknown; created_at: unknown; expires_at: unknown; updated_at: unknown; }
interface EvidenceRow { owner_key: unknown; incident_id: unknown; sequence: unknown; hash: unknown; payload_json: unknown; }
const OWNER = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const STATES = new Set(['collecting','complete','partial','unavailable','interrupted']);
const TERMINAL = new Set(['complete','partial','unavailable','interrupted']);
const HEADER_MAX = 8192, PAYLOAD_MAX = 4096, ROW_MAX = 128, BYTES_MAX = 256 * 1024;
const HEADER_COLS = `CASE WHEN typeof(owner_key)='text' AND length(CAST(owner_key AS BLOB))<=64 THEN owner_key ELSE NULL END AS owner_key,CASE WHEN typeof(id)='text' AND length(CAST(id AS BLOB))<=128 THEN id ELSE NULL END AS id,CASE WHEN typeof(request_fingerprint)='text' AND length(CAST(request_fingerprint AS BLOB))<=64 THEN request_fingerprint ELSE NULL END AS request_fingerprint,CASE WHEN typeof(run_token)='text' AND length(CAST(run_token AS BLOB))<=64 THEN run_token ELSE NULL END AS run_token,CASE WHEN typeof(state)='text' AND length(CAST(state AS BLOB))<=16 THEN state ELSE NULL END AS state,CASE WHEN typeof(header_json)='text' AND length(CAST(header_json AS BLOB))<=${HEADER_MAX} THEN header_json ELSE NULL END AS header_json,CASE WHEN typeof(created_at)='integer' AND created_at BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER} THEN created_at ELSE NULL END AS created_at,CASE WHEN typeof(expires_at)='integer' AND expires_at BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER} THEN expires_at ELSE NULL END AS expires_at,CASE WHEN typeof(updated_at)='integer' AND updated_at BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER} THEN updated_at ELSE NULL END AS updated_at`;
const EVIDENCE_COLS = `CASE WHEN typeof(owner_key)='text' AND length(CAST(owner_key AS BLOB))<=64 THEN owner_key ELSE NULL END AS owner_key,CASE WHEN typeof(incident_id)='text' AND length(CAST(incident_id AS BLOB))<=128 THEN incident_id ELSE NULL END AS incident_id,CASE WHEN typeof(sequence)='integer' AND sequence BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER} THEN sequence ELSE NULL END AS sequence,CASE WHEN typeof(hash)='text' AND length(CAST(hash AS BLOB))<=64 THEN hash ELSE NULL END AS hash,CASE WHEN typeof(payload_json)='text' AND length(CAST(payload_json AS BLOB))<=${PAYLOAD_MAX} THEN payload_json ELSE NULL END AS payload_json`;

export class SqliteIncidentRepository {
  public constructor(private readonly database: SqliteDatabase) {}
  public get(owner: string, id: string): IncidentRecord | null {
    if (!validOwner(owner) || !validId(id)) return null;
    const row = this.database.connection.prepare(`SELECT ${HEADER_COLS} FROM incidents WHERE owner_key=? AND id=?`).get(owner,id) as HeaderRow | undefined;
    return row ? decodeHeader(row) : null;
  }
  public create(record: IncidentRecord): boolean {
    const json = canonicalJson(record.header);
    if (record.state !== 'collecting' || !isObject(record.header) || json === null || bytes(json) > HEADER_MAX || !validId(record.id) || !validOwner(record.ownerKey) || !validHash(record.requestFingerprint) || !validHash(record.runToken) || !validTime(record.createdAt) || !validTime(record.expiresAt) || !validTime(record.updatedAt) || record.expiresAt < record.createdAt || record.updatedAt < record.createdAt) return false;
    return this.tx((db) => {
      if (db.prepare('SELECT 1 FROM incidents WHERE owner_key=? AND id=?').get(record.ownerKey,record.id)) return false;
      const own = db.prepare('SELECT COUNT(*) n FROM incidents WHERE owner_key=?').get(record.ownerKey) as {n:number|bigint};
      const all = db.prepare('SELECT COUNT(*) n FROM incidents').get() as {n:number|bigint};
      if (Number(own.n)>=32 || Number(all.n)>=256) return false;
      db.prepare('INSERT INTO incidents(owner_key,id,request_fingerprint,run_token,state,header_json,created_at,expires_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(record.ownerKey,record.id,record.requestFingerprint,record.runToken,'collecting',json,record.createdAt,record.expiresAt,record.updatedAt);
      return true;
    });
  }
  public listEvidence(owner: string,id: string,afterSequence=0,limit=16): IncidentEvidenceRecord[] {
    if (!validOwner(owner)||!validId(id)||!Number.isSafeInteger(afterSequence)||afterSequence<0||!Number.isInteger(limit)||limit<1||limit>32) return [];
    const rows=this.readAllEvidence(owner,id);
    return rows.filter((r)=>r.sequence>afterSequence).slice(0,limit);
  }
  public append(owner:string,id:string,token:string,payload:unknown,now:number):IncidentEvidenceRecord|null {
    const json=canonicalJson(payload);
    if(!validOwner(owner)||!validId(id)||!validHash(token)||!validTime(now)||json===null||!isObject(payload)||bytes(json)>PAYLOAD_MAX) return null;
    return this.tx((db)=>{
      const raw=db.prepare(`SELECT ${HEADER_COLS} FROM incidents WHERE owner_key=? AND id=?`).get(owner,id) as HeaderRow|undefined;
      if(!raw)return null; const record=decodeHeader(raw); if(record.state!=='collecting'||record.runToken!==token||now<record.createdAt||now<record.updatedAt||now>record.expiresAt)return null;
      const rows=this.readAllEvidence(owner,id); const count=rows.length, used=rows.reduce((n,r)=>n+bytes(canonicalJson(r.payload)!),0), seq=count===0?1:rows[rows.length-1]!.sequence+1;
      if(count>=ROW_MAX||used+bytes(json)>BYTES_MAX)return null;
      const hash=createHash('sha256').update(json,'utf8').digest('hex');
      db.prepare('INSERT INTO incident_evidence(owner_key,incident_id,sequence,hash,payload_json) VALUES(?,?,?,?,?)').run(owner,id,seq,hash,json);
      return {incidentId:id,sequence:seq,hash,payload};
    });
  }
  public finish(owner:string,id:string,token:string,state:'complete'|'partial'|'unavailable'|'interrupted',now:number):boolean {
    if(!validOwner(owner)||!validId(id)||!validHash(token)||!TERMINAL.has(state)||!validTime(now))return false;
    return this.tx((db)=>{
      const raw=db.prepare(`SELECT ${HEADER_COLS} FROM incidents WHERE owner_key=? AND id=?`).get(owner,id) as HeaderRow|undefined;
      if(!raw)return false; const r=decodeHeader(raw); if(r.runToken!==token||r.state!=='collecting'||now<r.createdAt||now<r.updatedAt||now>r.expiresAt)return false;
      return Number(db.prepare("UPDATE incidents SET state=?,updated_at=? WHERE owner_key=? AND id=? AND run_token=? AND state='collecting'").run(state,now,owner,id,token).changes)===1;
    });
  }
  public summary(owner:string,id:string):{count:number;bytes:number}|null {
    if(!validOwner(owner)||!validId(id))return null;
    const row=this.database.connection.prepare(`SELECT ${HEADER_COLS} FROM incidents WHERE owner_key=? AND id=?`).get(owner,id) as HeaderRow|undefined;
    if(!row)return null; decodeHeader(row);
    const rows=this.readAllEvidence(owner,id); const size=rows.reduce((n,r)=>n+bytes(canonicalJson(r.payload)!),0); if(size>BYTES_MAX)throw corrupt(); return {count:rows.length,bytes:size};
  }
  private readAllEvidence(owner:string,id:string):IncidentEvidenceRecord[] { const rows=this.database.connection.prepare(`SELECT ${EVIDENCE_COLS} FROM incident_evidence WHERE owner_key=? AND incident_id=? ORDER BY sequence LIMIT 129`).all(owner,id) as unknown as EvidenceRow[]; if(rows.length>ROW_MAX)throw corrupt(); const records=rows.map((r)=>decodeEvidence(r,owner,id)); if(records.some((r,i)=>r.sequence!==i+1)||records.reduce((n,r)=>n+bytes(canonicalJson(r.payload)!),0)>BYTES_MAX)throw corrupt(); return records; }
  private tx<T>(f:(db:DatabaseSync)=>T):T {const db=this.database.connection;db.exec('BEGIN IMMEDIATE');try{const v=f(db);db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;}}
}
function decodeHeader(r:HeaderRow):IncidentRecord {
  if(typeof r.header_json!=='string'||bytes(r.header_json)>HEADER_MAX)throw corrupt(); let header:unknown;try{header=JSON.parse(r.header_json) as unknown;}catch{throw corrupt();}
  if(!validOwner(r.owner_key)||!validId(r.id)||!validHash(r.request_fingerprint)||!validHash(r.run_token)||!STATES.has(String(r.state))||!isObject(header)||!validTime(r.created_at)||!validTime(r.expires_at)||!validTime(r.updated_at)||Number(r.expires_at)<Number(r.created_at)||Number(r.updated_at)<Number(r.created_at)||canonicalJson(header)!==r.header_json)throw corrupt();
  return {id:r.id,ownerKey:r.owner_key,requestFingerprint:r.request_fingerprint,runToken:r.run_token,state:r.state as IncidentRecord['state'],header,createdAt:Number(r.created_at),expiresAt:Number(r.expires_at),updatedAt:Number(r.updated_at)};
}
function decodeEvidence(r:EvidenceRow,owner:string,id:string):IncidentEvidenceRecord {
  if(r.owner_key!==owner||r.incident_id!==id||!validId(r.incident_id)||!validTime(r.sequence)||Number(r.sequence)<1||!validHash(r.hash)||typeof r.payload_json!=='string'||bytes(r.payload_json)>PAYLOAD_MAX)throw corrupt();
  let payload:unknown;try{payload=JSON.parse(r.payload_json) as unknown;}catch{throw corrupt();}
  if(!isObject(payload)||canonicalJson(payload)!==r.payload_json||createHash('sha256').update(r.payload_json,'utf8').digest('hex')!==r.hash)throw corrupt();
  return {incidentId:r.incident_id,sequence:Number(r.sequence),hash:r.hash,payload};
}
function canonicalJson(v:unknown):string|null {try{const json=JSON.stringify(sort(v,0,new Set()));return typeof json==='string'?json:null;}catch{return null;}}
function sort(v:unknown,depth:number,ancestors:Set<object>):unknown {
  if(depth>32)throw new Error('too deep');
  if(v===null||typeof v==='string'||typeof v==='boolean')return v;
  if(typeof v==='number'){if(!Number.isFinite(v))throw new Error('invalid');return v;}
  if(typeof v!=='object')throw new Error('invalid JSON value');
  if(ancestors.has(v))throw new Error('cyclic'); ancestors.add(v);
  try {
    if(Array.isArray(v)) { if(Object.getPrototypeOf(v)!==Array.prototype||Object.getOwnPropertySymbols(v).length||Object.keys(v).length!==v.length)throw new Error('invalid array'); const out:unknown[]=[]; for(let i=0;i<v.length;i++)out.push(sort(v[i],depth+1,ancestors)); return out; }
    const proto=Object.getPrototypeOf(v); if(proto!==Object.prototype&&proto!==null)throw new Error('non-plain object');
    if(Reflect.ownKeys(v).length!==Object.keys(v).length)throw new Error('non-JSON property');
    const out=Object.create(null) as Record<string,unknown>;
    for(const k of Object.keys(v).sort()) { const d=Object.getOwnPropertyDescriptor(v,k); if(!d||!('value' in d))throw new Error('accessor property'); out[k]=sort(d.value,depth+1,ancestors); }
    return out;
  } finally {ancestors.delete(v);}
}
function isObject(v:unknown):v is Record<string,unknown>{return typeof v==='object'&&v!==null&&!Array.isArray(v);}
function bytes(s:string):number{return Buffer.byteLength(s,'utf8');}
function validId(v:unknown):v is string{return typeof v==='string'&&ID.test(v);}
function validOwner(v:unknown):v is string{return typeof v==='string'&&OWNER.test(v);}
function validHash(v:unknown):v is string{return typeof v==='string'&&HASH.test(v);}
function validTime(v:unknown):v is number{return typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;}
function corrupt():Error{return new Error('Incident data is corrupt');}
