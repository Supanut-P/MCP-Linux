import { createHash } from 'node:crypto';
import type { SqliteDatabase } from './database.js';

export interface DiagnosisRecord { readonly id:string; readonly ownerKey:string; readonly requestFingerprint:string; readonly document:unknown; readonly documentHash:string; readonly createdAt:number; }
export type DiagnosisRecordHashInput = Omit<DiagnosisRecord,'documentHash'>;
interface Row { owner_key:unknown; id:unknown; request_fingerprint:unknown; document_json:unknown; document_hash:unknown; created_at:unknown; }
const OWNER=/^[a-f0-9]{64}$/, HASH=/^[a-f0-9]{64}$/, ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const DOCUMENT_MAX=32*1024;
const COLS=`CASE WHEN typeof(owner_key)='text' AND length(CAST(owner_key AS BLOB))<=64 THEN owner_key END owner_key,CASE WHEN typeof(id)='text' AND length(CAST(id AS BLOB))<=128 THEN id END id,CASE WHEN typeof(request_fingerprint)='text' AND length(CAST(request_fingerprint AS BLOB))<=64 THEN request_fingerprint END request_fingerprint,CASE WHEN typeof(document_json)='text' AND length(CAST(document_json AS BLOB))<=${DOCUMENT_MAX} THEN document_json END document_json,CASE WHEN typeof(document_hash)='text' AND length(CAST(document_hash AS BLOB))<=64 THEN document_hash END document_hash,CASE WHEN typeof(created_at)='integer' AND created_at BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER} THEN created_at END created_at`;

export function diagnosisRecordHash(input:DiagnosisRecordHashInput):string|null {
  const json=canonicalJson({ownerKey:input.ownerKey,id:input.id,requestFingerprint:input.requestFingerprint,document:input.document,createdAt:input.createdAt});
  return json===null?null:sha(json);
}
export class SqliteDiagnosisRepository {
  public constructor(private readonly database:SqliteDatabase){}
  public get(owner:string,id:string):DiagnosisRecord|null {
    if(!validOwner(owner)||!validId(id))return null;
    const row=this.database.connection.prepare(`SELECT ${COLS} FROM diagnosis_records WHERE owner_key=? AND id=?`).get(owner,id) as Row|undefined;
    return row?decode(row):null;
  }
  public create(record:DiagnosisRecord):boolean {
    const json=canonicalJson(record.document), expected=diagnosisRecordHash(record);
    if(!validOwner(record.ownerKey)||!validId(record.id)||!validHash(record.requestFingerprint)||!validTime(record.createdAt)||json===null||bytes(json)>DOCUMENT_MAX||!validHash(record.documentHash)||record.documentHash!==expected)return false;
    const db=this.database.connection; db.exec('BEGIN IMMEDIATE');
    try {
      if(db.prepare('SELECT 1 FROM diagnosis_records WHERE owner_key=? AND id=?').get(record.ownerKey,record.id)){db.exec('COMMIT');return false;}
      const own=db.prepare('SELECT COUNT(*) n FROM diagnosis_records WHERE owner_key=?').get(record.ownerKey) as {n:number|bigint};
      const all=db.prepare('SELECT COUNT(*) n FROM diagnosis_records').get() as {n:number|bigint};
      if(Number(own.n)>=32||Number(all.n)>=256){db.exec('COMMIT');return false;}
      db.prepare('INSERT INTO diagnosis_records(owner_key,id,request_fingerprint,document_json,document_hash,created_at) VALUES(?,?,?,?,?,?)').run(record.ownerKey,record.id,record.requestFingerprint,json,record.documentHash,record.createdAt);
      db.exec('COMMIT'); return true;
    } catch(e) {db.exec('ROLLBACK');throw e;}
  }
}
function decode(r:Row):DiagnosisRecord {
  if(!validOwner(r.owner_key)||!validId(r.id)||!validHash(r.request_fingerprint)||typeof r.document_json!=='string'||bytes(r.document_json)>DOCUMENT_MAX||!validHash(r.document_hash)||!validTime(r.created_at))throw corrupt();
  let document:unknown;try{document=JSON.parse(r.document_json) as unknown;}catch{throw corrupt();}
  const record={ownerKey:r.owner_key,id:r.id,requestFingerprint:r.request_fingerprint,document,createdAt:Number(r.created_at)};
  if(canonicalJson(document)!==r.document_json||diagnosisRecordHash(record)!==r.document_hash)throw corrupt();
  return {...record,documentHash:r.document_hash};
}
function canonicalJson(v:unknown):string|null {try{const json=JSON.stringify(sort(v,0,new Set()));return typeof json==='string'?json:null;}catch{return null;}}
function sort(v:unknown,d:number,ancestors:Set<object>):unknown {
  if(d>32)throw Error(); if(v===null||typeof v==='string'||typeof v==='boolean')return v;
  if(typeof v==='number'){if(!Number.isFinite(v))throw Error();return v;} if(typeof v!=='object')throw Error();
  if(ancestors.has(v))throw Error();ancestors.add(v);
  try {if(Array.isArray(v)){if(Object.getPrototypeOf(v)!==Array.prototype||Object.getOwnPropertySymbols(v).length||Object.keys(v).length!==v.length)throw Error();return Array.from({length:v.length},(_,i)=>sort(v[i],d+1,ancestors));}
    const p=Object.getPrototypeOf(v);if(p!==Object.prototype&&p!==null||Reflect.ownKeys(v).length!==Object.keys(v).length)throw Error();
    const out=Object.create(null) as Record<string,unknown>;for(const k of Object.keys(v).sort()){const desc=Object.getOwnPropertyDescriptor(v,k);if(!desc||!('value'in desc))throw Error();out[k]=sort(desc.value,d+1,ancestors);}return out;
  } finally {ancestors.delete(v);}
}
function bytes(s:string):number{return Buffer.byteLength(s,'utf8');}function sha(s:string):string{return createHash('sha256').update(s,'utf8').digest('hex');}
function validId(v:unknown):v is string{return typeof v==='string'&&ID.test(v);}function validOwner(v:unknown):v is string{return typeof v==='string'&&OWNER.test(v);}function validHash(v:unknown):v is string{return typeof v==='string'&&HASH.test(v);}function validTime(v:unknown):v is number{return typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;}function corrupt():Error{return new Error('Diagnosis data is corrupt');}
