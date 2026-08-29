import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteDatabase } from './database.js';
import { SqliteDatabaseTargetRepository } from './database-target-repository.js';
import { SqliteRemoteHostRepository } from './remote-host-repository.js';

describe('v0.5 registered target repositories', () => {
  it('persists database targets without secret values', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'baitonghub-v05-storage-'));
    const database = new SqliteDatabase(path.join(dir, 'state.sqlite'));
    try {
      const repository = new SqliteDatabaseTargetRepository(database);
      await repository.insert({ id: 'pg-main', displayName: 'Main PostgreSQL', driver: 'postgresql', host: 'db.internal', port: 5432, databaseName: 'app', username: 'readonly', secretRef: 'db-pg-main' });
      await expect(repository.get('pg-main')).resolves.toMatchObject({ driver: 'postgresql', secretRef: 'db-pg-main', port: 5432 });
      expect(database.connection.prepare('SELECT secret_ref FROM database_targets').all()).toEqual([{ secret_ref: 'db-pg-main' }]);
      await expect(repository.insert({ id: 'bad', displayName: 'bad', driver: 'mysql', host: 'db', port: 3306, databaseName: 'app', username: 'u', secretRef: 'not a secret' })).rejects.toThrow();
    } finally { database.close(); }
  });

  it('persists pinned remote fingerprints and registered roots only', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'baitonghub-v05-storage-'));
    const database = new SqliteDatabase(path.join(dir, 'state.sqlite'));
    try {
      const repository = new SqliteRemoteHostRepository(database);
      await repository.insert({ id: 'vm103', displayName: 'VM103', host: '192.168.1.39', port: 22, username: 'adminops', secretRef: 'ssh-vm103', pinnedFingerprint: 'SHA256:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN=', roots: ['/home/adminops/project'] });
      await expect(repository.list()).resolves.toMatchObject([{ id: 'vm103', pinnedFingerprint: expect.stringContaining('SHA256:'), roots: ['/home/adminops/project'] }]);
      await expect(repository.insert({ id: 'bad', displayName: 'bad', host: 'host', port: 22, username: 'u', secretRef: 'ssh', pinnedFingerprint: 'ssh-rsa AAAA', roots: ['/'] })).rejects.toThrow();
    } finally { database.close(); }
  });
});
