import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const DEFAULT_MAX_BUFFER = 1024 * 1024;
const CHECKPOINT_SECRET_NAME = 'checkpoint-master-key';

export interface CheckpointKeyOptions {
  readonly platform?: NodeJS.Platform;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly useLinuxSecretService?: boolean;
  readonly secretToolRunner?: SyncSecretToolRunner;
}

export type SyncSecretToolRunner = (
  args: readonly string[],
  input?: string,
) => { readonly status: number | null; readonly stdout: string; readonly error?: Error };

export function loadCheckpointEncryptionKey(_dataPath: string, options: CheckpointKeyOptions = {}): Buffer {
  const platform = options.platform ?? process.platform;
  if (platform !== 'linux') throw new Error('Checkpoint key storage is available on Linux only');

  const environment = options.environment ?? process.env;
  const configured = environment.BAITONGHUB_LINUX_MCP_CHECKPOINT_KEY_BASE64;
  if (configured !== undefined && configured.trim().length > 0) {
    return decodeKey(configured, 'BAITONGHUB_LINUX_MCP_CHECKPOINT_KEY_BASE64 must decode to 32 bytes');
  }
  if (options.useLinuxSecretService !== true) {
    throw new Error('BAITONGHUB_LINUX_MCP_CHECKPOINT_KEY_BASE64 is required for headless Linux');
  }
  return loadOrCreateSecretServiceKey(options.secretToolRunner ?? runSecretToolSync);
}

function loadOrCreateSecretServiceKey(runner: SyncSecretToolRunner): Buffer {
  const lookupArgs = ['lookup', 'service', 'baitonghub-linux-mcp', 'account', CHECKPOINT_SECRET_NAME] as const;
  const stored = runner(lookupArgs);
  if (stored.error !== undefined) throw secretServiceUnavailable();
  if (stored.status === 0) return decodeKey(stored.stdout, 'Linux Secret Service checkpoint key has an invalid length');
  if (stored.status !== 1) throw secretServiceUnavailable();

  const generated = randomBytes(32).toString('base64');
  const saved = runner([
    'store',
    '--label=Baitonghub-Linux-mcp checkpoint encryption key',
    'service', 'baitonghub-linux-mcp',
    'account', CHECKPOINT_SECRET_NAME,
  ], generated);
  if (saved.error !== undefined || saved.status !== 0) throw secretServiceUnavailable();
  const confirmed = runner(lookupArgs);
  if (confirmed.error !== undefined || confirmed.status !== 0) throw secretServiceUnavailable();
  return decodeKey(confirmed.stdout, 'Linux Secret Service checkpoint key has an invalid length');
}

function decodeKey(value: string, errorMessage: string): Buffer {
  const key = Buffer.from(value.trim(), 'base64');
  if (key.byteLength !== 32) throw new Error(errorMessage);
  return key;
}

function runSecretToolSync(args: readonly string[], input?: string): { status: number | null; stdout: string; error?: Error } {
  const result = spawnSync('secret-tool', [...args], {
    input: input ?? '',
    encoding: 'utf8',
    maxBuffer: DEFAULT_MAX_BUFFER,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

function secretServiceUnavailable(): Error {
  return new Error('Linux Secret Service is unavailable');
}
