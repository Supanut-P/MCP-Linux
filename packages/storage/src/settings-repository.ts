import type { SqliteDatabase } from './database.js';

export class SqliteSettingsRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  public get(key: string): string | null {
    const row = this.database.connection.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (typeof row !== 'object' || row === null || !('value' in row) || typeof row.value !== 'string') return null;
    return row.value;
  }

  public set(key: string, value: string): void {
    this.database.connection.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, value);
  }

  public delete(key: string): void {
    this.database.connection.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }
}
