import { createHash } from 'node:crypto';
import { err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import { describe, expect, it } from 'vitest';
import { ContextPacketRuntime, type ContextPacketActor, type ContextPacketCandidate, type ContextPacketPorts, type ContextSource } from './context-packet-runtime.js';
import { mapResult } from './result-mapper.js';

const actor = { clientId: 'client', clientName: 'test-client', sessionId: 'session-a' };
const candidates: readonly ContextPacketCandidate[] = ['a.ts', 'A.ts', 'b.ts'].map((path) => ({ path, reason: 'matched', gitRelevance: 'none', testRelevance: 'source' }));
interface HarnessOptions { readonly ttl?: number; readonly candidates?: readonly ContextPacketCandidate[]; readonly now?: () => number; readonly beforeRead?: (path: string) => Promise<void> }
interface Harness { readonly runtime: ContextPacketRuntime; readonly texts: Map<string,string>; readonly root: { value: string }; readonly source: ContextPacketPorts['source']; readonly discovery: ContextPacketPorts['discovery'] }
function harness(options: HarnessOptions = {}): Harness {
  const texts = new Map<string, string>([['a.ts', 'const title = "東京";\nexport function alpha() { return title; }'], ['A.ts', 'const title = "distinct";'], ['b.ts', 'export const beta = true;']]);
  const root = { value: 'root1' };
  const source = { readContextFile: async (_actor: ContextPacketActor, _workspace: string, { path }: { readonly path: string; readonly maxBytes?: number }): Promise<Result<ContextSource>> => {
      void _actor; void _workspace;
      await options.beforeRead?.(path);
      const text = texts.get(path); if (text === undefined) return err({ code: 'FILE_NOT_FOUND', message: 'Missing fixture source', recoverable: false });
      const bytes = Buffer.byteLength(text); return ok({ status: 'available', path, text, sourceBytes: bytes, sourceSha256: createHash('sha256').update(text).digest('hex'), rootFingerprint: root.value });
    } };
  const discovery = { discoverPacketCandidates: async (): Promise<ReturnType<typeof ok<{ readonly candidates: readonly ContextPacketCandidate[]; readonly searchTruncated: boolean }>>> => ok({ candidates: options.candidates ?? candidates, searchTruncated: false }) };
  const runtime = new ContextPacketRuntime({ actor, ...(options.ttl === undefined ? {} : { ttlMs: options.ttl }), ...(options.now === undefined ? {} : { now: options.now }), source, discovery });
  return { runtime, texts, root, source, discovery };
}

describe('ContextPacketRuntime', () => {
  it('distinguishes unstable existing reads from missing files during resolve and continuation', async () => {
    const base = harness(); let unstable = false;
    const runtime = new ContextPacketRuntime({ actor, discovery: base.discovery, source: {
      readContextFile: async (owner, workspace, request, signal): Promise<Result<ContextSource>> => unstable && request.path === 'a.ts'
        ? ok({ status: 'unavailable', path: request.path, reason: 'changed', rootFingerprint: base.root.value })
        : base.source.readContextFile(owner, workspace, request, signal),
    } });
    const first = await runtime.collect({ taskId: 'unstable', workspaceId: 'workspace', query: 'title', role: 'worker', budgetBytes: 1800 });
    expect(first.ok).toBe(true); if (!first.ok) return;
    expect(first.value.continuationToken).toBeTruthy();
    unstable = true;
    const resolved = await runtime.resolve({ taskId: 'unstable', workspaceId: 'workspace', reference: first.value.files[0]!.reference });
    expect(resolved.ok).toBe(true); if (resolved.ok) {
      expect(resolved.value.files[0]?.resolutionStatus).toBe('changed');
      expect(resolved.value.files[0]?.sourceReason).toBe('changed');
    }
    unstable = false;
    const again = await runtime.collect({ taskId: 'unstable', workspaceId: 'workspace', query: 'title', role: 'worker', budgetBytes: 3000 });
    expect(again.ok).toBe(true); if (!again.ok) return;
    expect(again.value.files[0]?.snippets?.length).toBeGreaterThan(0);
    expect(again.value.continuationToken).toBeTruthy();
    unstable = true;
    const next = await runtime.continue({ taskId: 'unstable', workspaceId: 'workspace', continuationToken: again.value.continuationToken!, budgetBytes: 5000 });
    expect(next.ok).toBe(true); if (next.ok) expect(next.value.files[0]?.resolutionStatus).toBe('changed');
  });

  it('preserves pending stale notices when a continuation loses ownership to a failed replacement', async () => {
    const paths = Array.from({ length: 5 }, (_, index) => `${index}-${'p'.repeat(200)}.ts`);
    const choices = paths.map(path => ({ path, reason: 'matched', gitRelevance: 'none' as const, testRelevance: 'source' as const }));
    let holdRead = false; let failReplacement = false;
    let releaseRead!: () => void; let readStarted!: () => void; let releaseDiscovery!: () => void;
    const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
    const started = new Promise<void>(resolve => { readStarted = resolve; });
    const discoveryGate = new Promise<void>(resolve => { releaseDiscovery = resolve; });
    const base = harness({ candidates: choices, beforeRead: async (path): Promise<void> => {
      if (holdRead && path === paths[2]) { readStarted(); await readGate; }
    } });
    paths.forEach(path => base.texts.set(path, 'export const title = true;'));
    const runtime = new ContextPacketRuntime({ actor, source: base.source, discovery: {
      discoverPacketCandidates: async (): Promise<Result<{ readonly candidates: readonly ContextPacketCandidate[]; readonly searchTruncated: boolean }>> => {
        if (failReplacement) { await discoveryGate; return err({ code: 'INTERNAL_ERROR', message: 'Fixture discovery failure', recoverable: true }); }
        return ok({ candidates: choices, searchTruncated: false });
      },
    } });
    let initial = await runtime.collect({ taskId: 'stale-race', workspaceId: 'workspace', query: 'title', role: 'worker', budgetBytes: 7500 });
    expect(initial.ok).toBe(true); if (!initial.ok) return;
    expect(initial.value.files.length).toBeGreaterThanOrEqual(3);
    expect(initial.value.hasMore).toBe(true);
    base.texts.set(paths[0]!, 'changed first'); base.texts.set(paths[1]!, 'changed second');
    initial = await runtime.continue({ taskId: 'stale-race', workspaceId: 'workspace', continuationToken: initial.value.continuationToken!, budgetBytes: 2000 });
    expect(initial.ok).toBe(true); if (!initial.ok) return;
    expect(initial.value.files.map(file => file.path)).toEqual([paths[0]]);
    const token = initial.value.continuationToken!;
    holdRead = true;
    const rejected = runtime.continue({ taskId: 'stale-race', workspaceId: 'workspace', continuationToken: token, budgetBytes: 2000 });
    await started;
    failReplacement = true;
    const replacement = runtime.collect({ taskId: 'stale-race', workspaceId: 'workspace', query: 'title', role: 'worker' });
    releaseRead(); expect((await rejected).ok).toBe(false);
    releaseDiscovery(); expect((await replacement).ok).toBe(false);
    holdRead = false;
    const retried = await runtime.continue({ taskId: 'stale-race', workspaceId: 'workspace', continuationToken: token, budgetBytes: 2000 });
    expect(retried.ok).toBe(true); if (retried.ok) {
      expect(retried.value.files.map(file => file.path)).toEqual([paths[1]]);
      expect(retried.value.files[0]?.resolutionStatus).toBe('changed');
    }
  });

  it('bounds the complete mapped MCP response and preserves case-distinct paths', async () => {
    const { runtime } = harness();
    const result = await runtime.collect({ taskId: 'task', workspaceId: 'workspace', query: 'title', role: 'worker', budgetBytes: 5000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Buffer.byteLength(JSON.stringify(mapResult(result)), 'utf8')).toBeLessThanOrEqual(5000);
    expect(result.value.serializedBytes).toBe(Buffer.byteLength(JSON.stringify(mapResult(result)), 'utf8'));
    expect(result.value.files.map((f) => f.path)).toContain('a.ts');
    expect(result.value.files.map((f) => f.path)).toContain('A.ts');
    expect(result.value.safety).toContain('references grant no permissions');
  });

  it('leaves pruned candidates for continuation and rotates tokens after successful delivery', async () => {
    const { runtime } = harness({ candidates: candidates.slice(0, 2) });
    const first = await runtime.collect({ taskId: 'task', workspaceId: 'workspace', query: 'title', role: 'worker', budgetBytes: 1700 });
    expect(first.ok).toBe(true); if (!first.ok) return;
    expect(first.value.hasMore).toBe(true); expect(first.value.files.length).toBeGreaterThan(0);
    const second = await runtime.continue({ taskId: 'task', workspaceId: 'workspace', continuationToken: first.value.continuationToken!, budgetBytes: 5000 });
    expect(second.ok).toBe(true); if (!second.ok) return;
    expect(second.value.files.some((file) => file.path === 'A.ts')).toBe(true);
    const replay = await runtime.continue({ taskId: 'task', workspaceId: 'workspace', continuationToken: first.value.continuationToken! });
    expect(replay.ok).toBe(false);
  });

  it('resolves changed content freshly with prior and observed fingerprints', async () => {
    const { runtime, texts } = harness({ candidates: candidates.slice(0, 2) });
    const packet = await runtime.collect({ taskId: 'task', workspaceId: 'workspace', query: 'title', role: 'worker' });
    expect(packet.ok).toBe(true); if (!packet.ok) return;
    const prior = packet.value.files[0]!;
    texts.set('a.ts', 'const title = "changed";');
    texts.set('A.ts', 'const title = "also changed";');
    const resolved = await runtime.resolve({ taskId: 'task', workspaceId: 'workspace', reference: prior.reference, budgetBytes: 5000 });
    expect(resolved.ok).toBe(true); if (!resolved.ok) return;
    expect(resolved.value.files[0]?.sourceSha256).not.toBe(prior.sourceSha256);
    expect(resolved.value.files[0]?.diff?.baseSha256).toBe(prior.sourceSha256);
    expect(resolved.value.files[0]?.diff?.currentSha256).toBe(resolved.value.files[0]?.sourceSha256);
    const second = await runtime.resolve({ taskId: 'task', workspaceId: 'workspace', reference: packet.value.files.find((file) => file.path === 'A.ts')!.reference });
    expect(second.ok).toBe(true); if (second.ok) expect(second.value.files[0]?.resolutionStatus).toBe('changed');
  });

  it('rejects expired, cross-session and unknown references uniformly', async () => {
    let now = 1000; const first = harness({ ttl: 5, now: () => now });
    const packet = await first.runtime.collect({ taskId: 'task', workspaceId: 'workspace', query: 'title', role: 'worker' });
    expect(packet.ok).toBe(true); if (!packet.ok) return;
    now += 6;
    expect((await first.runtime.resolve({ taskId: 'task', workspaceId: 'workspace', reference: packet.value.files[0]!.reference })).ok).toBe(false);
    const second = harness();
    expect((await second.runtime.resolve({ taskId: 'task', workspaceId: 'workspace', reference: packet.value.files[0]!.reference })).ok).toBe(false);
  });

  it('does not commit cancellation after an in-flight discovery', async () => {
    const controller = new AbortController(); const base = harness();
    const runtime = new ContextPacketRuntime({ actor, source: base.source, discovery: { discoverPacketCandidates: async (): Promise<ReturnType<typeof ok<{ readonly candidates: readonly ContextPacketCandidate[]; readonly searchTruncated: boolean }>>> => { controller.abort(); return ok({ candidates, searchTruncated: false }); } } });
    const result = await runtime.collect({ taskId: 'task', workspaceId: 'workspace', query: 'title', role: 'worker' }, controller.signal);
    expect(result.ok).toBe(false);
    expect((await runtime.continue({ taskId: 'task', workspaceId: 'workspace', continuationToken: 'x' })).ok).toBe(false);
  });

  it('resolves large escaped and multibyte sources within the actual response budget and establishes a delivered diff base', async () => {
    const longText = `const title = "${'東京\\"'.repeat(5000)}";`;
    const { runtime, texts } = harness({ candidates: candidates.slice(0, 1) });
    texts.set('a.ts', longText);
    const initial = await runtime.collect({ taskId: 'large', workspaceId: 'workspace', query: 'title', role: 'worker', budgetBytes: 2048 });
    expect(initial.ok).toBe(true); if (!initial.ok) return;
    const ref = initial.value.files[0]!.reference;
    const resolved = await runtime.resolve({ taskId: 'large', workspaceId: 'workspace', reference: ref, budgetBytes: 2048 });
    expect(resolved.ok).toBe(true); if (!resolved.ok) return;
    expect(resolved.value.serializedBytes).toBeLessThanOrEqual(2048);
    expect(resolved.value.files[0]?.snippets?.length || resolved.value.files[0]?.contentOmitted).toBeTruthy();
    const delivered = await runtime.resolve({ taskId: 'large', workspaceId: 'workspace', reference: ref, budgetBytes: 32 * 1024 });
    expect(delivered.ok).toBe(true); if (!delivered.ok) return;
    const baseline = delivered.value.files[0]?.sourceSha256;
    texts.set('a.ts', `${longText}\n// changed`);
    const changed = await runtime.resolve({ taskId: 'large', workspaceId: 'workspace', reference: ref, budgetBytes: 32 * 1024 });
    expect(changed.ok).toBe(true); if (!changed.ok) return;
    expect(changed.value.files[0]?.diff?.baseSha256).toBe(baseline);
    expect(Buffer.byteLength(JSON.stringify(mapResult(changed)), 'utf8')).toBeLessThanOrEqual(32 * 1024);
  });

  it('identifies missing and replaced-root sources without claiming old hashes are current', async () => {
    const { runtime, texts, root } = harness({ candidates: candidates.slice(0, 2) });
    const packet = await runtime.collect({ taskId: 'stale', workspaceId: 'workspace', query: 'title', role: 'worker' });
    expect(packet.ok).toBe(true); if (!packet.ok) return;
    texts.delete('a.ts');
    const missing = await runtime.resolve({ taskId: 'stale', workspaceId: 'workspace', reference: packet.value.files.find((file) => file.path === 'a.ts')!.reference });
    expect(missing.ok).toBe(true); if (missing.ok) expect(missing.value.files[0]?.resolutionStatus).toBe('missing');
    root.value = 'replacement-root';
    const replaced = await runtime.resolve({ taskId: 'stale', workspaceId: 'workspace', reference: packet.value.files.find((file) => file.path === 'A.ts')!.reference });
    expect(replaced.ok).toBe(true); if (replaced.ok) expect(replaced.value.files[0]?.resolutionStatus).toBe('root_changed');
  });

  it('returns explicit stale status when continue detects a replaced workspace root', async () => {
    const { runtime, root } = harness({ candidates });
    const packet=await runtime.collect({taskId:'continue-stale',workspaceId:'workspace',query:'title',role:'worker',budgetBytes:1800});
    expect(packet.ok).toBe(true);if(!packet.ok||!packet.value.continuationToken)return;
    root.value='new-root';
    const next=await runtime.continue({taskId:'continue-stale',workspaceId:'workspace',continuationToken:packet.value.continuationToken,budgetBytes:3000});
    expect(next.ok).toBe(true);if(!next.ok)return;
    expect(next.value.files[0]?.resolutionStatus).toBe('root_changed');
    expect(next.value.files[0]?.sourceSha256).toBeUndefined();
  });

  it('does not commit a read that completes after task expiry', async () => {
    let now = 100; let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { runtime } = harness({ ttl: 10, now: () => now, candidates: candidates.slice(0, 1), beforeRead: async (): Promise<void> => gate });
    const pending = runtime.collect({ taskId: 'expiring', workspaceId: 'workspace', query: 'title', role: 'worker' });
    await Promise.resolve(); now = 111; release?.();
    expect((await pending).ok).toBe(false);
  });

  it('checks expiry again after a deferred resolve read', async () => {
    let now=100;let release:(()=>void)|undefined;let waitForRead:(()=>void)|undefined;
    const gate=new Promise<void>((resolve)=>{release=resolve;});const started=new Promise<void>((resolve)=>{waitForRead=resolve;});
    let hold=false;
    const pendingRuntime=harness({ttl:10,now:()=>now,candidates:candidates.slice(0,1),beforeRead:async():Promise<void>=>{if(hold){waitForRead?.();await gate;}}});
    const pendingPacket=await pendingRuntime.runtime.collect({taskId:'resolve-expiry',workspaceId:'workspace',query:'title',role:'worker'});
    expect(pendingPacket.ok).toBe(true);if(!pendingPacket.ok)return;
    hold=true;
    const pending=pendingRuntime.runtime.resolve({taskId:'resolve-expiry',workspaceId:'workspace',reference:pendingPacket.value.files[0]!.reference});
    await started;now=111;release?.();
    expect((await pending).ok).toBe(false);
  });

  it('rejects simultaneous continuation reuse and concurrent collect replacement commits', async () => {
    let arrivals = 0; let hold = false; let release: (() => void) | undefined; const gate = new Promise<void>((resolve) => { release = resolve; });
    const { runtime } = harness({ candidates, beforeRead: async (): Promise<void> => { if (!hold) return; arrivals++; if (arrivals <= 2) { if (arrivals === 2) release?.(); await gate; } } });
    const initial = await runtime.collect({ taskId: 'race', workspaceId: 'workspace', query: 'title', role: 'worker', budgetBytes: 1800 });
    expect(initial.ok).toBe(true); if (!initial.ok || !initial.value.continuationToken) return;
    const token = initial.value.continuationToken;
    hold = true;
    const first = runtime.continue({ taskId: 'race', workspaceId: 'workspace', continuationToken: token, budgetBytes: 3000 });
    const replay = runtime.continue({ taskId: 'race', workspaceId: 'workspace', continuationToken: token, budgetBytes: 3000 });
    const pair = await Promise.all([first, replay]);
    expect(pair.filter((value) => value.ok).length).toBe(1);
    expect(pair.filter((value) => !value.ok).length).toBe(1);
  });

  it('lets a later collect replace state and prevents an earlier in-flight collect from committing', async () => {
    let count = 0; let release: (() => void) | undefined; let arrived: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; }); const started = new Promise<void>((resolve) => { arrived = resolve; });
    const { runtime } = harness({ candidates: candidates.slice(0, 1), beforeRead: async (): Promise<void> => { count++; if (count === 1) { arrived?.(); await gate; } } });
    const older = runtime.collect({ taskId: 'replace', workspaceId: 'workspace', query: 'title', role: 'worker' });
    await started;
    const newer = await runtime.collect({ taskId: 'replace', workspaceId: 'workspace', query: 'title', role: 'worker' });
    expect(newer.ok).toBe(true);
    release?.();
    expect((await older).ok).toBe(false);
  });

  it('keeps task, reference, and stored-text state within their hard quotas', async () => {
    const { runtime: taskRuntime } = harness({ candidates: candidates.slice(0, 1) });
    const firstTask = await taskRuntime.collect({ taskId: 'task-0', workspaceId: 'workspace', query: 'title', role: 'worker' });
    expect(firstTask.ok).toBe(true); if (!firstTask.ok) return;
    for (let index = 1; index < 33; index++) {
      await taskRuntime.collect({ taskId: `task-${index}`, workspaceId: 'workspace', query: 'title', role: 'worker' });
    }

    const refCandidates = Array.from({ length: 100 }, (_, index) => ({ path: `ref-${index}.ts`, reason: 'reference quota', gitRelevance: 'none' as const, testRelevance: 'source' as const }));
    const refRuntime = new ContextPacketRuntime({ actor, source: { readContextFile: async (_actor, _workspace, { path }): Promise<ReturnType<typeof ok<ContextSource>>> => ok({ status: 'unavailable', path, reason: 'changed', rootFingerprint: 'root' }) }, discovery: { discoverPacketCandidates: async (): Promise<ReturnType<typeof ok<{ readonly candidates: readonly ContextPacketCandidate[]; readonly searchTruncated: boolean }>>> => ok({ candidates: refCandidates, searchTruncated: false }) } });
    let oldestRef = '';
    for (let task = 0; task < 3; task++) {
      let refPage = await refRuntime.collect({ taskId: `refs-${task}`, workspaceId: 'workspace', query: 'none', role: 'qa' });
      expect(refPage.ok).toBe(true); if (!refPage.ok) return;
      if (task === 0) oldestRef = refPage.value.files[0]!.reference;
      for (let iteration=0;refPage.value.hasMore&&iteration<10;iteration++) {
        refPage=await refRuntime.continue({taskId:`refs-${task}`,workspaceId:'workspace',continuationToken:refPage.value.continuationToken!,budgetBytes:64*1024});
        expect(refPage.ok).toBe(true); if(!refPage.ok)return;
      }
      expect(refPage.value.hasMore).toBe(false);
    }
    expect((await refRuntime.resolve({taskId:'refs-0',workspaceId:'workspace',reference:oldestRef})).ok).toBe(false);

    const largeCandidates = Array.from({ length: 17 }, (_, index) => ({ path: `large-${index}.ts`, reason: 'large', gitRelevance: 'none' as const, testRelevance: 'source' as const }));
    const largeTexts = new Map(largeCandidates.map((candidate) => [candidate.path, `const title = "${'x'.repeat(250 * 1024 - 20)}";`]));
    const largeSource: ContextPacketPorts['source'] = { readContextFile: async (_actor, _workspace, { path }): Promise<ReturnType<typeof ok<ContextSource>>> => { const text=largeTexts.get(path); if(text===undefined)return ok({status:'unavailable',path,reason:'changed',rootFingerprint:'root'});return ok({status:'available',path,text,sourceBytes:Buffer.byteLength(text),sourceSha256:createHash('sha256').update(text).digest('hex'),rootFingerprint:'root'}); } };
    const largeRuntime = new ContextPacketRuntime({ actor, source: largeSource, discovery: { discoverPacketCandidates: async (): Promise<ReturnType<typeof ok<{ readonly candidates: readonly ContextPacketCandidate[]; readonly searchTruncated: boolean }>>> => ok({ candidates: largeCandidates, searchTruncated: false }) } });
    let page = await largeRuntime.collect({ taskId: 'large-quota', workspaceId: 'workspace', query: 'title', role: 'worker' });
    expect(page.ok).toBe(true); if (!page.ok) return;
    const firstRef = page.value.files[0]!.reference;
    for (let iteration=0;page.value.hasMore&&iteration<20;iteration++) {
      page=await largeRuntime.continue({taskId:'large-quota',workspaceId:'workspace',continuationToken:page.value.continuationToken!});
      expect(page.ok).toBe(true); if(!page.ok)return;
    }
    expect(page.value.hasMore).toBe(false);
    largeTexts.set('large-0.ts', 'const title = "edited after packet";');
    const resolved = await largeRuntime.resolve({taskId:'large-quota',workspaceId:'workspace',reference:firstRef});
    expect(resolved.ok).toBe(true); if(resolved.ok)expect(resolved.value.files[0]?.diff).toBeUndefined();
    expect((await taskRuntime.resolve({taskId:'task-0',workspaceId:'workspace',reference:firstTask.value.files[0]!.reference})).ok).toBe(false);
  });

  it('rejects concurrent resolve reuse after the first atomic commit', async () => {
    let hold = false; let arrivals = 0; let release: (() => void) | undefined;
    const gate=new Promise<void>((resolve)=>{release=resolve;});
    const {runtime}=harness({candidates:candidates.slice(0,1),beforeRead:async():Promise<void>=>{if(!hold)return;arrivals++;if(arrivals===2)release?.();if(arrivals<=2)await gate;}});
    const packet=await runtime.collect({taskId:'resolve-race',workspaceId:'workspace',query:'title',role:'worker'});
    expect(packet.ok).toBe(true);if(!packet.ok)return;hold=true;
    const reference=packet.value.files[0]!.reference;
    const pair=await Promise.all([runtime.resolve({taskId:'resolve-race',workspaceId:'workspace',reference}),runtime.resolve({taskId:'resolve-race',workspaceId:'workspace',reference})]);
    expect(pair.filter((result)=>result.ok).length).toBe(1);
    expect(pair.filter((result)=>!result.ok).length).toBe(1);
  });

  it('rejects NUL identifiers and workspace identifiers over 128 UTF-8 bytes', async () => {
    const { runtime } = harness();
    expect((await runtime.collect({ taskId: 'bad\0task', workspaceId: 'workspace', query: 'title', role: 'worker' })).ok).toBe(false);
    expect((await runtime.collect({ taskId: 'task', workspaceId: 'x'.repeat(129), query: 'title', role: 'worker' })).ok).toBe(false);
  });
});
