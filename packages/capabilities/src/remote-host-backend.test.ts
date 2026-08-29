import { describe, expect, it } from 'vitest';
import { RemoteHostBackend, type RegisteredRemoteHost, type RemoteCommandRunner } from './remote-host-backend.js';

const host: RegisteredRemoteHost = {
  id: 'vm103', host: '192.0.2.10', port: 22, username: 'adminops', secretRef: 'ssh-vm103',
  pinnedFingerprint: 'SHA256:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN', roots: ['/srv/app'],
};

function backend(calls: string[][] = [], output = 'Linux vm103 6.8\n'): RemoteHostBackend {
  const runner: RemoteCommandRunner = async (_executable, args) => {
    calls.push([...args]);
    const command = args.slice(args.indexOf(`${host.username}@${host.host}`) + 1);
    return { exitCode: 0, stdout: command[0] === 'realpath' ? '/srv/app/file.txt\n' : command[0] === 'stat' ? 'regular file\n' : output, stderr: '', truncated: false };
  };
  return new RemoteHostBackend({
    platform: 'linux', registry: { get: async (id) => id === host.id ? host : null }, secrets: { get: async () => '-----BEGIN PRIVATE KEY-----\nmock\n-----END PRIVATE KEY-----', set: async () => undefined, delete: async () => undefined }, runner,
    knownHostsPathProvider: async () => ({ path: '/tmp/known_hosts' }),
  });
}

describe('RemoteHostBackend', () => {
  it('uses a registered host and strict non-forwarding SSH options', async () => {
    const calls: string[][] = [];
    const result = await backend(calls).execute({ hostId: 'vm103', operation: 'system_info' });
    expect(result).toMatchObject({ ok: true, value: { output: 'Linux vm103 6.8\n' } });
    const ssh = calls[0]!;
    expect(ssh).toEqual(expect.arrayContaining(['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes']));
    expect(ssh).toContain('adminops@192.0.2.10');
    expect(JSON.stringify(result)).not.toContain('ssh-vm103');
  });

  it('rejects paths outside registered roots before an SSH command', async () => {
    const calls: string[][] = [];
    await expect(backend(calls).execute({ hostId: 'vm103', operation: 'file_read', path: '/etc/passwd' })).resolves.toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
    expect(calls).toHaveLength(0);
  });

  it('fails closed when pinned host verification cannot produce known_hosts', async () => {
    const instance = new RemoteHostBackend({
      platform: 'linux', registry: { get: async (): Promise<RegisteredRemoteHost> => host },
      secrets: { get: async (): Promise<string> => '-----BEGIN PRIVATE KEY-----\nmock\n-----END PRIVATE KEY-----', set: async (): Promise<void> => undefined, delete: async (): Promise<void> => undefined },
      knownHostsPathProvider: async (): Promise<{ readonly path: string }> => { throw new Error('scan failed'); },
    });
    await expect(instance.execute({ hostId: 'vm103', operation: 'system_info' })).resolves.toMatchObject({ ok: false, error: { code: 'CAPABILITY_UNAVAILABLE' } });
  });

  it('rejects secret file reads and includes host alias and workspace in mutation evidence', async () => {
    const calls: string[][] = [];
    const instance = new RemoteHostBackend({
      platform: 'linux', registry: { get: async (): Promise<RegisteredRemoteHost> => ({ ...host, displayName: 'VM103' }) },
      secrets: { get: async (): Promise<string> => '-----BEGIN PRIVATE KEY-----\nmock\n-----END PRIVATE KEY-----', set: async (): Promise<void> => undefined, delete: async (): Promise<void> => undefined },
      runner: async (_executable, args): Promise<{ readonly exitCode: number; readonly stdout: string }> => { calls.push([...args]); const command = args.slice(args.indexOf(`${host.username}@${host.host}`) + 1); return { exitCode: 0, stdout: command[0] === 'realpath' ? '/srv/app/file.txt\n' : command[0] === 'stat' ? 'regular file\n' : 'ok\n' }; },
      knownHostsPathProvider: async (): Promise<{ readonly path: string }> => ({ path: '/tmp/known_hosts' }),
    });
    await expect(instance.execute({ hostId: 'vm103', operation: 'file_read', path: '/srv/app/.env' })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    const preview = await instance.execute({ hostId: 'vm103', workspaceId: 'ws-1', operation: 'file-write', path: '/srv/app/file.txt', content: 'safe', dry_run: true });
    if (!preview.ok) throw new Error('expected preview');
    await expect(instance.execute({ hostId: 'vm103', workspaceId: 'ws-1', operation: 'file-write', path: '/srv/app/file.txt', content: 'safe', previewHash: String(preview.value.previewHash), userConfirmed: true })).resolves.toMatchObject({ ok: true, value: { hostAlias: 'VM103', workspaceId: 'ws-1' } });
    expect(calls.length).toBeGreaterThan(0);
  });

  it('requires a preview hash and explicit confirmation for file writes', async () => {
    const calls: string[][] = [];
    const instance = backend(calls);
    const preview = await instance.execute({ hostId: 'vm103', workspaceId: 'ws-1', operation: 'file-write', path: '/srv/app/file.txt', content: 'safe', dry_run: true });
    expect(preview).toMatchObject({ ok: true, value: { dry_run: true, previewHash: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    if (!preview.ok) return;
    await expect(instance.execute({ hostId: 'vm103', workspaceId: 'ws-1', operation: 'file-write', path: '/srv/app/file.txt', content: 'safe', previewHash: String(preview.value.previewHash) })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    await expect(instance.execute({ hostId: 'vm103', workspaceId: 'ws-1', operation: 'file-write', path: '/srv/app/file.txt', content: 'safe', previewHash: String(preview.value.previewHash), userConfirmed: true })).resolves.toMatchObject({ ok: true });
  });

  it('canonicalizes project commands and rejects executable symlink escapes', async () => {
    const calls: string[][] = [];
    const instance = backend(calls);
    const preview = await instance.execute({ hostId: 'vm103', workspaceId: 'ws-1', operation: 'project-command', path: '/srv/app', executable: '/srv/app/bin/run', arguments: ['--safe'], dry_run: true });
    expect(preview).toMatchObject({ ok: true, value: { dry_run: true, preview: { command: ['/srv/app/file.txt', '--safe'] } } });

    const escaping = new RemoteHostBackend({
      platform: 'linux', registry: { get: async (): Promise<RegisteredRemoteHost> => host },
      secrets: { get: async (): Promise<string> => '-----BEGIN PRIVATE KEY-----\nmock\n-----END PRIVATE KEY-----', set: async (): Promise<void> => undefined, delete: async (): Promise<void> => undefined },
      knownHostsPathProvider: async (): Promise<{ readonly path: string }> => ({ path: '/tmp/known_hosts' }),
      runner: async (_executable, args): Promise<{ readonly exitCode: number; readonly stdout: string }> => {
        calls.push([...args]);
        const command = args.slice(args.indexOf(`${host.username}@${host.host}`) + 1);
        return { exitCode: 0, stdout: command[0] === 'realpath' && command[command.length - 1] === '/srv/app/link' ? '/etc/passwd\n' : '/srv/app\n' };
      },
    });
    await expect(escaping.execute({ hostId: 'vm103', workspaceId: 'ws-1', operation: 'project-command', path: '/srv/app', executable: '/srv/app/link', dry_run: true }))
      .resolves.toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
  });

  it('canonicalizes bounded inventory and disk usage paths immediately before use', async (): Promise<void> => {
    const calls: string[][] = [];
    const runner: RemoteCommandRunner = async (_executable, args): Promise<{ readonly exitCode: number; readonly stdout: string }> => {
      calls.push([...args]);
      const command = args.slice(args.indexOf(`${host.username}@${host.host}`) + 1);
      if (command[0] === 'realpath') return { exitCode: 0, stdout: '/srv/app\n' };
      if (command[0] === 'stat') return { exitCode: 0, stdout: 'directory\n' };
      if (command[0] === 'find') return { exitCode: 0, stdout: '/srv/app/one\n/srv/app/two\n' };
      return { exitCode: 0, stdout: '12\t/srv/app\n' };
    };
    const instance = new RemoteHostBackend({
      platform: 'linux', registry: { get: async (id: string): Promise<RegisteredRemoteHost | null> => id === host.id ? host : null },
      secrets: { get: async (): Promise<string> => '-----BEGIN PRIVATE KEY-----\nmock\n-----END PRIVATE KEY-----', set: async (): Promise<void> => undefined, delete: async (): Promise<void> => undefined },
      runner,
      knownHostsPathProvider: async (): Promise<{ readonly path: string }> => ({ path: '/tmp/known_hosts' }),
    });

    await expect(instance.execute({ hostId: 'vm103', operation: 'inventory', path: '/srv/app/link' }))
      .resolves.toMatchObject({ ok: true, value: { entries: ['/srv/app/one', '/srv/app/two'], truncated: false } });
    await expect(instance.execute({ hostId: 'vm103', operation: 'disk_usage', path: '/srv/app' }))
      .resolves.toMatchObject({ ok: true, value: { output: '12\t/srv/app\n' } });
    const find = calls.find((command) => command.includes('find'));
    expect(find).toEqual(expect.arrayContaining(['find', '-P', '/srv/app', '-maxdepth', '1', '-mindepth', '1', '-print']));
    const du = calls.find((command) => command.includes('du'));
    expect(du).toEqual(expect.arrayContaining(['du', '-sx', '--bytes', '--', '/srv/app']));
  });

  it('returns checksums only for registered regular files and validates service units', async (): Promise<void> => {
    const calls: string[][] = [];
    const runner: RemoteCommandRunner = async (_executable, args): Promise<{ readonly exitCode: number; readonly stdout: string }> => {
      calls.push([...args]);
      const command = args.slice(args.indexOf(`${host.username}@${host.host}`) + 1);
      if (command[0] === 'realpath') return { exitCode: 0, stdout: '/srv/app/file.txt\n' };
      if (command[0] === 'stat') return { exitCode: 0, stdout: 'regular file\n' };
      return { exitCode: 0, stdout: 'abc  /srv/app/file.txt\n' };
    };
    const instance = new RemoteHostBackend({
      platform: 'linux', registry: { get: async (id: string): Promise<RegisteredRemoteHost | null> => id === host.id ? host : null },
      secrets: { get: async (): Promise<string> => '-----BEGIN PRIVATE KEY-----\nmock\n-----END PRIVATE KEY-----', set: async (): Promise<void> => undefined, delete: async (): Promise<void> => undefined },
      runner,
      knownHostsPathProvider: async (): Promise<{ readonly path: string }> => ({ path: '/tmp/known_hosts' }),
    });

    await expect(instance.execute({ hostId: 'vm103', operation: 'checksum', path: '/srv/app/file.txt' }))
      .resolves.toMatchObject({ ok: true, value: { output: 'abc  /srv/app/file.txt\n' } });
    await expect(instance.execute({ hostId: 'vm103', operation: 'checksum', path: '/srv/app/.env' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    await expect(instance.execute({ hostId: 'vm103', operation: 'service-status', unit: 'baitonghub.service' }))
      .resolves.toMatchObject({ ok: true, value: { output: 'abc  /srv/app/file.txt\n' } });
    await expect(instance.execute({ hostId: 'vm103', operation: 'service-status', unit: 'reboot.service' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(calls.some((command) => command.includes('sha256sum'))).toBe(true);
    expect(calls.some((command) => command.includes('systemctl'))).toBe(true);
  });
});
