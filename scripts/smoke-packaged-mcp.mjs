#!/usr/bin/env node
import { createRequire } from 'node:module';
import { access, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';

const require = createRequire(new URL('../packages/mcp-server/package.json', import.meta.url));
const { Client } = require('@modelcontextprotocol/client');
const { StdioClientTransport } = require('@modelcontextprotocol/client/stdio');

const SMOKE_TIMEOUT_MS = 30_000;
const [launcher, workspace, expectedToolsMin] = parseArgs(process.argv.slice(2));
await assertExecutable(launcher);
await assertDirectory(workspace);

const filename = `.baitonghub-linux-mcp-smoke-${process.pid}.txt`;
const seedPath = path.join(workspace, filename);
const transport = new StdioClientTransport({
  command: launcher,
  args: ['mcp', '--stdio', '--workspace', workspace],
  stderr: 'pipe',
  // The MCP SDK intentionally inherits a small safe environment allowlist;
  // pass only the isolated XDG paths and checkpoint key needed by this smoke
  // child rather than leaking the caller's complete environment.
  env: Object.fromEntries([
    'BAITONGHUB_LINUX_MCP_CHECKPOINT_KEY_BASE64',
    'XDG_DATA_HOME',
    'XDG_CONFIG_HOME',
    'XDG_STATE_HOME',
  ].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]),
  ),
});
let diagnostics = '';
transport.stderr?.on('data', (chunk) => { diagnostics += chunk.toString('utf8'); });
const client = new Client(
  { name: 'baitonghub-linux-mcp-packaged-smoke', version: '1.0.0' },
  { versionNegotiation: { mode: { pin: '2026-07-28' } } },
);

try {
  // Seed a disposable, non-secret file so read_file is deterministic even
  // when the caller supplies an otherwise empty temporary workspace.
  await writeFile(seedPath, 'seed\n', { encoding: 'utf8', flag: 'wx' });
  await withTimeout(client.connect(transport), 'MCP stdio connect');
  const tools = await withTimeout(client.listTools(), 'tools/list');
  if (tools.tools.length < expectedToolsMin) {
    throw new Error(`tools/list returned ${tools.tools.length} tools; expected at least ${expectedToolsMin}`);
  }

  const listed = await callTool(client, 'workspace_list', {});
  const entries = readArray(listed);
  const parent = entries.find((entry) => entry.kind === 'machine_root') ?? entries.find((entry) => entry.kind === 'project');
  if (parent === undefined || typeof parent.id !== 'string') {
    throw new Error('workspace_list did not return a machine root or project workspace');
  }
  const listedMachineRoot = parent.kind === 'machine_root';
  const existing = entries.find((entry) => entry.kind === 'project'
    && typeof entry.id === 'string'
    && typeof (entry.realRootPath ?? entry.rootPath) === 'string'
    && path.resolve(entry.realRootPath ?? entry.rootPath) === path.resolve(workspace));
  const registered = existing === undefined
    ? await callTool(client, 'workspace_register', {
      parentWorkspaceId: parent.id,
      path: workspace,
      displayName: 'packaged-mcp-smoke',
    })
    : undefined;
  const workspaceId = existing?.id ?? (registered === undefined ? undefined : readWorkspaceId(registered));
  if (workspaceId === undefined) throw new Error('workspace_register did not return a workspace id');

  await callTool(client, 'workspace_tree', { workspaceId, maxDepth: 1, maxEntries: 100 });
  const read = await callTool(client, 'read_file', { workspaceId, path: filename });
  if (!readText(read).includes('seed')) throw new Error('read_file did not return the seeded content');
  await callTool(client, 'write_file', { workspaceId, path: filename, content: 'written\n' });
  await callTool(client, 'apply_patch', { workspaceId, files: [{ path: filename, content: 'patched\n' }] });
  try {
    await callTool(client, 'git_status', { workspaceId });
  } catch (error) {
    // The package smoke workspace may be a source export without `.git`; the
    // dedicated Git acceptance suite covers repository-backed workspaces.
    if (!(error instanceof Error) || !error.message.includes('GIT_NOT_REPOSITORY')) throw error;
  }

  const started = await callTool(client, 'shell', {
    workspaceId,
    operation: 'run',
    executable: '/usr/bin/printf',
    arguments: ['baitonghub-smoke\\n'],
    execution: 'background',
    timeout_seconds: 30,
  });
  const taskId = readTaskId(started);
  if (taskId === undefined) throw new Error('shell run did not return a durable task_id');
  const finished = await callTool(client, 'shell', {
    workspaceId,
    operation: 'wait',
    task_id: taskId,
    timeout_seconds: 5,
  });
  const final = readObject(finished);
  if (final.state !== 'completed' || final.exit_code !== 0 || final.stdout !== 'baitonghub-smoke\n') {
    throw new Error(`shell wait did not complete successfully: ${JSON.stringify({ state: final.state, exit_code: final.exit_code, stdout: final.stdout })}`);
  }

  const audit = await callTool(client, 'audit_query', { limit: 10 });
  const auditValue = readObject(audit);
  if (!Array.isArray(auditValue.entries)
    || typeof auditValue.count !== 'number'
    || typeof auditValue.truncated !== 'boolean') {
    throw new Error('audit_query did not return bounded structured summaries');
  }

  const snapshot = await callTool(client, 'workspace_snapshot', {
    workspaceId,
    operation: 'manifest',
    maxEntries: 10,
    hashMode: 'none',
  });
  const snapshotValue = readObject(snapshot);
  if (snapshotValue.workspaceId !== workspaceId
    || !Array.isArray(snapshotValue.entries)
    || typeof snapshotValue.count !== 'number'
    || typeof snapshotValue.truncated !== 'boolean') {
    throw new Error('workspace_snapshot manifest did not return bounded metadata');
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    toolCount: tools.tools.length,
    expectedToolsMin,
    registeredWorkspaceId: workspaceId,
    parentKind: listedMachineRoot ? 'machine_root' : 'project_compatibility_fallback',
    taskId,
    auditCount: auditValue.count,
    auditTruncated: auditValue.truncated,
    snapshotCount: snapshotValue.count,
    snapshotTruncated: snapshotValue.truncated,
  }) + '\n');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(`${message}${diagnostics.length > 0 ? `; stderr=${diagnostics.trim()}` : ''}`);
} finally {
  await client.close().catch(() => undefined);
  await rm(seedPath, { force: true }).catch(() => undefined);
}

function parseArgs(args) {
  if (args.length !== 6) throw new Error('Usage: smoke-packaged-mcp.mjs --launcher <absolute-path> --workspace <absolute-path> --expected-tools-min <n>');
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!['--launcher', '--workspace', '--expected-tools-min'].includes(flag) || values.has(flag) || value === undefined || value.length === 0) {
      throw new Error('Arguments must be exactly --launcher <abs> --workspace <abs> --expected-tools-min <n>');
    }
    values.set(flag, value);
  }
  const launcher = values.get('--launcher');
  const workspace = values.get('--workspace');
  const expectedToolsMin = Number(values.get('--expected-tools-min'));
  if (!path.isAbsolute(launcher) || !path.isAbsolute(workspace) || !Number.isSafeInteger(expectedToolsMin) || expectedToolsMin < 1) {
    throw new Error('launcher and workspace must be absolute paths and expected-tools-min must be a positive integer');
  }
  return [launcher, workspace, expectedToolsMin];
}

async function assertExecutable(filename) {
  const details = await stat(filename).catch(() => undefined);
  if (details === undefined || !details.isFile()) throw new Error(`Launcher is not a file: ${filename}`);
  await access(filename).catch(() => { throw new Error(`Launcher is not accessible: ${filename}`); });
}

async function assertDirectory(directory) {
  const details = await stat(directory).catch(() => undefined);
  if (details === undefined || !details.isDirectory()) throw new Error(`Workspace is not a directory: ${directory}`);
}

async function callTool(client, name, args) {
  const result = await withTimeout(client.callTool({ name, arguments: args }), `tools/call ${name}`);
  if (result.isError === true) {
    const error = readObject(result).error;
    throw new Error(`${name} failed: ${typeof error === 'object' && error !== null && 'code' in error ? error.code : 'MCP_ERROR'}`);
  }
  return result;
}

function readObject(result) {
  const structured = result?.structuredContent;
  if (structured && typeof structured === 'object' && !Array.isArray(structured)) return structured;
  return {};
}

function readArray(result) {
  const structured = readObject(result);
  if (Array.isArray(structured.value)) return structured.value;
  if (Array.isArray(structured.workspaces)) return structured.workspaces;
  return [];
}

function readWorkspaceId(result) {
  const object = readObject(result);
  return typeof object.id === 'string' ? object.id : undefined;
}

function readTaskId(result) {
  const object = readObject(result);
  return typeof object.task_id === 'string' ? object.task_id : undefined;
}

function readText(result) {
  const object = readObject(result);
  return typeof object.content === 'string' ? object.content : result?.content?.map((item) => item.type === 'text' ? item.text : '').join('') ?? '';
}

function withTimeout(promise, operation) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = globalThis.setTimeout(() => reject(new Error(`${operation} timed out after ${SMOKE_TIMEOUT_MS}ms`)), SMOKE_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => globalThis.clearTimeout(timer));
}
