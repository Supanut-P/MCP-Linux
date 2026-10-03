import { describe, expect, it, vi } from 'vitest';
import { SqliteDatabase, SqliteFleetCatalogRepository } from '@baitonghub-linux-mcp/storage';
import { permissionProfiles } from '@baitonghub-linux-mcp/permissions';
import type { Workspace, WorkspaceRepository } from '@baitonghub-linux-mcp/workspace';
import { FleetCatalogService } from './fleet-catalog-service.js';

const actor = { clientId: 'owner', clientName: 'fixture', sessionId: 'one' };
type FixtureHost = { id: string; host: string; port: number; username: string; secretRef: string; pinnedFingerprint: string; roots: string[]; createdAt: string };
function fixture(): { db: SqliteDatabase; service: FleetCatalogService; hosts: Map<string, FixtureHost>; audit: ReturnType<typeof vi.fn>; setWorkspace(value: Workspace | null): void; setProfile(value: typeof permissionProfiles.full): void } {
  const db = new SqliteDatabase(':memory:');
  const host = { id: 'h1', host: '127.0.0.1', port: 22, username: 'test', secretRef: 'fixture', pinnedFingerprint: 'SHA256:fixture', roots: ['/srv'], createdAt: '2026-10-03T00:00:00Z' };
  const hosts = new Map([['h1', host], ['h2', { ...host, id: 'h2' }]]);
  let workspace: Workspace | null = { id: 'ws', displayName: 'fixture', rootPath: '/repo', realRootPath: '/repo', createdAt: host.createdAt };
  const workspaces: WorkspaceRepository = { async get(id) { return id === 'ws' ? workspace : null; }, async list() { return workspace ? [workspace] : []; }, async insert() {}, async delete() {} };
  let profile = permissionProfiles.full;
  const audit = vi.fn(async () => undefined);
  const service = new FleetCatalogService(new SqliteFleetCatalogRepository(db), { async get(id): Promise<FixtureHost | null> { return hosts.get(id) ?? null; } }, workspaces, () => profile, audit);
  return { db, service, hosts, audit, setWorkspace(value: Workspace | null): void { workspace = value; }, setProfile(value: typeof profile): void { profile = value; } };
}

describe('owner-scoped registered fleet catalog', () => {
  it('rejects destination-option mappings before retaining them', async () => {
    const f = fixture();
    try {
      for (const serviceUnit of ['-Hother.service', '-Mcontainer.service']) expect(await f.service.execute(actor, { operation: 'put_mapping', id: 'option', hostId: 'h1', serviceUnit, workspaceId: 'ws', expectedRevision: 0 })).toMatchObject({ ok: false });
      expect(await f.service.execute(actor, { operation: 'list' })).toMatchObject({ ok: true, value: { entries: [] } });
    } finally { f.db.close(); }
  });
  it('resolves mixed group members and detects replacement/removal without dispatch', async () => {
    const f = fixture();
    try {
      expect(await f.service.execute(actor, { operation: 'put_group', id: 'g', hostIds: ['h1', 'h2'], expectedRevision: 0 })).toMatchObject({ ok: true, value: { revision: 1 } });
      f.hosts.set('h1', { ...f.hosts.get('h1')!, port: 2222 }); f.hosts.delete('h2');
      expect(await f.service.execute(actor, { operation: 'resolve', id: 'g' })).toMatchObject({ ok: true, value: { resolvedHostIds: [], summary: { resolved: 0, stale: 1, unavailable: 1 } } });
      expect(await f.service.execute({ ...actor, clientId: 'other' }, { operation: 'resolve', id: 'g' })).toMatchObject({ ok: false });
      expect(await f.service.execute({ ...actor, sessionId: 'new' }, { operation: 'list' })).toMatchObject({ ok: true, value: { entries: [{ id: 'g' }] } });
      expect(f.audit).toHaveBeenCalled();
    } finally { f.db.close(); }
  });
  it('withholds mappings when workspace binding changes or disappears', async () => {
    const f = fixture();
    try {
      const put = { operation: 'put_mapping', id: 'm', hostId: 'h1', serviceUnit: 'app.service', workspaceId: 'ws', expectedRevision: 0 };
      expect(await f.service.execute(actor, put)).toMatchObject({ ok: true });
      expect(await f.service.execute(actor, { operation: 'resolve', id: 'm' })).toMatchObject({ ok: true, value: { mapping: { hostId: 'h1', workspaceId: 'ws', serviceUnit: 'app.service' } } });
      f.setWorkspace({ id: 'ws', displayName: 'new', rootPath: '/changed', realRootPath: '/changed', createdAt: '2026-10-03T00:00:00Z' });
      const stale = await f.service.execute(actor, { operation: 'resolve', id: 'm' });
      expect(stale).toMatchObject({ ok: true, value: { workspaceStatus: 'stale', resolvedHostIds: [] } });
      if (stale.ok) expect(stale.value).not.toHaveProperty('mapping');
      expect(await f.service.execute(actor, { ...put, expectedRevision: 1 })).toMatchObject({ ok: true, value: { revision: 2 } });
      f.setWorkspace(null);
      expect(await f.service.execute(actor, { operation: 'resolve', id: 'm' })).toMatchObject({ ok: true, value: { workspaceStatus: 'unavailable', resolvedHostIds: [] } });
    } finally { f.db.close(); }
  });
  it('rejects owner spoofing, arbitrary inputs, corrupt payload and stale revision', async () => {
    const f = fixture();
    try {
      const put = { operation: 'put_group', id: 'g', hostIds: ['h1'], expectedRevision: 0 };
      for (const extra of [{ ownerKey: 'fake' }, { host: 'other' }, { command: 'id' }]) expect(await f.service.execute(actor, { ...put, ...extra })).toMatchObject({ ok: false });
      expect(await f.service.execute(actor, { ...put, hostIds: ['h1', 'h1'] })).toMatchObject({ ok: false });
      expect(await f.service.execute(actor, { ...put, hostIds: ['missing'] })).toMatchObject({ ok: false });
      expect(await f.service.execute(actor, put)).toMatchObject({ ok: true });
      expect(await f.service.execute(actor, put)).toMatchObject({ ok: false });
      f.db.connection.prepare('UPDATE fleet_catalog SET payload_json = ?').run(JSON.stringify({ hosts: [{ hostId: 'h1', fingerprint: 'invalid' }] }));
      expect(await f.service.execute(actor, { operation: 'list' })).toMatchObject({ ok: false });
    } finally { f.db.close(); }
  });
  it('checks current READ/WRITE policy, confirmation and cancellation', async () => {
    const f = fixture();
    try {
      const put = { operation: 'put_group', id: 'g', hostIds: ['h1'], expectedRevision: 0 };
      f.setProfile(permissionProfiles.safe);
      expect(await f.service.execute(actor, put)).toMatchObject({ ok: false });
      expect(await f.service.execute(actor, { operation: 'list' })).toMatchObject({ ok: true });
      f.setProfile(permissionProfiles.balanced);
      const result = await f.service.execute(actor, put);
      if (!result.ok && result.error.code === 'PERMISSION_REQUIRED') expect(await f.service.execute(actor, { ...put, userConfirmed: true })).toMatchObject({ ok: true });
      const controller = new AbortController(); controller.abort();
      expect(await f.service.execute(actor, { operation: 'list' }, controller.signal)).toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    } finally { f.db.close(); }
  });
  it('rechecks permission after registry lookup before committing', async () => {
    const f = fixture();
    try {
      const host = f.hosts.get('h1')!;
      vi.spyOn(f.hosts, 'get').mockImplementation(() => { f.setProfile(permissionProfiles.safe); return host; });
      expect(await f.service.execute(actor, { operation: 'put_group', id: 'g', hostIds: ['h1'], expectedRevision: 0 })).toMatchObject({ ok: false });
      expect(await f.service.execute(actor, { operation: 'list' })).toMatchObject({ ok: true, value: { entries: [] } });
    } finally { f.db.close(); }
  });
  it('withholds results after audit revokes READ or cancels', async () => {
    const f = fixture();
    try {
      f.audit.mockImplementation(async () => { f.setProfile({ ...permissionProfiles.full, defaults: { ...permissionProfiles.full.defaults, READ: 'DENY' } }); });
      expect(await f.service.execute(actor, { operation: 'list' })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
      f.setProfile(permissionProfiles.full);
      const controller = new AbortController();
      f.audit.mockImplementation(async () => { controller.abort(); });
      expect(await f.service.execute(actor, { operation: 'list' }, controller.signal)).toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    } finally { f.db.close(); }
  });
});
