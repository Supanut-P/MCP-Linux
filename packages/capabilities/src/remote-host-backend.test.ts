import { describe, expect, it } from 'vitest';
import { RemoteHostBackend, type RegisteredRemoteHost, type RemoteCommandRunner } from './remote-host-backend.js';

const host: RegisteredRemoteHost = {
  id: 'vm103', host: '192.0.2.10', port: 22, username: 'adminops', secretRef: 'ssh-vm103',
  pinnedFingerprint: 'SHA256:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN', roots: ['/srv/app'],
};

function backend(calls: string[][] = [], output = 'Linux vm103 6.8\n'): RemoteHostBackend {
  const runner: RemoteCommandRunner = async (_executable, args, options) => {
    calls.push([...args]);
    const command = args.slice(args.indexOf(`${host.username}@${host.host}`) + 1);
    return { exitCode: 0, stdout: command[0] === 'realpath' ? '/srv/app/file.txt\n' : output, stderr: '', truncated: false };
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

  it('requires a preview hash and explicit confirmation for file writes', async () => {
    const calls: string[][] = [];
    const instance = backend(calls);
    const preview = await instance.execute({ hostId: 'vm103', operation: 'file-write', path: '/srv/app/file.txt', content: 'safe', dry_run: true });
    expect(preview).toMatchObject({ ok: true, value: { dry_run: true, previewHash: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    if (!preview.ok) return;
    await expect(instance.execute({ hostId: 'vm103', operation: 'file-write', path: '/srv/app/file.txt', content: 'safe', previewHash: String(preview.value.previewHash) })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    await expect(instance.execute({ hostId: 'vm103', operation: 'file-write', path: '/srv/app/file.txt', content: 'safe', previewHash: String(preview.value.previewHash), userConfirmed: true })).resolves.toMatchObject({ ok: true });
  });
});
