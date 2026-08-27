import { spawn } from 'node:child_process';

const SERVICE_NAME = 'baitonghub-linux-mcp';
const MAX_SECRET_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_SECRET_TOOL_TIMEOUT_MS = 2_000;

export interface SecretStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

export interface SecretToolResult {
  readonly exitCode: number | null;
  readonly stdout: string;
}

export type SecretToolRunner = (
  args: readonly string[],
  input?: string,
  signal?: AbortSignal,
) => Promise<SecretToolResult>;

export class SecretStoreUnavailableError extends Error {
  public constructor(message = 'Required secret is unavailable') {
    super(message);
    this.name = 'SecretStoreUnavailableError';
  }
}

export interface LibsecretSecretStoreOptions {
  readonly runner?: SecretToolRunner;
  readonly timeoutMs?: number;
}

/** Linux Secret Service adapter. Secret values are sent through stdin, never argv. */
export class LibsecretSecretStore implements SecretStore {
  private readonly runner: SecretToolRunner;
  private readonly timeoutMs: number;

  public constructor(options: LibsecretSecretStoreOptions = {}) {
    this.runner = options.runner ?? runSecretTool;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_SECRET_TOOL_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error('Secret Service timeout must be positive');
  }

  public async get(name: string): Promise<string | null> {
    validateSecretName(name);
    const result = await this.run([
      'lookup',
      'service', SERVICE_NAME,
      'account', name,
    ]);
    if (result.exitCode === 1) return null;
    if (result.exitCode !== 0) throw unavailable();
    return result.stdout.replace(/\r?\n$/, '');
  }

  public async set(name: string, value: string): Promise<void> {
    validateSecretName(name);
    if (value.length === 0) throw new SecretStoreUnavailableError('Empty secrets are not accepted');
    const result = await this.run([
      'store',
      `--label=Baitonghub-Linux-mcp ${name}`,
      'service', SERVICE_NAME,
      'account', name,
    ], value);
    if (result.exitCode !== 0) throw unavailable();
  }

  public async delete(name: string): Promise<void> {
    validateSecretName(name);
    const result = await this.run([
      'clear',
      'service', SERVICE_NAME,
      'account', name,
    ]);
    if (result.exitCode !== 0 && result.exitCode !== 1) throw unavailable();
  }

  private async run(args: readonly string[], input?: string): Promise<SecretToolResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await Promise.race([
        this.runner(args, input, controller.signal),
        new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => reject(unavailable()), { once: true });
        }),
      ]);
    } catch {
      throw unavailable();
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface RequiredSecretOptions {
  readonly name: string;
  readonly environmentVariable: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly store?: SecretStore;
}

/** Read a secret without ever creating a plaintext fallback file. */
export async function readRequiredSecret(options: RequiredSecretOptions): Promise<string> {
  const environment = options.environment ?? process.env;
  const configured = environment[options.environmentVariable]?.trim();
  if (configured) return configured;

  const stored = await options.store?.get(options.name);
  if (stored) return stored;
  throw unavailable();
}

function validateSecretName(name: string): void {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(name)) {
    throw new SecretStoreUnavailableError('Secret name is invalid');
  }
}

function unavailable(): SecretStoreUnavailableError {
  return new SecretStoreUnavailableError('Linux Secret Service is unavailable');
}

function runSecretTool(args: readonly string[], input?: string, signal?: AbortSignal): Promise<SecretToolResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('secret-tool', [...args], {
      shell: false,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let stdout = '';
    const abort = (): void => {
      child.kill('SIGTERM');
      reject(unavailable());
    };
    if (signal?.aborted === true) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    const cleanup = (): void => signal?.removeEventListener('abort', abort);
    child.stdout.on('data', (chunk: Buffer) => {
      if (Buffer.byteLength(stdout) >= MAX_SECRET_OUTPUT_BYTES) return;
      stdout += chunk.toString('utf8');
    });
    child.once('error', (error) => { cleanup(); reject(error); });
    child.once('close', (exitCode) => { cleanup(); resolve({ exitCode, stdout }); });
    child.stdin.end(input ?? '');
  });
}
