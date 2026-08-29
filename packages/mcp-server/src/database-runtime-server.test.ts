import { describe, expect, it } from 'vitest';
import { DatabaseRuntimeService, type RegisteredDatabaseTarget } from './database-runtime.js';

const target: RegisteredDatabaseTarget = { id: 'pg-main', driver: 'postgresql', host: 'db.internal', port: 5432, databaseName: 'app', username: 'readonly', secretRef: 'db-pg-main' };
const services = {} as never;
const actor = { clientId: 'test', clientName: 'test' };

describe('registered server database runtime', () => {
  it('uses the registered target, read-only transaction and Secret Service value outside argv/results', async () => {
    let invocation: { args: readonly string[]; environment: Readonly<Record<string, string>> } | undefined;
    const runtime = new DatabaseRuntimeService(services, actor, {
      targetRegistry: { get: async (id) => id === target.id ? target : null },
      secrets: { get: async () => 'do-not-return', set: async () => undefined, delete: async () => undefined },
      resolveExecutable: async () => '/usr/bin/psql',
      runner: async (_executable, args, options) => { invocation = { args, environment: options.environment }; return { exitCode: 0, stdout: '1\talice\n2\tbob\n' }; },
    });
    const result = await runtime.query({ targetId: 'pg-main', sql: 'SELECT id, name FROM users', max_rows: 1 });
    expect(result).toMatchObject({ ok: true, value: { provider: 'postgresql', rows: 1, truncated: true } });
    expect(invocation?.args.join(' ')).toContain('READ ONLY');
    expect(invocation?.args.join(' ')).toContain('statement_timeout');
    expect(invocation?.environment).toEqual({ PGPASSWORD: 'do-not-return' });
    expect(JSON.stringify(result)).not.toContain('do-not-return');
  });

  it('rejects writes and multi-statements before resolving secrets or spawning', async () => {
    let spawned = false;
    const runtime = new DatabaseRuntimeService(services, actor, {
      targetRegistry: { get: async () => target },
      secrets: { get: async () => { throw new Error('must not read'); }, set: async () => undefined, delete: async () => undefined },
      runner: async () => { spawned = true; return { exitCode: 0, stdout: '' }; },
    });
    await expect(runtime.query({ targetId: 'pg-main', sql: 'DELETE FROM users' })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    await expect(runtime.query({ targetId: 'pg-main', sql: 'SELECT 1; SELECT 2' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(spawned).toBe(false);
  });
});
