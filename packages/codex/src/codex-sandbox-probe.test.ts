import { describe, expect, it, vi } from 'vitest';
import { err, ok } from '@baitonghub-linux-mcp/domain';
import type { ManagedProcess, ManagedProcessStart } from '@baitonghub-linux-mcp/process';
import { codexRoleConfig } from './codex-config-policy.js';
import { DirectCodexSandboxProbe, type CodexSandboxProcessPort } from './codex-sandbox-probe.js';

const running: ManagedProcess = { processId: 'probe-1', executable: 'codex', args: [], cwd: '/workspace', state: 'running', startedAt: 'now' };
function manager(status: () => ReturnType<CodexSandboxProcessPort['status']>, stop = vi.fn(async () => ok(undefined))): { port: CodexSandboxProcessPort; start: ReturnType<typeof vi.fn>; stop: CodexSandboxProcessPort['stop'] } {
  const start = vi.fn(async (_spec: ManagedProcessStart, _signal?: AbortSignal, created?: (process: ManagedProcess) => void) => {
    created?.(running);
    return ok(running);
  });
  return { port: { start, status, stop } satisfies CodexSandboxProcessPort, start, stop };
}

describe('DirectCodexSandboxProbe', () => {
  it('runs /bin/true using the exact requested sandbox config and supplied environment', async () => {
    const fixture = manager(() => ok({ ...running, state: 'exited', exitCode: 0 }));
    const environment = { PATH: '/usr/bin', HOME: '/home/test', CODEX_HOME: '/tmp/codex', OPENAI_API_KEY: 'must-not-pass' };
    const result = await new DirectCodexSandboxProbe(fixture.port, 'linux').verify('codex', '/workspace', 'workspace-write', undefined, environment);
    expect(result).toEqual({ ok: true, value: undefined });
    expect(fixture.start).toHaveBeenCalledWith({ executable: 'codex', args: ['sandbox', ...codexRoleConfig('workspace-write').flatMap((value) => ['--config', value]), '--', '/bin/true'], cwd: '/workspace', timeoutMs: 5000 }, undefined, expect.any(Function), expect.objectContaining({ PATH: environment.PATH, HOME: environment.HOME, CODEX_HOME: environment.CODEX_HOME }));
    expect(fixture.start.mock.calls[0]?.[3]).not.toHaveProperty('OPENAI_API_KEY');
    expect(fixture.stop).toHaveBeenCalledWith('probe-1', true);
  });

  it('rejects a helper failure and keeps only bounded safe diagnostics', async () => {
    const fixture = manager(() => ok({ ...running, state: 'exited', exitCode: 1 }));
    const result = await new DirectCodexSandboxProbe(fixture.port, 'linux').verify('codex', '/workspace', 'read-only');
    expect(result).toMatchObject({ ok: false, error: { code: 'CODEX_NOT_AVAILABLE', details: { stage: 'sandbox-probe', platform: 'linux', exitCode: 1 } } });
    expect(JSON.stringify(result)).not.toContain('stderr');
  });

  it('fails closed when cleanup cannot be verified', async () => {
    const fixture = manager(() => ok({ ...running, state: 'exited', exitCode: 0 }), async () => err({ code: 'PROCESS_TIMEOUT', message: 'secret diagnostic', recoverable: true }));
    const result = await new DirectCodexSandboxProbe(fixture.port, 'linux').verify('codex', '/workspace', 'read-only');
    expect(result).toMatchObject({ ok: false, error: { code: 'CODEX_NOT_AVAILABLE' } });
    expect(JSON.stringify(result)).not.toContain('secret diagnostic');
  });

  it('fails closed when the helper remains running through the bounded probe window', async () => {
    vi.useFakeTimers();
    try {
      const fixture = manager(() => ok(running));
      const pending = new DirectCodexSandboxProbe(fixture.port, 'linux').verify('codex', '/workspace', 'read-only');
      await vi.advanceTimersByTimeAsync(5_100);
      await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'CODEX_NOT_AVAILABLE', details: { stage: 'sandbox-probe' } } });
      expect(fixture.stop).toHaveBeenCalledWith('probe-1', true);
    } finally { vi.useRealTimers(); }
  });

  it('does not execute on unsupported platforms', async () => {
    const fixture = manager(() => ok(running));
    await expect(new DirectCodexSandboxProbe(fixture.port, 'win32').verify('codex', '/workspace', 'read-only')).resolves.toEqual({ ok: true, value: undefined });
    expect(fixture.start).not.toHaveBeenCalled();
  });

  it('returns cancellation when aborted and still cleans up its owned process', async () => {
    const controller = new AbortController();
    const fixture = manager(() => { controller.abort(); return ok(running); });
    await expect(new DirectCodexSandboxProbe(fixture.port, 'linux').verify('codex', '/workspace', 'read-only', controller.signal)).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    expect(fixture.stop).toHaveBeenCalledWith('probe-1', true);
  });

  it('does not launch when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const fixture = manager(() => ok(running));
    await expect(new DirectCodexSandboxProbe(fixture.port, 'linux').verify('codex', '/workspace', 'read-only', controller.signal)).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    expect(fixture.start).not.toHaveBeenCalled();
  });

  it('cleans up a process handle created before start reported failure', async () => {
    const stop = vi.fn(async () => ok(undefined));
    const start = vi.fn(async (_spec: ManagedProcessStart, _signal?: AbortSignal, created?: (process: ManagedProcess) => void) => {
      created?.(running);
      return err({ code: 'PROCESS_TIMEOUT', message: 'raw details', recoverable: true });
    });
    const port: CodexSandboxProcessPort = { start, status: () => ok(running), stop };
    const result = await new DirectCodexSandboxProbe(port, 'linux').verify('codex', '/workspace', 'read-only');
    expect(result).toMatchObject({ ok: false, error: { code: 'CODEX_NOT_AVAILABLE' } });
    expect(JSON.stringify(result)).not.toContain('raw details');
    expect(stop).toHaveBeenCalledWith('probe-1', true);
  });
});
