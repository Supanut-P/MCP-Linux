import type { SqliteDatabase } from './database.js';

export type DatabaseTargetDriver = 'postgresql' | 'mysql';

export interface DatabaseTarget {
  readonly id: string;
  readonly displayName: string;
  readonly driver: DatabaseTargetDriver;
  readonly host: string;
  readonly port: number;
  readonly databaseName: string;
  readonly username: string;
  readonly readOnly: boolean;
  readonly secretRef: string;
  readonly createdAt: string;
}

export type DatabaseTargetRegistration = Omit<DatabaseTarget, 'createdAt' | 'readOnly'> & { readonly readOnly?: boolean; readonly createdAt?: string };

export class SqliteDatabaseTargetRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  public async list(): Promise<readonly DatabaseTarget[]> {
    return this.rows(this.database.connection.prepare('SELECT id, display_name, driver, host, port, database_name, username, read_only, secret_ref, created_at FROM database_targets ORDER BY created_at, id').all());
  }

  public async get(id: string): Promise<DatabaseTarget | null> {
    return this.toTarget(this.database.connection.prepare('SELECT id, display_name, driver, host, port, database_name, username, read_only, secret_ref, created_at FROM database_targets WHERE id = ?').get(id));
  }

  public async insert(target: DatabaseTargetRegistration): Promise<void> {
    validateDatabaseTarget(target);
    this.database.connection.prepare('INSERT INTO database_targets (id, display_name, driver, host, port, database_name, username, read_only, secret_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      target.id, target.displayName, target.driver, target.host, target.port, target.databaseName, target.username, target.readOnly !== false ? 1 : 0, target.secretRef, target.createdAt ?? new Date().toISOString(),
    );
  }

  public async remove(id: string): Promise<void> {
    this.database.connection.prepare('DELETE FROM database_targets WHERE id = ?').run(id);
  }

  private rows(values: readonly unknown[]): readonly DatabaseTarget[] {
    return values.flatMap((value) => { const target = this.toTarget(value); return target === null ? [] : [target]; });
  }

  private toTarget(value: unknown): DatabaseTarget | null {
    if (!isRecord(value) || typeof value.id !== 'string' || typeof value.display_name !== 'string' || typeof value.driver !== 'string'
      || (value.driver !== 'postgresql' && value.driver !== 'mysql') || typeof value.host !== 'string' || typeof value.port !== 'number'
      || typeof value.database_name !== 'string' || typeof value.username !== 'string' || typeof value.read_only !== 'number' || typeof value.secret_ref !== 'string' || typeof value.created_at !== 'string') return null;
    return { id: value.id, displayName: value.display_name, driver: value.driver, host: value.host, port: value.port, databaseName: value.database_name, username: value.username, readOnly: value.read_only === 1, secretRef: value.secret_ref, createdAt: value.created_at };
  }
}

function validateDatabaseTarget(target: DatabaseTargetRegistration): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(target.id) || target.displayName.trim().length === 0
    || !['postgresql', 'mysql'].includes(target.driver) || !/^[A-Za-z0-9_.-]{1,253}$/.test(target.host)
    || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535 || target.databaseName.trim().length === 0
    || target.username.trim().length === 0 || !/^[A-Za-z0-9._-]{1,128}$/.test(target.secretRef)) throw new Error('Database target registration is invalid');
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
