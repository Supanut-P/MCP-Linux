import { describe, expect, it, vi } from 'vitest';
import { LinuxCommandRunner, type LinuxCommandResult } from './linux-command-runner.js';
import { ServiceLogsBackend } from './service-logs-backend.js';

describe('ServiceLogsBackend', () => {
  it('reads a fixed systemd unit through bounded argv', async () => {
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const backend = new ServiceLogsBackend({
      platform: 'linux',
      resolveExecutable: async (): Promise<string> => '/usr/bin/journalctl',
      runner: new LinuxCommandRunner({
        allowedExecutables: ['journalctl'],
        spawn: async (executable: string, args: readonly string[]): Promise<LinuxCommandResult> => {
          calls.push({ executable, args });
          return {
            exitCode: 0,
            stderr: '',
            truncated: false,
            stdout: '{"MESSAGE":"ready","_SYSTEMD_UNIT":"caddy.service","_SOURCE_REALTIME_TIMESTAMP":"1700000000000000","_SEQNUM":"1"}\n',
          };
        },
      }),
    });

    await expect(backend.execute({ operation: 'read', unit: 'caddy.service', lines: 10 })).resolves.toMatchObject({
      ok: true,
      value: {
        unit: 'caddy.service',
        provider: 'journalctl',
        entries: [{ MESSAGE: 'ready', _SYSTEMD_UNIT: 'caddy.service' }],
        truncated: false,
      },
    });
    expect(calls).toEqual([{
      executable: '/usr/bin/journalctl',
      args: ['--no-pager', '--output=json', '--utc', '-u', 'caddy.service', '-n', '10'],
    }]);
  });

  it('rejects an invalid unit before resolving or spawning journalctl', async () => {
    let resolved = false;
    const backend = new ServiceLogsBackend({
      platform: 'linux',
      resolveExecutable: async (): Promise<string> => { resolved = true; return '/usr/bin/journalctl'; },
    });

    await expect(backend.execute({ operation: 'read', unit: '../../etc/passwd.service' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
    expect(resolved).toBe(false);
  });

  it('uses an opaque cursor to return only newer records and binds it to the unit', async () => {
    const calls: Array<{ readonly args: readonly string[] }> = [];
    const backend = new ServiceLogsBackend({
      platform: 'linux',
      resolveExecutable: async (): Promise<string> => '/usr/bin/journalctl',
      runner: new LinuxCommandRunner({
        allowedExecutables: ['journalctl'],
        spawn: async (_executable: string, args: readonly string[]): Promise<LinuxCommandResult> => {
          calls.push({ args });
          return {
            exitCode: 0,
            stderr: '',
            truncated: false,
            stdout: [
              '{"MESSAGE":"first","_SOURCE_REALTIME_TIMESTAMP":"1700000000000000","_SEQNUM":"1"}',
              '{"MESSAGE":"second","_SOURCE_REALTIME_TIMESTAMP":"1700000000002000","_SEQNUM":"2"}',
            ].join('\n'),
          };
        },
      }),
    });

    const first = await backend.execute({ operation: 'read', unit: 'caddy.service', lines: 1 });
    expect(first).toMatchObject({ ok: true, value: { entries: [{ MESSAGE: 'first' }], nextCursor: expect.any(String) } });
    const cursor = (first.ok ? (first.value as { nextCursor?: unknown }).nextCursor : undefined);
    expect(typeof cursor).toBe('string');

    await expect(backend.execute({ operation: 'tail', unit: 'caddy.service', cursor, lines: 10 })).resolves.toMatchObject({
      ok: true,
      value: { entries: [{ MESSAGE: 'second' }] },
    });
    expect(calls[1]?.args).toContain('--since');

    await expect(backend.execute({ operation: 'tail', unit: 'other.service', cursor, lines: 10 })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
  });

  it('caps serialized output and redacts sensitive journal fields', async () => {
    const secret = 'service-log-secret-canary';
    const backend = new ServiceLogsBackend({
      platform: 'linux',
      resolveExecutable: async (): Promise<string> => '/usr/bin/journalctl',
      runner: new LinuxCommandRunner({
        allowedExecutables: ['journalctl'],
        spawn: async (): Promise<LinuxCommandResult> => ({
          exitCode: 0,
          stderr: `password=${secret}`,
          truncated: false,
          stdout: JSON.stringify({
            MESSAGE: 'x'.repeat(4_000),
            PASSWORD: secret,
            _SOURCE_REALTIME_TIMESTAMP: '1700000000000000',
            _SEQNUM: '1',
          }),
        }),
      }),
    });

    const result = await backend.execute({ unit: 'caddy.service', lines: 100, maxBytes: 1_024 });
    expect(result.ok).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(1_024);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result).toMatchObject({ ok: true, value: { truncated: true } });
  });

  it('reports missing journalctl and maps cancellation to a recoverable result', async () => {
    await expect(new ServiceLogsBackend({ platform: 'linux', resolveExecutable: async (): Promise<null> => null }).health()).resolves.toMatchObject({
      provider: 'journalctl', available: false, ready: false, missingDependencies: ['journalctl'],
    });

    const controller = new AbortController();
    const spawn = vi.fn(async (_executable: string, _args: readonly string[], options: { readonly signal?: AbortSignal }): Promise<LinuxCommandResult> => {
      await new Promise<void>((resolve: () => void): void => options.signal?.addEventListener('abort', () => resolve(), { once: true }));
      return { exitCode: null, stdout: '', stderr: 'private=never-return-this' };
    });
    const backend = new ServiceLogsBackend({
      platform: 'linux',
      resolveExecutable: async (): Promise<string> => '/usr/bin/journalctl',
      runner: new LinuxCommandRunner({ allowedExecutables: ['journalctl'], spawn }),
    });
    const pending = backend.execute({ unit: 'caddy.service' }, controller.signal);
    controller.abort();
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT', recoverable: true } });
  });

  it('converts resolver failures into sanitized unavailable results', async () => {
    const failure = new ServiceLogsBackend({
      platform: 'linux',
      resolveExecutable: async (): Promise<never> => { throw new Error('private resolver detail'); },
    });
    await expect(failure.health()).resolves.toMatchObject({ available: false, ready: false, reason: 'missing_dependencies' });
    await expect(failure.execute({ unit: 'caddy.service' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'CAPABILITY_UNAVAILABLE', message: 'Service log provider is unavailable' },
    });
  });
});
