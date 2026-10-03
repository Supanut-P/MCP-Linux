import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, readlink, realpath, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import { WorkspacePathGuard, type Workspace } from '@baitonghub-linux-mcp/workspace';
import { createSafeProcessEnvironment } from '@baitonghub-linux-mcp/process';

const execFileAsync = promisify(execFile);
const MAX_FILES = 1024;
const MAX_ENTRIES = 8192;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_SERIALIZED_BYTES = 512 * 1024;
const MAX_GIT_OUTPUT = 1024 * 1024;

export interface WorkflowScopeEntry { readonly path: string; readonly inode: string | null }
export interface WorkflowSourceFile { readonly path: string; readonly sha256: string; readonly bytes: number; readonly kind?: 'file' | 'symlink' }
export interface WorkflowSourceSnapshot {
  readonly fingerprint: string;
  readonly files: readonly WorkflowSourceFile[];
  readonly gitIdentity: string | null;
}
export interface WorkflowScopeCapture {
  readonly scopes: readonly WorkflowScopeEntry[];
  readonly workspaceFingerprint: string;
  readonly snapshot: WorkflowSourceSnapshot;
  readonly canonicalAllowedFiles: readonly string[];
}

/** Capture literal path reservations and a bounded, content-addressed source baseline. */
export async function captureWorkflowScope(
  workspace: Workspace,
  allowedFiles: readonly string[],
  mode: 'workspace' | 'disjoint',
  signal?: AbortSignal,
): Promise<Result<WorkflowScopeCapture>> {
  try {
    cancelled(signal);
    if (mode !== 'workspace' && mode !== 'disjoint') return failure();
    const root = await realpath(workspace.realRootPath);
    const rootStat = await stat(root);
    if (!rootStat.isDirectory() || path.resolve(root) !== path.resolve(workspace.realRootPath)) return failure();
    const guard = new WorkspacePathGuard();
    const scopes: WorkflowScopeEntry[] = [];
    const identitySeen = new Set<string>();
    for (const raw of mode === 'workspace' ? ['.'] : allowedFiles) {
      cancelled(signal);
      if (!validPath(raw) || raw.split(/[\\/]/).includes('.git')) return failure();
      const checked = await guard.resolveForWrite(workspace, raw);
      cancelled(signal);
      if (!checked.ok) return failure();
      const absolute = path.resolve(root, raw);
      const canonical = await canonicalWithMissingSuffix(absolute);
      const relative = path.relative(root, canonical);
      if (relative.startsWith('..') || path.isAbsolute(relative)) return failure();
      const key = foldPath(path.resolve(canonical));
      if (identitySeen.has(key)) return failure();
      identitySeen.add(key);
      let inode: string | null = null;
      try {
        const s = await stat(absolute);
        if (s.isFile()) {
          if (s.nlink > 1) return failure();
          inode = `${s.dev}:${s.ino}`;
        }
      } catch { /* Missing paths are reserved by their canonical literal identity. */ }
      scopes.push({ path: normalizeAbsolute(canonical), inode });
    }
    scopes.sort((a, b) => compare(a.path, b.path));
    if (mode === 'disjoint' && scopes.some((scope, index) => scopes.some((other, otherIndex) => index !== otherIndex && other.path.startsWith(`${scope.path.replace(/\/$/, '')}/`)))) return failure();
    const workspaceFingerprint = hash(JSON.stringify({ root: normalizeAbsolute(root), dev: String(rootStat.dev), ino: String(rootStat.ino) }));
    const canonicalAllowedFiles: string[] = [];
    for (const raw of allowedFiles) {
      const checked = await guard.resolveForWrite(workspace, raw);
      if (!checked.ok) return failure();
      const canonical = await canonicalWithMissingSuffix(path.resolve(root, raw));
      const rel = posix(path.relative(root, canonical)) || '.';
      if (!validPath(rel) || rel.startsWith('..')) return failure();
      canonicalAllowedFiles.push(rel);
    }
    const git = await gitInventory(root, signal);
    const snapshot = await captureSnapshot(root, allowedFiles, git, guard, workspace, signal);
    if (!snapshot.ok) return snapshot;
    const finalGit = await gitInventory(root, signal);
    const finalSnapshot = await captureSnapshot(root, allowedFiles, finalGit, guard, workspace, signal);
    if (!finalSnapshot.ok || snapshot.value.fingerprint !== finalSnapshot.value.fingerprint) return failure();
    const finalAllowed = await Promise.all(allowedFiles.map(async (raw) => posix(path.relative(root, await canonicalWithMissingSuffix(path.resolve(root, raw)))) || '.'));
    if (JSON.stringify(finalAllowed) !== JSON.stringify(canonicalAllowedFiles)) return failure();
    const finalRoot = await stat(root);
    if (rootStat.dev !== finalRoot.dev || rootStat.ino !== finalRoot.ino || await realpath(workspace.realRootPath) !== root) return failure();
    const finalScopes = await Promise.all((mode === 'workspace' ? ['.'] : allowedFiles).map(async (raw) => normalizeAbsolute(await canonicalWithMissingSuffix(path.resolve(root, raw)))));
    if (JSON.stringify(finalScopes.sort(compare)) !== JSON.stringify(scopes.map((scope) => scope.path))) return failure();
    cancelled(signal);
    return ok({ scopes, workspaceFingerprint, snapshot: finalSnapshot.value, canonicalAllowedFiles });
  } catch {
    return signal?.aborted ? cancelledResult() : failure();
  }
}

/** Compare a later source snapshot with the captured dirty baseline. */
export function compareWorkflowSnapshots(
  baseline: WorkflowSourceSnapshot,
  current: WorkflowSourceSnapshot,
  allowedFiles: readonly string[],
): Result<{ readonly sourceFingerprint: string; readonly diffFingerprint: string; readonly changedFiles: readonly string[] }> {
  try {
    if (allowedFiles.some((item) => !validPath(item) || item.split(/[\\/]/).includes('.git'))) return failure();
    if (baseline.gitIdentity !== current.gitIdentity) return failure();
    const oldFiles = snapshotMap(baseline.files);
    const newFiles = snapshotMap(current.files);
    if (oldFiles === null || newFiles === null) return failure();
    const all = [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort(compare);
    const changed: string[] = [];
    for (const key of all) {
      const before = oldFiles.get(key); const after = newFiles.get(key);
      if (before?.sha256 === after?.sha256 && before?.bytes === after?.bytes && before?.path === after?.path && before?.kind === after?.kind) continue;
      const endpoints = [...new Set([before?.path, after?.path].filter((item): item is string => item !== undefined))];
      if (endpoints.some((p) => !allowedFiles.some((allowed) => pathMatches(p, allowed)))) return failure();
      changed.push(...endpoints);
    }
    changed.sort(compare);
    const changes = changed.map((p) => {
      const k = foldPath(p); return [p, oldFiles.get(k)?.sha256 ?? null, newFiles.get(k)?.sha256 ?? null];
    });
    return ok({ sourceFingerprint: current.fingerprint, diffFingerprint: hash(JSON.stringify(changes)), changedFiles: changed });
  } catch { return failure(); }
}

async function captureSnapshot(root: string, allowed: readonly string[], git: GitInventory, guard: WorkspacePathGuard, workspace: Workspace, signal?: AbortSignal): Promise<Result<WorkflowSourceSnapshot>> {
  const names = new Map<string, string>();
  const walkState = { entries: 0 };
  if (git.isGit) for (const name of git.paths) putPath(names, name);
  else await walk(root, root, names, walkState, signal);
  for (const entry of allowed) {
    const absolute = path.resolve(root, entry);
    const checked = await guard.resolveForWrite(workspace, entry);
    cancelled(signal);
    if (!checked.ok) return failure();
    const canonical = await canonicalWithMissingSuffix(absolute);
    const rel = path.relative(root, canonical);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      try {
        const s = await lstat(absolute);
        if (s.isDirectory()) { if (!git.isGit) await walk(root, absolute, names, walkState, signal); }
        else putPath(names, posix(rel));
      } catch { putPath(names, posix(rel)); }
    }
  }
  if (names.size > MAX_FILES) return failure();
  const files: WorkflowSourceFile[] = [];
  let total = 0;
  for (const relative of [...names.values()].sort(compare)) {
    cancelled(signal);
    const abs = path.resolve(root, relative);
    const checked = await guard.resolveForRead(workspace, relative);
    if (!checked.ok) {
      // Tracked deletions and absent explicitly scoped leaves are represented by omission.
      try { await lstat(abs); return failure(); } catch { continue; }
    }
    const s = await lstat(abs);
    let data: Buffer;
    if (s.isSymbolicLink()) {
      data = Buffer.from(await readlink(abs), 'utf8');
      if (!sameStat(s, await lstat(abs))) return failure();
    }
    else if (s.isFile()) {
      if (s.nlink > 1) return failure();
      if (s.size > MAX_FILE_BYTES) return failure();
      const flags = process.platform === 'win32' ? 'r' : constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
      const handle = await open(abs, flags);
      try {
        if (!sameStat(s, await handle.stat())) return failure();
        const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
        let offset = 0;
        while (offset < buffer.length) {
          cancelled(signal);
          const chunk = await handle.read(buffer, offset, Math.min(64 * 1024, buffer.length - offset), null);
          if (chunk.bytesRead === 0) break;
          offset += chunk.bytesRead;
        }
        if (offset > MAX_FILE_BYTES || !sameStat(s, await handle.stat())) return failure();
        data = buffer.subarray(0, offset);
      } finally { await handle.close(); }
      const after = await lstat(abs);
      if (!sameStat(s, after) || data.byteLength !== s.size) return failure();
    } else if (s.isDirectory()) continue;
    else return failure();
    if (data.byteLength > MAX_FILE_BYTES) return failure();
    total += data.byteLength;
    if (total > MAX_TOTAL_BYTES) return failure();
    files.push({ path: posix(relative), sha256: hash(data), bytes: data.byteLength, kind: s.isSymbolicLink() ? 'symlink' : 'file' });
  }
  const serialized = JSON.stringify({ files, gitIdentity: git.identity });
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SERIALIZED_BYTES) return failure();
  return ok({ fingerprint: hash(serialized), files, gitIdentity: git.identity });
}

interface GitInventory { readonly isGit: boolean; readonly paths: readonly string[]; readonly identity: string | null }
async function gitInventory(root: string, signal?: AbortSignal): Promise<GitInventory> {
  if (!await hasGitMarkerInAncestors(root)) return { isGit: false, paths: [], identity: null };
  const top = (await git(root, ['rev-parse', '--show-toplevel'], signal)).trim();
  if (foldPath(path.resolve(top)) !== foldPath(path.resolve(root))) throw new Error('registered workspace is not the Git root');
  const head = (await git(root, ['rev-parse', '--verify', 'HEAD'], signal)).trim();
  const inventory = await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], signal, true);
  const stage = await git(root, ['ls-files', '--stage', '-z'], signal, true);
  const paths = decodeGitNames(inventory);
  const stageRows = decodeUtf8(stage).split('\0').filter(Boolean);
  if (stageRows.some((row) => /^\d+ [a-f0-9]+ [123]\t/.test(row))) throw new Error('unmerged');
  const index = stageRows.sort(compare).join('\n');
  return { isGit: true, paths, identity: hash(`${head}\n${index}`) };
}

async function git(cwd: string, args: string[], signal?: AbortSignal, raw = false): Promise<string> {
  cancelled(signal);
  const platformNull = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const full = ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', `core.hooksPath=${platformNull}`, ...args];
  const result = await execFileAsync('git', full, { cwd, env: createSafeProcessEnvironment(process.env), timeout: 5000, maxBuffer: MAX_GIT_OUTPUT, windowsHide: true, encoding: 'buffer', signal });
  const output = result.stdout as unknown as Buffer;
  const bytes = output.toString('binary');
  return raw ? bytes : decodeUtf8(bytes);
}
function decodeGitNames(binary: string): string[] {
  const bytes = Buffer.from(binary, 'binary');
  const parts = bytes.toString('utf8').split('\0').filter(Boolean);
  if (parts.some((p) => p.includes('\ufffd') || p.includes('\0') || path.isAbsolute(p) || p.split(/[\\/]/).includes('..'))) throw new Error('invalid git path');
  return [...new Set(parts.map((p) => posix(p)))];
}
function decodeUtf8(value: string): string {
  const buffer = Buffer.from(value, 'binary');
  return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
}
async function walk(root: string, directory: string, out: Map<string, string>, state: { entries: number }, signal?: AbortSignal): Promise<void> {
  cancelled(signal);
  const entries = await opendir(directory);
  for await (const item of entries) {
    cancelled(signal);
    if (item.name === '.git') continue;
    if (++state.entries > MAX_ENTRIES) throw new Error('too many directory entries');
    const absolute = path.join(directory, item.name);
    const relative = posix(path.relative(root, absolute));
    if (item.isSymbolicLink()) putPath(out, relative);
    else if (item.isDirectory()) await walk(root, absolute, out, state, signal);
    else if (item.isFile()) putPath(out, relative);
    else throw new Error('unsupported source entry');
    if (out.size > MAX_FILES) throw new Error('too many files');
  }
}
async function canonicalWithMissingSuffix(input: string): Promise<string> {
  const suffix: string[] = []; let current = path.resolve(input);
  while (true) {
    try { const actual = await realpath(current); return path.resolve(actual, ...suffix); }
    catch { const parent = path.dirname(current); if (parent === current) throw new Error('no ancestor'); suffix.unshift(path.basename(current)); current = parent; }
  }
}
function validPath(p: string): boolean { return typeof p === 'string' && p.length > 0 && !p.includes('\0') && !path.isAbsolute(p) && !p.split(/[\\/]/).includes('..'); }
function pathMatches(file: string, scope: string): boolean {
  const f = foldPath(path.posix.normalize(posix(file))); const s = foldPath(path.posix.normalize(posix(scope)).replace(/\/$/, ''));
  return s === '.' || f === s || f.startsWith(`${s}/`);
}
function foldPath(p: string): string { return p.normalize('NFC').toLocaleLowerCase('en-US'); }
function normalizeAbsolute(p: string): string { return foldPath(path.resolve(p).split(path.sep).join('/')); }
function posix(p: string): string { return p.split(path.sep).join('/').replace(/^\.\//, ''); }
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function hash(input: string | Buffer): string { return createHash('sha256').update(input).digest('hex'); }
function sameStat(a: Awaited<ReturnType<typeof lstat>>, b: Awaited<ReturnType<typeof lstat>>): boolean { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs; }
function putPath(out: Map<string, string>, value: string): void {
  const key = foldPath(value); const old = out.get(key);
  if (old !== undefined && old !== value) throw new Error('ambiguous folded path');
  out.set(key, value);
}
function snapshotMap(files: readonly WorkflowSourceFile[]): Map<string, WorkflowSourceFile> | null {
  const map = new Map<string, WorkflowSourceFile>();
  for (const file of files) {
    const key = foldPath(file.path); const previous = map.get(key);
    if (previous !== undefined && previous.path !== file.path) return null;
    map.set(key, file);
  }
  return map;
}
async function hasGitMarkerInAncestors(root: string): Promise<boolean> {
  let current = root;
  while (true) {
    try { await lstat(path.join(current, '.git')); return true; }
    catch { const parent = path.dirname(current); if (parent === current) return false; current = parent; }
  }
}
function cancelled(signal?: AbortSignal): void { if (signal?.aborted) throw new Error('cancelled'); }
function cancelledResult(): Result<never> { return err(appError('PROCESS_TIMEOUT', 'Workflow scope capture was cancelled', true)); }
function failure(): Result<never> { return err(appError('INVALID_INPUT', 'Workflow filesystem scope could not be validated')); }
