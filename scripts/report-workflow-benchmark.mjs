#!/usr/bin/env node
import { constants } from 'node:fs';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';
import { lstat, realpath, open } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { reportWorkflowBenchmark } from '../packages/codex/dist/index.js';

// Evidence import only: no processes, network, dynamic imports or workflow writes.
const MAX_JSON = 128 * 1024, MAX_LOG = 2 * 1024 * 1024, MAX_CONTEXT = 16 * 1024 * 1024;
const MAX_TOTAL = 32 * 1024 * 1024;
const names = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const record = x => typeof x === 'object' && x !== null && !Array.isArray(x);
const exact = (x, keys) => record(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== '--evidence-dir') throw Error('arguments');
  const requested = path.resolve(process.argv[3]);
  const rootInfo = await lstat(requested);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(requested) !== requested) throw Error('directory');
  let total = 0;
  const artifacts = [], cache = new Map();
  async function read(name, limit) {
    if (!names.test(name)) throw Error('filename');
    if (cache.has(name)) { const x=cache.get(name); if (x.bytes > limit) throw Error('bound'); return x; }
    const filename = path.join(requested, name);
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > limit || total + info.size > MAX_TOTAL) throw Error('file');
    const fd = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const before = await fd.stat();
      if (!before.isFile() || before.ino !== info.ino || before.dev !== info.dev || before.nlink !== 1 || before.size !== info.size) throw Error('identity');
      const buffer = Buffer.alloc(before.size);
      let position = 0;
      while (position < buffer.length) {const x=await fd.read(buffer, position, buffer.length-position,position); if(x.bytesRead===0) throw Error('short'); position+=x.bytesRead;}
      const after = await fd.stat(); const current = await lstat(filename);
      if (before.size!==after.size || before.mtimeMs!==after.mtimeMs || before.ctimeMs!==after.ctimeMs || after.nlink!==1 || current.ino!==before.ino || current.dev!==before.dev || !current.isFile() || current.isSymbolicLink() || current.nlink!==1 || current.size!==before.size || current.mtimeMs!==before.mtimeMs || current.ctimeMs!==before.ctimeMs) throw Error('changed');
      const text = new TextDecoder('utf-8', {fatal:true}).decode(buffer);
      const entry={bytes:buffer.length,sha256:createHash('sha256').update(buffer).digest('hex'),text};
      total += buffer.length; cache.set(name,entry); artifacts.push({file:name,bytes:entry.bytes,sha256:entry.sha256}); return entry;
    } finally {await fd.close();}
  }
  const manifest = JSON.parse((await read('manifest.json',MAX_JSON)).text);
  const raw = JSON.parse((await read('runs.json',MAX_JSON)).text);
  if (!record(manifest) || !Array.isArray(manifest.fixtures) || manifest.fixtures.length!==6 || !Array.isArray(raw) || raw.length!==12) throw Error('shape');
  for (const fixture of manifest.fixtures) {
    if (!record(fixture) || typeof fixture.id!=='string') throw Error('fixture');
    const source=await read(`source-${fixture.id}.json`,MAX_LOG), acceptance=await read(`acceptance-${fixture.id}.json`,MAX_JSON);
    if(source.sha256!==fixture.sourceFingerprint || acceptance.sha256!==fixture.acceptanceFingerprint) throw Error('binding');
  }
  const runs=[];
  for (const run of raw) {
    if (!exact(run,['fixtureId','variant','sourceFingerprint','acceptanceFingerprint','outcome','safetyPassed','invocations']) || !Array.isArray(run.invocations) || run.invocations.length>16) throw Error('run');
    const invocations=[];
    for (const call of run.invocations) {
      if(!exact(call,['id','role','provider','model','effort','contextPath','logPath','elapsedMs','logTruncated'])) throw Error('invocation');
      const context=await read(call.contextPath,MAX_CONTEXT);
      const log=call.logPath===null ? null : await read(call.logPath,MAX_LOG);
      invocations.push({id:call.id,role:call.role,provider:call.provider,model:call.model,effort:call.effort,contextBytes:context.bytes,elapsedMs:call.elapsedMs,log:log?.text??null,logTruncated:call.logTruncated});
    }
    runs.push({...run,invocations});
  }
  const result=reportWorkflowBenchmark(manifest,runs);
  if(!result.ok) throw Error('report');
  // Detect directory replacement after all reads. This is not an OS sandbox.
  const final=await lstat(requested);
  if(final.ino!==rootInfo.ino || final.dev!==rootInfo.dev || final.isSymbolicLink()) throw Error('directory changed');
  const output = JSON.stringify({schema:'mcp-linux.workflow-benchmark-report.v1',report:result.value,artifacts,measurementBoundary:'Hashes and explicit input bytes verified locally; acceptance/safety, elapsed time, requested provider/model/effort and log completeness remain caller-attested. Log telemetry is not authenticated provider billing. Context files do not include hidden/system/reasoning context. No execution or workflow completion authority.'},null,2)+'\n';
  if (Buffer.byteLength(output)>512*1024) throw Error('output bound');
  process.stdout.write(output);
}
main().catch(()=>{process.stderr.write('WORKFLOW_BENCHMARK_INVALID: bounded local evidence validation failed\n');process.exitCode=1;});
