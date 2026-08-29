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
const MAX_QUERY_ROWS = 1_000;
const MAX_SERVER_QUERY_ROWS = 1_000;
const MAX_SERVER_QUERY_BYTES = 2 * 1024 * 1024;
// Server queries run with a read-only transaction, but PostgreSQL/MySQL still
// expose functions that can mutate state, acquire locks, execute code, or
// exfiltrate files.  Keep the function surface deliberately small instead of
// trying to maintain an ever-growing denylist.
const PURE_SQL_FUNCTIONS = new Set([
  'abs', 'avg', 'cast', 'coalesce', 'concat', 'convert', 'count', 'database', 'date', 'datetime',
  'ifnull', 'json_extract', 'length', 'lower', 'ltrim', 'max', 'min', 'nullif',
  'round', 'rtrim', 'strftime', 'substr', 'substring', 'sum', 'trim', 'upper',
]);

export type DatabaseTargetDriver = 'postgresql' | 'mysql';

export interface RegisteredDatabaseTarget {
  readonly id: string;
  readonly displayName?: string;
  readonly driver: DatabaseTargetDriver;
  readonly host: string;
  readonly port: number;
  readonly databaseName: string;
  readonly username: string;
  readonly readOnly?: boolean;
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

interface DatabaseResponse {
  readonly tool: 'db_inspect' | 'db_query';
  readonly status: 'ready';
  readonly available: true;
  readonly provider: DatabaseTargetDriver;
  readonly targetId: string;
  readonly rows: number;
  readonly truncated: boolean;
  readonly result: readonly Record<string, unknown>[];
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
      const boundedStatement = /^(select|with)\b/i.test(statement)
        ? `SELECT * FROM (${statement}) AS baitonghub_bounded LIMIT ${maxRows + 1}`
        : statement;
      const rows = database.value.prepare(boundedStatement).all(...bindParameters(input)) as Record<string, unknown>[];
      const bounded = boundLocalRows(rows, maxRows);
      if (!bounded.ok) return bounded;
      return ok({
        tool: 'db_query', status: 'ready', available: true,
        target: target.value,
        columns: bounded.value.rows.length === 0 ? [] : Object.keys(bounded.value.rows[0]!),
        rows: bounded.value.rows.length,
        truncated: bounded.value.truncated,
        result: bounded.value.rows,
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
      ? `SELECT 'column' AS kind, table_schema AS schema_name, table_name, column_name AS object_name, data_type, '' AS foreign_table, '' AS foreign_column FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
         UNION ALL SELECT 'index', schemaname, tablename, indexname, '', '', '' FROM pg_indexes WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
         UNION ALL SELECT 'foreign_key', kcu.table_schema, kcu.table_name, kcu.constraint_name, '', ccu.table_name, ccu.column_name FROM information_schema.key_column_usage kcu JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = kcu.constraint_name AND ccu.table_schema = kcu.table_schema WHERE kcu.table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY 2, 3, 1, 4`
      : `SELECT 'column' AS kind, table_schema AS schema_name, table_name, column_name AS object_name, data_type, '' AS foreign_table, '' AS foreign_column FROM information_schema.columns WHERE table_schema = DATABASE()
         UNION ALL SELECT 'index', table_schema, table_name, index_name, '', '', '' FROM information_schema.statistics WHERE table_schema = DATABASE()
         UNION ALL SELECT 'foreign_key', kcu.table_schema, kcu.table_name, kcu.constraint_name, '', kcu.referenced_table_name, kcu.referenced_column_name FROM information_schema.key_column_usage kcu WHERE kcu.table_schema = DATABASE() AND kcu.referenced_table_name IS NOT NULL ORDER BY 2, 3, 1, 4`;
    const result = await this.runServerQuery(target, statement, input, 'db_inspect');
    if (!result.ok) return result;
    const rows = Array.isArray(result.value.result) ? result.value.result : [];
    return ok({ ...result.value, tables: [...new Set(rows.map((row) => typeof row.table_name === 'string' ? row.table_name : undefined).filter((value): value is string => value !== undefined))], columns: rows.filter((row) => row.kind === 'column'), indexes: rows.filter((row) => row.kind === 'index'), foreignKeys: rows.filter((row) => row.kind === 'foreign_key') });
  }

  private async remoteQuery(target: RegisteredDatabaseTarget | null, input: Record<string, unknown>): Promise<Result<unknown>> {
    if (target === null) return err(appError('INVALID_INPUT', 'Registered database target was not found'));
    const statement = typeof input.sql === 'string' ? input.sql.trim() : '';
    const validation = validateServerReadQuery(statement);
    if (!validation.ok) return validation;
    return this.runServerQuery(target, statement, input, 'db_query');
  }

  private async runServerQuery(target: RegisteredDatabaseTarget, statement: string, input: Record<string, unknown>, tool: 'db_inspect' | 'db_query'): Promise<Result<DatabaseResponse>> {
    if (target.readOnly !== true) return err(appError('PERMISSION_DENIED', 'Database target is not registered as read-only', true));
    if (this.options.secrets === undefined) return err(appError('CAPABILITY_UNAVAILABLE', 'Database Secret Service is not configured', true));
    let password: string | null;
    try { password = await this.options.secrets.get(target.secretRef); } catch { return err(appError('CAPABILITY_UNAVAILABLE', 'Database secret is unavailable', true)); }
    if (password === null || password.length === 0) return err(appError('CAPABILITY_UNAVAILABLE', 'Database secret is unavailable', true));
    let executable: string | null;
    try { executable = await (this.options.resolveExecutable ?? defaultResolveExecutable)(target.driver === 'postgresql' ? 'psql' : 'mysql'); }
    catch { return err(appError('CAPABILITY_UNAVAILABLE', `Database provider ${target.driver} is unavailable`, true)); }
    if (executable === null) return err(appError('CAPABILITY_UNAVAILABLE', `Database provider ${target.driver} is unavailable`, true));
    const requestedRows = typeof input.max_rows === 'number' && Number.isFinite(input.max_rows) ? Math.min(MAX_SERVER_QUERY_ROWS, Math.max(1, Math.trunc(input.max_rows))) : MAX_SERVER_QUERY_ROWS;
    const boundedStatement = addServerLimit(statement, requestedRows);
    const query = serverTransaction(target.driver, boundedStatement);
    const args = target.driver === 'postgresql'
      ? ['--no-password', '--tuples-only', '--csv', '--host', target.host, '--port', String(target.port), '--username', target.username, '--dbname', target.databaseName, '--command', query]
      : ['--batch', '--raw', '--skip-column-names', `--host=${target.host}`, `--port=${target.port}`, `--user=${target.username}`, `--database=${target.databaseName}`, '--execute', query];
    try {
      const result = await (this.options.runner ?? runDatabaseCommand)(executable, args, { environment: target.driver === 'postgresql' ? { PGPASSWORD: password } : { MYSQL_PWD: password }, maxBytes: MAX_SERVER_QUERY_BYTES + 1 });
      if (result.exitCode !== 0 || result.truncated === true) return err(appError('CAPABILITY_UNAVAILABLE', 'Database provider query failed or exceeded the response limit', true));
      const bounded = boundServerRows(result.stdout, input.max_rows, tool === 'db_inspect');
      if (!bounded.ok) return bounded;
      return ok({ tool, status: 'ready', available: true, provider: target.driver, targetId: target.id, rows: bounded.value.rows.length, truncated: bounded.value.truncated, result: bounded.value.rows });
    } catch { return err(appError('CAPABILITY_UNAVAILABLE', 'Database provider query failed', true)); }
  }
}

function validateServerReadQuery(statement: string): Result<string> {
  if (statement.length === 0) return err(appError('INVALID_INPUT', 'db_query requires sql'));
  if (statement.includes(';') || /(--|\/\*)/.test(statement)) return err(appError('INVALID_INPUT', 'Server database queries accept one statement without comments or semicolons'));
  if (!/^(select|show|describe|desc|explain|with)\b/i.test(statement) || /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|replace|call|load|set|do|execute|merge|for\s+update|lock\s+in\s+share\s+mode|into\s+(out|dump)file)\b/i.test(statement)
    || /\b(pg_(?:terminate_backend|reload_conf|advisory_lock|try_advisory_lock)|(?:get|release)_lock|load_file|benchmark|sleep|sys_exec|xp_cmdshell|dblink|lo_import|lo_export|set_config|current_setting)\s*\(/i.test(statement)) return err(appError('PERMISSION_DENIED', 'Only one side-effect-free read-only database statement is permitted'));
  if (hasDisallowedSqlFunction(statement)) return err(appError('PERMISSION_DENIED', 'Only allowlisted side-effect-free SQL functions are permitted'));
  return ok(statement);
}

function hasDisallowedSqlFunction(statement: string): boolean {
  // Ignore quoted literals so a value containing "foo()" is not mistaken for
  // an invocation.  Qualified function names are rejected; even a currently
  // harmless schema can be shadowed by a user-defined function.
  const sql = stripSqlLiterals(statement);
  const invocation = /\b([A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)?)\s*\(/g;
  for (const match of sql.matchAll(invocation)) {
    const name = match[1]?.toLowerCase();
    if (name === undefined || name.includes('.') || !PURE_SQL_FUNCTIONS.has(name)) return true;
  }
  return false;
}

function stripSqlLiterals(statement: string): string {
  return statement
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""');
}

function serverTransaction(driver: DatabaseTargetDriver, statement: string): string {
  return driver === 'postgresql'
    ? `BEGIN; SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = '30000'; ${statement}; COMMIT;`
    : `START TRANSACTION READ ONLY; SET SESSION MAX_EXECUTION_TIME=30000; ${statement}; COMMIT;`;
}

function addServerLimit(statement: string, maxRows: number): string {
  return /^(select|with)\b/i.test(statement) ? `SELECT * FROM (${statement}) AS baitonghub_bounded LIMIT ${maxRows + 1}` : statement;
}

function boundServerRows(output: string, requested: unknown, inspection = false): Result<{ readonly rows: readonly Record<string, unknown>[]; readonly truncated: boolean }> {
  const maxRows = typeof requested === 'number' && Number.isFinite(requested) ? Math.min(MAX_SERVER_QUERY_ROWS, Math.max(1, Math.trunc(requested))) : MAX_SERVER_QUERY_ROWS;
  if (Buffer.byteLength(output, 'utf8') > MAX_SERVER_QUERY_BYTES) return err(appError('CAPABILITY_UNAVAILABLE', 'Database response exceeded the 2 MiB limit', true));
  const lines = output.split(/\r?\n/).filter((line) => line.length > 0);
  const fields = ['kind', 'schema_name', 'table_name', 'object_name', 'data_type', 'foreign_table', 'foreign_column'];
  const rows: Record<string, unknown>[] = [];
  let bytes = 0;
  for (const line of lines) {
    if (rows.length >= maxRows) break;
    const values = parseDelimitedLine(line);
    const next: Record<string, unknown> = inspection && values.length >= fields.length
      ? Object.fromEntries(fields.map((field, index) => [field, redactSensitive(values[index] ?? '')]))
      : { value: redactSensitive(line) };
    const nextBytes = Buffer.byteLength(JSON.stringify(next), 'utf8');
    if (bytes + nextBytes > MAX_SERVER_QUERY_BYTES) break;
    rows.push(next);
    bytes += nextBytes;
  }
  return ok({ rows, truncated: lines.length > rows.length });
}

function boundLocalRows(rows: readonly Record<string, unknown>[], maxRows: number): Result<{ readonly rows: readonly Record<string, unknown>[]; readonly truncated: boolean }> {
  const bounded: Record<string, unknown>[] = [];
  let bytes = 0;
  for (const row of rows) {
    if (bounded.length >= maxRows) break;
    const serialized = JSON.stringify(row);
    if (serialized === undefined) return err(appError('CAPABILITY_UNAVAILABLE', 'Database response could not be serialized', true));
    const safe = JSON.parse(redactSensitive(serialized)) as Record<string, unknown>;
    const size = Buffer.byteLength(JSON.stringify(safe), 'utf8');
    if (bytes + size > MAX_SERVER_QUERY_BYTES) return err(appError('CAPABILITY_UNAVAILABLE', 'Database response exceeded the 2 MiB limit', true));
    bounded.push(safe); bytes += size;
  }
  return ok({ rows: bounded, truncated: rows.length > bounded.length });
}

function parseDelimitedLine(line: string): string[] {
  if (line.includes('\t')) return line.split('\t');
  const values: string[] = []; let current = ''; let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (character === '"' && line[index - 1] !== '\\') { quoted = !quoted; continue; }
    if (character === ',' && !quoted) { values.push(current); current = ''; continue; }
    current += character;
  }
  values.push(current); return values;
}

function redactSensitive(value: string): string {
  return value.replace(/((?:password|passwd|token|secret|api[_-]?key|authorization)\s*[:=]\s*)([^\s,;]+)/gi, '$1[REDACTED]');
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
