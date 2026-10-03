import type { DatabaseSync } from 'node:sqlite';
import type { SqliteDatabase } from './database.js';

export interface FleetCatalogRecord {
  readonly id: string;
  readonly ownerKey: string;
  readonly kind: 'group' | 'mapping';
  readonly payload: unknown;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface FleetCatalogRow {
  readonly id: string;
  readonly owner_key: string;
  readonly kind: string;
  readonly payload_json: string;
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
}

const OWNER = /^[a-fA-F0-9]{64}$/;
const ID = /^[\x21-\x7e]{1,128}$/;
const KINDS = new Set(['group', 'mapping']);
const MAX_PAYLOAD_BYTES = 16 * 1024;
// Preserve corrupt rows as null projections so they fail validation, rather than
// transferring unbounded stored strings into JavaScript or silently filtering.
const BOUNDED_COLUMNS = [['id', 128], ['owner_key', 64], ['kind', 7], ['payload_json', MAX_PAYLOAD_BYTES], ['created_at', 64], ['updated_at', 64]]
  .map(([field, bytes]) => `CASE WHEN typeof(${field}) = 'text' AND length(CAST(${field} AS BLOB)) <= ${bytes} THEN ${field} ELSE NULL END AS ${field}`)
  .concat(`CASE WHEN typeof(revision) = 'integer' AND revision BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER} THEN revision ELSE NULL END AS revision`).join(', ');

/** Bounded, owner-scoped persistence for fleet catalog metadata. */
export class SqliteFleetCatalogRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  public get(ownerKey: string, id: string): FleetCatalogRecord | null {
    if (!validOwner(ownerKey) || !validId(id)) return null;
    const row = this.database.connection.prepare(`SELECT ${BOUNDED_COLUMNS} FROM fleet_catalog WHERE owner_key=? AND id=?`).get(ownerKey, id) as FleetCatalogRow | undefined;
    return row === undefined ? null : decode(row);
  }

  public list(ownerKey: string): FleetCatalogRecord[] {
    if (!validOwner(ownerKey)) return [];
    const rows = this.database.connection.prepare(`SELECT ${BOUNDED_COLUMNS} FROM fleet_catalog WHERE owner_key=? ORDER BY id LIMIT 161`).all(ownerKey) as unknown as FleetCatalogRow[];
    if (rows.length > 160) throw new Error('Fleet catalog data is corrupt');
    return rows.map(decode);
  }

  public put(ownerKey: string, id: string, kind: 'group' | 'mapping', payload: unknown, expectedRevision: number, now: string): FleetCatalogRecord | null {
    if (!validOwner(ownerKey) || !validId(id) || !KINDS.has(kind) || !validRevision(expectedRevision) || !validTimestamp(now) || !validPayload(payload)) return null;
    const payloadJson = JSON.stringify(payload);
    if (typeof payloadJson !== 'string' || Buffer.byteLength(payloadJson, 'utf8') > MAX_PAYLOAD_BYTES) return null;
    return this.transaction((db) => {
      const existing = db.prepare(`SELECT ${BOUNDED_COLUMNS} FROM fleet_catalog WHERE owner_key=? AND id=?`).get(ownerKey, id) as FleetCatalogRow | undefined;
      if (existing === undefined) {
        if (expectedRevision !== 0) return null;
        const ownerCount = db.prepare('SELECT COUNT(*) AS n FROM fleet_catalog WHERE owner_key=? AND kind=?').get(ownerKey, kind) as { n: number | bigint };
        const totalCount = db.prepare('SELECT COUNT(*) AS n FROM fleet_catalog').get() as { n: number | bigint };
        if (Number(ownerCount.n) >= (kind === 'group' ? 32 : 128) || Number(totalCount.n) >= 1024) return null;
        db.prepare('INSERT INTO fleet_catalog(owner_key,id,kind,payload_json,revision,created_at,updated_at) VALUES(?,?,?,?,1,?,?)').run(ownerKey, id, kind, payloadJson, now, now);
        return { id, ownerKey, kind, payload, revision: 1, createdAt: now, updatedAt: now };
      }
      const record = decode(existing);
      if (record.revision !== expectedRevision || expectedRevision >= Number.MAX_SAFE_INTEGER) return null;
      if (record.kind !== kind) {
        const count = db.prepare('SELECT COUNT(*) AS n FROM fleet_catalog WHERE owner_key=? AND kind=?').get(ownerKey, kind) as { n: number | bigint };
        if (Number(count.n) >= (kind === 'group' ? 32 : 128)) return null;
      }
      db.prepare('UPDATE fleet_catalog SET kind=?,payload_json=?,revision=revision+1,updated_at=? WHERE owner_key=? AND id=? AND revision=?').run(kind, payloadJson, now, ownerKey, id, expectedRevision);
      return { ...record, kind, payload, revision: expectedRevision + 1, updatedAt: now };
    });
  }

  public remove(ownerKey: string, id: string, expectedRevision: number): boolean {
    if (!validOwner(ownerKey) || !validId(id) || !validRevision(expectedRevision) || expectedRevision === 0) return false;
    return this.transaction((db) => Number(db.prepare('DELETE FROM fleet_catalog WHERE owner_key=? AND id=? AND revision=?').run(ownerKey, id, expectedRevision).changes) === 1);
  }

  private transaction<T>(work: (db: DatabaseSync) => T): T {
    const db = this.database.connection;
    db.exec('BEGIN IMMEDIATE;');
    try { const value = work(db); db.exec('COMMIT;'); return value; }
    catch (error) { db.exec('ROLLBACK;'); throw error; }
  }
}

function decode(row: FleetCatalogRow): FleetCatalogRecord {
  if (typeof row.payload_json !== 'string' || Buffer.byteLength(row.payload_json, 'utf8') > MAX_PAYLOAD_BYTES) throw new Error('Fleet catalog data is corrupt');
  let payload: unknown;
  try { payload = JSON.parse(row.payload_json) as unknown; } catch { throw new Error('Fleet catalog data is corrupt'); }
  if (!validOwner(row.owner_key) || !validId(row.id) || !KINDS.has(row.kind) || !validRevision(row.revision) || row.revision < 1 || !validTimestamp(row.created_at) || !validTimestamp(row.updated_at) || !validPayload(payload) || Buffer.byteLength(row.payload_json, 'utf8') > MAX_PAYLOAD_BYTES) throw new Error('Fleet catalog data is corrupt');
  return { id: row.id, ownerKey: row.owner_key, kind: row.kind as 'group' | 'mapping', payload, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at };
}

function validOwner(value: string): boolean { return typeof value === 'string' && OWNER.test(value); }
function validId(value: string): boolean { return typeof value === 'string' && ID.test(value); }
function validRevision(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
function validTimestamp(value: string): boolean { return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value)); }
function validPayload(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  try { const json = JSON.stringify(value); return typeof json === 'string' && Buffer.byteLength(json, 'utf8') <= MAX_PAYLOAD_BYTES; } catch { return false; }
}
