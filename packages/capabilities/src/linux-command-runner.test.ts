import { describe, expect, it, vi } from 'vitest';
import { LinuxCommandRunner } from './linux-command-runner.js';

describe('LinuxCommandRunner', () => {
  it('executes a fixed executable with argv and never enables a shell', async () => {
    const spawn = vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'ok', stderr: '' });
    const runner = new LinuxCommandRunner({ spawn, allowedExecutables: ['/usr/bin/journalctl'] });

    await expect(runner.run('/usr/bin/journalctl', ['--no-pager', '-n', '20'])).resolves.toEqual({
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      truncated: false,
    });
    expect(spawn).toHaveBeenCalledWith('/usr/bin/journalctl', ['--no-pager', '-n', '20'], expect.objectContaining({ shell: false }));
  });

  it('rejects an executable outside the allowlist before spawning', async () => {
    const spawn = vi.fn();
    const runner = new LinuxCommandRunner({ spawn, allowedExecutables: ['journalctl'] });

    await expect(runner.run('/usr/bin/sh', ['-c', 'echo unsafe'])).rejects.toThrow('allowlisted');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('normalizes omitted truncation from injected runners', async () => {
    const runner = new LinuxCommandRunner({
      allowedExecutables: ['journalctl'],
      spawn: async (): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => ({ exitCode: 0, stdout: 'ok', stderr: '' }),
    });

    await expect(runner.run('journalctl', [])).resolves.toMatchObject({ truncated: false });
  });
});
