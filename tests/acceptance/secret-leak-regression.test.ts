import { describe, expect, it } from 'vitest';
import { DatabaseRuntimeService, type RegisteredDatabaseTarget } from '@baitonghub-linux-mcp/mcp-server';
import { RemoteHostBackend, type RegisteredRemoteHost } from '../../packages/capabilities/src/remote-host-backend.js';

const dbTarget: RegisteredDatabaseTarget = { id: 'db-canary', driver: 'postgresql', host: 'db.internal', port: 5432, databaseName: 'app', username: 'readonly', secretRef: 'db-canary', readOnly: true };
const sshHost: RegisteredRemoteHost = { id: 'host-canary', displayName: 'Canary host', host: '192.0.2.10', port: 22, username: 'admin', secretRef: 'ssh-canary', pinnedFingerprint: 'SHA256:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN', roots: ['/srv/app'] };
const secrets = { get: async (name: string): Promise<string> => name === 'db-canary' ? 'database-password-canary' : '-----BEGIN PRIVATE KEY-----\nmock\n-----END PRIVATE KEY-----', set: async (): Promise<void> => undefined, delete: async (): Promise<void> => undefined };

describe('secret leak regression', () => {
  it('redacts database output and never returns the database secret', async () => {
    const runtime = new DatabaseRuntimeService({} as never, { clientId: 'test', clientName: 'test' }, {
      targetRegistry: { get: async (): Promise<RegisteredDatabaseTarget> => dbTarget }, secrets,
      resolveExecutable: async (): Promise<string> => '/usr/bin/psql',
      runner: async (): Promise<{ readonly exitCode: number; readonly stdout: string }> => ({ exitCode: 0, stdout: 'password=database-password-canary\n' }),
    });
    const result = await runtime.query({ targetId: 'db-canary', sql: 'SELECT password FROM users' });
    expect(JSON.stringify(result)).not.toContain('database-password-canary');
  });

  it('redacts remote command output and never returns SSH credential material', async () => {
    const runtime = new RemoteHostBackend({ platform: 'linux', registry: { get: async (): Promise<RegisteredRemoteHost> => sshHost }, secrets, knownHostsPathProvider: async (): Promise<{ readonly path: string }> => ({ path: '/tmp/known_hosts' }), runner: async (): Promise<{ readonly exitCode: number; readonly stdout: string }> => ({ exitCode: 0, stdout: 'token=ssh-password-canary\n' }) });
    const result = await runtime.execute({ hostId: 'host-canary', operation: 'system_info' });
    expect(JSON.stringify(result)).not.toContain('ssh-password-canary');
    expect(JSON.stringify(result)).not.toContain('PRIVATE KEY');
  });
});
