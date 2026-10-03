import type { ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { memberMayExecute, readLinuxGroupMembers, sameLinuxGroupMember, type LinuxGroupMember } from './linux-process-group.js';

export interface ProcessTreeTerminator {
  captureOwnership?(child: ChildProcess, pid: number): void;
  observeOwnership?(child: ChildProcess, pid: number): void;
  stop(child: ChildProcess, pid: number): Promise<void>;
}

type UnixSignal = 'SIGTERM' | 'SIGKILL';

export interface UnixProcessTreeOptions {
  readonly killGroup?: (pid: number, signal: UnixSignal) => void;
  /** Returns false only when the owned group is proven absent; throws when unknown. */
  readonly groupExists?: (pid: number) => boolean;
  readonly leaderIdentity?: (pid: number) => string;
  readonly groupMembers?: (pid: number) => readonly LinuxGroupMember[];
  readonly gracefulTimeoutMs?: number;
  readonly forcedTimeoutMs?: number;
}

/** Terminates only a process group created and retained by this runtime. */
export class UnixProcessTree implements ProcessTreeTerminator {
  private readonly killGroup: (pid: number, signal: UnixSignal) => void;
  private readonly groupExists: (pid: number) => boolean;
  private readonly leaderIdentity: (pid: number) => string;
  private readonly gracefulTimeoutMs: number;
  private readonly forcedTimeoutMs: number;
  private readonly identities = new WeakMap<ChildProcess, string>();
  private readonly witnesses = new WeakMap<ChildProcess, readonly LinuxGroupMember[]>();
  private readonly samplers = new WeakMap<ChildProcess, ReturnType<typeof setInterval>>();
  private readonly groupMembers: ((pid: number) => readonly LinuxGroupMember[]) | undefined;

  public constructor(options: UnixProcessTreeOptions = {}) {
    this.killGroup = options.killGroup ?? killProcessGroup;
    this.groupExists = options.groupExists ?? processGroupExists;
    this.leaderIdentity = options.leaderIdentity ?? readProcessGroupLeaderIdentity;
    this.groupMembers = options.groupMembers ?? (options.leaderIdentity === undefined ? readLinuxGroupMembers : undefined);
    this.gracefulTimeoutMs = options.gracefulTimeoutMs ?? 2_000;
    this.forcedTimeoutMs = options.forcedTimeoutMs ?? 2_000;
  }

  public async stop(child: ChildProcess, pid: number): Promise<void> {
    try { await this.stopOwnedGroup(child, pid); }
    finally { this.clearSampler(child); }
  }

  private async stopOwnedGroup(child: ChildProcess, pid: number): Promise<void> {
    if (!Number.isSafeInteger(pid) || pid <= 1 || child.pid !== pid) {
      throw new Error('Refusing to terminate an unverified owned process group');
    }
    if (!this.groupExists(pid)) return;
    let identity = this.identities.get(child);
    if (identity === undefined) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Process group ownership identity is unavailable');
      this.captureOwnership(child, pid);
      identity = this.identities.get(child)!;
    }
    this.observeOwnership(child, pid);
    if (this.groupMembers !== undefined && await this.verifyNoExecution(child, pid, identity)) return;
    if (!this.assertOwnership(child, pid, identity)) return;
    this.signalGroup(pid, 'SIGTERM');
    if (await this.waitForGroupExit(child, pid, identity, this.gracefulTimeoutMs)) return;

    if (!this.groupExists(pid)) return;
    if (!this.assertOwnership(child, pid, identity)) return;
    this.signalGroup(pid, 'SIGKILL');
    if (await this.waitForGroupExit(child, pid, identity, this.forcedTimeoutMs)) return;
    throw new Error('Process group exit could not be verified');
  }

  public captureOwnership(child: ChildProcess, pid: number): void {
    if (!Number.isSafeInteger(pid) || pid <= 1 || child.pid !== pid) throw new Error('Refusing to capture an unverified owned process group');
    this.identities.set(child, this.leaderIdentity(pid));
    this.observeOwnership(child, pid);
    if (this.groupMembers !== undefined) {
      this.clearSampler(child);
      const timer = setInterval(() => this.observeOwnership(child, pid), 100);
      this.samplers.set(child, timer);
      timer.unref();
      child.once('exit', () => this.clearSampler(child));
      child.once('error', () => this.clearSampler(child));
    }
  }

  private clearSampler(child: ChildProcess): void {
    clearInterval(this.samplers.get(child));
    this.samplers.delete(child);
  }

  public observeOwnership(child: ChildProcess, pid: number): void {
    const identity = this.identities.get(child);
    if (identity === undefined || this.groupMembers === undefined || child.exitCode !== null || child.signalCode !== null) return;
    try {
      this.assertLeaderIdentity(pid, identity);
      const members = this.groupMembers(pid);
      this.assertLeaderIdentity(pid, identity);
      if (members.length <= 256) this.witnesses.set(child, members);
    } catch { /* Keep earlier witnesses; incomplete discovery grants no ownership. */ }
  }

  private assertOwnership(child: ChildProcess, pid: number, identity: string): boolean {
    try { this.assertLeaderIdentity(pid, identity); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (this.groupMembers !== undefined) {
      const current = this.groupMembers(pid);
      const witnesses = this.witnesses.get(child) ?? [];
      if (current.some((member) => witnesses.some((witness) => sameLinuxGroupMember(member, witness)))) return true;
    }
    // The last member may disappear during the metadata observation.
    // Confirm group absence again; an empty snapshot alone is insufficient.
    if (!this.groupExists(pid)) return false;
    throw new Error('Exited process group ownership cannot be verified');
  }

  private async verifyNoExecution(child: ChildProcess, pid: number, identity: string): Promise<boolean> {
    if (!this.groupExists(pid)) return true;
    if (!this.assertOwnership(child, pid, identity)) return true;
    if (this.groupMembers === undefined || this.groupMembers(pid).some(memberMayExecute)) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    if (!this.groupExists(pid)) return true;
    if (!this.assertOwnership(child, pid, identity)) return true;
    const members = this.groupMembers(pid);
    return members.length > 0 && !members.some(memberMayExecute);
  }

  private signalGroup(pid: number, signal: UnixSignal): void {
    try {
      this.killGroup(pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }

  private assertLeaderIdentity(pid: number, identity: string): void {
    if (this.leaderIdentity(pid) !== identity) throw new Error('Process group leader identity no longer matches the owned launch');
  }

  private async waitForGroupExit(child: ChildProcess, pid: number, identity: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    do {
      if (await this.verifyNoExecution(child, pid, identity)) return true;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    return this.verifyNoExecution(child, pid, identity);
  }
}

export function createProcessTreeTerminator(): ProcessTreeTerminator {
  return new UnixProcessTree();
}

function killProcessGroup(pid: number, signal: UnixSignal): void {
  process.kill(-pid, signal);
}

function processGroupExists(pid: number): boolean {
  if (process.platform !== 'linux') throw new Error('Process group termination proof is unavailable on this platform');
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

function readProcessGroupLeaderIdentity(pid: number): string {
  if (process.platform !== 'linux') throw new Error('Process group identity proof is unavailable on this platform');
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  if (Number(fields[2]) !== pid || fields[19] === undefined) throw new Error('Process group leader identity is unavailable');
  return fields[19];
}
