import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { UnixProcessTree } from './unix-process-tree.js';

describe('UnixProcessTree', () => {
  it('terminates the owned process group and verifies its exit', async () => {
    const killGroup = vi.fn();
    const waitForExit = vi.fn().mockResolvedValue(true);
    const tree = new UnixProcessTree({ killGroup, waitForExit });

    await tree.stop(fakeChild(), 4_242);

    expect(killGroup).toHaveBeenCalledWith(4_242, 'SIGTERM');
    expect(killGroup).not.toHaveBeenCalledWith(4_242, 'SIGKILL');
  });

  it('escalates to SIGKILL only when SIGTERM exit cannot be verified', async () => {
    const killGroup = vi.fn();
    const waitForExit = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const tree = new UnixProcessTree({ killGroup, waitForExit });

    await tree.stop(fakeChild(), 4_242);

    expect(killGroup.mock.calls).toEqual([[4_242, 'SIGTERM'], [4_242, 'SIGKILL']]);
  });

  it('rejects invalid group leaders without sending a signal', async () => {
    const killGroup = vi.fn();
    const tree = new UnixProcessTree({ killGroup, waitForExit: async (): Promise<boolean> => true });
    await expect(tree.stop(fakeChild(), 1)).rejects.toThrow('owned process group');
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
