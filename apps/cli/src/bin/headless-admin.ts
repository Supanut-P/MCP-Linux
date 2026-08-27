import { createServer } from 'node:net';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { resolveBaitonghubLinuxMcpPaths } from '@baitonghub-linux-mcp/shared';
import { SqliteDatabase, SqliteWorkspaceRepository } from '@baitonghub-linux-mcp/storage';
import { WorkspaceService } from '@baitonghub-linux-mcp/workspace';

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  if (command === 'status') return status();
  if (command === 'doctor') return doctor();
  if (command === 'workspace' && args[1] === 'list') return listWorkspaces();
  if (command === 'workspace' && args[1] === 'add' && args[2] !== undefined) return addWorkspace(args[2]);
  process.stderr.write('Usage: baitonghub-linux-mcp status | doctor | workspace add <path> | workspace list\n');
  process.exitCode = 2;
}

function openDatabase(): { readonly dataPath: string; readonly database: SqliteDatabase; readonly workspaces: SqliteWorkspaceRepository } {
  const dataPath = resolveBaitonghubLinuxMcpPaths(process.env, process.platform).dataPath;
  mkdirSync(dataPath, { recursive: true });
  const database = new SqliteDatabase(path.join(dataPath, 'baitonghub-linux-mcp.sqlite'), { backupDirectory: path.join(dataPath, 'backups') });
  return { dataPath, database, workspaces: new SqliteWorkspaceRepository(database) };
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

async function doctor(): Promise<void> {
  const opened = openDatabase();
  try {
    const workspaces = await opened.workspaces.list();
    const portAvailable = await localPortAvailable();
    const gitAvailable = executable('git');
    const rgAvailable = executable('rg');
    const secretToolAvailable = executable('secret-tool');
    const checks: Array<[string, 'PASS' | 'WARN' | 'FAIL', string]> = [
      ['os', process.platform === 'linux' && process.arch === 'x64' ? 'PASS' : 'FAIL', `${process.platform} ${process.arch}`],
      ['database', 'PASS', 'SQLite database ready'],
      ['git', gitAvailable ? 'PASS' : 'FAIL', gitAvailable ? 'git is available' : 'git is not available'],
      ['ripgrep', rgAvailable ? 'PASS' : 'FAIL', rgAvailable ? 'rg is available' : 'rg is not available'],
      ['workspaces', 'PASS', `${workspaces.length} workspace(s) registered`],
      ['secret-service', secretToolAvailable ? 'PASS' : 'WARN', secretToolAvailable ? 'secret-tool is available' : 'secret-tool is unavailable; set BAITONGHUB_LINUX_MCP_CHECKPOINT_KEY_BASE64 for headless CI'],
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
