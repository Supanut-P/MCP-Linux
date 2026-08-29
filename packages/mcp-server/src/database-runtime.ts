import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import type { FileActor } from '@baitonghub-linux-mcp/application';
import type { SecretStore } from '@baitonghub-linux-mcp/shared';
import type { McpApplicationServices } from './tools/tool-types.js';

/**
 * Wave 6 read-only SQLite runtime behind `db_inspect` and `db_query`.
 * Targets must be SQLite files inside a registered workspace, connections
 * open with `readOnly: true`, and queries accept exactly one SELECT/PRAGMA
 * statement with bounded rows.
 */

const SQLITE_EXTENSIONS = new Set(['.db', '.sqlite', '.sqlite3']);
const MAX_QUERY_ROWS = 500;
const MAX_SERVER_QUERY_ROWS = 1_000;
const MAX_SERVER_QUERY_BYTES = 2 * 1024 * 1024;

export type DatabaseTargetDriver = 'postgresql' | 'mysql';

export interface RegisteredDatabaseTarget {
  readonly id: string;
  readonly displayName?: string;
  readonly driver: DatabaseTargetDriver;
  readonly host: string;
  readonly port: number;
  readonly databaseName: string;
  readonly username: string;
  /** A Secret Service reference. The value itself must never cross this boundary. */
  readonly secretRef: string;
}

export interface DatabaseTargetRegistry {
  get(id: string): Promise<RegisteredDatabaseTarget | null>;
  list?(): Promise<readonly RegisteredDatabaseTarget[]>;
}

export interface DatabaseCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr?: string;
  readonly truncated?: boolean;
}

export type DatabaseCommandRunner = (executable: string, args: readonly string[], options: {
  readonly environment: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly maxBytes: number;
}) => Promise<DatabaseCommandResult>;

export interface DatabaseRuntimeOptions {
  readonly targetRegistry?: DatabaseTargetRegistry;
  readonly secrets?: SecretStore;
  readonly resolveExecutable?: (name: string) => Promise<string | null>;
  readonly runner?: DatabaseCommandRunner;
}

export class DatabaseRuntimeService {
  private readonly options: DatabaseRuntimeOptions;

  public constructor(
    private readonly services: McpApplicationServices,
    private readonly actor: FileActor,
    options: DatabaseRuntimeOptions = {},
  ) { this.options = options; }

  public async inspect(input: Record<string, unknown>): Promise<Result<unknown>> {
    const remoteTarget = await this.remoteTarget(input);
    if (remoteTarget !== undefined) return this.remoteInspect(remoteTarget, input);
    if (input.targetId !== undefined || input.target_id !== undefined) return err(appError('INVALID_INPUT', 'Registered database target was not found'));
    const target = await this.resolveTarget(input);
    if (!target.ok) return target;
    const database = this.openReadonly(target.value);
    if (!database.ok) return database;
    try {
      const objects = database.value.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all() as Record<string, unknown>[];
      const tables: Record<string, unknown>[] = [];
      for (const entry of objects.filter((candidate) => candidate.type === 'table')) {
        const name = String(entry.name);
        const columns = database.value.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all() as Record<string, unknown>[];
        const rowCount = safeCount(database.value, name);
        tables.push({ name, rowCount, columns: columns.map((column) => ({ name: String(column.name), type: column.type === null ? null : String(column.type), notNull: column.notnull === 1, primaryKey: column.pk === 1 })) });
      }
      return ok({
        tool: 'db_inspect', status: 'ready', available: true,
        target: target.value,
        sqliteVersion: sqliteVersion(database.value),
        tables,
        views: objects.filter((candidate) => candidate.type === 'view').map((candidate) => String(candidate.name)),
        indexes: objects.filter((candidate) => candidate.type === 'index').map((candidate) => ({ name: String(candidate.name), table: String(candidate.tbl_name) })),
      });
    } finally {
      database.value.close();
    }
  }

  public async query(input: Record<string, unknown>): Promise<Result<unknown>> {
    const remoteTarget = await this.remoteTarget(input);
    if (remoteTarget !== undefined) return this.remoteQuery(remoteTarget, input);
    if (input.targetId !== undefined || input.target_id !== undefined) return err(appError('INVALID_INPUT', 'Registered database target was not found'));
    const target = await this.resolveTarget(input);
    if (!target.ok) return target;
    const statement = typeof input.sql === 'string' ? input.sql.trim() : '';
    if (statement.length === 0) return err(appError('INVALID_INPUT', 'db_query requires sql'));
    if (statement.includes(';')) return err(appError('INVALID_INPUT', 'db_query accepts exactly one statement'));
    const readOnly = /^(select|pragma|with)\b/i.test(statement);
    if (!readOnly) return err(appError('PERMISSION_DENIED', 'db_query only accepts a single SELECT, PRAGMA, or WITH...SELECT statement'));
    if (/^(pragma)\b/i.test(statement) && /(=\s*\S|insert|update|delete|attach|journal_mode)/i.test(statement)) {
      return err(appError('PERMISSION_DENIED', 'PRAGMA writes are not permitted'));
    }
    const maxRows = typeof input.max_rows === 'number' ? Math.min(MAX_QUERY_ROWS, Math.max(1, Math.trunc(input.max_rows))) : MAX_QUERY_ROWS;

    const database = this.openReadonly(target.value);
    if (!database.ok) return database;
    try {
      const rows = database.value.prepare(statement).all(...bindParameters(input)) as Record<string, unknown>[];
      const bounded = rows.slice(0, maxRows);
      return ok({
        tool: 'db_query', status: 'ready', available: true,
        target: target.value,
        columns: bounded.length === 0 ? [] : Object.keys(bounded[0]!),
        rows: bounded.length,
        truncated: rows.length > bounded.length,
        result: bounded,
      });
    } catch (error) {
      return err(appError('INVALID_INPUT', `Query failed: ${error instanceof Error ? error.message : String(error)}`));
    } finally {
      database.value.close();
    }
  }

  private openReadonly(file: string): Result<DatabaseSync> {
    try {
      return ok(new DatabaseSync(file, { readOnly: true, timeout: 5_000 }));
    } catch (error) {
      return err(appError('INVALID_INPUT', `Database could not be opened read-only: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  private async resolveTarget(input: Record<string, unknown>): Promise<Result<string>> {
    const workspaceId = readTrimmed(input.workspaceId);
    const requested = readTrimmed(input.target ?? input.path ?? input.database);
    if (workspaceId === undefined || requested === undefined) return err(appError('INVALID_INPUT', 'db tools require workspaceId and target'));
    if (SQLITE_EXTENSIONS.has(path.extname(requested).toLowerCase()) === false) {
      return err(appError('INVALID_INPUT', `Database target must end with ${[...SQLITE_EXTENSIONS].join(', ')}`));
    }
    const root = await this.workspaceRoot(workspaceId);
    if (!root.ok) return root;
    let canonicalRoot: string;
    try {
      canonicalRoot = path.normalize(await realpath(root.value));
    } catch {
      return err(appError('WORKSPACE_NOT_FOUND', 'Workspace root could not be resolved'));
    }
    const resolved = path.isAbsolute(requested) ? path.normalize(requested) : path.join(canonicalRoot, requested);
    if (!isWithin(canonicalRoot, resolved)) return err(appError('PATH_OUTSIDE_WORKSPACE', 'Database target must stay inside the registered workspace'));
    if (!existsSync(resolved)) return err(appError('FILE_NOT_FOUND', `Database target was not found: ${resolved}`));
    try {
      const canonicalTarget = path.normalize(await realpath(resolved));
      return isWithin(canonicalRoot, canonicalTarget)
        ? ok(canonicalTarget)
        : err(appError('PATH_OUTSIDE_WORKSPACE', 'Database target resolves outside the registered workspace'));
    } catch {
      return err(appError('FILE_NOT_FOUND', `Database target could not be resolved: ${resolved}`));
    }
  }

  private async workspaceRoot(workspaceId: string): Promise<Result<string>> {
    const workspaceInfo = this.services.workspaceInfo;
    if (workspaceInfo === undefined) return err(appError('WORKSPACE_NOT_FOUND', 'Workspace service is not configured'));
    const info = await workspaceInfo.info(this.actor, workspaceId);
    if (!info.ok) return info;
    const rootPath = typeof (info.value as { realRootPath?: unknown }).realRootPath === 'string'
      ? (info.value as { realRootPath: string }).realRootPath
      : undefined;
    return rootPath === undefined
      ? err(appError('INTERNAL_ERROR', 'Workspace root could not be resolved', true))
      : ok(path.normalize(rootPath));
  }

  private async remoteTarget(input: Record<string, unknown>): Promise<RegisteredDatabaseTarget | null | undefined> {
    const requested = readTrimmed(input.targetId ?? input.target_id);
    if (requested === undefined) return undefined;
    if (this.options.targetRegistry === undefined) return null;
    try { return await this.options.targetRegistry.get(requested); } catch { return null; }
  }

  private async remoteInspect(target: RegisteredDatabaseTarget | null, input: Record<string, unknown>): Promise<Result<unknown>> {
    if (target === null) return err(appError('INVALID_INPUT', 'Registered database target was not found'));
    const statement = target.driver === 'postgresql'
      ? 'SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN (\'pg_catalog\', \'information_schema\') ORDER BY table_schema, table_name'
      : 'SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_schema, table_name';
    return this.runServerQuery(target, statement, input, 'db_inspect');
  }

  private async remoteQuery(target: RegisteredDatabaseTarget | null, input: Record<string, unknown>): Promise<Result<unknown>> {
    if (target === null) return err(appError('INVALID_INPUT', 'Registered database target was not found'));
    const statement = typeof input.sql === 'string' ? input.sql.trim() : '';
    const validation = validateServerReadQuery(statement);
    if (!validation.ok) return validation;
    return this.runServerQuery(target, statement, input, 'db_query');
  }

  private async runServerQuery(target: RegisteredDatabaseTarget, statement: string, input: Record<string, unknown>, tool: 'db_inspect' | 'db_query'): Promise<Result<unknown>> {
    if (this.options.secrets === undefined) return err(appError('CAPABILITY_UNAVAILABLE', 'Database Secret Service is not configured', true));
    let password: string | null;
    try { password = await this.options.secrets.get(target.secretRef); } catch { return err(appError('CAPABILITY_UNAVAILABLE', 'Database secret is unavailable', true)); }
    if (password === null || password.length === 0) return err(appError('CAPABILITY_UNAVAILABLE', 'Database secret is unavailable', true));
    const executable = await (this.options.resolveExecutable ?? defaultResolveExecutable)(target.driver === 'postgresql' ? 'psql' : 'mysql');
    if (executable === null) return err(appError('CAPABILITY_UNAVAILABLE', `Database provider ${target.driver} is unavailable`, true));
    const query = serverTransaction(target.driver, statement);
    const args = target.driver === 'postgresql'
      ? ['--no-password', '--tuples-only', '--csv', '--host', target.host, '--port', String(target.port), '--username', target.username, '--dbname', target.databaseName, '--command', query]
      : ['--batch', '--raw', '--skip-column-names', `--host=${target.host}`, `--port=${target.port}`, `--user=${target.username}`, `--database=${target.databaseName}`, '--execute', query];
    try {
      const result = await (this.options.runner ?? runDatabaseCommand)(executable, args, { environment: target.driver === 'postgresql' ? { PGPASSWORD: password } : { MYSQL_PWD: password }, maxBytes: MAX_SERVER_QUERY_BYTES + 1 });
      if (result.exitCode !== 0 || result.truncated === true) return err(appError('CAPABILITY_UNAVAILABLE', 'Database provider query failed or exceeded the response limit', true));
      const bounded = boundServerRows(result.stdout, input.max_rows);
      if (!bounded.ok) return bounded;
      return ok({ tool, status: 'ready', available: true, provider: target.driver, targetId: target.id, rows: bounded.value.rows.length, truncated: bounded.value.truncated, result: bounded.value.rows });
    } catch { return err(appError('CAPABILITY_UNAVAILABLE', 'Database provider query failed', true)); }
  }
}

function validateServerReadQuery(statement: string): Result<string> {
  if (statement.length === 0) return err(appError('INVALID_INPUT', 'db_query requires sql'));
  if (statement.includes(';') || /(--|\/\*)/.test(statement)) return err(appError('INVALID_INPUT', 'Server database queries accept one statement without comments or semicolons'));
  if (!/^(select|show|describe|desc|explain|with)\b/i.test(statement) || /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|replace|call|load|set|do|execute|merge)\b/i.test(statement)) return err(appError('PERMISSION_DENIED', 'Only one read-only database statement is permitted'));
  return ok(statement);
}

function serverTransaction(driver: DatabaseTargetDriver, statement: string): string {
  return driver === 'postgresql'
    ? `BEGIN; SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = '30000'; ${statement}; COMMIT;`
    : `START TRANSACTION READ ONLY; SET SESSION MAX_EXECUTION_TIME=30000; ${statement}; COMMIT;`;
}

function boundServerRows(output: string, requested: unknown): Result<{ readonly rows: readonly Record<string, unknown>[]; readonly truncated: boolean }> {
  const maxRows = typeof requested === 'number' && Number.isFinite(requested) ? Math.min(MAX_SERVER_QUERY_ROWS, Math.max(1, Math.trunc(requested))) : MAX_SERVER_QUERY_ROWS;
  if (Buffer.byteLength(output, 'utf8') > MAX_SERVER_QUERY_BYTES) return err(appError('CAPABILITY_UNAVAILABLE', 'Database response exceeded the 2 MiB limit', true));
  const lines = output.split(/\r?\n/).filter((line) => line.length > 0);
  const rows: Record<string, unknown>[] = [];
  let bytes = 0;
  for (const line of lines) {
    if (rows.length >= maxRows) break;
    const next = { value: line };
    const nextBytes = Buffer.byteLength(JSON.stringify(next), 'utf8');
    if (bytes + nextBytes > MAX_SERVER_QUERY_BYTES) break;
    rows.push(next);
    bytes += nextBytes;
  }
  return ok({ rows, truncated: lines.length > rows.length });
}

async function defaultResolveExecutable(name: string): Promise<string | null> {
  const { access } = await import('node:fs/promises');
  const { delimiter } = await import('node:path');
  for (const entry of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = path.join(entry, name);
    try { await access(candidate); return candidate; } catch { /* continue */ }
  }
  return null;
}

function runDatabaseCommand(executable: string, args: readonly string[], options: { readonly environment: Readonly<Record<string, string>>; readonly signal?: AbortSignal; readonly maxBytes: number }): Promise<DatabaseCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], { shell: false, env: { ...process.env, ...options.environment }, stdio: ['ignore', 'pipe', 'ignore'], signal: options.signal });
    let stdout = ''; let bytes = 0; let truncated = false;
    child.stdout.on('data', (chunk: Buffer) => { const remaining = options.maxBytes - bytes; const slice = chunk.subarray(0, Math.max(0, remaining)); stdout += slice.toString('utf8'); bytes += slice.byteLength; if (slice.byteLength < chunk.byteLength) truncated = true; });
    child.once('error', reject);
    child.once('close', (exitCode) => resolve({ exitCode, stdout, truncated }));
  });
}

function safeCount(database: DatabaseSync, table: string): number | null {
  try {
    const row = database.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get() as { count?: unknown } | undefined;
    const count = row?.count;
    return typeof count === 'number' ? count : null;
  } catch {
    return null;
  }
}

function sqliteVersion(database: DatabaseSync): string {
  const row = database.prepare('SELECT sqlite_version() AS version').get() as { version?: unknown } | undefined;
  return typeof row?.version === 'string' ? row.version : 'unknown';
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function bindParameters(input: Record<string, unknown>): (null | number | bigint | string)[] {
  const parameters = input.parameters ?? input.params;
  return Array.isArray(parameters) ? parameters.map((value): null | number | bigint | string => {
    if (value === null || typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string') return value;
    return JSON.stringify(value);
  }) : [];
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function readTrimmed(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
