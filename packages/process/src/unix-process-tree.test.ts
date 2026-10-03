import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { UnixProcessTree } from './unix-process-tree.js';

describe('UnixProcessTree', () => {
  it.runIf(process.platform !== 'linux')('does not interpret a foreign-platform negative PID probe as Linux group absence', async () => {
    await expect(new UnixProcessTree().stop(fakeChild(), 4242)).rejects.toThrow('unavailable on this platform');
  });
  it('accepts proven absence without a launch identity after a very short-lived child exited', async () => {
    const child = fakeChild();
    child.exitCode = 0;
    const killGroup = vi.fn();
    const tree = new UnixProcessTree({ groupExists: (): boolean => false, killGroup });
    await tree.stop(child, 4242);
    expect(killGroup).not.toHaveBeenCalled();
  });

  it('never escalates to KILL when the retained survivor identity changes after TERM', async () => {
    const child = fakeChild();
    let vanished = false;
    let startTime = '10';
    const killGroup = vi.fn((): void => { startTime = '99'; });
    const tree = new UnixProcessTree({ gracefulTimeoutMs: 0, groupExists: (): boolean => true, killGroup,
      groupMembers: (): { pid: number; groupId: number; sessionId: number; startTime: string; state: string }[] => [{ pid: 4243, groupId: 4242, sessionId: 4242, startTime, state: 'S' }],
      leaderIdentity: (): string => { if (vanished) throw Object.assign(new Error('gone'), { code: 'ENOENT' }); return 'launch-a'; },
    });
    tree.captureOwnership(child, 4242);
    vanished = true;
    child.exitCode = 0;
    child.emit('exit', 0);
    await expect(tree.stop(child, 4242)).rejects.toThrow('ownership cannot be verified');
    expect(killGroup.mock.calls).toEqual([[4242, 'SIGTERM']]);
  });
  it('uses a retained survivor after leader exit and verifies zombie nonexecution after KILL', async () => {
    const child = fakeChild();
    let vanished = false;
    let state = 'S';
    const member = (): { pid: number; groupId: number; sessionId: number; startTime: string; state: string } => ({ pid: 4243, groupId: 4242, sessionId: 4242, startTime: '10', state });
    const killGroup = vi.fn((_pid: number, signal: string): void => { if (signal === 'SIGKILL') state = 'Z'; });
    const tree = new UnixProcessTree({ gracefulTimeoutMs: 0, forcedTimeoutMs: 100, groupExists: (): boolean => true, groupMembers: (): ReturnType<typeof member>[] => [member()], killGroup, leaderIdentity: (): string => {
      if (vanished) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      return 'launch-a';
    } });
    tree.captureOwnership(child, 4242);
    vanished = true;
    child.exitCode = 0;
    child.emit('exit', 0);
    await tree.stop(child, 4242);
    expect(killGroup.mock.calls).toEqual([[4242, 'SIGTERM'], [4242, 'SIGKILL']]);
  });

  it('rejects reused survivor identity and incomplete membership without a signal', async () => {
    for (const failure of ['reused', 'unreadable']) {
      const child = fakeChild();
      let vanished = false;
      const killGroup = vi.fn();
      const tree = new UnixProcessTree({ groupExists: (): boolean => true, killGroup, groupMembers: (): { pid: number; groupId: number; sessionId: number; startTime: string; state: string }[] => {
        if (vanished && failure === 'unreadable') throw new Error('observation exceeded its bound');
        return [{ pid: 4243, groupId: 4242, sessionId: 4242, startTime: vanished ? '99' : '10', state: 'S' }];
      }, leaderIdentity: (): string => { if (vanished) throw Object.assign(new Error('gone'), { code: 'ENOENT' }); return 'launch-a'; } });
      tree.captureOwnership(child, 4242);
      vanished = true;
      child.exitCode = 0;
      child.emit('exit', 0);
      await expect(tree.stop(child, 4242)).rejects.toThrow();
      expect(killGroup).not.toHaveBeenCalled();
    }
  });
  it('never signals an exited group when the retained leader identity is no longer readable', async () => {
    const child = fakeChild();
    let vanished = false;
    const killGroup = vi.fn();
    const tree = new UnixProcessTree({ groupExists: (): boolean => true, killGroup, leaderIdentity: (): string => {
      if (vanished) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      return 'launch-a';
    } });
    tree.captureOwnership(child, 4242);
    child.exitCode = 0;
    vanished = true;
    await expect(tree.stop(child, 4242)).rejects.toThrow('ownership cannot be verified');
    expect(killGroup).not.toHaveBeenCalled();
  });
  it('terminates the owned process group and verifies its exit', async () => {
    const killGroup = vi.fn();
    const groupExists = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const tree = new UnixProcessTree({ killGroup, groupExists, leaderIdentity: (): string => 'launch-a' });
    const child = fakeChild();
    tree.captureOwnership(child, 4_242);

    await tree.stop(child, 4_242);

    expect(killGroup).toHaveBeenCalledWith(4_242, 'SIGTERM');
    expect(killGroup).not.toHaveBeenCalledWith(4_242, 'SIGKILL');
  });

  it('escalates to SIGKILL only when SIGTERM exit cannot be verified', async () => {
    let exists = true;
    const killGroup = vi.fn((_pid: number, signal: string): void => { if (signal === 'SIGKILL') exists = false; });
    const groupExists = (): boolean => exists;
    const tree = new UnixProcessTree({ killGroup, groupExists, leaderIdentity: (): string => 'launch-a', gracefulTimeoutMs: 0, forcedTimeoutMs: 0 });
    const child = fakeChild();
    tree.captureOwnership(child, 4_242);

    await tree.stop(child, 4_242);

    expect(killGroup.mock.calls).toEqual([[4_242, 'SIGTERM'], [4_242, 'SIGKILL']]);
  });

  it('rejects invalid group leaders without sending a signal', async () => {
    const killGroup = vi.fn();
    const tree = new UnixProcessTree({ killGroup, groupExists: (): boolean => false });
    await expect(tree.stop(fakeChild(), 1)).rejects.toThrow('owned process group');
    expect(killGroup).not.toHaveBeenCalled();
  });

  it('does not trust an exited parent while its group remains, and rejects denied probes', async () => {
    const child = fakeChild();
    child.exitCode = 0;
    const killGroup = vi.fn();
    const denied = Object.assign(new Error('denied'), { code: 'EPERM' });
    const tree = new UnixProcessTree({ killGroup, groupExists: (): boolean => { throw denied; }, leaderIdentity: (): string => 'launch-a' });
    tree.captureOwnership(child, 4_242);
    await expect(tree.stop(child, 4_242)).rejects.toBe(denied);
    expect(killGroup).not.toHaveBeenCalled();
  });

  it('does not signal a reused PGID whose leader identity changed', async () => {
    const child = fakeChild();
    child.exitCode = 0;
    const killGroup = vi.fn();
    let identity = 'launch-a';
    const tree = new UnixProcessTree({ groupExists: (): boolean => true, leaderIdentity: (): string => identity, killGroup });
    tree.captureOwnership(child, 4_242);
    identity = 'reused-pid';
    await expect(tree.stop(child, 4_242)).rejects.toThrow('identity no longer matches');
    expect(killGroup).not.toHaveBeenCalled();
  });

  it('rejects a mismatched child pid', async () => {
    const killGroup = vi.fn();
    const tree = new UnixProcessTree({ killGroup });
    await expect(tree.stop(fakeChild(), 4_243)).rejects.toThrow('owned process group');
    expect(killGroup).not.toHaveBeenCalled();
  });
});

function fakeChild(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    pid: 4_242,
    exitCode: null,
    signalCode: null,
    kill: (): boolean => true,
  }) as unknown as ChildProcess;
}
