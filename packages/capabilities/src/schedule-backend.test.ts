import { describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ScheduleBackend } from './schedule-backend.js';
import { LinuxCommandRunner } from './linux-command-runner.js';

describe('ScheduleBackend', () => {
  it('plans and creates only user units with an executable in a registered root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-schedule-root-'));
    const config = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-schedule-config-'));
    try {
      const executable = path.join(root, 'job');
      await writeFile(executable, '#!/bin/sh\n');
      await chmod(executable, 0o755);
      const backend = new ScheduleBackend({ platform: 'linux', configHome: config, allowedRootsProvider: async (): Promise<readonly string[]> => [root], packagedCliPath: executable, resolveExecutable: async (): Promise<string> => '/usr/bin/systemctl', runner: new LinuxCommandRunner({ allowedExecutables: ['systemctl'], spawn: async (): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => ({ exitCode: 0, stdout: '', stderr: '' }) }) });
      const plan = await backend.execute({ operation: 'plan', unit: 'demo', executable, arguments: ['--safe'], onCalendar: '*-*-* 03:00:00' });
      expect(plan).toMatchObject({ ok: true, value: { plan_hash: expect.stringMatching(/^[a-f0-9]{64}$/) } });
      await expect(backend.execute({ operation: 'create', unit: 'demo', executable, arguments: ['--safe'], onCalendar: '*-*-* 03:00:00', userConfirmed: true, plan_hash: (plan as { ok: true; value: { plan_hash: string } }).value.plan_hash })).resolves.toMatchObject({ ok: true, value: { created: ['demo.service', 'demo.timer'] } });
      await expect(backend.execute({ operation: 'create', unit: 'rescue', executable, onCalendar: 'daily', userConfirmed: true, plan_hash: '0'.repeat(64) })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    } finally { await rm(root, { recursive: true, force: true }); await rm(config, { recursive: true, force: true }); }
  });

  it('rejects system-level cron style inputs and paths outside roots', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-schedule-root-'));
    const config = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-schedule-config-'));
    try {
      const backend = new ScheduleBackend({ platform: 'linux', configHome: config, allowedRootsProvider: async (): Promise<readonly string[]> => [root] });
      await expect(backend.execute({ operation: 'plan', unit: 'cron', executable: '/usr/bin/cron', onCalendar: '* * * * *' })).resolves.toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
      await expect(backend.execute({ operation: 'plan', unit: 'cron', executable: '/usr/bin/cron', onCalendar: 'daily', cronFile: '/etc/cron.d/job' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    } finally { await rm(root, { recursive: true, force: true }); await rm(config, { recursive: true, force: true }); }
  });

  it('rejects registered-root files that are not executable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-schedule-root-'));
    const config = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-schedule-config-'));
    try {
      const executable = path.join(root, 'not-executable');
      await writeFile(executable, 'text\n', { mode: 0o644 });
      const backend = new ScheduleBackend({ platform: 'linux', configHome: config, allowedRootsProvider: async (): Promise<readonly string[]> => [root] });
      await expect(backend.execute({ operation: 'plan', unit: 'demo', executable, onCalendar: 'daily' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    } finally { await rm(root, { recursive: true, force: true }); await rm(config, { recursive: true, force: true }); }
  });

  it('rejects control-character executable paths and escapes systemd specifiers', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-schedule-root-'));
    const config = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-schedule-config-'));
    try {
      const backend = new ScheduleBackend({ platform: 'linux', configHome: config, allowedRootsProvider: async (): Promise<readonly string[]> => [root], packagedCliPath: '/opt/baitonghub-linux-mcp/job%name' });
      await expect(backend.execute({ operation: 'plan', unit: 'demo', executable: path.join(root, 'job\n%bad'), onCalendar: 'daily' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      const plan = await backend.execute({ operation: 'plan', unit: 'demo', executable: '/opt/baitonghub-linux-mcp/job%name', arguments: ['--token=%n'], onCalendar: 'daily' });
      expect(plan).toMatchObject({ ok: true, value: { service: expect.stringContaining('job%%name'), timer: expect.any(String) } });
      expect(JSON.stringify(plan)).toContain('--token=%%n');
    } finally { await rm(root, { recursive: true, force: true }); await rm(config, { recursive: true, force: true }); }
  });
});
