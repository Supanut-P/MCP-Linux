import { describe, expect, it } from 'vitest';
import { DatabaseRuntimeService, type RegisteredDatabaseTarget } from './database-runtime.js';

const target: RegisteredDatabaseTarget = { id: 'pg-main', driver: 'postgresql', host: 'db.internal', port: 5432, databaseName: 'app', username: 'readonly', secretRef: 'db-pg-main', readOnly: true };
const services = {} as never;
const actor = { clientId: 'test', clientName: 'test' };

describe('registered server database runtime', () => {
  it('uses the registered target, read-only transaction and Secret Service value outside argv/results', async () => {
    let invocation: { args: readonly string[]; environment: Readonly<Record<string, string>> } | undefined;
    const runtime = new DatabaseRuntimeService(services, actor, {
      targetRegistry: { get: async (id: string): Promise<RegisteredDatabaseTarget | null> => id === target.id ? target : null },
      secrets: { get: async (): Promise<string> => 'do-not-return', set: async (): Promise<void> => undefined, delete: async (): Promise<void> => undefined },
      resolveExecutable: async (): Promise<string> => '/usr/bin/psql',
      runner: async (_executable, args, options): Promise<{ readonly exitCode: number; readonly stdout: string }> => { invocation = { args, environment: options.environment }; return { exitCode: 0, stdout: '1\talice\n2\tbob\n' }; },
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
      targetRegistry: { get: async (): Promise<RegisteredDatabaseTarget> => target },
      secrets: { get: async (): Promise<never> => { throw new Error('must not read'); }, set: async (): Promise<void> => undefined, delete: async (): Promise<void> => undefined },
      runner: async (): Promise<{ readonly exitCode: number; readonly stdout: string }> => { spawned = true; return { exitCode: 0, stdout: '' }; },
    });
    await expect(runtime.query({ targetId: 'pg-main', sql: 'DELETE FROM users' })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    await expect(runtime.query({ targetId: 'pg-main', sql: 'SELECT 1; SELECT 2' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(spawned).toBe(false);
  });

  it('adds a server-side row cap and rejects database side-effect functions', async () => {
    let query = '';
    const runtime = new DatabaseRuntimeService(services, actor, {
      targetRegistry: { get: async (): Promise<RegisteredDatabaseTarget> => target },
      secrets: { get: async (): Promise<string> => 'secret', set: async (): Promise<void> => undefined, delete: async (): Promise<void> => undefined },
      resolveExecutable: async (): Promise<string> => '/usr/bin/psql',
      runner: async (_executable, args): Promise<{ readonly exitCode: number; readonly stdout: string }> => { query = args[args.length - 1]!; return { exitCode: 0, stdout: '1\n' }; },
    });
    await runtime.query({ targetId: 'pg-main', sql: 'SELECT id FROM users', max_rows: 5 });
    expect(query).toContain('LIMIT 6');
    await expect(runtime.query({ targetId: 'pg-main', sql: 'SELECT pg_terminate_backend(1)' })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
  });

  it('fails closed for a target not explicitly registered read-only', async () => {
    const runtime = new DatabaseRuntimeService(services, actor, { targetRegistry: { get: async (): Promise<RegisteredDatabaseTarget> => ({ ...target, readOnly: false }) }, secrets: { get: async (): Promise<string> => 'secret', set: async (): Promise<void> => undefined, delete: async (): Promise<void> => undefined } });
    await expect(runtime.query({ targetId: 'pg-main', sql: 'SELECT 1' })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
  });
});
