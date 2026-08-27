import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LinuxCommandRunner } from './linux-command-runner.js';
import { LinuxObservabilityBackend } from './linux-observability-backend.js';

function backend(
  capability: 'system_info' | 'journal' | 'network',
  outputs: Readonly<Record<string, { readonly exitCode: number | null; readonly stdout: string; readonly stderr: string }>> = {},
  resolveExecutable: (name: string) => Promise<string | null> = async (name: string): Promise<string> => `/usr/bin/${name}`,
): LinuxObservabilityBackend {
  const runner = new LinuxCommandRunner({
    allowedExecutables: ['df', 'journalctl', 'ip', 'ss'],
    spawn: async (executable: string): Promise<{ readonly exitCode: number | null; readonly stdout: string; readonly stderr: string }> => outputs[executable.split('/').pop() ?? ''] ?? { exitCode: 0, stdout: '', stderr: '' },
  });
  return new LinuxObservabilityBackend(capability, {
    platform: 'linux',
    environment: {},
    resolveExecutable,
    runner,
  });
}

describe('LinuxObservabilityBackend', () => {
  it('returns a Linux summary without invoking a shell', async () => {
    await expect(backend('system_info').execute({ operation: 'summary' })).resolves.toMatchObject({
      ok: true,
      value: { platform: 'linux', cpu: { logical_count: expect.any(Number) }, memory: { total_bytes: expect.any(Number) } },
    });
  });

  it('parses bounded disk output', async () => {
    const service = backend('system_info', {
      df: { exitCode: 0, stderr: '', stdout: 'Filesystem Type 1024-blocks Used Available Capacity Mounted on\n/dev/vda1 ext4 100 40 60 40% /\n' },
    });
    await expect(service.execute({ operation: 'disk', path: '/' })).resolves.toMatchObject({
      ok: true,
      value: { mounts: [{ source: '/dev/vda1', filesystem: 'ext4', target: '/' }], truncated: false },
    });
  });

  it('rejects invalid systemd units before spawning journalctl', async () => {
    const service = backend('journal', {}, async () => { throw new Error('resolver should not run'); });
    await expect(service.execute({ unit: '../../etc/passwd.service' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('redacts credential-shaped journal fields and never returns stderr', async () => {
    const service = backend('journal', {
      journalctl: { exitCode: 0, stderr: 'password=never-return-this', stdout: '{"MESSAGE":"token=never-return-this","_SYSTEMD_UNIT":"caddy.service"}\n' },
    });
    const result = await service.execute({ unit: 'caddy.service', lines: 100 });
    expect(result).toMatchObject({ ok: true, value: { entries: [{ _SYSTEMD_UNIT: 'caddy.service', MESSAGE: 'token=[redacted]' }] } });
    expect(JSON.stringify(result)).not.toContain('never-return-this');
  });

  it('reads network interfaces and enforces listener row limits', async () => {
    const service = backend('network', {
      ip: { exitCode: 0, stderr: '', stdout: '[{"ifname":"eth0","operstate":"UP"}]' },
      ss: { exitCode: 0, stderr: '', stdout: 'LISTEN 0 128 127.0.0.1:18765 0.0.0.0:* users:(("node",pid=1,fd=2))\n' },
    });
    await expect(service.execute({ operation: 'interfaces' })).resolves.toMatchObject({ ok: true, value: { interfaces: [{ ifname: 'eth0' }] } });
    await expect(service.execute({ operation: 'listeners', limit: 1 })).resolves.toMatchObject({ ok: true, value: { listeners: [{ local_address: '127.0.0.1:18765' }] } });
  });

  it('redacts credential-shaped process arguments before returning procfs data', async () => {
    const procRoot = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-proc-'));
    try {
      await mkdir(path.join(procRoot, '42'));
      await writeFile(path.join(procRoot, '42', 'status'), 'Name: worker\nVmRSS: 12 kB\n', 'utf8');
      await writeFile(path.join(procRoot, '42', 'cmdline'), 'worker\0--token=never-return-this\0', 'utf8');
      const service = new LinuxObservabilityBackend('system_info', { platform: 'linux', procRoot });
      const result = await service.execute({ operation: 'processes', limit: 10 });
      expect(result).toMatchObject({ ok: true, value: { processes: [{ pid: 42, command: 'worker --token=[redacted]' }] } });
      expect(JSON.stringify(result)).not.toContain('never-return-this');
    } finally {
      await rm(procRoot, { recursive: true, force: true });
    }
  });

  it('maps cancellation to PROCESS_TIMEOUT without exposing provider output', async () => {
    const controller = new AbortController();
    const spawn = vi.fn(async (_executable: string, _args: readonly string[], options: { readonly signal?: AbortSignal }): Promise<{ readonly exitCode: null; readonly stdout: string; readonly stderr: string }> => {
      await new Promise<void>((resolve) => options.signal?.addEventListener('abort', () => resolve(), { once: true }));
      return { exitCode: null, stdout: '', stderr: 'password=private' };
    });
    const service = new LinuxObservabilityBackend('journal', {
      platform: 'linux',
      resolveExecutable: async (name: string): Promise<string> => `/usr/bin/${name}`,
      runner: new LinuxCommandRunner({ allowedExecutables: ['journalctl'], spawn }),
    });
    const pending = service.execute({ unit: 'caddy.service' }, controller.signal);
    controller.abort();
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
  });
});
