import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DependencyAuditBackend } from './dependency-audit-backend.js';
import { LinuxCommandRunner } from './linux-command-runner.js';

describe('DependencyAuditBackend', () => {
  it('detects pnpm lockfiles, runs the fixed audit command, and normalizes findings', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-audit-'));
    try {
      await writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
      const calls: unknown[] = [];
      const runner = new LinuxCommandRunner({ allowedExecutables: ['pnpm'], spawn: async (executable, args, options): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => { calls.push({ executable, args, options }); return { exitCode: 1, stdout: JSON.stringify({ vulnerabilities: { lodash: { severity: 'high', version: '4.17.0', via: [{ source: 'GHSA-test' }] } } }), stderr: '' }; } });
      const backend = new DependencyAuditBackend({ platform: 'linux', allowedRootsProvider: async (): Promise<readonly string[]> => [root], resolveExecutable: async (): Promise<string> => '/usr/bin/pnpm', runner });
      await expect(backend.execute({ operation: 'audit', path: root })).resolves.toMatchObject({ ok: true, value: { provider: 'pnpm', packages: [{ package: 'lodash', installed: '4.17.0', severity: 'high', advisory: 'GHSA-test', source: 'pnpm' }] } });
      expect(calls[0]).toMatchObject({ executable: '/usr/bin/pnpm', args: ['audit', '--json'], options: expect.objectContaining({ shell: false, cwd: root }) });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('normalizes pnpm advisory maps and Cargo vulnerability lists', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-audit-shapes-'));
    try {
      await writeFile(path.join(root, 'Cargo.lock'), '[[package]]\nname = "demo"\n', 'utf8');
      let output = JSON.stringify({ vulnerabilities: { list: [{ package: { name: 'demo', version: '1.0.0' }, advisory: { id: 1234, severity: 'medium' }, versions: { patched: ['>=1.0.1'] } }] } });
      const runner = new LinuxCommandRunner({ allowedExecutables: ['cargo', 'pnpm'], spawn: async (): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => ({ exitCode: 0, stdout: output, stderr: '' }) });
      const backend = new DependencyAuditBackend({ platform: 'linux', allowedRootsProvider: async (): Promise<readonly string[]> => [root], resolveExecutable: async (name: string): Promise<string> => `/usr/bin/${name}`, runner });
      await expect(backend.execute({ path: root })).resolves.toMatchObject({ ok: true, value: { provider: 'cargo', packages: [{ package: 'demo', installed: '1.0.0', fixed: '>=1.0.1', advisory: '1234', source: 'cargo' }] } });
      await writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8');
      output = JSON.stringify({ advisories: { 'GHSA-1': { module_name: 'left-pad', vulnerable_versions: '<1.3.0', patched_versions: '>=1.3.0', severity: 'high' } } });
      await expect(backend.execute({ path: root })).resolves.toMatchObject({ ok: true, value: { provider: 'pnpm', packages: [{ package: 'left-pad', installed: '<1.3.0', fixed: '>=1.3.0', advisory: 'GHSA-1' }] } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
