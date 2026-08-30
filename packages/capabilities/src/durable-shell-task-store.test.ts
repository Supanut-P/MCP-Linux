import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DurableShellTaskStore } from './durable-shell-task-store.js';
import { ShellCapabilityBackend } from './shell-backend.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  const roots = temporaryRoots.splice(0);
  await Promise.all(roots.map((root) => cleanupTestProcesses(path.join(root, '.tasks'))));
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe.runIf(process.platform === 'linux')('durable shell background tasks', () => {
  it('rejects traversal task IDs before constructing a task path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-durable-shell-'));
    temporaryRoots.push(root);
    const backend = new ShellCapabilityBackend({ allowedRoots: [root], taskStateDirectory: path.join(root, '.tasks') });
    await expect(backend.execute({ operation: 'status', task_id: '../outside' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
  });

  it('rejects persisted unsafe process IDs instead of signaling them', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-durable-shell-'));
    temporaryRoots.push(root);
    const taskStateDirectory = path.join(root, '.tasks');
    const taskDirectory = path.join(taskStateDirectory, 'unsafe-pid');
    await mkdir(taskDirectory, { recursive: true });
    await writeFile(path.join(taskDirectory, 'task.json'), JSON.stringify({
      version: 1,
      task_id: 'unsafe-pid',
      state: 'running',
      started_at: new Date().toISOString(),
      include_stdout: true,
      include_stderr: true,
      max_output_bytes: 1024,
      deadline_at: new Date(Date.now() + 10_000).toISOString(),
      worker_pid: 0,
    }), 'utf8');
    const backend = new ShellCapabilityBackend({ allowedRoots: [root], taskStateDirectory });
    await expect(backend.execute({ operation: 'cancel', task_id: 'unsafe-pid' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'PROCESS_NOT_FOUND' },
    });
  });

  it('does not claim cancellation when an unverified live PID is present', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-durable-shell-'));
    temporaryRoots.push(root);
    const taskStateDirectory = path.join(root, '.tasks');
    const backend = new ShellCapabilityBackend({ allowedRoots: [root], taskStateDirectory });
    const started = await backend.execute({
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', 'setTimeout(() => {}, 60000)'],
      cwd: root,
      execution: 'background',
      timeout_seconds: 30,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const taskId = String((started.value as Record<string, unknown>).task_id);
    await waitUntil(async () => {
      const status = await backend.execute({ operation: 'status', task_id: taskId });
      const value = status.ok ? status.value as Record<string, unknown> : {};
      return typeof value.child_pid === 'number';
    }, 1500);
    const metadataPath = path.join(taskStateDirectory, taskId, 'task.json');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>;
    metadata.worker_pid = process.pid;
    metadata.worker_start_identity = '0';
    await writeFile(metadataPath, JSON.stringify(metadata), 'utf8');
    const cancelled = await backend.execute({ operation: 'cancel', task_id: taskId });
    expect(cancelled).toMatchObject({ ok: true, value: { state: 'termination_unverified', durable: true } });
  }, 15_000);

  it('survives a backend/runtime replacement and returns logs and result by task id', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-durable-shell-'));
    temporaryRoots.push(root);
    const taskStateDirectory = path.join(root, '.tasks');
    const firstRuntime = new ShellCapabilityBackend({ allowedRoots: [root], taskStateDirectory });

    const started = await firstRuntime.execute({
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', "setTimeout(() => process.stdout.write('durable-done'), 300)"],
      cwd: root,
      execution: 'background',
      timeout_seconds: 30,
    });

    expect(started).toMatchObject({ ok: true, value: { task_id: expect.any(String), durable: true } });
    if (!started.ok) return;
    const taskId = String((started.value as Record<string, unknown>).task_id);

    const replacementRuntime = new ShellCapabilityBackend({ allowedRoots: [root], taskStateDirectory });
    const waited = await replacementRuntime.execute({ operation: 'wait', task_id: taskId, timeout_seconds: 5 });
    expect(waited).toMatchObject({
      ok: true,
      value: { task_id: taskId, state: 'completed', exit_code: 0, stdout: 'durable-done', durable: true },
    });
    await expect(replacementRuntime.execute({ operation: 'list' })).resolves.toMatchObject({
      ok: true,
      value: { tasks: expect.arrayContaining([expect.objectContaining({ task_id: taskId, state: 'completed', durable: true })]) },
    });
  });

  it('does not overwrite a very fast durable completion back to running', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-durable-shell-'));
    temporaryRoots.push(root);
    const backend = new ShellCapabilityBackend({
      allowedRoots: [root],
      taskStateDirectory: path.join(root, '.tasks'),
      autoWaitSeconds: 1,
    });

    const result = await backend.execute({
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', "process.stdout.write('fast')"],
      cwd: root,
      execution: 'auto',
      timeout_seconds: 30,
    });

    expect(result).toMatchObject({ ok: true, value: { state: 'completed', exit_code: 0, stdout: 'fast', durable: true } });
  });

  it('persists completion for the native /usr/bin/true fast path', async () => {
    await runFastNativeCommand('/usr/bin/true', [], '');
  });

  it('persists output for the native /usr/bin/printf fast path', async () => {
    await runFastNativeCommand('/usr/bin/printf', ['native-fast\\n'], 'native-fast\n');
  });

  it('cleans both detached groups when a post-spawn launcher write fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-durable-shell-'));
    temporaryRoots.push(root);
    const taskStateDirectory = path.join(root, '.tasks');
    const taskDirectory = path.join(taskStateDirectory, 'post-spawn-failure');
    // launch() has already spawned the worker when it publishes worker.pid.
    // Making that path a directory injects a deterministic post-spawn failure.
    await mkdir(path.join(taskDirectory, 'worker.pid'), { recursive: true });
    const store = new DurableShellTaskStore(taskStateDirectory);
    const taskId = 'post-spawn-failure';
    const result = await store.launch({
      taskId,
      executable: process.execPath,
      arguments: ['-e', 'setInterval(() => {}, 10000)'],
      cwd: root,
      timeoutSeconds: 30,
      maxOutputBytes: 1024,
      includeStdout: true,
      includeStderr: true,
      owner: { clientId: 'test-client', sessionId: 'test-session', workspaceId: root },
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    const entries = await readdir(taskStateDirectory, { withFileTypes: true });
    const taskEntry = entries.find((entry) => entry.isDirectory() && entry.name === taskId);
    expect(taskEntry).toBeDefined();
    if (taskEntry === undefined) return;
    const metadata = JSON.parse(await readFile(path.join(taskStateDirectory, taskEntry.name, 'task.json'), 'utf8')) as Record<string, unknown>;
    expect(typeof metadata.worker_pid).toBe('number');
    expect(typeof metadata.child_pid).toBe('number');
    await expectProcessGone(Number(metadata.worker_pid));
    await expectProcessGroupGone(Number(metadata.worker_pid));
    await expectProcessGone(Number(metadata.child_pid));
    await expectProcessGroupGone(Number(metadata.child_pid));
  }, 15_000);

  it('cancels a durable task from a replacement backend', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-durable-shell-'));
    temporaryRoots.push(root);
    const taskStateDirectory = path.join(root, '.tasks');
    const firstRuntime = new ShellCapabilityBackend({ allowedRoots: [root], taskStateDirectory });
    const started = await firstRuntime.execute({
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', 'setTimeout(() => {}, 60000)'],
      cwd: root,
      execution: 'background',
      timeout_seconds: 30,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const taskId = String((started.value as Record<string, unknown>).task_id);

    const replacementRuntime = new ShellCapabilityBackend({ allowedRoots: [root], taskStateDirectory });
    await waitUntil(async () => {
      const status = await replacementRuntime.execute({ operation: 'status', task_id: taskId });
      const value = status.ok ? status.value as Record<string, unknown> : {};
      return typeof value.worker_pid === 'number' && typeof value.child_pid === 'number';
    }, 1500);
    const beforeCancel = await replacementRuntime.execute({ operation: 'status', task_id: taskId });
    const cancelled = await replacementRuntime.execute({ operation: 'cancel', task_id: taskId });

    expect(cancelled).toMatchObject({ ok: true, value: { task_id: taskId, state: 'cancelled', durable: true } });
    if (beforeCancel.ok && cancelled.ok) {
      const beforeCancelValue = beforeCancel.value as Record<string, unknown>;
      await expectProcessGone(Number(beforeCancelValue.worker_pid));
      await expectProcessGroupGone(Number(beforeCancelValue.worker_pid));
      await expectProcessGone(Number(beforeCancelValue.child_pid));
      await expectProcessGroupGone(Number(beforeCancelValue.child_pid));
    }
  });

  it('times out a durable task and cleans up its worker and process group', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-durable-shell-'));
    temporaryRoots.push(root);
    const taskStateDirectory = path.join(root, '.tasks');
    const backend = new ShellCapabilityBackend({ allowedRoots: [root], taskStateDirectory });
    const started = await backend.execute({
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      cwd: root,
      execution: 'background',
      timeout_seconds: 0.2,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const taskId = String((started.value as Record<string, unknown>).task_id);

    const timedOut = await backend.execute({ operation: 'wait', task_id: taskId, timeout_seconds: 5 });
    expect(timedOut).toMatchObject({ ok: true, value: { task_id: taskId, state: 'timed_out', durable: true } });
    if (timedOut.ok) {
      const value = timedOut.value as Record<string, unknown>;
      await expectProcessGone(Number(value.worker_pid));
      await expectProcessGroupGone(Number(value.worker_pid));
      await expectProcessGone(Number(value.child_pid));
      await expectProcessGroupGone(Number(value.child_pid));
    }
  });

  it('cleans a detached descendant after the direct child leader exits', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-durable-shell-'));
    temporaryRoots.push(root);
    const backend = new ShellCapabilityBackend({
      allowedRoots: [root],
      taskStateDirectory: path.join(root, '.tasks'),
      maxSynchronousWaitSeconds: 15,
    });
    const grandchildCode = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
    const parentCode = `const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', ${JSON.stringify(grandchildCode)}]); setTimeout(() => process.exit(0), 50);`;
    const started = await backend.execute({
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', parentCode],
      cwd: root,
      execution: 'background',
      timeout_seconds: 20,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const taskId = String((started.value as Record<string, unknown>).task_id);
    const finished = await backend.execute({ operation: 'wait', task_id: taskId, timeout_seconds: 10 });
    expect(finished).toMatchObject({ ok: true, value: { state: 'completed', durable: true } });
    if (finished.ok) {
      const value = finished.value as Record<string, unknown>;
      await expectProcessGroupGone(Number(value.child_pid));
    }
  }, 15_000);

  it('keeps a durable auto task running when the original MCP caller aborts after submission', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-durable-shell-'));
    temporaryRoots.push(root);
    const taskStateDirectory = path.join(root, '.tasks');
    const backend = new ShellCapabilityBackend({
      allowedRoots: [root],
      taskStateDirectory,
      autoWaitSeconds: 0.3,
      maxSynchronousWaitSeconds: 0.3,
    });
    const controller = new AbortController();
    const running = backend.execute({
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', "setTimeout(() => process.stdout.write('after-abort'), 600)"],
      cwd: root,
      execution: 'auto',
      timeout_seconds: 30,
    }, controller.signal);
    setTimeout(() => controller.abort(), 100);

    const submitted = await running;
    expect(submitted).toMatchObject({ ok: true, value: { state: 'running', task_id: expect.any(String), durable: true } });
    if (!submitted.ok) return;
    const taskId = String((submitted.value as Record<string, unknown>).task_id);

    const replacementRuntime = new ShellCapabilityBackend({ allowedRoots: [root], taskStateDirectory });
    const finished = await replacementRuntime.execute({ operation: 'wait', task_id: taskId, timeout_seconds: 5 });
    expect(finished).toMatchObject({ ok: true, value: { state: 'completed', exit_code: 0, stdout: 'after-abort', durable: true } });
  });
});

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Condition was not met before timeout');
}

async function runFastNativeCommand(executable: string, args: readonly string[], expectedStdout: string): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-durable-shell-'));
  temporaryRoots.push(root);
  const taskStateDirectory = path.join(root, '.tasks');
  const backend = new ShellCapabilityBackend({ allowedRoots: [root], taskStateDirectory, autoWaitSeconds: 1 });
  const result = await backend.execute({
    operation: 'run',
    executable,
    arguments: args,
    cwd: root,
    execution: 'auto',
    timeout_seconds: 30,
  });

  expect(result).toMatchObject({ ok: true, value: { state: 'completed', exit_code: 0, stdout: expectedStdout, durable: true } });
  if (!result.ok) return;
  const value = result.value as Record<string, unknown>;
  const taskId = String(value.task_id);
  const metadata = JSON.parse(await readFile(path.join(taskStateDirectory, taskId, 'task.json'), 'utf8')) as Record<string, unknown>;
  expect(metadata.state).toBe('completed');
  expect(typeof metadata.worker_pid).toBe('number');
  expect(typeof metadata.child_pid).toBe('number');
  await expectProcessGone(Number(metadata.worker_pid));
  await expectProcessGroupGone(Number(metadata.worker_pid));
  await expectProcessGone(Number(metadata.child_pid));
  await expectProcessGroupGone(Number(metadata.child_pid));
}

async function expectProcessGone(pid: number): Promise<void> {
  expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Process ${pid} was still running after durable task completion`);
}

async function expectProcessGroupGone(pid: number): Promise<void> {
  expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!isProcessGroupRunning(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Process group ${pid} was still running after durable task completion`);
}

function isProcessRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function isProcessGroupRunning(pid: number): boolean {
  try { process.kill(-pid, 0); return true; } catch { return false; }
}

async function cleanupTestProcesses(taskStateDirectory: string): Promise<void> {
  const entries = await readdir(taskStateDirectory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let metadata: Record<string, unknown>;
    try { metadata = JSON.parse(await readFile(path.join(taskStateDirectory, entry.name, 'task.json'), 'utf8')) as Record<string, unknown>; } catch { continue; }
    for (const field of ['worker_pid', 'child_pid']) {
      const pid = metadata[field];
      if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 1) continue;
      const identity = metadata[field === 'worker_pid' ? 'worker_start_identity' : 'child_start_identity'];
      if (typeof identity === 'string' && processStartIdentity(pid) !== identity) continue;
      try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    }
  }
}

function processStartIdentity(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    return close < 0 ? undefined : stat.slice(close + 1).trim().split(/\s+/)[19];
  } catch { return undefined; }
}
