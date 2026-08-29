import { createHash } from 'node:crypto';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import type { SecretStore } from '@baitonghub-linux-mcp/shared';
import type { NativeCapabilityBackend, NativeCapabilityHealth } from './platform/types.js';
import { LinuxCommandRunner } from './linux-command-runner.js';

export type RemoteHostOperation = 'health' | 'system_info' | 'journal' | 'network' | 'file_read' | 'git_status' | 'service-restart' | 'file-write' | 'project-command';

export interface RegisteredRemoteHost {
  readonly id: string;
  readonly displayName?: string;
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly secretRef: string;
  readonly pinnedFingerprint: string;
  readonly roots: readonly string[];
}

export interface RemoteHostRegistry { get(id: string): Promise<RegisteredRemoteHost | null>; list?(): Promise<readonly RegisteredRemoteHost[]>; }

export interface RemoteCommandResult { readonly exitCode: number | null; readonly stdout: string; readonly stderr?: string; readonly truncated?: boolean; }
export type RemoteCommandRunner = (executable: string, args: readonly string[], options: { readonly input?: string; readonly signal?: AbortSignal; readonly maxBytes: number }) => Promise<RemoteCommandResult>;

export interface RemoteHostBackendOptions {
  readonly platform?: NodeJS.Platform;
  readonly registry?: RemoteHostRegistry;
  readonly secrets?: SecretStore;
  readonly runner?: RemoteCommandRunner;
  readonly knownHostsPathProvider?: (host: RegisteredRemoteHost) => Promise<{ readonly path: string; readonly cleanup?: () => Promise<void> }>;
}

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const UNIT = /^[A-Za-z0-9_.@:-]{1,256}\.service$/;
const SAFE_ARG = /^[A-Za-z0-9_./:@%+=,-]{1,4096}$/;

/** SSH operations are intentionally host-registration based; no arbitrary host or shell input is accepted. */
export class RemoteHostBackend implements NativeCapabilityBackend {
  private readonly platform: NodeJS.Platform;
  private readonly registry: RemoteHostRegistry | undefined;
  private readonly secrets: SecretStore | undefined;
  private readonly runner: RemoteCommandRunner;
  private readonly knownHostsPathProvider: (host: RegisteredRemoteHost) => Promise<{ readonly path: string; readonly cleanup?: () => Promise<void> }>;

  public constructor(options: RemoteHostBackendOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.registry = options.registry;
    this.secrets = options.secrets;
    this.runner = options.runner ?? runRemoteCommand;
    this.knownHostsPathProvider = options.knownHostsPathProvider ?? ((host) => createVerifiedKnownHosts(host, this.runner));
  }

  public async health(): Promise<NativeCapabilityHealth> {
    if (this.platform !== 'linux') return { platform: this.platform, available: false, ready: false, requiresConsent: false, missingDependencies: [], reason: 'platform_unsupported' };
    const registered = this.registry !== undefined;
    return { platform: 'linux', provider: 'openssh', available: registered, ready: registered && this.secrets !== undefined, requiresConsent: false, missingDependencies: registered ? (this.secrets === undefined ? ['secret-service'] : []) : ['registered-remote-host'], ...(registered ? {} : { reason: 'no_registered_remote_host' }) };
  }

  public async execute(input: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
    if (this.platform !== 'linux') return err(appError('PLATFORM_UNSUPPORTED', 'Remote hosts are available on Linux only', true));
    if (!isRecord(input)) return invalid('remote_host input must be an object');
    const operation = readOperation(input.operation);
    if (operation === null) return invalid('Unknown remote_host operation');
    const hostId = typeof input.hostId === 'string' ? input.hostId.trim() : typeof input.host_id === 'string' ? input.host_id.trim() : '';
    if (hostId.length === 0 || this.registry === undefined) return invalid('A registered hostId is required');
    const host = await this.registry.get(hostId);
    if (host === null) return invalid('Registered remote host was not found');
    if (host.roots.length === 0 || host.roots.some((root) => !path.posix.isAbsolute(root))) return invalid('Registered remote host roots are invalid');
    if (signal?.aborted === true) return cancelled();
    if (isMutation(operation)) return this.mutation(host, operation, input, signal);
    const command = await this.readCommand(host, operation, input);
    if (!command.ok) return command;
    return this.run(host, command.value, signal);
  }

  private async readCommand(host: RegisteredRemoteHost, operation: RemoteHostOperation, input: Record<string, unknown>): Promise<Result<readonly string[]>> {
    if (operation === 'health') return ok(['true']);
    if (operation === 'system_info') return ok(['uname', '-a']);
    if (operation === 'journal') {
      const lines = typeof input.lines === 'number' && Number.isInteger(input.lines) ? Math.min(1000, Math.max(1, input.lines)) : 100;
      const args = ['journalctl', '--no-pager', '-n', String(lines)];
      if (typeof input.unit === 'string' && !/^[A-Za-z0-9_.@:-]{1,256}\.(service|socket|timer|path)$/.test(input.unit)) return invalid('Remote journal unit is invalid');
      if (typeof input.unit === 'string') args.push('-u', input.unit);
      return ok(args);
    }
    if (operation === 'network') return ok(['ip', '-j', 'addr']);
    if (operation === 'file_read') {
      const target = typeof input.path === 'string' ? input.path : '';
      return this.registeredPath(host, target, ['cat', '--']);
    }
    if (operation === 'git_status') {
      const target = typeof input.path === 'string' ? input.path : host.roots[0]!;
      const checked = await this.registeredPath(host, target, ['git', '-C']);
      return checked.ok ? ok(['git', '-C', checked.value[2]!, 'status', '--short', '--branch']) : checked;
    }
    return invalid('Unsupported read operation');
  }

  private async registeredPath(host: RegisteredRemoteHost, target: string, prefix: readonly string[]): Promise<Result<readonly string[]>> {
    if (!path.posix.isAbsolute(target) || target.includes('\0')) return err(appError('PATH_OUTSIDE_WORKSPACE', 'Remote path must be absolute and registered', true));
    const normalized = path.posix.normalize(target);
    const root = host.roots.find((candidate) => isWithin(candidate, normalized));
    if (root === undefined) return err(appError('PATH_OUTSIDE_WORKSPACE', 'Remote path is outside registered roots', true));
    if (!SAFE_ARG.test(normalized)) return invalid('Remote path is invalid');
    // realpath is executed before the operation so a symlink cannot escape a registered root.
    const checked = await this.run(host, ['realpath', '--canonicalize-existing', '--', normalized]);
    if (!checked.ok) return checked;
    const canonical = typeof checked.value.output === 'string' ? checked.value.output.trim() : '';
    if (!isWithin(root, canonical)) return err(appError('PATH_OUTSIDE_WORKSPACE', 'Remote path resolves outside registered roots', true));
    return ok([...prefix, canonical]);
  }

  private async mutation(host: RegisteredRemoteHost, operation: RemoteHostOperation, input: Record<string, unknown>, signal?: AbortSignal): Promise<Result<unknown>> {
    const plan = await this.mutationPlan(host, operation, input);
    if (!plan.ok) return plan;
    const previewHash = createHash('sha256').update(JSON.stringify(plan.value)).digest('hex');
    if (input.dry_run === true) return ok({ operation, hostId: host.id, preview: plan.value, previewHash, dry_run: true });
    const supplied = typeof input.previewHash === 'string' ? input.previewHash : typeof input.preview_hash === 'string' ? input.preview_hash : '';
    if (supplied !== previewHash) return err(appError('PERMISSION_REQUIRED', 'Remote mutation requires a matching previewHash', true));
    if (input.userConfirmed !== true) return err(appError('PERMISSION_REQUIRED', 'Remote mutation requires explicit confirmation', true));
    const result = await this.run(host, plan.value.command, signal, plan.value.input);
    return result.ok ? ok({ operation, hostId: host.id, previewHash, output: result.value.output }) : result;
  }

  private async mutationPlan(host: RegisteredRemoteHost, operation: RemoteHostOperation, input: Record<string, unknown>): Promise<Result<{ readonly command: readonly string[]; readonly input?: string }>> {
    if (operation === 'service-restart') {
      const unit = typeof input.unit === 'string' ? input.unit : '';
      if (!UNIT.test(unit) || /^(shutdown|reboot|emergency|rescue)\.service$/.test(unit)) return invalid('Remote service unit is invalid or blocked');
      return ok({ command: ['systemctl', 'restart', unit] });
    }
    const target = typeof input.path === 'string' ? input.path : '';
    const checked = await this.registeredPath(host, target, operation === 'file-write' ? ['tee', '--'] : []);
    if (!checked.ok) return checked;
    if (operation === 'file-write') {
      const content = typeof input.content === 'string' ? input.content : '';
      if (Buffer.byteLength(content, 'utf8') > 1_048_576) return invalid('Remote file content is too large');
      return ok({ command: checked.value, input: content });
    }
    const executable = typeof input.executable === 'string' ? input.executable : '';
    if (!path.posix.isAbsolute(executable) || !isWithin(target, executable) || !SAFE_ARG.test(executable)) return err(appError('PATH_OUTSIDE_WORKSPACE', 'Project executable must be inside the requested registered root', true));
    const args = Array.isArray(input.arguments) ? input.arguments : [];
    if (!args.every((value) => typeof value === 'string' && SAFE_ARG.test(value))) return invalid('Project command arguments are invalid');
    return ok({ command: [executable, ...args] });
  }

  private async run(host: RegisteredRemoteHost, remoteCommand: readonly string[], signal?: AbortSignal, input?: string): Promise<Result<{ readonly output: string }>> {
    if (this.secrets === undefined) return err(appError('CAPABILITY_UNAVAILABLE', 'Remote host Secret Service is not configured', true));
    let credential: string | null;
    try { credential = await this.secrets.get(host.secretRef); } catch { return err(appError('CAPABILITY_UNAVAILABLE', 'Remote host credential is unavailable', true)); }
    if (credential === null || credential.length === 0) return err(appError('CAPABILITY_UNAVAILABLE', 'Remote host credential is unavailable', true));
    const knownHosts = await this.knownHostsPathProvider(host);
    let keyPath: string | undefined;
    let keyCleanup: (() => Promise<void>) | undefined;
    try {
      if (credential.includes('PRIVATE KEY')) {
        const dir = await mkdtemp(path.join(tmpdir(), 'baitonghub-ssh-key-'));
        keyPath = path.join(dir, 'id'); await writeFile(keyPath, credential, { mode: 0o600 }); await chmod(keyPath, 0o600);
        keyCleanup = async () => rm(dir, { recursive: true, force: true });
      } else {
        await access(credential); keyPath = credential;
      }
      const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${knownHosts.path}`, '-o', 'IdentitiesOnly=yes', '-o', 'ForwardAgent=no', '-o', 'PermitLocalCommand=no', '-o', 'ClearAllForwardings=yes', '-o', 'ConnectTimeout=10', '-p', String(host.port), '-i', keyPath!, `${host.username}@${host.host}`, ...remoteCommand];
      const result = await this.runner('ssh', args, { ...(input === undefined ? {} : { input }), ...(signal === undefined ? {} : { signal }), maxBytes: MAX_OUTPUT_BYTES });
      if (result.exitCode !== 0 || result.truncated === true) return err(appError('CAPABILITY_UNAVAILABLE', 'Remote SSH operation failed or exceeded the response limit', true));
      return ok({ output: redact(result.stdout) });
    } catch { return err(appError('CAPABILITY_UNAVAILABLE', 'Remote SSH operation failed', true)); }
    finally { await keyCleanup?.(); await knownHosts.cleanup?.(); }
  }
}

export const LinuxRemoteHostBackend = RemoteHostBackend;

async function createVerifiedKnownHosts(host: RegisteredRemoteHost, runner: RemoteCommandRunner): Promise<{ readonly path: string; readonly cleanup: () => Promise<void> }> {
  const result = await runner('ssh-keyscan', ['-T', '10', '-p', String(host.port), '--', host.host], { maxBytes: 128 * 1024 });
  if (result.exitCode !== 0 || result.stdout.trim().length === 0) throw new Error('Host key could not be scanned');
  const line = result.stdout.split(/\r?\n/).find((value) => value.trim().length > 0);
  if (line === undefined || !matchesFingerprint(line, host.pinnedFingerprint)) throw new Error('Pinned host fingerprint did not match');
  const dir = await mkdtemp(path.join(tmpdir(), 'baitonghub-known-hosts-'));
  const filename = path.join(dir, 'known_hosts'); await writeFile(filename, line + '\n', { mode: 0o600 }); await chmod(filename, 0o600);
  return { path: filename, cleanup: async () => rm(dir, { recursive: true, force: true }) };
}

function matchesFingerprint(line: string, expected: string): boolean {
  const parts = line.trim().split(/\s+/); if (parts.length < 3) return false;
  try { return `SHA256:${createHash('sha256').update(Buffer.from(parts[2]!, 'base64')).digest('base64').replace(/=+$/, '')}` === expected; } catch { return false; }
}

async function runRemoteCommand(executable: string, args: readonly string[], options: { readonly input?: string; readonly signal?: AbortSignal; readonly maxBytes: number }): Promise<RemoteCommandResult> {
  const child = spawn(executable, [...args], { shell: false, stdio: ['pipe', 'pipe', 'ignore'], signal: options.signal });
  return new Promise((resolve, reject) => {
    let stdout = ''; let bytes = 0; let truncated = false;
    child.stdout.on('data', (chunk: Buffer) => { const slice = chunk.subarray(0, Math.max(0, options.maxBytes - bytes)); stdout += slice.toString('utf8'); bytes += slice.byteLength; if (slice.byteLength < chunk.byteLength) truncated = true; });
    child.once('error', reject); child.once('close', (exitCode) => resolve({ exitCode, stdout, truncated })); child.stdin.end(options.input ?? '');
  });
}

function readOperation(value: unknown): RemoteHostOperation | null { return typeof value === 'string' && new Set<RemoteHostOperation>(['health', 'system_info', 'journal', 'network', 'file_read', 'git_status', 'service-restart', 'file-write', 'project-command']).has(value as RemoteHostOperation) ? value as RemoteHostOperation : null; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isMutation(operation: RemoteHostOperation): boolean { return operation === 'service-restart' || operation === 'file-write' || operation === 'project-command'; }
function isWithin(root: string, candidate: string): boolean { const relative = path.posix.relative(path.posix.normalize(root), path.posix.normalize(candidate)); return relative === '' || (relative !== '..' && !relative.startsWith('../') && !path.posix.isAbsolute(relative)); }
function redact(value: string): string { return value.replace(/\b(token|secret|password|api[_-]?key|private[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]'); }
function invalid(message: string): Result<never> { return err(appError('INVALID_INPUT', message)); }
function cancelled(): Result<never> { return err(appError('PROCESS_TIMEOUT', 'Remote operation was cancelled', true)); }
