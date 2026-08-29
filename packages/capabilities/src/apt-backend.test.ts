import { describe, expect, it, vi } from 'vitest';
import { AptBackend } from './apt-backend.js';
import { LinuxCommandRunner } from './linux-command-runner.js';

describe('AptBackend', () => {
  it('returns a simulation plan hash and requires the matching hash to mutate', async () => {
    const calls: string[][] = [];
    const backend = new AptBackend({ platform: 'linux', resolveExecutable: async (name: string): Promise<string> => `/usr/bin/${name}`, runner: new LinuxCommandRunner({ allowedExecutables: ['apt-get', 'apt-cache', 'apt', 'dpkg-query'], spawn: async (_executable: string, args: readonly string[]): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => { calls.push([...args]); return { exitCode: 0, stdout: 'The following NEW packages will be installed: jq\n', stderr: '' }; } }) });
    const plan = await backend.execute({ operation: 'install', packages: ['jq'], dry_run: true });
    expect(plan).toMatchObject({ ok: true, value: { plan_hash: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    await expect(backend.execute({ operation: 'install', packages: ['jq'], userConfirmed: true, plan_hash: '0'.repeat(64) })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('--simulate');
  });

  it('rejects invalid package names and arbitrary manager flags before spawning', async () => {
    const spawn = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const backend = new AptBackend({ platform: 'linux', resolveExecutable: async (): Promise<string> => '/usr/bin/apt-get', runner: new LinuxCommandRunner({ allowedExecutables: ['apt-get'], spawn }) });
    await expect(backend.execute({ operation: 'install', packages: ['../../etc/passwd'], userConfirmed: true })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await expect(backend.execute({ operation: 'install', packages: ['jq'], flags: ['--allow-unauthenticated'], userConfirmed: true })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await expect(backend.execute({ operation: 'install', packages: ['jq'], repositories: ['http://unsigned.invalid'], userConfirmed: true })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await expect(backend.execute({ operation: 'install', packages: ['jq'], lock_timeout: 60, userConfirmed: true })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects empty mutation/show requests and binds hashes to operation and packages', async () => {
    const calls: string[][] = [];
    const backend = new AptBackend({ platform: 'linux', resolveExecutable: async (name: string): Promise<string> => `/usr/bin/${name}`, runner: new LinuxCommandRunner({ allowedExecutables: ['apt-get', 'apt-cache'], spawn: async (_executable: string, args: readonly string[]): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => { calls.push([...args]); return { exitCode: 0, stdout: 'same preview\n', stderr: '' }; } }) });
    await expect(backend.execute({ operation: 'install', packages: [], userConfirmed: true })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await expect(backend.execute({ operation: 'show', packages: [] })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    const install = await backend.execute({ operation: 'install', packages: ['jq'], dry_run: true });
    const remove = await backend.execute({ operation: 'remove', packages: ['jq'], dry_run: true });
    const installHash = (install as { ok: true; value: { plan_hash: string } }).value.plan_hash;
    const removeHash = (remove as { ok: true; value: { plan_hash: string } }).value.plan_hash;
    const otherPackages = await backend.execute({ operation: 'install', packages: ['vim'], dry_run: true });
    const otherPackagesHash = (otherPackages as { ok: true; value: { plan_hash: string } }).value.plan_hash;
    expect(removeHash).not.toBe(installHash);
    expect(otherPackagesHash).not.toBe(installHash);
    expect(calls).toHaveLength(3);
  });
});
