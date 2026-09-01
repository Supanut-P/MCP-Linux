import type { SqliteDatabase } from './database.js';

export interface RemoteHost {
  readonly id: string;
  readonly displayName: string;
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly secretRef: string;
  readonly pinnedFingerprint: string;
  readonly roots: readonly string[];
  readonly createdAt: string;
}

export type RemoteHostRegistration = Omit<RemoteHost, 'createdAt'> & { readonly createdAt?: string };

export class SqliteRemoteHostRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  public async list(): Promise<readonly RemoteHost[]> {
    return this.rows(this.database.connection.prepare('SELECT id, display_name, host, port, username, secret_ref, pinned_fingerprint, roots_json, created_at FROM remote_hosts ORDER BY created_at, id').all());
  }

  public async get(id: string): Promise<RemoteHost | null> {
    return this.toHost(this.database.connection.prepare('SELECT id, display_name, host, port, username, secret_ref, pinned_fingerprint, roots_json, created_at FROM remote_hosts WHERE id = ?').get(id));
  }

  public async insert(host: RemoteHostRegistration): Promise<void> {
    validateRemoteHost(host);
    this.database.connection.prepare('INSERT INTO remote_hosts (id, display_name, host, port, username, secret_ref, pinned_fingerprint, roots_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      host.id, host.displayName, host.host, host.port, host.username, host.secretRef, host.pinnedFingerprint, JSON.stringify(host.roots), host.createdAt ?? new Date().toISOString(),
    );
  }

  public async replace(host: RemoteHostRegistration): Promise<void> {
    validateRemoteHost(host);
    const result = this.database.connection.prepare(
      'UPDATE remote_hosts SET display_name = ?, host = ?, port = ?, username = ?, secret_ref = ?, pinned_fingerprint = ?, roots_json = ? WHERE id = ?',
    ).run(host.displayName, host.host, host.port, host.username, host.secretRef, host.pinnedFingerprint, JSON.stringify(host.roots), host.id);
    if (Number(result.changes) !== 1) throw new Error('Remote host was not found');
  }

  public async remove(id: string): Promise<boolean> {
    validateTargetId(id);
    return Number(this.database.connection.prepare('DELETE FROM remote_hosts WHERE id = ?').run(id).changes) === 1;
  }

  private rows(values: readonly unknown[]): readonly RemoteHost[] { return values.flatMap((value) => { const host = this.toHost(value); return host === null ? [] : [host]; }); }

  private toHost(value: unknown): RemoteHost | null {
    if (!isRecord(value) || typeof value.id !== 'string' || typeof value.display_name !== 'string' || typeof value.host !== 'string'
      || typeof value.port !== 'number' || typeof value.username !== 'string' || typeof value.secret_ref !== 'string'
      || typeof value.pinned_fingerprint !== 'string' || typeof value.roots_json !== 'string' || typeof value.created_at !== 'string') return null;
    let roots: unknown;
    try { roots = JSON.parse(value.roots_json); } catch { return null; }
    if (!Array.isArray(roots) || roots.some((root) => typeof root !== 'string')) return null;
    return { id: value.id, displayName: value.display_name, host: value.host, port: value.port, username: value.username, secretRef: value.secret_ref, pinnedFingerprint: value.pinned_fingerprint, roots, createdAt: value.created_at };
  }
}

function validateRemoteHost(host: RemoteHostRegistration): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(host.id) || host.displayName.trim().length === 0
    || !/^[A-Za-z0-9_.-]{1,253}$/.test(host.host) || !Number.isInteger(host.port) || host.port < 1 || host.port > 65535
    || host.username.trim().length === 0 || !/^[A-Za-z0-9._-]{1,128}$/.test(host.secretRef)
    || !/^SHA256:[A-Za-z0-9+/=]{20,}$/.test(host.pinnedFingerprint) || host.roots.length === 0 || host.roots.some((root) => !root.startsWith('/'))) throw new Error('Remote host registration is invalid');
}

function validateTargetId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id)) throw new Error('Remote host id is invalid');
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
