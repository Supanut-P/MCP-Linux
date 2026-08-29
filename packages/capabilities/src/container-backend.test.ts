import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ContainerBackend } from './container-backend.js';
import { LinuxCommandRunner } from './linux-command-runner.js';

describe('ContainerBackend', () => {
  it('prefers Docker and uses fixed argv for list/logs', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-compose-list-'));
    const calls: unknown[] = [];
    try {
      const composeFile = path.join(root, 'compose.yaml');
      await writeFile(composeFile, 'services:\n  api:\n    image: alpine\n', 'utf8');
      const runner = new LinuxCommandRunner({ allowedExecutables: ['docker', 'podman'], spawn: async (executable, args, options): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => { calls.push({ executable, args, options }); return { exitCode: 0, stdout: 'api\n', stderr: '' }; } });
      const backend = new ContainerBackend({ platform: 'linux', allowedRootsProvider: async (): Promise<readonly string[]> => [root], resolveExecutable: async (name: string): Promise<string> => `/usr/bin/${name}`, runner });
      await expect(backend.execute({ operation: 'list', all: true, compose_file: composeFile })).resolves.toMatchObject({ ok: true, value: { provider: 'docker' } });
      await expect(backend.execute({ operation: 'logs', container: 'api', tail: 200, compose_file: composeFile })).resolves.toMatchObject({ ok: true });
      expect(calls).toEqual([
        expect.objectContaining({ executable: '/usr/bin/docker', args: ['compose', '-f', composeFile, 'ps', '--all'], options: expect.objectContaining({ shell: false }) }),
        expect.objectContaining({ executable: '/usr/bin/docker', args: ['compose', '-f', composeFile, 'logs', '--tail', '200', 'api'], options: expect.objectContaining({ shell: false }) }),
      ]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('requires confirmation for lifecycle mutations', async () => {
    const backend = new ContainerBackend({ platform: 'linux', resolveExecutable: async (): Promise<string> => '/usr/bin/docker' });
    await expect(backend.execute({ operation: 'remove', container: 'api' })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
  });

  it('rejects direct host-container operations without a registered compose file', async () => {
    const backend = new ContainerBackend({ platform: 'linux', resolveExecutable: async (): Promise<string> => '/usr/bin/docker' });
    await expect(backend.execute({ operation: 'list' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('rejects bind mounts declared inside compose files when they escape registered roots', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-compose-'));
    try {
      const composeFile = path.join(root, 'compose.yaml');
      await writeFile(composeFile, 'services:\n  api:\n    image: alpine\n    volumes:\n      - /etc:/data\n', 'utf8');
      const runner = new LinuxCommandRunner({ allowedExecutables: ['docker'], spawn: async (): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => ({ exitCode: 0, stdout: '', stderr: '' }) });
      const backend = new ContainerBackend({ platform: 'linux', allowedRootsProvider: async (): Promise<readonly string[]> => [root], resolveExecutable: async (): Promise<string> => '/usr/bin/docker', runner });
      await expect(backend.execute({ operation: 'compose-config', compose_file: composeFile })).resolves.toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
