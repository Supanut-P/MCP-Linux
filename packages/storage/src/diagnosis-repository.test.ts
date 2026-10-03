import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteDatabase } from './database.js';
import { diagnosisRecordHash, SqliteDiagnosisRepository, type DiagnosisRecord } from './diagnosis-repository.js';

const roots:string[]=[],dbs:SqliteDatabase[]=[];
afterEach(async()=>{for(const db of dbs.splice(0)){try{db.close();}catch{/* closed after reopen */}}await Promise.all(roots.splice(0).map(r=>rm(r,{recursive:true,force:true})));});
async function setup():Promise<{file:string;db:SqliteDatabase;repo:SqliteDiagnosisRepository}>{const root=await mkdtemp(path.join(os.tmpdir(),'diagnosis-'));roots.push(root);const file=path.join(root,'db.sqlite'),db=new SqliteDatabase(file);dbs.push(db);return{file,db,repo:new SqliteDiagnosisRepository(db)};}
const owner='a'.repeat(64),other='b'.repeat(64),fingerprint='c'.repeat(64);
function record(id='diagnosis-1',ownerKey=owner,document:unknown={z:1,a:['safe']}):DiagnosisRecord{const input={id,ownerKey,requestFingerprint:fingerprint,document,createdAt:1_800_000_000_000};return{...input,documentHash:diagnosisRecordHash(input)!};}
function cyclic():Record<string,unknown>{const value:Record<string,unknown>={};value.self=value;return value;}

describe('SqliteDiagnosisRepository',()=>{
  it('isolates owners, rejects overwrite and survives reopen',async()=>{const{file,db,repo}=await setup();const r=record();expect(repo.create(r)).toBe(true);expect(repo.create(r)).toBe(false);const peerDb=new SqliteDatabase(file);dbs.push(peerDb);expect(new SqliteDiagnosisRepository(peerDb).create(r)).toBe(false);expect(repo.get(other,r.id)).toBeNull();expect(repo.get(owner,r.id)).toEqual(r);db.close();const reopened=new SqliteDatabase(file);dbs.push(reopened);expect(new SqliteDiagnosisRepository(reopened).get(owner,r.id)).toEqual(r);});
  it('binds caller supplied content and rejects invalid canonical input',async()=>{const{repo}=await setup();expect(repo.create({...record(),documentHash:'d'.repeat(64)})).toBe(false);expect(repo.create(record('cycle',owner,cyclic()))).toBe(false);expect(repo.create(record('accessor',owner,Object.defineProperty({},'x',{enumerable:true,get():number{return 1;}})))).toBe(false);expect(repo.create(record('symbol',owner,{[Symbol('x')]:1}))).toBe(false);expect(repo.create(record('date',owner,new Date()))).toBe(false);});
  it('fails closed on stored hash, binding and oversized SQL fields',async()=>{const{db,repo}=await setup();repo.create(record());db.connection.prepare('UPDATE diagnosis_records SET document_hash=? WHERE owner_key=?').run('d'.repeat(64),owner);expect(()=>repo.get(owner,'diagnosis-1')).toThrow('Diagnosis data is corrupt');db.connection.prepare('UPDATE diagnosis_records SET document_hash=?,id=? WHERE owner_key=?').run(record().documentHash,'diagnosis-2',owner);expect(()=>repo.get(owner,'diagnosis-2')).toThrow('Diagnosis data is corrupt');db.connection.prepare('UPDATE diagnosis_records SET id=?,request_fingerprint=? WHERE owner_key=?').run('diagnosis-1','x'.repeat(65),owner);expect(()=>repo.get(owner,'diagnosis-1')).toThrow('Diagnosis data is corrupt');db.connection.prepare('UPDATE diagnosis_records SET request_fingerprint=?,document_json=? WHERE owner_key=?').run(fingerprint,'x'.repeat(40*1024),owner);expect(()=>repo.get(owner,'diagnosis-1')).toThrow('Diagnosis data is corrupt');});
  it('enforces document byte and per-owner/global quotas',async()=>{const{repo}=await setup();expect(repo.create(record('large',owner,{s:'x'.repeat(32*1024)}))).toBe(false);for(let i=0;i<32;i++)expect(repo.create(record(`own-${i}`))).toBe(true);expect(repo.create(record('own-over'))).toBe(false);for(let i=0;i<224;i++){const key=(i%8).toString(16).repeat(64);expect(repo.create(record(`global-${i}`,key))).toBe(true);}expect(repo.create(record('global-over','e'.repeat(64)))).toBe(false);});
});
