import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import { ProcessManager, createSafeProcessEnvironment, type ManagedProcess, type ManagedProcessStart } from '@baitonghub-linux-mcp/process';
import { codexRoleConfig } from './codex-config-policy.js';

export interface CodexSandboxProbePort {
  verify(executable: string, cwd: string, sandbox: 'read-only' | 'workspace-write', signal?: AbortSignal, environment?: NodeJS.ProcessEnv): Promise<Result<void>>;
}

export interface CodexSandboxProcessPort {
  start(spec: ManagedProcessStart, signal?: AbortSignal, onCreated?: (process: ManagedProcess) => void, environment?: NodeJS.ProcessEnv): Promise<Result<ManagedProcess>>;
  status(processId: string): Result<ManagedProcess>;
  stop(processId: string, autoRetry?: boolean): Promise<Result<void>>;
}

const PROBE_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 25;

/** Checks Linux sandbox usability by launching only a no-op inside the requested Codex sandbox. */
export class DirectCodexSandboxProbe implements CodexSandboxProbePort {
  public constructor(
    private readonly processManager: CodexSandboxProcessPort = new ProcessManager(),
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  public async verify(executable: string, cwd: string, sandbox: 'read-only' | 'workspace-write', signal?: AbortSignal, environment = createSafeProcessEnvironment(process.env)): Promise<Result<void>> {
    if (signal?.aborted) return cancelled();
    if (this.platform !== 'linux') return ok(undefined);
    const args = ['sandbox', ...codexRoleConfig(sandbox).flatMap((value) => ['--config', value]), '--', '/bin/true'];
    const env = Object.freeze(createSafeProcessEnvironment(environment));
    let owned: ManagedProcess | undefined;
    let exitCode: number | undefined;
    let probeResult: Result<void> = unavailable(this.platform);
    try {
      const started = await this.processManager.start({ executable, args, cwd, timeoutMs: PROBE_TIMEOUT_MS }, signal, (process) => { owned = process; }, env);
      if (!started.ok) return signal?.aborted ? cancelled() : unavailable(this.platform);
      owned = started.value;
      const deadline = Date.now() + PROBE_TIMEOUT_MS;
      while (Date.now() < deadline && !signal?.aborted) {
        const status = this.processManager.status(owned.processId);
        if (!status.ok) break;
        if (status.value.state === 'exited' || status.value.state === 'failed') {
          exitCode = status.value.exitCode;
          probeResult = exitCode === 0 ? ok(undefined) : unavailable(this.platform, exitCode);
          break;
        }
        await delay(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())), signal);
      }
    } catch {
      probeResult = unavailable(this.platform, exitCode);
    } finally {
      if (owned !== undefined) {
        try {
          const stopped = await this.processManager.stop(owned.processId, true);
          if (!stopped.ok) probeResult = unavailable(this.platform, exitCode);
        } catch {
          probeResult = unavailable(this.platform, exitCode);
        }
      }
    }
    if (signal?.aborted) return cancelled();
    return probeResult;
  }
}

function unavailable(platform: NodeJS.Platform, exitCode?: number): Result<never> {
  return err({ ...appError('CODEX_NOT_AVAILABLE', 'Codex Linux sandbox could not be verified', true), details: { stage: 'sandbox-probe', platform, ...(exitCode === undefined ? {} : { exitCode }) } });
}
function cancelled(): Result<never> { return err(appError('PROCESS_TIMEOUT', 'Codex sandbox preflight was cancelled', true)); }
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
    signal?.addEventListener('abort', done, { once: true });
  });
}
