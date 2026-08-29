import { describe, expect, it, vi } from 'vitest';
import { LinuxCommandRunner } from './linux-command-runner.js';
import { SystemdBackend } from './systemd-backend.js';

function backend(calls: Array<{ executable: string; args: readonly string[] }> = []): SystemdBackend {
  const runner = new LinuxCommandRunner({
    allowedExecutables: ['systemctl'],
    spawn: async (executable: string, args: readonly string[]): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => { calls.push({ executable, args }); return { exitCode: 0, stdout: 'Id=demo.service\nActiveState=active\n', stderr: '' }; },
  });
  return new SystemdBackend({ platform: 'linux', resolveExecutable: async () => '/usr/bin/systemctl', runner });
}

describe('SystemdBackend', () => {
  it('uses fixed show properties and validates units', async () => {
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const service = backend(calls);
    await expect(service.execute({ operation: 'status', unit: 'demo.service' })).resolves.toMatchObject({ ok: true, value: { properties: { ActiveState: 'active' } } });
    expect(calls[0]?.args.join(' ')).toContain('show --no-pager --property=Id,Names,Description,LoadState,ActiveState,SubState,UnitFileState,FragmentPath,MainPID,ExecMainStartTimestamp demo.service');
    await expect(service.execute({ operation: 'restart', unit: '../../etc/passwd.service', userConfirmed: true })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await expect(service.execute({ operation: 'restart', unit: 'reboot.service', userConfirmed: true })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('does not spawn an unconfirmed mutation', async () => {
    const spawn = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const service = new SystemdBackend({ platform: 'linux', resolveExecutable: async (): Promise<string> => '/usr/bin/systemctl', runner: new LinuxCommandRunner({ allowedExecutables: ['systemctl'], spawn }) });
    await expect(service.execute({ operation: 'restart', unit: 'demo.service' })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('executes confirmed mutations through argv-only runner', async () => {
    const calls: Array<{ executable: string; args: readonly string[]; shell: false }> = [];
    const service = new SystemdBackend({
      platform: 'linux',
      resolveExecutable: async (): Promise<string> => '/usr/bin/systemctl',
      runner: new LinuxCommandRunner({
        allowedExecutables: ['systemctl'],
        spawn: async (executable: string, args: readonly string[], options: { readonly shell: false }): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => { calls.push({ executable, args, shell: options.shell }); return { exitCode: 0, stdout: '', stderr: '' }; },
      }),
    });
    await expect(service.execute({ operation: 'restart', unit: 'demo.service', userConfirmed: true })).resolves.toMatchObject({ ok: true });
    expect(calls).toEqual([{ executable: '/usr/bin/systemctl', args: ['restart', 'demo.service'], shell: false }]);
  });
});
