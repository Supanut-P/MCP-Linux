import { describe, expect, it } from 'vitest';
import { TargetCatalogService, type TargetCatalogDatabaseRecord, type TargetCatalogRemoteHostRecord } from './target-catalog-service.js';

const database: TargetCatalogDatabaseRecord = {
  id: 'pg-main',
  displayName: 'Primary database',
  driver: 'postgresql',
  readOnly: true,
  createdAt: '2026-09-01T00:00:00.000Z',
};

const remoteHost: TargetCatalogRemoteHostRecord = {
  id: 'vm103',
  displayName: 'VM103',
  roots: ['/srv/app'],
  createdAt: '2026-09-01T00:01:00.000Z',
};

function service(
  databases: readonly TargetCatalogDatabaseRecord[] = [database],
  hosts: readonly TargetCatalogRemoteHostRecord[] = [remoteHost],
): TargetCatalogService {
  return new TargetCatalogService(
    { list: async () => databases, get: async (id) => databases.find((entry) => entry.id === id) ?? null },
    { list: async () => hosts, get: async (id) => hosts.find((entry) => entry.id === id) ?? null },
  );
}

describe('TargetCatalogService', () => {
  it('lists sanitized entries in stable kind and id order', async () => {
    const result = await service([
      { ...database, id: 'z-db' },
      { ...database, id: 'a-db' },
    ], [{ ...remoteHost, id: 'vm104' }]).list();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((entry) => entry.id)).toEqual(['a-db', 'z-db', 'vm104']);
    expect(result.value).toEqual([
      expect.objectContaining({ id: 'a-db', kind: 'database', provider: 'postgresql', readOnly: true }),
      expect.objectContaining({ id: 'z-db', kind: 'database', provider: 'postgresql', readOnly: true }),
      expect.objectContaining({ id: 'vm104', kind: 'remote-host', provider: 'openssh', readOnly: true, rootCount: 1 }),
    ]);
    for (const entry of result.value) {
      expect(entry).not.toHaveProperty('host');
      expect(entry).not.toHaveProperty('port');
      expect(entry).not.toHaveProperty('username');
      expect(entry).not.toHaveProperty('roots');
      expect(entry).not.toHaveProperty('secretRef');
      expect(entry).not.toHaveProperty('pinnedFingerprint');
    }
  });

  it('filters by target kind', async () => {
    const result = await service().list('remote-host');
    expect(result).toEqual({ ok: true, value: [expect.objectContaining({ id: 'vm103', kind: 'remote-host' })] });
  });

  it('describes a registered entry and fails closed for unknown or invalid ids', async () => {
    await expect(service().describe('database', 'pg-main')).resolves.toEqual({ ok: true, value: expect.objectContaining({ id: 'pg-main', kind: 'database' }) });
    await expect(service().describe('database', 'missing')).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await expect(service().describe('database', '../secret')).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });
});
