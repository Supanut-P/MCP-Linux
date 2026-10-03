import { describe, expect, it } from 'vitest';
import { err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import type { ManagedProcess, ManagedProcessStart, ProcessLogResult } from '@baitonghub-linux-mcp/process';
import { CodexAdapter, type CodexDiscoveryPort, type CodexProcessManagerPort } from './codex-adapter.js';
import type { CodexDiscoveryResult } from './codex-capabilities.js';
import type { CodexVerifiedConfig } from './codex-config-inspector.js';

describe('CodexAdapter', () => {
  it('rejects an unusable sandbox before model dispatch and passes the same effective environment', async () => {
    let starts = 0;
    const manager: CodexProcessManagerPort = {
      start: async () => { starts++; return ok(processHandle()); },
      status: () => ok(processHandle()), logs: () => ok({ entries: [], truncated: false, nextSequence: 0 }), stop: async () => ok(undefined),
    };
    const discovery: CodexDiscoveryPort = { discover: async () => ok({ ...discovered(), capabilities: { instructionMode: 'exec-argument', names: ['exec'], enhanced: true } }) };
    let effectiveEnvironment: NodeJS.ProcessEnv | undefined;
    let probes = 0;
    const adapter = new CodexAdapter(discovery, manager, undefined,
      { verify: async (_executable, _cwd, _sandbox, _signal, environment): Promise<Result<CodexVerifiedConfig>> => {
        effectiveEnvironment = environment;
        return ok({ disabledServerIds: [], configFingerprint: 'fixture' });
      } },
      { verify: async (executable, cwd, sandbox, _signal, environment): Promise<Result<void>> => {
        probes++;
        expect(executable).toBe('C:\\tools\\codex.exe');
        expect(cwd).toBe('/workspace');
        expect(sandbox).toBe('workspace-write');
        expect(environment).toBe(effectiveEnvironment);
        return err({ code: 'CODEX_NOT_AVAILABLE', message: 'Sandbox unavailable', recoverable: true, details: { stage: 'sandbox-probe' } });
      } });
    await expect(adapter.start('/workspace', 'fix', undefined, undefined, { role: 'worker' }, true)).resolves.toMatchObject({ ok: false, error: { code: 'CODEX_NOT_AVAILABLE', details: { stage: 'sandbox-probe' } } });
    expect(probes).toBe(1);
    expect(starts).toBe(0);
  });

  it('does not dispatch when cancellation arrives during sandbox verification', async () => {
    const controller = new AbortController();
    let starts = 0;
    const manager: CodexProcessManagerPort = {
      start: async () => { starts++; return ok(processHandle()); },
      status: () => ok(processHandle()), logs: () => ok({ entries: [], truncated: false, nextSequence: 0 }), stop: async () => ok(undefined),
    };
    const discovery: CodexDiscoveryPort = { discover: async () => ok({ ...discovered(), capabilities: { instructionMode: 'exec-argument', names: ['exec'], enhanced: true } }) };
    const adapter = new CodexAdapter(discovery, manager, undefined,
      { verify: async (): Promise<Result<CodexVerifiedConfig>> => ok({ disabledServerIds: [], configFingerprint: 'fixture' }) },
      { verify: async (): Promise<Result<void>> => { controller.abort(); return ok(undefined); } });
    await expect(adapter.start('/workspace', 'review', controller.signal, undefined, { role: 'qa' })).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    expect(starts).toBe(0);
  });

  it('preserves legacy invocation without adding sandbox probes', async () => {
    let probes = 0;
    const manager: CodexProcessManagerPort = {
      start: async () => ok(processHandle()), status: () => ok(processHandle()),
      logs: () => ok({ entries: [], truncated: false, nextSequence: 0 }), stop: async () => ok(undefined),
    };
    const discovery: CodexDiscoveryPort = { discover: async () => ok(discovered()) };
    const adapter = new CodexAdapter(discovery, manager, undefined, undefined, { verify: async (): Promise<Result<void>> => { probes++; return ok(undefined); } });
    await expect(adapter.start('/workspace', 'legacy instruction')).resolves.toMatchObject({ ok: true });
    expect(probes).toBe(0);
  });

  it('does not launch after cancellation during effective-config verification', async () => {
    const controller = new AbortController();
    let starts = 0;
    const manager: CodexProcessManagerPort = {
      start: async (): Promise<Result<ManagedProcess>> => { starts++; return ok(processHandle()); },
      status: () => ok(processHandle()), logs: () => ok({ entries: [], truncated: false, nextSequence: 0 }), stop: async () => ok(undefined),
    };
    const discovery: CodexDiscoveryPort = { discover: async () => ok({ ...discovered(), capabilities: { instructionMode: 'exec-argument', names: ['exec'], enhanced: true } }) };
    const adapter = new CodexAdapter(discovery, manager, undefined, { verify: async (): Promise<Result<CodexVerifiedConfig>> => { controller.abort(); return ok({ disabledServerIds: [], configFingerprint: 'fixture' }); } });
    await expect(adapter.start('workspace', 'review', controller.signal, undefined, { role: 'qa' })).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    expect(starts).toBe(0);
  });
  it('requires enhanced controls and WRITE authority without silently reverting to legacy invocation', async () => {
    let starts = 0;
    const manager: CodexProcessManagerPort = {
      async start(): Promise<Result<ManagedProcess>> { starts++; return ok(processHandle()); },
      status: () => ok(processHandle()), logs: () => ok({ entries: [], truncated: false, nextSequence: 0 }), stop: async () => ok(undefined),
    };
    const discovery: CodexDiscoveryPort = { discover: async () => ok(discovered()) };
    const adapter = new CodexAdapter(discovery, manager);
    await expect(adapter.start('workspace', 'review', undefined, undefined, { role: 'qa' })).resolves.toMatchObject({ ok: false, error: { code: 'CODEX_NOT_AVAILABLE' } });
    await expect(adapter.start('workspace', 'edit', undefined, undefined, { role: 'worker' })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(starts).toBe(0);
  });

  it('reports CLI syntax readiness separately from unknown account availability and fixes launch controls', async () => {
    const calls: ManagedProcessStart[] = [];
    const manager: CodexProcessManagerPort = {
      async start(spec): Promise<Result<ManagedProcess>> { calls.push(spec); return ok(processHandle()); },
      status: () => ok(processHandle()), logs: () => ok({ entries: [], truncated: false, nextSequence: 0 }), stop: async () => ok(undefined),
    };
    const discovery: CodexDiscoveryPort = { discover: async () => ok({ ...discovered(), capabilities: { instructionMode: 'exec-argument', names: ['exec'], enhanced: true, integrationControlsVerified: true } }) };
    const adapter = new CodexAdapter(discovery, manager, undefined, { verify: async (): Promise<Result<CodexVerifiedConfig>> => ok({ disabledServerIds: ['registered'], configFingerprint: 'fixture' }) }, { verify: async (): Promise<Result<void>> => ok(undefined) });
    await expect(adapter.status({ role: 'qa' })).resolves.toMatchObject({ ok: true, value: { preflight: { localReady: false, reasonCodes: ['workspace_preflight_required'], authentication: 'unknown', accountAvailability: 'unknown', evidence: 'cli_help_only' } } });
    await adapter.start('workspace', 'review --danger', undefined, undefined, { role: 'qa', effort: 'high' });
    expect(calls[0]?.args).toContain('gpt-6.1-sol');
    expect(calls[0]?.args).toContain('model_reasoning_effort="high"');
    expect(calls[0]?.args).toContain('read-only');
    expect(calls[0]?.args).not.toContain('--ignore-user-config');
    expect(calls[0]?.args).toContain('features.hooks=false');
    expect(calls[0]?.args).toContain('mcp_servers={"registered"={enabled=false}}');
    expect(calls[0]?.args).not.toContain('mcp_servers={}');
    expect(calls[0]?.args.slice(-2)).toEqual(['--', 'review --danger']);
    expect(calls[0]?.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('does not treat CLI syntax support as verified integration isolation', async () => {
    let starts = 0;
    const manager: CodexProcessManagerPort = {
      start: async (): Promise<Result<ManagedProcess>> => { starts++; return ok(processHandle()); },
      status: () => ok(processHandle()), logs: () => ok({ entries: [], truncated: false, nextSequence: 0 }), stop: async () => ok(undefined),
    };
    const discovery: CodexDiscoveryPort = { discover: async () => ok({ ...discovered(), capabilities: { instructionMode: 'exec-argument', names: ['exec'], enhanced: true } }) };
    const adapter = new CodexAdapter(discovery, manager, undefined, { verify: async (): Promise<Result<CodexVerifiedConfig>> => err({ code: 'CODEX_NOT_AVAILABLE', message: 'fixture unavailable', recoverable: true }) });
    await expect(adapter.status({ role: 'qa' })).resolves.toMatchObject({ ok: true, value: { preflight: { syntaxReady: true, localReady: false, reasonCodes: ['workspace_preflight_required'] } } });
    await expect(adapter.start('workspace', 'review', undefined, undefined, { role: 'qa' })).resolves.toMatchObject({ ok: false, error: { code: 'CODEX_NOT_AVAILABLE' } });
    expect(starts).toBe(0);
  });
  it('builds direct executable arguments and delegates the task to ProcessManager', async () => {
    const calls: ManagedProcessStart[] = [];
    const manager: CodexProcessManagerPort = {
      async start(spec): Promise<Result<ManagedProcess>> { calls.push(spec); return ok(processHandle()); },
      status(): Result<ManagedProcess> { return ok(processHandle()); },
      logs(): Result<ProcessLogResult> { return ok({ entries: [], truncated: false, nextSequence: 0 }); },
      async stop(): Promise<Result<void>> { return ok(undefined); },
    };
    const discovery: CodexDiscoveryPort = { async discover(): Promise<Result<CodexDiscoveryResult>> { return ok(discovered()); } };

    const result = await new CodexAdapter(discovery, manager).start('C:\\workspace', 'review "quoted" input');

    expect(result).toMatchObject({ ok: true, value: { processId: 'process-1' } });
    expect(calls).toEqual([{ executable: 'C:\\tools\\codex.exe', args: ['exec', 'review "quoted" input'], cwd: 'C:\\workspace' }]);
  });

  it('does not start a process after cancellation wins during Codex discovery', async () => {
    let releaseDiscovery!: () => void;
    const discoveryGate = new Promise<void>((resolve) => { releaseDiscovery = resolve; });
    let starts = 0;
    const manager: CodexProcessManagerPort = {
      async start(): Promise<Result<ManagedProcess>> { starts += 1; return ok(processHandle()); },
      status(): Result<ManagedProcess> { return ok(processHandle()); },
      logs(): Result<ProcessLogResult> { return ok({ entries: [], truncated: false, nextSequence: 0 }); },
      async stop(): Promise<Result<void>> { return ok(undefined); },
    };
    const discovery: CodexDiscoveryPort = {
      async discover(): Promise<Result<CodexDiscoveryResult>> {
        await discoveryGate;
        return ok(discovered());
      },
    };
    const controller = new AbortController();

    const starting = new CodexAdapter(discovery, manager).start('C:\\workspace', 'review', controller.signal);
    controller.abort();
    releaseDiscovery();

    await expect(starting).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    expect(starts).toBe(0);
  });
});

function discovered(): CodexDiscoveryResult {
  return {
    status: { installed: true, executablePath: 'C:\\tools\\codex.exe', version: '0.42.1', capabilities: ['exec'] },
    capabilities: { instructionMode: 'exec-argument', names: ['exec'] },
  };
}

function processHandle(): ManagedProcess {
  return { processId: 'process-1', executable: 'C:\\tools\\codex.exe', args: ['exec', 'review'], cwd: 'C:\\workspace', state: 'running', startedAt: new Date(0).toISOString() };
}
