import type { ChildProcess } from 'node:child_process';

export interface ProcessTreeTerminator {
  stop(child: ChildProcess, pid: number): Promise<void>;
}

type UnixSignal = 'SIGTERM' | 'SIGKILL';

export interface UnixProcessTreeOptions {
  readonly killGroup?: (pid: number, signal: UnixSignal) => void;
  readonly waitForExit?: (child: ChildProcess, timeoutMs: number) => Promise<boolean>;
  readonly gracefulTimeoutMs?: number;
  readonly forcedTimeoutMs?: number;
}

/** Terminates only a process group created and retained by this runtime. */
export class UnixProcessTree implements ProcessTreeTerminator {
  private readonly killGroup: (pid: number, signal: UnixSignal) => void;
  private readonly waitForExit: (child: ChildProcess, timeoutMs: number) => Promise<boolean>;
  private readonly gracefulTimeoutMs: number;
  private readonly forcedTimeoutMs: number;

  public constructor(options: UnixProcessTreeOptions = {}) {
    this.killGroup = options.killGroup ?? killProcessGroup;
    this.waitForExit = options.waitForExit ?? waitForChildExit;
    this.gracefulTimeoutMs = options.gracefulTimeoutMs ?? 2_000;
    this.forcedTimeoutMs = options.forcedTimeoutMs ?? 2_000;
  }

  public async stop(child: ChildProcess, pid: number): Promise<void> {
    if (!Number.isSafeInteger(pid) || pid <= 1 || child.pid !== pid) {
      throw new Error('Refusing to terminate an unverified owned process group');
    }
    if (child.exitCode !== null || child.signalCode !== null) return;

    this.killGroup(pid, 'SIGTERM');
    if (await this.waitForExit(child, this.gracefulTimeoutMs)) return;

    this.killGroup(pid, 'SIGKILL');
    if (await this.waitForExit(child, this.forcedTimeoutMs)) return;
    throw new Error('Process group exit could not be verified');
  }
}

export function createProcessTreeTerminator(): ProcessTreeTerminator {
  return new UnixProcessTree();
}

function killProcessGroup(pid: number, signal: UnixSignal): void {
  process.kill(-pid, signal);
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const complete = (): void => {
      clearTimeout(timer);
      child.removeListener('exit', complete);
      child.removeListener('close', complete);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.removeListener('exit', complete);
      child.removeListener('close', complete);
      resolve(false);
    }, timeoutMs);
    child.once('exit', complete);
    child.once('close', complete);
  });
}
