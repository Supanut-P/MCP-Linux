import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import { createSafeProcessEnvironment, UnixProcessTree } from '@baitonghub-linux-mcp/process';
import { codexRoleConfig, disabledMcpConfig, readCodexConfigProjection, verifyCodexConfig } from './codex-config-policy.js';

export interface CodexConfigReadPort {
  read(executable: string, cwd: string, overrides: readonly string[], environment: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<Result<unknown>>;
}
export interface CodexVerifiedConfig {
  readonly disabledServerIds: readonly string[];
  readonly configFingerprint: string;
}
export interface CodexConfigInspectorPort {
  verify(executable: string, cwd: string, sandbox: 'read-only' | 'workspace-write', signal?: AbortSignal, environment?: NodeJS.ProcessEnv): Promise<Result<CodexVerifiedConfig>>;
}

/** Metadata only: no thread, turn, tool, login, config mutation or auth copying. */
export class DirectCodexConfigReader implements CodexConfigReadPort {
  public read(executable: string, cwd: string, overrides: readonly string[], environment: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<Result<unknown>> {
    if (signal?.aborted) return Promise.resolve(cancelled());
    return new Promise((resolve) => {
      const env = createSafeProcessEnvironment(environment);
      const child = spawn(executable, ['app-server', '--stdio', '--strict-config', ...overrides.flatMap((value) => ['--config', value])], { cwd, env, shell: false, windowsHide: true, detached: process.platform === 'linux', stdio: ['pipe', 'pipe', 'pipe'] });
      const tree = new UnixProcessTree();
      let pending = '';
      let received = 0;
      let settled = false;
      const decoder = new StringDecoder('utf8');
      let closed = false;
      let markClosed!: () => void;
      const closeReceipt = new Promise<void>((done) => { markClosed = done; });
      const finish = (result: Result<unknown>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        void (async (): Promise<void> => {
          try {
            if (process.platform === 'linux' && child.pid !== undefined) await tree.stop(child, child.pid);
            else if (!closed) {
              child.kill('SIGTERM');
              let deadline: ReturnType<typeof setTimeout> | undefined;
              const stopped = await Promise.race([
                closeReceipt.then(() => true),
                new Promise<boolean>((done) => { deadline = setTimeout(() => done(false), 2_000); }),
              ]);
              clearTimeout(deadline);
              if (!stopped) { resolve(unavailable()); return; }
            }
            resolve(result);
          } catch { resolve(unavailable()); }
        })();
      };
      const abort = (): void => finish(cancelled());
      const timer = setTimeout(() => finish(unavailable()), 10_000);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const send = (message: unknown): void => { if (!settled) child.stdin.write(`${JSON.stringify(message)}\n`); };
      child.stderr.resume(); // Never retain arbitrary config/auth diagnostics.
      child.stdin.on('error', () => finish(unavailable()));
      child.once('error', () => finish(unavailable()));
      child.once('close', () => { closed = true; markClosed(); if (!settled) finish(unavailable()); });
      child.once('spawn', () => {
        if (process.platform === 'linux' && child.pid !== undefined) {
          try { tree.captureOwnership(child, child.pid); } catch { finish(unavailable()); return; }
        }
        send({ id: 0, method: 'initialize', params: { clientInfo: { name: 'mcp_linux_config_preflight', version: '1' }, capabilities: { experimentalApi: true } } });
      });
      child.stdout.on('data', (chunk: Buffer) => {
        if (settled) return;
        received += chunk.length;
        if (received > 1024 * 1024) { finish(unavailable()); return; }
        pending += decoder.write(chunk);
        let end: number;
        while (!settled && (end = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          let message: unknown;
          try { message = JSON.parse(line); } catch { finish(unavailable()); return; }
          if (!record(message)) { finish(unavailable()); return; }
          if (message.id === 0) {
            if (message.error !== undefined || !record(message.result)) { finish(unavailable()); return; }
            send({ method: 'initialized', params: {} });
            send({ id: 1, method: 'config/read', params: { cwd, includeLayers: true } });
          } else if (message.id === 1) {
            if (message.error !== undefined || !record(message.result)) finish(unavailable());
            else finish(ok(message.result));
          } else if (message.id !== undefined) { finish(unavailable()); return; }
        }
      });
    });
  }
}

export class CodexConfigInspector implements CodexConfigInspectorPort {
  public constructor(private readonly reader: CodexConfigReadPort = new DirectCodexConfigReader()) {}

  public async verify(executable: string, cwd: string, sandbox: 'read-only' | 'workspace-write', signal?: AbortSignal, environment = createSafeProcessEnvironment(process.env)): Promise<Result<CodexVerifiedConfig>> {
    if (signal?.aborted) return cancelled();
    const env = Object.freeze(createSafeProcessEnvironment(environment));
    try {
      const base = codexRoleConfig(sandbox);
      const first = await this.reader.read(executable, cwd, base, env, signal);
      if (signal?.aborted) return cancelled();
      if (!first.ok) return first;
      const projection = readCodexConfigProjection(first.value);
      const fingerprint = layerFingerprint(first.value);
      if (!projection.ok || !fingerprint.ok) return unavailable();
      const overrides = disabledMcpConfig(projection.value.mcpServerIds);
      if (!overrides.ok) return overrides;
      const second = await this.reader.read(executable, cwd, [...base, ...overrides.value], env, signal);
      if (signal?.aborted) return cancelled();
      if (!second.ok) return second;
      const verified = readCodexConfigProjection(second.value);
      const current = layerFingerprint(second.value);
      if (!verified.ok || !current.ok || current.value !== fingerprint.value) return unavailable();
      const controls = verifyCodexConfig(verified.value, projection.value.mcpServerIds, sandbox);
      if (!controls.ok) return controls;
      const binding = JSON.stringify({ layers: current.value, executable, cwd, sandbox, overrides: [...base, ...overrides.value], environment: Object.entries(env).sort(([a], [b]) => a.localeCompare(b)) });
      return ok({ disabledServerIds: projection.value.mcpServerIds, configFingerprint: createHash('sha256').update(binding).digest('hex') });
    } catch { return unavailable(); }
  }
}

function layerFingerprint(input: unknown): Result<string> {
  if (!record(input) || !Array.isArray(input.layers) || input.layers.length === 0 || input.layers.length > 64) return unavailable();
  const bindings: unknown[] = [];
  for (const layer of input.layers) {
    if (!record(layer) || !record(layer.name) || typeof layer.name.type !== 'string' || typeof layer.version !== 'string' || layer.version.length === 0 || layer.version.length > 512 || JSON.stringify(layer.name).length > 8192) return unavailable();
    if (layer.name.type === 'sessionFlags') continue;
    if (!['system', 'project', 'user', 'mdm', 'legacyManagedConfigTomlFromFile'].includes(layer.name.type)) return unavailable();
    bindings.push({ name: layer.name, version: layer.version, disabled: layer.disabledReason !== undefined && layer.disabledReason !== null });
  }
  if (bindings.length === 0) return unavailable();
  return ok(createHash('sha256').update(JSON.stringify(bindings)).digest('hex'));
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function unavailable(): Result<never> { return err(appError('CODEX_NOT_AVAILABLE', 'Codex effective integration configuration could not be verified', true)); }
function cancelled(): Result<never> { return err(appError('PROCESS_TIMEOUT', 'Codex configuration preflight was cancelled', true)); }
