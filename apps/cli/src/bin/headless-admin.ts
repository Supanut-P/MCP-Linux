import { createServer } from 'node:net';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { resolveBaitonghubLinuxMcpPaths } from '@baitonghub-linux-mcp/shared';
import { SqliteDatabase, SqliteDatabaseTargetRepository, SqliteRemoteHostRepository, SqliteWorkspaceRepository, type DatabaseTargetDriver } from '@baitonghub-linux-mcp/storage';
import { WorkspaceService } from '@baitonghub-linux-mcp/workspace';

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  if (command === 'status') return status();
  if (command === 'doctor') return doctor();
  if (command === 'workspace' && args[1] === 'list') return listWorkspaces();
  if (command === 'workspace' && args[1] === 'add' && args[2] !== undefined) return addWorkspace(args[2]);
  if (command === 'database' && args[1] === 'list') return listDatabases();
  if (command === 'database' && args[1] === 'add') return addDatabase(args.slice(2));
  if (command === 'database' && args[1] === 'replace') return replaceDatabase(args.slice(2));
  if (command === 'database' && args[1] === 'remove') return removeDatabase(args.slice(2));
  if (command === 'remote-host' && args[1] === 'list') return listRemoteHosts();
  if (command === 'remote-host' && args[1] === 'add') return addRemoteHost(args.slice(2));
  if (command === 'remote-host' && args[1] === 'replace') return replaceRemoteHost(args.slice(2));
  if (command === 'remote-host' && args[1] === 'remove') return removeRemoteHost(args.slice(2));
  process.stderr.write('Usage: baitonghub-linux-mcp status | doctor | workspace add <path> | workspace list | database list | database add <id> <driver> <host> <port> <database> <username> <secret-ref> | database replace <id> <driver> <host> <port> <database> <username> <secret-ref> | database remove <id> --confirm <id> | remote-host list | remote-host add <id> <host> <port> <username> <secret-ref> <fingerprint> <root[,root...]> | remote-host replace <id> <host> <port> <username> <secret-ref> <fingerprint> <root[,root...]> | remote-host remove <id> --confirm <id>\n');
  process.exitCode = 2;
}

function openDatabase(): { readonly dataPath: string; readonly database: SqliteDatabase; readonly workspaces: SqliteWorkspaceRepository } {
  const dataPath = resolveBaitonghubLinuxMcpPaths(process.env, process.platform).dataPath;
  mkdirSync(dataPath, { recursive: true });
  const database = new SqliteDatabase(path.join(dataPath, 'baitonghub-linux-mcp.sqlite'), { backupDirectory: path.join(dataPath, 'backups') });
  return { dataPath, database, workspaces: new SqliteWorkspaceRepository(database) };
}

function openRegistries(): { readonly database: SqliteDatabase; readonly targets: SqliteDatabaseTargetRepository; readonly hosts: SqliteRemoteHostRepository } {
  const dataPath = resolveBaitonghubLinuxMcpPaths(process.env, process.platform).dataPath;
  mkdirSync(dataPath, { recursive: true });
  const database = new SqliteDatabase(path.join(dataPath, 'baitonghub-linux-mcp.sqlite'), { backupDirectory: path.join(dataPath, 'backups') });
  return { database, targets: new SqliteDatabaseTargetRepository(database), hosts: new SqliteRemoteHostRepository(database) };
}

async function status(): Promise<void> {
  const opened = openDatabase();
  try { process.stdout.write(`workspaces: ${(await opened.workspaces.list()).length}\n`); }
  finally { opened.database.close(); }
}

async function listWorkspaces(): Promise<void> {
  const opened = openDatabase();
  try {
    const workspaces = await opened.workspaces.list();
    if (workspaces.length === 0) process.stdout.write('No workspaces configured\n');
    else for (const workspace of workspaces) process.stdout.write(`${workspace.id}\t${workspace.displayName}\t${workspace.realRootPath}\n`);
  } finally { opened.database.close(); }
}

async function addWorkspace(rootPath: string): Promise<void> {
  const opened = openDatabase();
  try {
    const result = await new WorkspaceService(opened.workspaces).add(path.basename(path.resolve(rootPath)) || 'Workspace', rootPath);
    if (!result.ok) { process.stderr.write(`${result.error.message}\n`); process.exitCode = 1; return; }
    process.stdout.write(`workspace added: ${result.value.id}\n`);
  } finally { opened.database.close(); }
}

async function listDatabases(): Promise<void> {
  const opened = openRegistries();
  try {
    const targets = await opened.targets.list();
    if (targets.length === 0) process.stdout.write('No database targets configured\n');
    else for (const target of targets) process.stdout.write(`${target.id}\t${target.driver}\t${target.host}:${target.port}/${target.databaseName}\treadOnly=${target.readOnly}\n`);
  } finally { opened.database.close(); }
}

async function addDatabase(values: readonly string[]): Promise<void> {
  if (values.length !== 7 || !['postgresql', 'mysql'].includes(values[1]!)) { process.stderr.write('Usage: database add <id> <postgresql|mysql> <host> <port> <database> <username> <secret-ref>\n'); process.exitCode = 2; return; }
  const port = Number(values[3]);
  if (!Number.isInteger(port)) { process.stderr.write('Database port must be an integer\n'); process.exitCode = 2; return; }
  const opened = openRegistries();
  try {
    await opened.targets.insert({ id: values[0]!, displayName: values[0]!, driver: values[1]! as DatabaseTargetDriver, host: values[2]!, port, databaseName: values[4]!, username: values[5]!, secretRef: values[6]!, readOnly: true });
    process.stdout.write(`database target added: ${values[0]}\n`);
  } catch (error: unknown) { process.stderr.write(`${error instanceof Error ? error.message : 'database target could not be added'}\n`); process.exitCode = 1; }
  finally { opened.database.close(); }
}

async function replaceDatabase(values: readonly string[]): Promise<void> {
  if (values.length !== 7 || !['postgresql', 'mysql'].includes(values[1]!)) { process.stderr.write('Usage: database replace <id> <postgresql|mysql> <host> <port> <database> <username> <secret-ref>\n'); process.exitCode = 2; return; }
  const port = Number(values[3]);
  if (!Number.isInteger(port)) { process.stderr.write('Database port must be an integer\n'); process.exitCode = 2; return; }
  const opened = openRegistries();
  try {
    await opened.targets.replace({ id: values[0]!, displayName: values[0]!, driver: values[1]! as DatabaseTargetDriver, host: values[2]!, port, databaseName: values[4]!, username: values[5]!, secretRef: values[6]!, readOnly: true });
    process.stdout.write(`database target replaced: ${values[0]}\n`);
  } catch (error: unknown) { process.stderr.write(`${error instanceof Error ? error.message : 'database target could not be replaced'}\n`); process.exitCode = 1; }
  finally { opened.database.close(); }
}

async function removeDatabase(values: readonly string[]): Promise<void> {
  if (values.length !== 3 || values[1] !== '--confirm' || values[0] !== values[2]) { process.stderr.write('Usage: database remove <id> --confirm <id>\n'); process.exitCode = 2; return; }
  const opened = openRegistries();
  try {
    if (!await opened.targets.remove(values[0]!)) { process.stderr.write('Database target was not found\n'); process.exitCode = 1; return; }
    process.stdout.write(`database target removed: ${values[0]}\n`);
  } catch (error: unknown) { process.stderr.write(`${error instanceof Error ? error.message : 'database target could not be removed'}\n`); process.exitCode = 1; }
  finally { opened.database.close(); }
}

async function listRemoteHosts(): Promise<void> {
  const opened = openRegistries();
  try {
    const hosts = await opened.hosts.list();
    if (hosts.length === 0) process.stdout.write('No remote hosts configured\n');
    else for (const host of hosts) process.stdout.write(`${host.id}\t${host.displayName}\t${host.host}:${host.port}\troots=${host.roots.join(',')}\n`);
  } finally { opened.database.close(); }
}

async function addRemoteHost(values: readonly string[]): Promise<void> {
  if (values.length !== 7) { process.stderr.write('Usage: remote-host add <id> <host> <port> <username> <secret-ref> <SHA256:fingerprint> <root[,root...]>\n'); process.exitCode = 2; return; }
  const port = Number(values[2]);
  const roots = values[6]!.split(',').map((root) => root.trim()).filter(Boolean);
  if (!Number.isInteger(port) || roots.length === 0) { process.stderr.write('Remote host port must be an integer and at least one root is required\n'); process.exitCode = 2; return; }
  const opened = openRegistries();
  try {
    await opened.hosts.insert({ id: values[0]!, displayName: values[0]!, host: values[1]!, port, username: values[3]!, secretRef: values[4]!, pinnedFingerprint: values[5]!, roots });
    process.stdout.write(`remote host added: ${values[0]}\n`);
  } catch (error: unknown) { process.stderr.write(`${error instanceof Error ? error.message : 'remote host could not be added'}\n`); process.exitCode = 1; }
  finally { opened.database.close(); }
}

async function replaceRemoteHost(values: readonly string[]): Promise<void> {
  if (values.length !== 7) { process.stderr.write('Usage: remote-host replace <id> <host> <port> <username> <secret-ref> <SHA256:fingerprint> <root[,root...]>\n'); process.exitCode = 2; return; }
  const port = Number(values[2]);
  const roots = values[6]!.split(',').map((root) => root.trim()).filter(Boolean);
  if (!Number.isInteger(port) || roots.length === 0) { process.stderr.write('Remote host port must be an integer and at least one root is required\n'); process.exitCode = 2; return; }
  const opened = openRegistries();
  try {
    await opened.hosts.replace({ id: values[0]!, displayName: values[0]!, host: values[1]!, port, username: values[3]!, secretRef: values[4]!, pinnedFingerprint: values[5]!, roots });
    process.stdout.write(`remote host replaced: ${values[0]}\n`);
  } catch (error: unknown) { process.stderr.write(`${error instanceof Error ? error.message : 'remote host could not be replaced'}\n`); process.exitCode = 1; }
  finally { opened.database.close(); }
}

async function removeRemoteHost(values: readonly string[]): Promise<void> {
  if (values.length !== 3 || values[1] !== '--confirm' || values[0] !== values[2]) { process.stderr.write('Usage: remote-host remove <id> --confirm <id>\n'); process.exitCode = 2; return; }
  const opened = openRegistries();
  try {
    if (!await opened.hosts.remove(values[0]!)) { process.stderr.write('Remote host was not found\n'); process.exitCode = 1; return; }
    process.stdout.write(`remote host removed: ${values[0]}\n`);
  } catch (error: unknown) { process.stderr.write(`${error instanceof Error ? error.message : 'remote host could not be removed'}\n`); process.exitCode = 1; }
  finally { opened.database.close(); }
}

async function doctor(): Promise<void> {
  const opened = openDatabase();
  try {
    const workspaces = await opened.workspaces.list();
    const portAvailable = await localPortAvailable();
    const gitAvailable = executable('git');
    const rgAvailable = executable('rg');
    const secretToolAvailable = executable('secret-tool');
    const journalctlAvailable = executable('journalctl');
    const ipAvailable = executable('ip');
    const ssAvailable = executable('ss');
    const dfAvailable = executable('df');
    const procAvailable = existsSync('/proc');
    const checks: Array<[string, 'PASS' | 'WARN' | 'FAIL', string]> = [
      ['os', process.platform === 'linux' && process.arch === 'x64' ? 'PASS' : 'FAIL', `${process.platform} ${process.arch}`],
      ['database', 'PASS', 'SQLite database ready'],
      ['git', gitAvailable ? 'PASS' : 'FAIL', gitAvailable ? 'git is available' : 'git is not available'],
      ['ripgrep', rgAvailable ? 'PASS' : 'FAIL', rgAvailable ? 'rg is available' : 'rg is not available'],
      ['workspaces', 'PASS', `${workspaces.length} workspace(s) registered`],
      ['secret-service', secretToolAvailable ? 'PASS' : 'WARN', secretToolAvailable ? 'secret-tool is available' : 'secret-tool is unavailable; set BAITONGHUB_LINUX_MCP_CHECKPOINT_KEY_BASE64 for headless CI'],
      ['journalctl', journalctlAvailable ? 'PASS' : 'WARN', journalctlAvailable ? 'journalctl is available' : 'journalctl is unavailable; journal tool will be unavailable'],
      ['iproute2-ip', ipAvailable ? 'PASS' : 'WARN', ipAvailable ? 'ip is available' : 'ip is unavailable; interface and route tools will be unavailable'],
      ['iproute2-ss', ssAvailable ? 'PASS' : 'WARN', ssAvailable ? 'ss is available' : 'ss is unavailable; listener tools will be unavailable'],
      ['df', dfAvailable ? 'PASS' : 'WARN', dfAvailable ? 'df is available' : 'df is unavailable; disk details will be unavailable'],
      ['procfs', procAvailable ? 'PASS' : 'WARN', procAvailable ? '/proc is available' : '/proc is unavailable; process details will be empty'],
      ['mcp-port', portAvailable ? 'PASS' : 'FAIL', portAvailable ? '127.0.0.1 is available' : '127.0.0.1 is unavailable'],
    ];
    for (const [id, status, message] of checks) process.stdout.write(`[${status}] ${id}: ${message}\n`);
    if (checks.some(([, status]) => status === 'FAIL')) process.exitCode = 1;
  } finally { opened.database.close(); }
}

function executable(name: string): boolean {
  const pathValue = process.env.PATH ?? '';
  return pathValue.split(path.delimiter).some((directory) => directory.length > 0 && name.length > 0 && existsSync(path.join(directory, name)));
}

async function localPortAvailable(): Promise<boolean> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port: 0 }, () => resolve()); });
    return true;
  } catch { return false; }
  finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

main().catch((error: unknown) => { process.stderr.write(`baitonghub-linux-mcp admin failed: ${error instanceof Error ? error.message : 'unknown'}\n`); process.exit(1); });
