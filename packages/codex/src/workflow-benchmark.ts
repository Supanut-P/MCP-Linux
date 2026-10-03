import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';

const FIXTURES = ['small_edit','bugfix','refactor','context_retrieval','incident_diagnosis','resume'] as const;
const VARIANTS = ['single','routed'] as const;
const ROLES = ['lead','worker','qa','planner'] as const;
const EFFORTS = ['none','minimal','low','medium','high','xhigh','max','ultra'] as const;
const LOG_LIMIT = 2 * 1024 * 1024;
const TOTAL_LOG_LIMIT = 16 * 1024 * 1024;
const TOKEN_LIMIT = Number.MAX_SAFE_INTEGER;

export type WorkflowBenchmarkFixtureId = typeof FIXTURES[number];
export type WorkflowBenchmarkVariant = typeof VARIANTS[number];
export type WorkflowBenchmarkRole = typeof ROLES[number];
export type WorkflowBenchmarkEffort = typeof EFFORTS[number];

export interface WorkflowBenchmarkInvocation {
  readonly id: string;
  readonly role: WorkflowBenchmarkRole;
  readonly provider: string;
  readonly model: string;
  readonly effort: WorkflowBenchmarkEffort;
  readonly contextBytes: number;
  readonly elapsedMs: number | null;
  readonly log: string | null;
  readonly logTruncated: boolean;
}
export interface WorkflowBenchmarkRun {
  readonly fixtureId: WorkflowBenchmarkFixtureId;
  readonly variant: WorkflowBenchmarkVariant;
  readonly sourceFingerprint: string;
  readonly acceptanceFingerprint: string;
  readonly outcome: 'passed' | 'failed' | 'blocked';
  readonly safetyPassed: boolean | null;
  readonly invocations: readonly WorkflowBenchmarkInvocation[];
}
export interface WorkflowBenchmarkInvocationReport {
  readonly id: string;
  readonly role: WorkflowBenchmarkRole;
  readonly provider: string;
  readonly model: string;
  readonly effort: WorkflowBenchmarkEffort;
  readonly contextBytes: number;
  readonly elapsedMs: number | null;
  readonly observedTokens: number | null;
  readonly inputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly cacheWriteInputTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningOutputTokens: number | null;
  readonly totalTokens: number | null;
  readonly usageSource: 'codex_jsonl' | 'unavailable';
  readonly elapsedTimeProvenance: 'caller_attested';
  readonly telemetryComplete: boolean;
  readonly usageReasonCodes: readonly string[];
  readonly toolCalls: number | null;
}
export interface WorkflowBenchmarkPairReport {
  readonly fixtureId: WorkflowBenchmarkFixtureId;
  readonly variant: WorkflowBenchmarkVariant;
  readonly sourceFingerprint: string;
  readonly acceptanceFingerprint: string;
  readonly outcome: 'passed' | 'failed' | 'blocked';
  readonly outcomeProvenance: 'caller_attested';
  readonly safetyPassed: boolean | null;
  readonly safetyProvenance: 'caller_attested';
  readonly expectedInvocationIds: readonly string[];
  readonly observedInvocationIds: readonly string[];
  readonly missingInvocationIds: readonly string[];
  readonly reasonCodes: readonly string[];
  readonly repeatedRoleInvocations: number;
  readonly retryCount: number | null;
  readonly retryProvenance: 'manifest_attested';
  readonly invocations: readonly WorkflowBenchmarkInvocationReport[];
  readonly observedTokenSubtotal: number;
  readonly totalTokens: number | null;
  readonly contextBytes: number;
  readonly contextBytesProvenance: 'caller_attested';
  readonly telemetryComplete: boolean;
}
export interface WorkflowBenchmarkVariantAggregate {
  readonly completePairs: number;
  readonly passedRuns: number;
  readonly observedTokenSubtotal: number;
  readonly medianTotalTokens: number | null;
  readonly medianContextBytes: number | null;
  readonly totalElapsedMs: number | null;
  readonly totalToolCalls: number | null;
  readonly totalRetries: number | null;
  readonly telemetryComplete: boolean;
}
export interface WorkflowBenchmarkReport {
  readonly schema: 1;
  readonly goalReductionPercent: 25;
  readonly status: 'not_evaluable' | 'missed' | 'satisfied';
  readonly reasons: readonly string[];
  readonly pairs: readonly WorkflowBenchmarkPairReport[];
  readonly single: WorkflowBenchmarkVariantAggregate;
  readonly routed: WorkflowBenchmarkVariantAggregate;
  readonly medianTokenReductionPercent: number | null;
  readonly medianContextByteReductionPercent: number | null;
  readonly successRegression: boolean;
  readonly safetyFailures: number;
}

interface ExpectedCall { id: string; role: WorkflowBenchmarkRole; retryOf: string | null }
interface Fixture { id: WorkflowBenchmarkFixtureId; sourceFingerprint: string; acceptanceFingerprint: string; variants: Record<WorkflowBenchmarkVariant, ExpectedCall[]> }
interface Usage { input: number; cached: number; cacheWrite: number | null; output: number; reasoning: number | null }
interface ParsedLog { usage: Usage | null; usageUnambiguous: boolean; toolCalls: number | null; reasons: string[] }

/** Pure bounded report builder. Logs and outcomes are caller evidence, not authenticated facts. */
export function reportWorkflowBenchmark(manifest: unknown, runs: unknown): Result<WorkflowBenchmarkReport> {
 try {
  const parsedManifest = parseManifest(manifest);
  if (!parsedManifest) return invalid();
  const parsedRuns = parseRuns(runs, parsedManifest);
  if (!parsedRuns) return invalid();
  const fixtureMap = new Map(parsedManifest.map((fixture) => [fixture.id, fixture]));
  const pairs: WorkflowBenchmarkPairReport[] = [];
  for (const run of parsedRuns) {
    const fixture = fixtureMap.get(run.fixtureId)!;
    const expected = fixture.variants[run.variant];
    const expectedIds = expected.map((call) => call.id);
    const seenIds = new Set(run.invocations.map((call) => call.id));
    const missingIds = expectedIds.filter((id) => !seenIds.has(id));
    const roleCounts = new Map<string, number>();
    let contextBytes = 0;
    let observedTokenSubtotal = 0;
    let complete = missingIds.length === 0;
    const invocations: WorkflowBenchmarkInvocationReport[] = [];
    for (const call of run.invocations) {
      contextBytes = add(contextBytes, call.contextBytes);
      roleCounts.set(call.role, (roleCounts.get(call.role) ?? 0) + 1);
      if (call.log !== null) {
        const bytes = Buffer.byteLength(call.log, 'utf8');
        if (bytes > LOG_LIMIT) return invalid();
      }
      const parsed = parseLog(call.log, call.logTruncated);
      const observed = parsed.usageUnambiguous && parsed.usage ? add(parsed.usage.input, parsed.usage.output) : null;
      if (observed !== null) observedTokenSubtotal = add(observedTokenSubtotal, observed);
      const reasons = [...parsed.reasons];
      const telemetryComplete = parsed.usage !== null && reasons.length === 0 && call.log !== null;
      if (!telemetryComplete) complete = false;
      invocations.push({
        id: call.id, role: call.role, provider: call.provider, model: call.model, effort: call.effort,
        contextBytes: call.contextBytes, elapsedMs: call.elapsedMs, observedTokens: observed,
        inputTokens: telemetryComplete ? parsed.usage!.input : null,
        cachedInputTokens: telemetryComplete ? parsed.usage!.cached : null,
        cacheWriteInputTokens: telemetryComplete ? parsed.usage!.cacheWrite : null,
        outputTokens: telemetryComplete ? parsed.usage!.output : null,
        reasoningOutputTokens: telemetryComplete ? parsed.usage!.reasoning : null,
        totalTokens: telemetryComplete ? observed : null,
        usageSource: parsed.usage !== null ? 'codex_jsonl' : 'unavailable',
        elapsedTimeProvenance: 'caller_attested',
        telemetryComplete, usageReasonCodes: reasons, toolCalls: parsed.toolCalls,
      });
    }
    const totalTokens = complete ? invocations.reduce((sum, invocation) => add(sum, invocation.totalTokens!), 0) : null;
    pairs.push({
      fixtureId: run.fixtureId, variant: run.variant, sourceFingerprint: run.sourceFingerprint,
      acceptanceFingerprint: run.acceptanceFingerprint, outcome: run.outcome, safetyPassed: run.safetyPassed,
      outcomeProvenance: 'caller_attested', safetyProvenance: 'caller_attested',
      expectedInvocationIds: expectedIds, observedInvocationIds: run.invocations.map((call) => call.id),
      missingInvocationIds: missingIds, reasonCodes: missingIds.length > 0 ? ['missing_invocation'] : [], repeatedRoleInvocations: [...roleCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0),
      retryCount: missingIds.length === 0 ? expected.filter((call) => call.retryOf !== null).length : null, retryProvenance: 'manifest_attested',
      invocations, observedTokenSubtotal, totalTokens, contextBytes, contextBytesProvenance: 'caller_attested', telemetryComplete: complete,
    });
  }
  if (pairs.length !== FIXTURES.length * VARIANTS.length) return invalid();
  const single = aggregate(pairs.filter((pair) => pair.variant === 'single'));
  const routed = aggregate(pairs.filter((pair) => pair.variant === 'routed'));
  const safetyFailures = pairs.filter((pair) => pair.safetyPassed === false).length;
  const safetyUnknown = pairs.some((pair) => pair.safetyPassed === null);
  const telemetryComplete = single.telemetryComplete && routed.telemetryComplete && !safetyUnknown;
  const successRegression = pairs.some((pair) => pair.variant === 'single' && pair.outcome === 'passed'
    && pairs.some((other) => other.fixtureId === pair.fixtureId && other.variant === 'routed' && other.outcome !== 'passed'));
  const tokenReduction = reduction(single.medianTotalTokens, routed.medianTotalTokens);
  const contextReduction = reduction(single.medianContextBytes, routed.medianContextBytes);
  const status = !telemetryComplete ? 'not_evaluable' : tokenReduction !== null && tokenReduction >= 25 && !successRegression && safetyFailures === 0 ? 'satisfied' : 'missed';
  const reasons: string[] = [];
  if (!telemetryComplete) reasons.push('incomplete_telemetry_or_safety');
  if (successRegression) reasons.push('success_regression');
  if (safetyFailures > 0) reasons.push('safety_failure');
  if (telemetryComplete && (tokenReduction === null || tokenReduction < 25)) reasons.push('token_reduction_below_goal');
  return ok({ schema: 1, goalReductionPercent: 25, status, reasons, pairs, single, routed, medianTokenReductionPercent: tokenReduction, medianContextByteReductionPercent: contextReduction, successRegression, safetyFailures });
 } catch { return invalid(); }
}

function parseManifest(input: unknown): Fixture[] | null {
  if (!plain(input) || !exactKeys(input, ['schema','fixtures']) || input.schema !== 1 || !Array.isArray(input.fixtures) || input.fixtures.length !== 6) return null;
  const fixtures: Fixture[] = [];
  const seen = new Set<string>();
  for (const raw of input.fixtures) {
    if (!plain(raw) || !exactKeys(raw, ['id','sourceFingerprint','acceptanceFingerprint','variants']) || !isFixture(raw.id) || seen.has(raw.id) || !hash(raw.sourceFingerprint) || !hash(raw.acceptanceFingerprint) || !plain(raw.variants) || !exactKeys(raw.variants, ['single','routed'])) return null;
    seen.add(raw.id);
    const variants = {} as Record<WorkflowBenchmarkVariant, ExpectedCall[]>;
    for (const variant of VARIANTS) {
      const calls = raw.variants[variant];
      if (!Array.isArray(calls) || calls.length < 1 || calls.length > 16) return null;
      const ids = new Set<string>();
      const parsed: ExpectedCall[] = [];
      for (const call of calls) {
        if (!plain(call) || !exactKeys(call, Object.hasOwn(call,'retryOf') ? ['id','role','retryOf'] : ['id','role']) || !short(call.id, 128) || !ROLES.includes(call.role as WorkflowBenchmarkRole) || ids.has(call.id)) return null;
        if (Object.hasOwn(call,'retryOf') && (!short(call.retryOf,128) || !parsed.some((prior) => prior.id === call.retryOf && prior.role === call.role))) return null;
        ids.add(call.id);
        parsed.push({ id: call.id, role: call.role as WorkflowBenchmarkRole, retryOf: typeof call.retryOf === 'string' ? call.retryOf : null });
      }
      variants[variant] = parsed;
    }
    fixtures.push({ id: raw.id, sourceFingerprint: raw.sourceFingerprint, acceptanceFingerprint: raw.acceptanceFingerprint, variants });
  }
  return FIXTURES.every((id) => seen.has(id)) ? fixtures : null;
}

function parseRuns(input: unknown, fixtures: readonly Fixture[]): WorkflowBenchmarkRun[] | null {
  if (!Array.isArray(input) || input.length !== 12) return null;
  const byId = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  const seenPairs = new Set<string>();
  const output: WorkflowBenchmarkRun[] = [];
  let allLogBytes = 0;
  for (const raw of input) {
    if (!plain(raw) || !exactKeys(raw, ['fixtureId','variant','sourceFingerprint','acceptanceFingerprint','outcome','safetyPassed','invocations']) || !isFixture(raw.fixtureId) || !VARIANTS.includes(raw.variant as WorkflowBenchmarkVariant) || !hash(raw.sourceFingerprint) || !hash(raw.acceptanceFingerprint) || !['passed','failed','blocked'].includes(String(raw.outcome)) || !(raw.safetyPassed === null || typeof raw.safetyPassed === 'boolean') || !Array.isArray(raw.invocations) || raw.invocations.length > 16) return null;
    const fixture = byId.get(raw.fixtureId)!;
    if (raw.sourceFingerprint !== fixture.sourceFingerprint || raw.acceptanceFingerprint !== fixture.acceptanceFingerprint) return null;
    const pairKey = `${raw.fixtureId}:${raw.variant}`;
    if (seenPairs.has(pairKey)) return null;
    seenPairs.add(pairKey);
    const expected = new Map(fixture.variants[raw.variant as WorkflowBenchmarkVariant].map((item) => [item.id,item.role]));
    const ids = new Set<string>();
    const invocations: WorkflowBenchmarkInvocation[] = [];
    for (const call of raw.invocations) {
      if (!plain(call) || !exactKeys(call, ['id','role','provider','model','effort','contextBytes','elapsedMs','log','logTruncated']) || !short(call.id,128) || !ROLES.includes(call.role as WorkflowBenchmarkRole) || expected.get(call.id) !== call.role || ids.has(call.id) || !short(call.provider,128) || !short(call.model,128) || !EFFORTS.includes(call.effort as WorkflowBenchmarkEffort) || !integer(call.contextBytes,0,16*1024*1024) || !(call.elapsedMs === null || integer(call.elapsedMs,0,86_400_000)) || !(call.log === null || typeof call.log === 'string') || typeof call.logTruncated !== 'boolean') return null;
      ids.add(call.id);
      if (call.log !== null) {
        const bytes = Buffer.byteLength(call.log, 'utf8');
        if (bytes > LOG_LIMIT) return null;
        allLogBytes = add(allLogBytes, bytes);
        if (allLogBytes > TOTAL_LOG_LIMIT) return null;
      }
      invocations.push({ id:call.id,role:call.role as WorkflowBenchmarkRole,provider:call.provider,model:call.model,effort:call.effort as WorkflowBenchmarkEffort,contextBytes:call.contextBytes,elapsedMs:call.elapsedMs,log:call.log,logTruncated:call.logTruncated });
    }
    output.push({ fixtureId:raw.fixtureId,variant:raw.variant as WorkflowBenchmarkVariant,sourceFingerprint:raw.sourceFingerprint,acceptanceFingerprint:raw.acceptanceFingerprint,outcome:raw.outcome as WorkflowBenchmarkRun['outcome'],safetyPassed:raw.safetyPassed,invocations });
  }
  return seenPairs.size === 12 ? output : null;
}

function parseLog(log: string | null, truncated: boolean): ParsedLog {
  const reasons: string[] = [];
  if (log === null) reasons.push('log_missing');
  if (truncated) reasons.push('log_truncated');
  if (log === null) return { usage:null,usageUnambiguous:false,toolCalls:null,reasons:[...reasons,'usage_unavailable'] };
  const records: unknown[] = [];
  let offset = 0;
  let lineCount = 0;
  while (offset <= log.length) {
    if (++lineCount > 4096) return { usage:null,usageUnambiguous:false,toolCalls:null,reasons:[...reasons,'malformed_log','usage_unavailable'] };
    const newline = log.indexOf('\n',offset);
    const end = newline < 0 ? log.length : newline;
    const line = log.slice(offset,end).replace(/\r$/,'');
    offset = newline < 0 ? log.length + 1 : newline + 1;
    if (line.trim() === '') continue;
    try { records.push(JSON.parse(line) as unknown); }
    catch { reasons.push('malformed_log'); }
  }
  const completed: Usage[] = [];
  let providerFailure = false;
  let toolCalls = 0;
  let turnActive = false;
  let turnTerminal = false;
  for (const record of records) {
    if (!plain(record)) { reasons.push('malformed_log'); continue; }
    if (record.type === 'turn.started') {
      if (turnActive) reasons.push('nested_turn_start');
      turnActive = true;
      turnTerminal = false;
      continue;
    }
    const terminalType = ['turn.completed','turn.failed','turn.interrupted'].includes(String(record.type));
    if (terminalType) {
      if (turnTerminal) reasons.push('redundant_turn_terminal');
      if (record.type !== 'turn.completed' && !turnActive) reasons.push('unmatched_turn_terminal');
      turnActive = false;
      turnTerminal = true;
    } else if (turnTerminal && (record.type === 'item.started' || record.type === 'item.completed')) {
      reasons.push('event_after_turn_terminal');
    }
    if (record.type === 'turn.completed') {
      const usage = record.usage;
      const usageKeys = ['input_tokens','cached_input_tokens','output_tokens'];
      if (plain(usage) && Object.hasOwn(usage,'cache_write_input_tokens')) usageKeys.push('cache_write_input_tokens');
      if (plain(usage) && Object.hasOwn(usage,'reasoning_output_tokens')) usageKeys.push('reasoning_output_tokens');
      if (!plain(usage) || !exactKeys(usage,usageKeys) || !integer(usage.input_tokens,0,TOKEN_LIMIT) || !integer(usage.cached_input_tokens,0,TOKEN_LIMIT) || !integer(usage.output_tokens,0,TOKEN_LIMIT) || (usage.cache_write_input_tokens !== undefined && !integer(usage.cache_write_input_tokens,0,usage.input_tokens)) || (usage.reasoning_output_tokens !== undefined && !integer(usage.reasoning_output_tokens,0,usage.output_tokens)) || usage.cached_input_tokens > usage.input_tokens) {
        reasons.push('invalid_usage');
      } else completed.push({input:usage.input_tokens,cached:usage.cached_input_tokens,cacheWrite:usage.cache_write_input_tokens as number|undefined ?? null,output:usage.output_tokens,reasoning:usage.reasoning_output_tokens as number|undefined ?? null});
    }
    if (['turn.failed','turn.interrupted','provider.error','error'].includes(String(record.type))) providerFailure = true;
    if (record.type === 'item.completed' && plain(record.item) && ['command_execution','mcp_tool_call','web_search'].includes(String(record.item.type))) toolCalls++;
  }
  if (providerFailure) reasons.push('provider_failure');
  if (turnActive) reasons.push('unfinished_turn');
  if (completed.length === 0) reasons.push('usage_missing');
  if (completed.length > 1) reasons.push('ambiguous_usage');
  const usage = completed.length === 1 ? completed[0]! : null;
  let validTotal = false;
  if (usage) {
    try { add(usage.input,usage.output); validTotal = true; } catch { reasons.push('token_overflow'); }
  }
  const malformed = reasons.includes('malformed_log') || reasons.includes('invalid_usage');
  const usageUnambiguous = usage !== null && validTotal && completed.length === 1 && !malformed;
  const lifecycleInvalid = reasons.some((reason)=>['nested_turn_start','redundant_turn_terminal','unmatched_turn_terminal','event_after_turn_terminal','unfinished_turn'].includes(reason));
  const usableToolCalls = malformed || providerFailure || truncated || lifecycleInvalid ? null : toolCalls;
  return { usage:usageUnambiguous ? usage : null,usageUnambiguous,toolCalls:usableToolCalls,reasons:[...new Set(reasons)] };
}

function aggregate(pairs: readonly WorkflowBenchmarkPairReport[]): WorkflowBenchmarkVariantAggregate {
  const values = pairs.map((pair) => pair.totalTokens).filter((value): value is number => value !== null).sort((a,b)=>a-b);
  const contexts = pairs.map((pair) => pair.contextBytes).sort((a,b)=>a-b);
  const observedTokenSubtotal = pairs.reduce((sum,pair)=>add(sum,pair.observedTokenSubtotal),0);
  const rosterComplete=pairs.length===6&&pairs.every((pair)=>pair.missingInvocationIds.length===0);
  const elapsed=pairs.flatMap((pair)=>pair.invocations.map((call)=>call.elapsedMs));
  const calls=pairs.flatMap((pair)=>pair.invocations.map((call)=>call.toolCalls));
  const totalElapsedMs=rosterComplete&&elapsed.every((value):value is number=>value!==null)?elapsed.reduce((sum,value)=>add(sum,value),0):null;
  const totalToolCalls=rosterComplete&&calls.every((value):value is number=>value!==null)?calls.reduce((sum,value)=>add(sum,value),0):null;
  const totalRetries=rosterComplete?pairs.reduce((sum,pair)=>add(sum,pair.retryCount!),0):null;
  return { completePairs:pairs.filter((pair)=>pair.telemetryComplete).length,passedRuns:pairs.filter((pair)=>pair.outcome==='passed').length,observedTokenSubtotal,medianTotalTokens:pairs.length===6&&values.length===6?median(values):null,medianContextBytes:rosterComplete?median(contexts):null,totalElapsedMs,totalToolCalls,totalRetries,telemetryComplete:pairs.length===6&&pairs.every((pair)=>pair.telemetryComplete) };
}
function median(values: readonly number[]): number { const middle=Math.floor(values.length/2); return values.length%2===0?values[middle-1]!/2+values[middle]!/2:values[middle]!; }
function reduction(baseline:number|null, candidate:number|null):number|null { if (baseline===null||candidate===null||baseline===0) return null; return ((baseline-candidate)/baseline)*100; }
function add(left:number,right:number):number { const result=left+right; if (!Number.isSafeInteger(result)||result<0) throw new RangeError('Benchmark total overflow'); return result; }
function plain(value:unknown):value is Record<string,unknown> { if(typeof value!=='object'||value===null||Array.isArray(value))return false; const prototype=Object.getPrototypeOf(value); return prototype===Object.prototype||prototype===null; }
function exactKeys(value:Record<string,unknown>,keys:readonly string[]):boolean { const actual=Object.keys(value).sort(); const expected=[...keys].sort(); return actual.length===expected.length&&actual.every((key,index)=>key===expected[index]); }
function short(value:unknown,max:number):value is string { return typeof value==='string'&&value.length>0&&Buffer.byteLength(value,'utf8')<=max&&!hasControl(value); }
function hasControl(value:string):boolean { return [...value].some((character)=>{const code=character.charCodeAt(0);return code<32||code===127;}); }
function integer(value:unknown,min:number,max:number):value is number { return typeof value==='number'&&Number.isSafeInteger(value)&&value>=min&&value<=max; }
function hash(value:unknown):value is string { return typeof value==='string'&&/^[a-f0-9]{64}$/i.test(value); }
function isFixture(value:unknown):value is WorkflowBenchmarkFixtureId { return typeof value==='string'&&(FIXTURES as readonly string[]).includes(value); }
function invalid():Result<never> { return err(appError('INVALID_INPUT','Invalid workflow benchmark evidence')); }
