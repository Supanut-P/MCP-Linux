import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteDatabase } from './database.js';
import { SqliteFleetCatalogRepository } from './fleet-catalog-repository.js';

const roots: string[] = [];
const databases: SqliteDatabase[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) { try { db.close(); } catch { /* already closed for reopen */ } }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(): Promise<{ file: string; db: SqliteDatabase; repo: SqliteFleetCatalogRepository }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fleet-catalog-')); roots.push(root);
  const file = path.join(root, 'catalog.sqlite'); const db = new SqliteDatabase(file); databases.push(db);
  return { file, db, repo: new SqliteFleetCatalogRepository(db) };
}

const ownerA = 'a'.repeat(64);
const ownerB = 'b'.repeat(64);
const now = '2026-10-03T00:00:00.000Z';

describe('SqliteFleetCatalogRepository', () => {
  it('fences two independent connections holding the same observed revision', async () => {
    const { file, repo } = await setup();
    expect(repo.put(ownerA, 'shared', 'group', {}, 0, now)).not.toBeNull();
    const otherDb = new SqliteDatabase(file); databases.push(otherDb);
    const other = new SqliteFleetCatalogRepository(otherDb);
    const firstRevision = repo.get(ownerA, 'shared')!.revision;
    const secondRevision = other.get(ownerA, 'shared')!.revision;
    expect(repo.put(ownerA, 'shared', 'group', { writer: 'first' }, firstRevision, now)).toMatchObject({ revision: 2 });
    expect(other.put(ownerA, 'shared', 'group', { writer: 'second' }, secondRevision, now)).toBeNull();
    expect(other.get(ownerA, 'shared')!.payload).toEqual({ writer: 'first' });
  });
  it('fails closed before projecting oversized persisted strings', async () => {
    const { db, repo } = await setup();
    expect(repo.put(ownerA, 'bounded', 'group', {}, 0, now)).not.toBeNull();
    db.connection.prepare('UPDATE fleet_catalog SET payload_json=?').run(JSON.stringify({ large: 'x'.repeat(32 * 1024) }));
    expect(() => repo.get(ownerA, 'bounded')).toThrow();
    expect(() => repo.list(ownerA)).toThrow();
    expect(() => repo.put(ownerA, 'bounded', 'group', {}, 1, now)).toThrow();
    db.connection.prepare('UPDATE fleet_catalog SET payload_json=?,created_at=?,revision=?').run('{}', now, 'x'.repeat(32 * 1024));
    expect(() => repo.get(ownerA, 'bounded')).toThrow();
    expect(() => repo.list(ownerA)).toThrow();
    expect(() => repo.put(ownerA, 'bounded', 'group', {}, 1, now)).toThrow();
    db.connection.prepare('UPDATE fleet_catalog SET revision=1,created_at=?').run('x'.repeat(32 * 1024));
    expect(() => repo.get(ownerA, 'bounded')).toThrow();
    expect(() => repo.list(ownerA)).toThrow();
    db.connection.prepare('UPDATE fleet_catalog SET created_at=?,id=?').run(now, 'x'.repeat(32 * 1024));
    expect(() => repo.list(ownerA)).toThrow();
  });
  it('isolates owners and persists records across database reopen', async () => {
    const { file, db, repo } = await setup();
    const created = repo.put(ownerA, 'group-1', 'group', { hostIds: ['host-1'] }, 0, now);
    expect(created).toMatchObject({ id: 'group-1', ownerKey: ownerA, kind: 'group', revision: 1, createdAt: now, updatedAt: now });
    expect(repo.get(ownerB, 'group-1')).toBeNull();
    expect(repo.list(ownerB)).toEqual([]);
    db.close();
    const reopened = new SqliteDatabase(file); databases.push(reopened); const persisted = new SqliteFleetCatalogRepository(reopened);
    expect(persisted.get(ownerA, 'group-1')).toEqual(created);
    expect(persisted.list(ownerA)).toEqual([created]);
  });

  it('uses optimistic revisions for create, update, and remove', async () => {
    const { repo } = await setup();
    expect(repo.put(ownerA, 'map-1', 'mapping', { hostId: 'host-1' }, 1, now)).toBeNull();
    expect(repo.put(ownerA, 'map-1', 'mapping', { hostId: 'host-1' }, 0, now)?.revision).toBe(1);
    expect(repo.put(ownerA, 'map-1', 'mapping', { hostId: 'host-2' }, 0, now)).toBeNull();
    expect(repo.put(ownerA, 'map-1', 'mapping', { hostId: 'host-2' }, 1, '2026-10-03T01:00:00.000Z')).toMatchObject({ revision: 2, createdAt: now, updatedAt: '2026-10-03T01:00:00.000Z' });
    expect(repo.remove(ownerB, 'map-1', 2)).toBe(false);
    expect(repo.remove(ownerA, 'map-1', 1)).toBe(false);
    expect(repo.remove(ownerA, 'map-1', 2)).toBe(true);
    expect(repo.get(ownerA, 'map-1')).toBeNull();
  });

  it('enforces owner and global quotas transactionally', async () => {
    const { repo } = await setup();
    for (let i = 0; i < 32; i++) expect(repo.put(ownerA, `g-${i}`, 'group', {}, 0, now)).not.toBeNull();
    expect(repo.put(ownerA, 'g-over', 'group', {}, 0, now)).toBeNull();
    for (let i = 0; i < 128; i++) expect(repo.put(ownerA, `m-${i}`, 'mapping', {}, 0, now)).not.toBeNull();
    expect(repo.list(ownerA)).toHaveLength(160);
    expect(repo.put(ownerA, 'm-over', 'mapping', {}, 0, now)).toBeNull();
    expect(repo.put(ownerA, 'g-0', 'mapping', {}, 1, now)).toBeNull();
    for (let ownerIndex = 0; ownerIndex < 7; ownerIndex++) {
      const owner = ownerIndex === 6 ? 'c'.repeat(64) : ownerIndex.toString(16).padStart(64, '0');
      const count = ownerIndex === 6 ? 96 : 128;
      for (let i = 0; i < count; i++) expect(repo.put(owner, `m-${i}`, 'mapping', {}, 0, now)).not.toBeNull();
    }
    expect(repo.put('d'.repeat(64), 'global-over', 'mapping', {}, 0, now)).toBeNull();
  });

  it('rejects invalid input and fails closed on corrupt persisted rows', async () => {
    const { db, repo } = await setup();
    expect(repo.put('actor', 'id', 'group', {}, 0, now)).toBeNull();
    expect(repo.put(ownerA, 'bad id', 'group', {}, 0, now)).toBeNull();
    expect(repo.put(ownerA, 'g', 'group', [], 0, now)).toBeNull();
    expect(repo.put(ownerA, 'g', 'group', { text: 'x'.repeat(16 * 1024) }, 0, now)).toBeNull();
    expect(repo.put(ownerA, 'g', 'group', {}, 0, 'bad-date')).toBeNull();
    expect(repo.put(ownerA, 'g', 'group', {}, -1, now)).toBeNull();
    expect(repo.put(ownerA, 'g', 'group', {}, 0, now)).not.toBeNull();
    db.connection.prepare('UPDATE fleet_catalog SET revision=? WHERE owner_key=? AND id=?').run(Number.MAX_SAFE_INTEGER, ownerA, 'g');
    expect(repo.put(ownerA, 'g', 'group', {}, Number.MAX_SAFE_INTEGER, now)).toBeNull();
    db.connection.prepare('UPDATE fleet_catalog SET payload_json=? WHERE owner_key=? AND id=?').run('{broken', ownerA, 'g');
    expect(() => repo.get(ownerA, 'g')).toThrow('Fleet catalog data is corrupt');
    expect(() => repo.list(ownerA)).toThrow('Fleet catalog data is corrupt');
  });
});
