import { describe, expect, it, vi } from 'vitest';
import {
  LibsecretSecretStore,
  SecretStoreUnavailableError,
  readRequiredSecret,
  type SecretToolRunner,
} from './secret-store.js';
import { loadCheckpointEncryptionKey } from './checkpoint-key.js';

describe('LibsecretSecretStore', () => {
  it('uses secret-tool argument arrays and passes values only through stdin', async () => {
    const runner = vi.fn<SecretToolRunner>().mockResolvedValue({ exitCode: 0, stdout: '' });
    const store = new LibsecretSecretStore({ runner });

    await store.set('tunnel-api-key', 'never-log-this');

    expect(runner).toHaveBeenCalledWith([
      'store',
      '--label=Baitonghub-Linux-mcp tunnel-api-key',
      'service',
      'baitonghub-linux-mcp',
      'account',
      'tunnel-api-key',
    ], 'never-log-this', expect.any(AbortSignal));
    expect(JSON.stringify(runner.mock.calls[0]?.[0])).not.toContain('never-log-this');
  });

  it('returns null when a lookup has no matching Secret Service entry', async () => {
    const runner: SecretToolRunner = async () => ({ exitCode: 1, stdout: '' });
    await expect(new LibsecretSecretStore({ runner }).get('missing')).resolves.toBeNull();
  });

  it('fails closed with a sanitized error when secret-tool is unavailable', async () => {
    const runner: SecretToolRunner = async () => { throw new Error('spawn ENOENT /private/path'); };
    await expect(new LibsecretSecretStore({ runner }).get('checkpoint')).rejects.toEqual(
      new SecretStoreUnavailableError('Linux Secret Service is unavailable'),
    );
  });

  it('aborts a hanging Secret Service lookup and fails closed', async () => {
    let aborted = false;
    const store = new LibsecretSecretStore({
      timeoutMs: 10,
      runner: async (_args, _input, signal): Promise<never> => new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('fixture aborted'));
        }, { once: true });
      }),
    });

    await expect(store.get('tunnel-api-key')).rejects.toEqual(
      new SecretStoreUnavailableError('Linux Secret Service is unavailable'),
    );
    expect(aborted).toBe(true);
  });
});

describe('readRequiredSecret', () => {
  it('supports an environment-only headless fallback without writing plaintext', async () => {
    await expect(readRequiredSecret({
      name: 'checkpoint',
      environmentVariable: 'BAITONGHUB_LINUX_MCP_CHECKPOINT_KEY',
      environment: { BAITONGHUB_LINUX_MCP_CHECKPOINT_KEY: 'from-environment' },
    })).resolves.toBe('from-environment');
  });

  it('fails closed when neither environment nor Secret Service contains the secret', async () => {
    await expect(readRequiredSecret({
      name: 'checkpoint',
      environmentVariable: 'BAITONGHUB_LINUX_MCP_CHECKPOINT_KEY',
      environment: {},
    })).rejects.toBeInstanceOf(SecretStoreUnavailableError);
  });
});

describe('Linux checkpoint key storage', () => {
  it('creates and confirms a 32-byte key through secret-tool without a plaintext fallback', () => {
    let saved = '';
    const calls: string[][] = [];
    const key = loadCheckpointEncryptionKey('/unused', {
      platform: 'linux',
      environment: {},
      useLinuxSecretService: true,
      secretToolRunner: (args, input) => {
        calls.push([...args]);
        if (args[0] === 'store') {
          saved = input ?? '';
          return { status: 0, stdout: '' };
        }
        return saved.length === 0 ? { status: 1, stdout: '' } : { status: 0, stdout: `${saved}\n` };
      },
    });

    expect(key).toHaveLength(32);
    expect(saved).toBe(key.toString('base64'));
    expect(calls.map((args) => args[0])).toEqual(['lookup', 'store', 'lookup']);
  });

  it('requires the environment key in headless Linux mode', () => {
    expect(() => loadCheckpointEncryptionKey('/unused', { platform: 'linux', environment: {} }))
      .toThrow('BAITONGHUB_LINUX_MCP_CHECKPOINT_KEY_BASE64 is required for headless Linux');
  });
});
