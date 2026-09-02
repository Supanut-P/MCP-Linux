import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import { capabilityTaskOwnerMatches, legacyCapabilityTaskOwner, type CapabilityTaskOwner } from './task-ownership.js';

export type DurableShellTaskState = 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled' | 'termination_unverified';

export interface DurableShellLaunchRequest {
  readonly taskId: string;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly timeoutSeconds: number;
  readonly maxOutputBytes: number;
  readonly includeStdout: boolean;
  readonly includeStderr: boolean;
  readonly owner: CapabilityTaskOwner;
}

interface DurableTaskMetadata {
  readonly version: 1;
  readonly task_id: string;
  state: DurableShellTaskState;
  readonly started_at: string;
  finished_at?: string;
  exit_code?: number;
  error?: string;
  readonly include_stdout: boolean;
  readonly include_stderr: boolean;
  readonly max_output_bytes: number;
  readonly deadline_at: string;
  worker_pid?: number;
  child_pid?: number;
  worker_start_identity?: string;
  child_start_identity?: string;
  child_group_members?: string[];
  resume_token_hash?: string;
  stdout_truncated?: boolean;
  stderr_truncated?: boolean;
  readonly owner_client_id?: string;
  owner_session_id?: string;
  readonly owner_workspace_id?: string;
}

interface DurableWorkerSpec {
  readonly version: 1;
  readonly taskId: string;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly includeStdout: boolean;
  readonly includeStderr: boolean;
  readonly startedAt: string;
  readonly deadlineAt: string;
  readonly metadataPath: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
}

const METADATA_FILENAME = 'task.json';
const STDOUT_FILENAME = 'stdout.log';
const STDERR_FILENAME = 'stderr.log';
const SPEC_FILENAME = 'spec.json';
const WORKER_PID_FILENAME = 'worker.pid';
const METADATA_READ_RETRIES = 4;
const PROCESS_EXIT_RECONCILE_DELAY_MS = 75;
const PROCESS_HANDLE_RELEASE_GRACE_MS = 150;
const SAFE_TASK_ID = /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_PROCESS_IDENTITY = /^(?:[0-9]{1,64}|pid:[0-9]{1,64})$/;
const SAFE_GROUP_MEMBER = /^[2-9][0-9]{0,19}:[0-9]{1,64}$/;

interface OwnedProcessTarget {
  readonly pid: number;
  readonly startIdentity: string;
  readonly groupMembers?: readonly string[];
}

interface ProcessObservation {
  readonly configured: boolean;
  readonly leaderRunning: boolean;
  readonly groupRunning: boolean;
  readonly identityMismatch: boolean;
}

export class DurableShellTaskStore {
  public constructor(private readonly rootDirectory: string) {}

  public async launch(request: DurableShellLaunchRequest): Promise<Result<Record<string, unknown>>> {
    if (!isSafeTaskId(request.taskId)) return err(appError('INVALID_INPUT', 'Task ID is invalid'));
    const taskDirectory = this.taskDirectory(request.taskId);
    await mkdir(taskDirectory, { recursive: true });
    await mkdir(this.rootDirectory, { recursive: true });
    const startedAt = new Date().toISOString();
    const deadlineAt = new Date(Date.now() + request.timeoutSeconds * 1000).toISOString();
    const metadataPath = path.join(taskDirectory, METADATA_FILENAME);
    const stdoutPath = path.join(taskDirectory, STDOUT_FILENAME);
    const stderrPath = path.join(taskDirectory, STDERR_FILENAME);
    const specPath = path.join(taskDirectory, SPEC_FILENAME);
    const resumeToken = createResumeToken();
    const metadata: DurableTaskMetadata = {
      version: 1,
      task_id: request.taskId,
      state: 'running',
      started_at: startedAt,
      include_stdout: request.includeStdout,
      include_stderr: request.includeStderr,
      max_output_bytes: request.maxOutputBytes,
      deadline_at: deadlineAt,
      owner_client_id: request.owner.clientId,
      owner_session_id: request.owner.sessionId,
      ...(request.owner.workspaceId === undefined ? {} : { owner_workspace_id: request.owner.workspaceId }),
      resume_token_hash: hashResumeToken(resumeToken),
    };
    const spec: DurableWorkerSpec = {
      version: 1,
      taskId: request.taskId,
      executable: request.executable,
      arguments: [...request.arguments],
      cwd: request.cwd,
      timeoutMs: request.timeoutSeconds * 1000,
      maxOutputBytes: request.maxOutputBytes,
      includeStdout: request.includeStdout,
      includeStderr: request.includeStderr,
      startedAt,
      deadlineAt,
      metadataPath,
      stdoutPath,
      stderrPath,
    };
    let workerTarget: OwnedProcessTarget | undefined;
    let spawnedWorker: ReturnType<typeof spawn> | undefined;
    try {
      await writeFile(metadataPath, JSON.stringify(metadata), 'utf8');
      await writeFile(specPath, JSON.stringify(spec), 'utf8');
      const workerPath = await this.ensureWorkerScript();
      spawnedWorker = spawn(process.execPath, [workerPath, specPath], {
        cwd: request.cwd,
        detached: true,
        stdio: 'ignore',
        shell: false,
        env: { ...process.env },
      });
      workerTarget = await waitForSpawn(spawnedWorker);
      metadata.worker_pid = workerTarget.pid;
      metadata.worker_start_identity = workerTarget.startIdentity;
      // Publish the worker identity on its own file before returning the task handle.
      // The worker owns task.json; keeping launcher identity separate avoids a race
      // where a very fast completion can be overwritten back to running.
      await writeFile(path.join(taskDirectory, WORKER_PID_FILENAME), String(workerTarget.pid), 'utf8');
      spawnedWorker.unref();
      return ok({ ...(await this.snapshotFromMetadata(metadata)), resume_token: resumeToken });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Durable task could not start';
      const stopped = workerTarget !== undefined
        ? await this.stopLaunchedTask(request.taskId, workerTarget)
        : spawnedWorker === undefined
          ? true
          : await stopSpawnedWorker(spawnedWorker);
      // A worker may have published child_pid after the launcher hit its
      // post-spawn failure. Preserve that metadata when recording the final
      // state so the child target remains auditable and cleanup can be retried.
      const observed = await this.readMetadata(request.taskId);
      const finalMetadata: DurableTaskMetadata = observed.ok ? { ...observed.value } : metadata;
      finalMetadata.state = stopped ? 'failed' : 'termination_unverified';
      finalMetadata.exit_code = -1;
      finalMetadata.error = stopped
        ? `Durable task could not start: ${message}`
        : `Durable task could not start and worker termination could not be verified: ${message}`;
      if (stopped) finalMetadata.finished_at = new Date().toISOString();
      else delete finalMetadata.finished_at;
      await writeFile(metadataPath, JSON.stringify(finalMetadata), 'utf8').catch(() => undefined);
      return err(appError('INTERNAL_ERROR', 'Durable task could not start', true));
    }
  }

  public async list(owner?: CapabilityTaskOwner): Promise<Record<string, unknown>[]> {
    await mkdir(this.rootDirectory, { recursive: true });
    const entries = await readdir(this.rootDirectory, { withFileTypes: true }).catch(() => []);
    const snapshots: Record<string, unknown>[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const snapshot = await this.snapshot(entry.name, undefined, owner);
      if (snapshot.ok) snapshots.push(snapshot.value);
    }
    return snapshots.sort((left, right) => String(right.started_at ?? '').localeCompare(String(left.started_at ?? '')));
  }

  public async snapshot(taskId: string, tailLines?: number, owner?: CapabilityTaskOwner): Promise<Result<Record<string, unknown>>> {
    const metadata = await this.readMetadata(taskId);
    if (!metadata.ok) return metadata;
    if (owner !== undefined && !capabilityTaskOwnerMatches(metadataOwner(metadata.value), owner)) {
      return err(appError('PERMISSION_DENIED', 'Task is not owned by this client session and workspace'));
    }
    const reconciled = await this.reconcile(metadata.value);
    return ok(await this.snapshotFromMetadata(reconciled, tailLines));
  }

  public async wait(taskId: string, seconds: number, tailLines?: number, owner?: CapabilityTaskOwner): Promise<Result<Record<string, unknown>>> {
    const deadline = Date.now() + Math.max(0, seconds) * 1000;
    let snapshot = await this.snapshot(taskId, tailLines, owner);
    // `termination_unverified` is still an active durable task state: a
    // worker may be finishing group cleanup or waiting for a replacement
    // runtime to re-verify ownership. Keep polling until the caller's
    // bounded wait window instead of returning a transient state immediately.
    while (snapshot.ok
      && (snapshot.value.state === 'running' || snapshot.value.state === 'termination_unverified')
      && Date.now() < deadline) {
      await delay(Math.min(100, Math.max(10, deadline - Date.now())));
      snapshot = await this.snapshot(taskId, tailLines, owner);
    }
    return snapshot;
  }

  public async cancel(taskId: string, owner?: CapabilityTaskOwner): Promise<Result<Record<string, unknown>>> {
    const metadataResult = await this.readMetadata(taskId);
    if (!metadataResult.ok) return metadataResult;
    if (owner !== undefined && !capabilityTaskOwnerMatches(metadataOwner(metadataResult.value), owner)) {
      return err(appError('PERMISSION_DENIED', 'Task is not owned by this client session and workspace'));
    }
    const metadata = await this.reconcile(metadataResult.value);
    if (isTerminal(metadata.state)) return ok(await this.snapshotFromMetadata(metadata));
    const observations = [
      observeProcess(metadata.worker_pid, metadata.worker_start_identity),
      observeProcess(metadata.child_pid, metadata.child_start_identity, metadata.child_group_members),
    ];
    const liveWithMismatch = observations.some((observation) =>
      observation.identityMismatch && (observation.leaderRunning || observation.groupRunning));
    const targets = [
      processTarget(metadata.worker_pid, metadata.worker_start_identity),
      processTarget(metadata.child_pid, metadata.child_start_identity, metadata.child_group_members),
    ].filter((target): target is OwnedProcessTarget => target !== undefined);
    const liveTargets = targets.filter((target) => isProcessTreeRunning(target.pid));
    if (liveTargets.length === 0) {
      metadata.state = 'termination_unverified';
      metadata.error = liveWithMismatch
        ? 'Durable task process identity changed; termination was not attempted'
        : 'Durable task process PID is unavailable; process termination could not be verified';
      delete metadata.finished_at;
      await this.writeMetadata(metadata);
      return ok(await this.snapshotFromMetadata(metadata));
    }
    const [primaryTarget, ...relatedTargets] = liveTargets;
    if (primaryTarget === undefined) return ok(await this.snapshotFromMetadata(metadata));
    const stopped = await stopProcessTree(primaryTarget, relatedTargets);
    if (!stopped) {
      metadata.state = 'termination_unverified';
      metadata.error = 'Durable task process termination could not be verified';
      delete metadata.finished_at;
      await this.writeMetadata(metadata);
      return ok(await this.snapshotFromMetadata(metadata));
    }
    if (liveWithMismatch) {
      metadata.state = 'termination_unverified';
      metadata.error = 'Durable task has a live process with an unverified identity; termination was partial';
      delete metadata.finished_at;
      await this.writeMetadata(metadata);
      return ok(await this.snapshotFromMetadata(metadata));
    }
    metadata.state = 'cancelled';
    metadata.exit_code = -1;
    delete metadata.error;
    metadata.finished_at = new Date().toISOString();
    await this.writeMetadata(metadata);
    return ok(await this.snapshotFromMetadata(metadata));
  }

  public async resume(taskId: string, resumeToken: string, owner: CapabilityTaskOwner): Promise<Result<Record<string, unknown>>> {
    if (!isSafeTaskId(taskId) || !isValidDurableResumeToken(resumeToken)) {
      return err(appError('INVALID_INPUT', 'Task ID or resume token is invalid'));
    }
    const metadataResult = await this.readMetadata(taskId);
    if (!metadataResult.ok) return metadataResult;
    const metadata = metadataResult.value;
    const storedOwner = metadataOwner(metadata);
    // Rebinding is intentionally limited to the authenticated client and
    // exact workspace. Only the transport session may change on resume.
    if (storedOwner.clientId !== owner.clientId || storedOwner.workspaceId !== owner.workspaceId) {
      return err(appError('PERMISSION_DENIED', 'Resume credentials do not match the task owner'));
    }
    if (!matchesResumeToken(metadata.resume_token_hash, resumeToken)) {
      return err(appError('PERMISSION_DENIED', 'Resume token is invalid or has already been rotated'));
    }
    const nextToken = createResumeToken();
    metadata.resume_token_hash = hashResumeToken(nextToken);
    metadata.owner_session_id = owner.sessionId;
    await this.writeMetadata(metadata);
    return ok({ ...(await this.snapshotFromMetadata(metadata)), resume_token: nextToken });
  }

  public async has(taskId: string): Promise<boolean> {
    return (await this.readMetadata(taskId)).ok;
  }

  private async reconcile(metadata: DurableTaskMetadata): Promise<DurableTaskMetadata> {
    if (metadata.state !== 'running' && metadata.state !== 'termination_unverified') return metadata;
    const initial = this.observeMetadataProcesses(metadata);
    if (initial.some((observation) => observation.identityMismatch && (observation.leaderRunning || observation.groupRunning))) {
      return this.markTerminationUnverified(metadata, 'Durable task process identity changed; process termination could not be verified');
    }
    if (initial.some((observation) => observation.leaderRunning)) return metadata;
    if (initial.some((observation) => observation.groupRunning)) {
      return this.markTerminationUnverified(metadata, 'Durable task worker exited while an owned process group is still running');
    }
    await delay(PROCESS_EXIT_RECONCILE_DELAY_MS);
    const refreshed = await this.readMetadata(metadata.task_id);
    if (refreshed.ok && isTerminal(refreshed.value.state)) return refreshed.value;
    const current = refreshed.ok ? refreshed.value : metadata;
    const final = this.observeMetadataProcesses(current);
    if (final.some((observation) => observation.identityMismatch && (observation.leaderRunning || observation.groupRunning))) {
      return this.markTerminationUnverified(current, 'Durable task process identity changed; process termination could not be verified');
    }
    if (final.some((observation) => observation.leaderRunning)) return current;
    if (final.some((observation) => observation.groupRunning)) {
      return this.markTerminationUnverified(current, 'Durable task worker exited while an owned process group is still running');
    }
    if (current.state === 'termination_unverified') return current;
    current.state = 'failed';
    current.exit_code = current.exit_code ?? -1;
    current.error = current.error ?? 'Durable task worker exited before recording a final state';
    current.finished_at = current.finished_at ?? new Date().toISOString();
    await this.writeMetadata(current);
    return current;
  }

  private observeMetadataProcesses(metadata: DurableTaskMetadata): ProcessObservation[] {
    return [
      observeProcess(metadata.worker_pid, metadata.worker_start_identity),
      observeProcess(metadata.child_pid, metadata.child_start_identity, metadata.child_group_members),
    ];
  }

  private async markTerminationUnverified(metadata: DurableTaskMetadata, reason: string): Promise<DurableTaskMetadata> {
    metadata.state = 'termination_unverified';
    metadata.error = metadata.error ?? reason;
    delete metadata.finished_at;
    await this.writeMetadata(metadata);
    return metadata;
  }

  private async snapshotFromMetadata(metadata: DurableTaskMetadata, tailLines?: number): Promise<Record<string, unknown>> {
    const taskDirectory = this.taskDirectory(metadata.task_id);
    const stdout = metadata.include_stdout ? await readBoundedText(path.join(taskDirectory, STDOUT_FILENAME), metadata.max_output_bytes, tailLines) : undefined;
    const stderr = metadata.include_stderr ? await readBoundedText(path.join(taskDirectory, STDERR_FILENAME), metadata.max_output_bytes, tailLines) : undefined;
    return {
      task_id: metadata.task_id,
      state: metadata.state,
      ...(metadata.exit_code === undefined ? {} : { exit_code: metadata.exit_code }),
      ...(stdout === undefined ? {} : { stdout }),
      ...(stderr === undefined ? {} : { stderr }),
      ...(metadata.error === undefined ? {} : { error: metadata.error }),
      started_at: metadata.started_at,
      ...(metadata.finished_at === undefined ? {} : { finished_at: metadata.finished_at }),
      deadline_at: metadata.deadline_at,
      ...(metadata.owner_workspace_id === undefined ? {} : { workspace_hash: hashWorkspaceId(metadata.owner_workspace_id) }),
      durable: true,
      ...(metadata.worker_pid === undefined ? {} : { worker_pid: metadata.worker_pid }),
      ...(metadata.child_pid === undefined ? {} : { child_pid: metadata.child_pid }),
      truncated: metadata.stdout_truncated === true || metadata.stderr_truncated === true,
    };
  }

  private async readMetadata(taskId: string): Promise<Result<DurableTaskMetadata>> {
    if (!isSafeTaskId(taskId)) return err(appError('INVALID_INPUT', 'Task ID is invalid'));
    const metadataPath = path.join(this.taskDirectory(taskId), METADATA_FILENAME);
    for (let attempt = 0; attempt < METADATA_READ_RETRIES; attempt += 1) {
      try {
        const parsed: unknown = JSON.parse(await readFile(metadataPath, 'utf8'));
        if (isMetadata(parsed) && parsed.task_id === taskId) {
          if (parsed.worker_pid === undefined) {
            const publishedPid = await readPublishedPid(path.join(this.taskDirectory(taskId), WORKER_PID_FILENAME));
            if (publishedPid !== undefined) parsed.worker_pid = publishedPid;
          }
          return ok(parsed);
        }
      } catch {
        if (attempt === METADATA_READ_RETRIES - 1) break;
      }
      await delay(15);
    }
    return err(appError('PROCESS_NOT_FOUND', 'Task was not found'));
  }

  private async writeMetadata(metadata: DurableTaskMetadata): Promise<void> {
    await writeFile(path.join(this.taskDirectory(metadata.task_id), METADATA_FILENAME), JSON.stringify(metadata), 'utf8');
  }

  private async stopLaunchedTask(taskId: string, workerTarget: OwnedProcessTarget): Promise<boolean> {
    const targets = new Map<number, OwnedProcessTarget>([[workerTarget.pid, workerTarget]]);
    // Give the worker a bounded window to publish its detached child identity.
    // The worker also has a SIGTERM handler as a second cleanup path, but
    // explicit child targeting lets the launcher verify both process groups.
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      const observed = await this.readMetadata(taskId);
      if (observed.ok) {
        const child = processTarget(observed.value.child_pid, observed.value.child_start_identity, observed.value.child_group_members);
        if (child !== undefined) targets.set(child.pid, child);
      }
      if (targets.size > 1 || !isProcessTreeRunning(workerTarget.pid)) break;
      await delay(25);
    }
    let stopped = true;
    const childTargets = [...targets.values()].filter((target) => target.pid !== workerTarget.pid);
    // Stop each group independently.  The worker and child intentionally use
    // separate detached groups; coupling their ownership checks means a child
    // that exits between observation and signalling can make the worker call
    // fail closed before the worker is signalled.
    stopped = (await stopProcessTree(workerTarget)) && stopped;
    for (const target of childTargets) {
      // Re-check independently to catch a child published concurrently or one
      // that survived the first escalation without invalidating worker cleanup.
      if (isProcessTreeRunning(target.pid)) stopped = (await stopProcessTree(target)) && stopped;
    }
    // The worker can publish child metadata concurrently with the first stop.
    // Re-read once and clean any newly verified child group before returning.
    const observed = await this.readMetadata(taskId);
    if (observed.ok) {
      const child = processTarget(observed.value.child_pid, observed.value.child_start_identity, observed.value.child_group_members);
      if (child !== undefined && isProcessTreeRunning(child.pid)) {
        stopped = (await stopProcessTree(child)) && stopped;
      }
    }
    return stopped;
  }

  private taskDirectory(taskId: string): string {
    return path.join(this.rootDirectory, taskId);
  }

  private async ensureWorkerScript(): Promise<string> {
    const workerHash = createHash('sha256').update(DURABLE_WORKER_SOURCE).digest('hex').slice(0, 16);
    const workerPath = path.join(this.rootDirectory, `durable-shell-worker-${workerHash}.mjs`);
    try {
      await writeFile(workerPath, DURABLE_WORKER_SOURCE, { encoding: 'utf8', flag: 'wx' });
    } catch (error: unknown) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    }
    return workerPath;
  }
}

function hashWorkspaceId(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32);
}

async function readPublishedPid(filename: string): Promise<number | undefined> {
  try {
    const value = Number.parseInt((await readFile(filename, 'utf8')).trim(), 10);
    return isSafePid(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isMetadata(value: unknown): value is DurableTaskMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const validIdentity = (identity: unknown): boolean => identity === undefined
    || (typeof identity === 'string' && SAFE_PROCESS_IDENTITY.test(identity));
  return record.version === 1
    && isSafeTaskId(record.task_id)
    && typeof record.state === 'string'
    && typeof record.started_at === 'string'
    && typeof record.include_stdout === 'boolean'
    && typeof record.include_stderr === 'boolean'
    && typeof record.max_output_bytes === 'number'
    && typeof record.deadline_at === 'string'
    && (record.worker_pid === undefined || isSafePid(record.worker_pid))
    && (record.child_pid === undefined || isSafePid(record.child_pid))
    && validIdentity(record.worker_start_identity)
    && validIdentity(record.child_start_identity)
    && (record.resume_token_hash === undefined
      || (typeof record.resume_token_hash === 'string' && /^[a-f0-9]{64}$/.test(record.resume_token_hash)))
    && (record.child_group_members === undefined
      || (Array.isArray(record.child_group_members) && record.child_group_members.every((member) => typeof member === 'string' && SAFE_GROUP_MEMBER.test(member))));
}

export function isValidDurableResumeToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function createResumeToken(): string {
  return randomBytes(32).toString('base64url');
}

function hashResumeToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function matchesResumeToken(expectedHash: string | undefined, token: string): boolean {
  if (expectedHash === undefined) return false;
  const expected = Buffer.from(expectedHash, 'hex');
  const actual = Buffer.from(hashResumeToken(token), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function isSafeTaskId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_TASK_ID.test(value);
}

function isSafePid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 1;
}

function isSafeProcessIdentity(value: unknown): value is string {
  return typeof value === 'string' && SAFE_PROCESS_IDENTITY.test(value);
}

function readProcessStartIdentity(pid: number): string | undefined {
  if (!isSafePid(pid)) return undefined;
  if (process.platform !== 'linux') return `pid:${pid}`;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return undefined;
    const fields = stat.slice(close + 1).trim().split(/\s+/);
    const start = fields[19];
    return isSafeProcessIdentity(start) ? start : undefined;
  } catch {
    return undefined;
  }
}

function observeProcess(pid: number | undefined, expectedIdentity: string | undefined, groupMembers?: readonly string[]): ProcessObservation {
  if (pid === undefined) return { configured: false, leaderRunning: false, groupRunning: false, identityMismatch: false };
  if (!isSafePid(pid) || !isSafeProcessIdentity(expectedIdentity)) {
    return { configured: true, leaderRunning: false, groupRunning: false, identityMismatch: true };
  }
  const identity = readProcessStartIdentity(pid);
  const identityMismatch = identity === undefined || identity !== expectedIdentity;
  const groupRunning = isProcessGroupRunning(pid);
  return {
    configured: true,
    // A live leader with a mismatched identity is still a live, unowned
    // process. Report it so callers preserve termination_unverified rather
    // than claiming that every target was cleaned up.
    leaderRunning: isProcessRunning(pid),
    // Group membership is observable even after the group leader exits. Keep
    // this independent from leader identity; identityMismatch makes callers
    // fail closed and prevents signaling a reused group.
    groupRunning: groupRunning || (groupMembers !== undefined && hasGroupProof(pid, groupMembers)),
    identityMismatch,
  };
}

function processTarget(pid: number | undefined, startIdentity: string | undefined, groupMembers?: readonly string[]): OwnedProcessTarget | undefined {
  if (!isSafePid(pid) || !isSafeProcessIdentity(startIdentity)) return undefined;
  if (readProcessStartIdentity(pid) === startIdentity) return { pid, startIdentity, ...(groupMembers === undefined ? {} : { groupMembers }) };
  if (groupMembers !== undefined && hasGroupProof(pid, groupMembers)) return { pid, startIdentity, groupMembers };
  return undefined;
}

function hasGroupProof(pgid: number, proof: readonly string[]): boolean {
  const members = new Set(readProcessGroupMembers(pgid));
  return proof.some((entry) => members.has(entry));
}

function readProcessGroupMembers(pgid: number): string[] {
  if (!isSafePid(pgid) || process.platform !== 'linux') return [];
  const members: string[] = [];
  try {
    for (const entry of readdirSync('/proc', { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[0-9]+$/.test(entry.name)) continue;
      const pid = Number(entry.name);
      if (!isSafePid(pid)) continue;
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        const close = stat.lastIndexOf(')');
        if (close < 0) continue;
        const fields = stat.slice(close + 1).trim().split(/\s+/);
        if (fields[2] !== String(pgid) || !isSafeProcessIdentity(fields[19])) continue;
        members.push(`${pid}:${fields[19]}`);
      } catch { /* process exited during the scan */ }
    }
  } catch { /* /proc may be unavailable or restricted */ }
  return members;
}

function metadataOwner(metadata: DurableTaskMetadata): CapabilityTaskOwner {
  if (metadata.owner_client_id === undefined || metadata.owner_session_id === undefined) return legacyCapabilityTaskOwner();
  return {
    clientId: metadata.owner_client_id,
    sessionId: metadata.owner_session_id,
    ...(metadata.owner_workspace_id === undefined ? {} : { workspaceId: metadata.owner_workspace_id }),
  };
}

function isTerminal(state: DurableShellTaskState): boolean {
  return state === 'completed' || state === 'failed' || state === 'timed_out' || state === 'cancelled';
}

async function readBoundedText(filename: string, maxBytes: number, tailLines?: number): Promise<string> {
  let value = '';
  try {
    const buffer = await readFile(filename);
    value = buffer.subarray(0, maxBytes).toString('utf8');
  } catch {
    return '';
  }
  value = redactText(value);
  if (tailLines === undefined || tailLines < 1) return tailLines === 0 ? '' : value;
  const lines = value.split(/\r?\n/);
  return lines.slice(-tailLines).join('\n');
}

function redactText(value: string): string {
  return value
    .replace(/(\bauthorization\s*:\s*bearer\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/\b(token|secret|password|api[_-]?key|private[_-]?key)\s*[:=]\s*[^\s]+/gi, '$1=[redacted]');
}

function waitForSpawn(child: ReturnType<typeof spawn>): Promise<OwnedProcessTarget> {
  return new Promise((resolve, reject) => {
    const onSpawn = (): void => {
      if (!isSafePid(child.pid)) { cleanup(); reject(new Error('Durable task worker did not return a safe process ID')); return; }
      const startIdentity = readProcessStartIdentity(child.pid);
      if (startIdentity === undefined) { cleanup(); reject(new Error('Durable task worker identity could not be verified')); return; }
      cleanup();
      resolve({ pid: child.pid, startIdentity });
    };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    const cleanup = (): void => {
      child.removeListener('spawn', onSpawn);
      child.removeListener('error', onError);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

async function stopSpawnedWorker(child: ReturnType<typeof spawn>): Promise<boolean> {
  try { child.kill('SIGKILL'); } catch { return false; }
  const pid = child.pid;
  if (!isSafePid(pid)) return child.exitCode !== null;
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) return true;
    await delay(50);
  }
  return !isProcessRunning(pid);
}

async function stopProcessTree(target: OwnedProcessTarget, relatedTargets: readonly OwnedProcessTarget[] = []): Promise<boolean> {
  const trackedTargets = [target, ...relatedTargets];
  if (!trackedTargets.every(targetStillOwned)) return false;
  const trackedPids = [...new Set(trackedTargets.map((entry) => entry.pid))];
  if (!trackedPids.some(isProcessTreeRunning)) {
    await delay(PROCESS_HANDLE_RELEASE_GRACE_MS);
    return true;
  }
  for (const trackedTarget of trackedTargets) {
    if (isProcessTreeRunning(trackedTarget.pid)) {
      signalProcessGroup(trackedTarget, 'SIGTERM');
    }
  }
  if (await waitForProcessesExit(trackedPids, 2500)) return true;
  // The worker and its child intentionally have separate detached process
  // groups. Escalate each owned group so cancelling the worker cannot leave
  // the child behind.
  for (const trackedTarget of trackedTargets) {
    if (isProcessTreeRunning(trackedTarget.pid)) {
      signalProcessGroup(trackedTarget, 'SIGKILL');
    }
  }
  return waitForProcessesExit(trackedPids, 2500);
}

function signalProcessGroup(target: OwnedProcessTarget, signal: NodeJS.Signals): void {
  const leaderVerified = readProcessStartIdentity(target.pid) === target.startIdentity;
  const groupVerified = target.groupMembers !== undefined && hasGroupProof(target.pid, target.groupMembers);
  if (!leaderVerified && !groupVerified) return;
  try {
    process.kill(-target.pid, signal);
  } catch {
    // Re-check immediately before the direct-PID fallback to avoid a PID
    // reuse race if the process-group signal failed after leader exit.
    if (leaderVerified && readProcessStartIdentity(target.pid) === target.startIdentity) {
      try { process.kill(target.pid, signal); } catch { /* already gone */ }
    }
  }
}

function targetStillOwned(target: OwnedProcessTarget): boolean {
  if (readProcessStartIdentity(target.pid) === target.startIdentity) return true;
  return target.groupMembers !== undefined && hasGroupProof(target.pid, target.groupMembers);
}

async function waitForProcessesExit(pids: readonly number[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pids.some(isProcessTreeRunning)) {
      await delay(PROCESS_HANDLE_RELEASE_GRACE_MS);
      return !pids.some(isProcessTreeRunning);
    }
    await delay(50);
  }
  return !pids.some(isProcessTreeRunning);
}

function isProcessRunning(pid: number): boolean {
  if (!isSafePid(pid)) return false;
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      if (close >= 0 && stat.slice(close + 1).trim().split(/\s+/)[0] === 'Z') return false;
    } catch { /* fall through to kill(0) for a race or restricted /proc */ }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

function isProcessGroupRunning(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error: unknown) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

function isProcessTreeRunning(pid: number): boolean {
  return isProcessRunning(pid) || isProcessGroupRunning(pid);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const DURABLE_WORKER_SOURCE = String.raw`import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { readFile, writeFile, open, unlink } from 'node:fs/promises';

const specPath = process.argv[2];
if (!specPath) process.exit(64);
const spec = JSON.parse(await readFile(specPath, 'utf8'));
await unlink(specPath).catch(() => undefined);
let metadata = JSON.parse(await readFile(spec.metadataPath, 'utf8'));
let persistQueue = Promise.resolve();
metadata.worker_pid = process.pid;
metadata.worker_start_identity = processStartIdentity(process.pid);
await persist();
let stdoutBytes = 0;
let stderrBytes = 0;
const stdoutHandle = await open(spec.stdoutPath, 'a');
const stderrHandle = await open(spec.stderrPath, 'a');
let settled = false;
let timer;
let child;
let stopTarget;
const pendingWrites = new Set();

function appendBounded(handle, chunk, stream) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
  const used = stream === 'stdout' ? stdoutBytes : stderrBytes;
  const remaining = Math.max(0, spec.maxOutputBytes - used);
  if (remaining <= 0) {
    metadata[stream + '_truncated'] = true;
    return;
  }
  const slice = buffer.subarray(0, remaining);
  if (stream === 'stdout') stdoutBytes += slice.byteLength;
  else stderrBytes += slice.byteLength;
  if (buffer.byteLength > remaining) metadata[stream + '_truncated'] = true;
  const pending = handle.write(slice);
  pendingWrites.add(pending);
  void pending.then(() => pendingWrites.delete(pending), () => pendingWrites.delete(pending));
}

async function persist() {
  // Snapshot before enqueueing and serialize every write. The launcher can
  // yield while a fast child is already emitting close; a direct write of
  // the shared metadata object can otherwise let the initial running
  // snapshot land after the terminal state.
  const snapshot = JSON.stringify(metadata);
  persistQueue = persistQueue.catch(() => undefined).then(() => writeFile(spec.metadataPath, snapshot, 'utf8'));
  await persistQueue;
}

function processRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
      const close = stat.lastIndexOf(')');
      if (close >= 0 && stat.slice(close + 1).trim().split(/\s+/)[0] === 'Z') return false;
    } catch { /* fall through to kill(0) for a race or restricted /proc */ }
  }
  try { process.kill(pid, 0); return true; }
  catch (error) { return error && error.code === 'EPERM'; }
}

function processGroupRunning(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) { return error && error.code === 'EPERM'; }
}

function processTreeRunning(pid) {
  return processRunning(pid) || processGroupRunning(pid);
}

function processStartIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
  if (process.platform !== 'linux') return 'pid:' + pid;
  try {
    const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return undefined;
    const fields = stat.slice(close + 1).trim().split(/\s+/);
    return /^[0-9]{1,64}$/.test(fields[19] || '') ? fields[19] : undefined;
  } catch { return undefined; }
}

function processGroupMembers(pgid) {
  if (!Number.isSafeInteger(pgid) || pgid <= 1 || process.platform !== 'linux') return [];
  const members = [];
  try {
    for (const entry of readdirSync('/proc', { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[0-9]+$/.test(entry.name)) continue;
      const pid = Number(entry.name);
      if (!Number.isSafeInteger(pid) || pid <= 1) continue;
      try {
        const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
        const close = stat.lastIndexOf(')');
        if (close < 0) continue;
        const fields = stat.slice(close + 1).trim().split(/\s+/);
        const startIdentity = fields[19];
        if (fields[2] === String(pgid) && /^[0-9]{1,64}$/.test(startIdentity || '')) members.push(pid + ':' + startIdentity);
      } catch { /* process exited during scan */ }
    }
  } catch { /* /proc may be unavailable or restricted */ }
  return members;
}

async function stopTree(pid, expectedIdentity, groupMembers) {
  const leaderVerified = !!expectedIdentity && processStartIdentity(pid) === expectedIdentity;
  const groupVerified = Array.isArray(groupMembers) && hasGroupProof(pid, groupMembers);
  if (!leaderVerified && !groupVerified) return false;
  if (!processTreeRunning(pid)) return true;
  signalProcessGroup(pid, 'SIGTERM', expectedIdentity, groupMembers);
  if (await waitForProcessExit(pid, 2500)) return true;
  signalProcessGroup(pid, 'SIGKILL', expectedIdentity, groupMembers);
  return waitForProcessExit(pid, 2500);
}

function signalProcessGroup(pid, signal, expectedIdentity, groupMembers) {
  const leaderVerified = !!expectedIdentity && processStartIdentity(pid) === expectedIdentity;
  const groupVerified = Array.isArray(groupMembers) && hasGroupProof(pid, groupMembers);
  if (!leaderVerified && !groupVerified) return;
  try { process.kill(-pid, signal); } catch {
    if (leaderVerified && processStartIdentity(pid) === expectedIdentity) {
      try { process.kill(pid, signal); } catch { /* already gone */ }
    }
  }
}

function hasGroupProof(pgid, proof) {
  if (!Array.isArray(proof) || proof.length === 0) return false;
  const members = new Set(processGroupMembers(pgid));
  return proof.some((entry) => members.has(entry));
}

let shuttingDown = false;
async function shutdownForSignal(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopTarget = 'cancelled';
  await finish('cancelled', -1, 'Durable task worker was asked to stop');
  process.exitCode = exitCode;
}
process.once('SIGTERM', () => { void shutdownForSignal(143); });
process.once('SIGINT', () => { void shutdownForSignal(130); });

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processTreeRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !processTreeRunning(pid);
}

async function finish(state, exitCode, error) {
  if (settled) return;
  settled = true;
  if (timer) clearTimeout(timer);
  if (child?.pid && processGroupRunning(child.pid) && state !== 'termination_unverified') {
    stopTarget = state;
    if (!await stopTree(child.pid, metadata.child_start_identity, metadata.child_group_members)) {
      state = 'termination_unverified';
      error = 'Local task process group could not be terminated';
    }
  }
  metadata.state = state;
  metadata.exit_code = exitCode;
  if (error) metadata.error = error;
  else delete metadata.error;
  if (state === 'termination_unverified') delete metadata.finished_at;
  else metadata.finished_at = new Date().toISOString();
  await Promise.allSettled([...pendingWrites]);
  await Promise.allSettled([stdoutHandle.close(), stderrHandle.close()]);
  await persist().catch(() => undefined);
}

try {
  child = spawn(spec.executable, [...spec.arguments], {
    cwd: spec.cwd,
    env: { ...process.env },
    shell: false,
    detached: true,
  });
  child.stdout?.on('data', (chunk) => { appendBounded(stdoutHandle, chunk, 'stdout'); });
  child.stderr?.on('data', (chunk) => { appendBounded(stderrHandle, chunk, 'stderr'); });
  child.once('error', (error) => { void finish('failed', -1, 'Local task failed to start: ' + error.message); });
  child.once('exit', () => {
    if (child?.pid) {
      metadata.child_group_members = processGroupMembers(child.pid);
      void persist();
    }
  });
  child.once('close', (code) => { if (!stopTarget) void finish(code === 0 ? 'completed' : 'failed', code ?? -1); });
  // Attach all child listeners before the first await after spawn. Native
  // one-shot commands can exit before metadata persistence yields.
  metadata.child_pid = child.pid;
  metadata.child_start_identity = processStartIdentity(child.pid);
  metadata.child_group_members = processGroupMembers(child.pid);
  await persist();
  if (!settled) {
    timer = setTimeout(() => {
      void (async () => {
        if (settled || !child?.pid) return;
        stopTarget = 'timed_out';
        const stopped = await stopTree(child.pid, metadata.child_start_identity, metadata.child_group_members);
        await finish(stopped ? 'timed_out' : 'termination_unverified', -1, stopped ? 'Local task timed out' : 'Local task timed out, but process termination could not be verified');
      })();
    }, spec.timeoutMs);
  }
} catch (error) {
  await finish('failed', -1, 'Local task failed to start: ' + (error instanceof Error ? error.message : String(error)));
}
`;
