import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { ProcessManager, UnixProcessTree } from './index.js';
import { readLinuxGroupMember, sameLinuxGroupMember, type LinuxGroupMember } from './linux-process-group.js';

describe.runIf(process.platform === 'linux')('Linux owned process-group cancellation', () => {
  it('kills a SIGTERM-ignoring descendant after its direct parent exits', async () => {
    const tree = new UnixProcessTree();
    const manager = new ProcessManager({
      captureOwnership: (child, pid): void => tree.captureOwnership(child, pid),
      observeOwnership: (child, pid): void => tree.observeOwnership(child, pid),
      stop: async (child, pid): Promise<void> => {
        try { await tree.stop(child, pid); }
        catch (error) { console.error('Owned group verification:', error instanceof Error ? error.message : 'unknown'); throw error; }
      },
    });
    const started = await manager.start({
      executable: process.execPath,
      args: ['-e', "const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'}); console.log(c.pid); setTimeout(()=>process.exit(0),100)"],
      cwd: process.cwd(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const leader = started.value.processId;
    let childPid: number | undefined;
    let childIdentity: LinuxGroupMember | undefined;
    try {
      await waitUntil(async () => {
        const logs = manager.logs(leader, {});
        childPid = logs.ok ? Number(logs.value.entries.map((entry) => entry.text).join('').trim()) : undefined;
        if (Number.isSafeInteger(childPid) && childPid! > 1 && childIdentity === undefined) childIdentity = readLinuxGroupMember(childPid!);
        const status = manager.status(leader);
        return Number.isSafeInteger(childPid) && childPid! > 1 && status.ok && status.value.state === 'exited';
      });
      await expect(manager.stop(leader)).resolves.toMatchObject({ ok: true });
      expect(manager.status(leader)).toMatchObject({ ok: true, value: { state: 'stopped' } });
      expect(childPid).toBeDefined();
      await waitUntil(async () => !await isExecuting(childPid!));
    } finally {
      // Cleanup is limited to the observed child PID spawned by the owned parent.
      if (childPid !== undefined && childIdentity !== undefined && await isExecuting(childPid)) {
        try {
          if (sameLinuxGroupMember(childIdentity, readLinuxGroupMember(childPid))) process.kill(childPid, 'SIGKILL');
        } catch { /* absent or identity unavailable; do not signal a reused PID */ }
      }
    }
  }, 10_000);
});

async function waitUntil(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for process-group cancellation evidence');
}

async function isExecuting(pid: number): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
