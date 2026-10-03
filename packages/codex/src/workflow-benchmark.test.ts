import { describe, expect, it } from 'vitest';
import { reportWorkflowBenchmark } from './workflow-benchmark.js';

const fixtureIds = ['small_edit','bugfix','refactor','context_retrieval','incident_diagnosis','resume'] as const;
const h=(char:string):string=>char.repeat(64);
interface TestCall { id:string;role:'lead'|'qa';provider:string;model:string;effort:string;contextBytes:number;elapsedMs:number|null;log:string|null;logTruncated:boolean }
interface TestRun { fixtureId:string;variant:'single'|'routed';sourceFingerprint:string;acceptanceFingerprint:string;outcome:'passed'|'failed'|'blocked';safetyPassed:boolean|null;invocations:TestCall[] }
const manifest=():Record<string,unknown>=>({schema:1,fixtures:fixtureIds.map((id,index)=>({id,sourceFingerprint:h(String(index+1)),acceptanceFingerprint:h(String(index+1)),variants:{single:[{id:`${id}-single-lead`,role:'lead'}],routed:[{id:`${id}-routed-lead`,role:'lead'},{id:`${id}-routed-qa`,role:'qa'}]}}))});
const log=(input:number,cached=0,output=0,extra=''):string=>`${extra}${JSON.stringify({type:'turn.completed',usage:{input_tokens:input,cached_input_tokens:cached,output_tokens:output}})}\n`;
function runs(options:{singleLog?:string|null;routedLog?:string|null;routedSafety?:boolean|null;singleOutcome?:'passed'|'failed'|'blocked';truncateRouted?:boolean;omitRoutedQa?:boolean}={}):TestRun[] {
  return fixtureIds.flatMap((fixtureId,index)=>{
    const common={fixtureId,sourceFingerprint:h(String(index+1)),acceptanceFingerprint:h(String(index+1)),outcome:'passed' as const,safetyPassed:true};
    const invocation=(id:string,role:'lead'|'qa',_tokens:number,providerLog:string|null,logTruncated=false):TestCall=>({id,role,provider:'codex',model:role==='lead'?'gpt-6.1-sol':'gpt-6-luna',effort:role==='lead'?'medium':'low',contextBytes:role==='lead'?1000:500,elapsedMs:100,log:providerLog,logTruncated});
    const single={...common,variant:'single' as const,outcome:options.singleOutcome??'passed',invocations:[invocation(`${fixtureId}-single-lead`,'lead',100,options.singleLog===undefined?log(100):options.singleLog)]};
    const routedCalls=[invocation(`${fixtureId}-routed-lead`,'lead',45,options.routedLog===undefined?log(45):options.routedLog,options.truncateRouted??false)];
    if(!options.omitRoutedQa)routedCalls.push(invocation(`${fixtureId}-routed-qa`,'qa',30,log(30)));
    const routed={...common,variant:'routed' as const,safetyPassed:options.routedSafety===undefined?true:options.routedSafety,invocations:routedCalls};
    return [single,routed];
  });
}
const report=(input:unknown=runs()):ReturnType<typeof reportWorkflowBenchmark>=>reportWorkflowBenchmark(manifest(),input);

describe('workflow benchmark report',()=>{
  it('counts explicitly declared retries without treating every repeated role as a retry',()=>{
    const m=manifest();
    const first=(m.fixtures as Array<{variants:{routed:Array<{id:string;role:string;retryOf?:string}>}}>)[0]!;
    first.variants.routed.push({id:'lead-retry',role:'lead',retryOf:first.variants.routed[0]!.id});
    const r=runs();
    r[1]!.invocations.push({...r[1]!.invocations[0]!,id:'lead-retry'});
    const result=reportWorkflowBenchmark(m,r);
    expect(result.ok&&result.value.routed.totalRetries).toBe(1);
    expect(result.ok&&result.value.pairs[1]?.retryProvenance).toBe('manifest_attested');
    delete first.variants.routed[2]!.retryOf;
    const repeated=reportWorkflowBenchmark(m,r);
    expect(repeated.ok&&repeated.value.routed.totalRetries).toBe(0);
    expect(repeated.ok&&repeated.value.pairs[1]?.repeatedRoleInvocations).toBe(1);
    first.variants.routed[2]!.retryOf='missing';
    expect(reportWorkflowBenchmark(m,r).ok).toBe(false);
    first.variants.routed[2]!.retryOf=first.variants.routed[1]!.id;
    expect(reportWorkflowBenchmark(m,r).ok).toBe(false);
    const missing=runs({omitRoutedQa:true});
    const incomplete=report(missing);
    expect(incomplete.ok&&incomplete.value.routed.totalRetries).toBeNull();
  });
  it('uses six-pair medians, avoids adding cached input twice, and evaluates the 25 percent goal',()=>{
    const result=report();
    expect(result.ok).toBe(true);
    if(!result.ok)return;
    expect(result.value.status).toBe('satisfied');
    expect(result.value.single.medianTotalTokens).toBe(100);
    expect(result.value.routed.medianTotalTokens).toBe(75);
    expect(result.value.medianTokenReductionPercent).toBe(25);
    expect(result.value.single.totalElapsedMs).toBe(600);
    expect(result.value.routed.totalElapsedMs).toBe(1200);
    expect(result.value.routed.totalToolCalls).toBe(0);
    const cached=reportWorkflowBenchmark(manifest(),runs({singleLog:log(120,90,30)}));
    expect(cached.ok&&cached.value.pairs[0]?.invocations[0]?.totalTokens).toBe(150);
    expect(cached.ok&&cached.value.pairs[0]?.invocations[0]?.cachedInputTokens).toBe(90);
    expect(cached.ok&&cached.value.pairs[0]?.invocations[0]?.toolCalls).toBe(0);
    const actualFiveField=JSON.stringify({type:'turn.completed',usage:{input_tokens:120,cached_input_tokens:90,cache_write_input_tokens:20,output_tokens:30,reasoning_output_tokens:15}})+'\n';
    const actual=reportWorkflowBenchmark(manifest(),runs({singleLog:actualFiveField}));
    expect(actual.ok&&actual.value.pairs[0]?.invocations[0]?.totalTokens).toBe(150);
    expect(actual.ok&&actual.value.pairs[0]?.invocations[0]?.cacheWriteInputTokens).toBe(20);
    expect(actual.ok&&actual.value.pairs[0]?.invocations[0]?.reasoningOutputTokens).toBe(15);
  });

  it('keeps a missing QA roster member visible and does not fabricate telemetry',()=>{
    const result=report(runs({omitRoutedQa:true}));
    expect(result.ok&&result.value.status).toBe('not_evaluable');
    expect(result.ok&&result.value.pairs[1]?.missingInvocationIds).toEqual(['small_edit-routed-qa']);
    expect(result.ok&&result.value.pairs[1]?.observedTokenSubtotal).toBe(45);
    expect(result.ok&&result.value.routed.medianTotalTokens).toBeNull();
    expect(result.ok&&result.value.routed.medianContextBytes).toBeNull();
    expect(result.ok&&result.value.medianContextByteReductionPercent).toBeNull();
    expect(result.ok&&result.value.routed.totalElapsedMs).toBeNull();
    expect(result.ok&&result.value.routed.totalToolCalls).toBeNull();
  });

  it('marks missing usage, malformed, double completed turns, and truncated logs incomplete',()=>{
    for(const badLog of [JSON.stringify({type:'item.completed'}),'{bad json',`${log(45)}${log(45)}`]) {
      const result=report(runs({routedLog:badLog}));
      expect(result.ok&&result.value.status).toBe('not_evaluable');
      expect(result.ok&&result.value.pairs[1]?.totalTokens).toBeNull();
    }
    const truncated=report(runs({truncateRouted:true}));
    expect(truncated.ok&&truncated.value.status).toBe('not_evaluable');
    expect(truncated.ok&&truncated.value.pairs[1]?.invocations[0]?.observedTokens).toBe(45);
    expect(truncated.ok&&truncated.value.pairs[1]?.invocations[0]?.toolCalls).toBeNull();
    const unfinished=report(runs({routedLog:`${log(45)}${JSON.stringify({type:'turn.started'})}\n`}));
    expect(unfinished.ok&&unfinished.value.status).toBe('not_evaluable');
    expect(unfinished.ok&&unfinished.value.pairs[1]?.invocations[0]?.observedTokens).toBe(45);
    expect(unfinished.ok&&unfinished.value.pairs[1]?.invocations[0]?.totalTokens).toBeNull();
    expect(unfinished.ok&&unfinished.value.pairs[1]?.invocations[0]?.usageReasonCodes).toContain('unfinished_turn');
    expect(unfinished.ok&&unfinished.value.pairs[1]?.invocations[0]?.toolCalls).toBeNull();
    const providerFailure=report(runs({routedLog:`${log(45)}${JSON.stringify({type:'turn.failed'})}\n`}));
    expect(providerFailure.ok&&providerFailure.value.pairs[1]?.invocations[0]?.observedTokens).toBe(45);
    expect(providerFailure.ok&&providerFailure.value.pairs[1]?.invocations[0]?.totalTokens).toBeNull();
  });

  it('preserves failures, flags success regression and safety failures, and makes no success claim',()=>{
    const regression=report(runs({singleOutcome:'passed'}).map((run)=>run.variant==='routed'&&run.fixtureId==='small_edit'?{...run,outcome:'failed' as const}:run));
    expect(regression.ok&&regression.value.successRegression).toBe(true);
    expect(regression.ok&&regression.value.status).toBe('missed');
    expect(regression.ok&&regression.value.pairs.find((pair)=>pair.fixtureId==='small_edit'&&pair.variant==='routed')?.outcome).toBe('failed');
    const unsafe=report(runs({routedSafety:false}));
    expect(unsafe.ok&&unsafe.value.safetyFailures).toBe(6);
    expect(unsafe.ok&&unsafe.value.status).toBe('missed');
    const unknownSafety=report(runs({routedSafety:null}));
    expect(unknownSafety.ok&&unknownSafety.value.status).toBe('not_evaluable');
  });

  it('rejects wrong source pairs, duplicate runs/calls, role mismatch, unknown fields, and arithmetic overflow',()=>{
    const sourceMismatch=runs(); sourceMismatch[0]!.sourceFingerprint=h('f');
    expect(reportWorkflowBenchmark(manifest(),sourceMismatch).ok).toBe(false);
    const duplicate=runs(); duplicate[1]={...duplicate[0]!};
    expect(reportWorkflowBenchmark(manifest(),duplicate).ok).toBe(false);
    const roleMismatch=runs(); roleMismatch[0]!.invocations[0]!.role='qa';
    expect(reportWorkflowBenchmark(manifest(),roleMismatch).ok).toBe(false);
    expect(reportWorkflowBenchmark({...manifest(),extra:true},runs()).ok).toBe(false);
    const overflow=runs(); overflow[0]!.invocations[0]!.log=log(Number.MAX_SAFE_INTEGER,0,1);
    const overflowResult=reportWorkflowBenchmark(manifest(),overflow);
    expect(overflowResult.ok&&overflowResult.value.status).toBe('not_evaluable');
    expect(overflowResult.ok&&overflowResult.value.pairs[0]?.invocations[0]?.totalTokens).toBeNull();
    const unknownMeasurements=runs();
    unknownMeasurements[0]!.invocations[0]!.elapsedMs=null;
    unknownMeasurements[2]!.invocations[0]!.log=null;
    const unknownTotals=report(unknownMeasurements);
    expect(unknownTotals.ok&&unknownTotals.value.single.totalElapsedMs).toBeNull();
    expect(unknownTotals.ok&&unknownTotals.value.single.totalToolCalls).toBeNull();
    expect(unknownTotals.ok&&unknownTotals.value.single.medianContextBytes).toBe(1000);
    const getter=new Proxy(manifest(),{getPrototypeOf():object|null{throw new Error('input trap');}});
    expect(reportWorkflowBenchmark(getter,runs()).ok).toBe(false);
    const unknownUsage=reportWorkflowBenchmark(manifest(),runs({singleLog:JSON.stringify({type:'turn.completed',usage:{input_tokens:10,cached_input_tokens:0,output_tokens:2,new_field:1}})}));
    expect(unknownUsage.ok&&unknownUsage.value.status).toBe('not_evaluable');
  });
});
