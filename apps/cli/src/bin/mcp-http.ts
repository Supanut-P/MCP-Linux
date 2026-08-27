import { createOriginPolicy, startMcpHttp } from '@baitonghub-linux-mcp/mcp-server';
import { createHeadlessRuntime } from '../runtime/headless-runtime.js';

function envList(name: string): readonly string[] {
  return (process.env[name] ?? '').split(',').map((value) => value.trim()).filter(Boolean);
}

function readArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  const value = index < 0 ? undefined : process.argv[index + 1];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readArgs(flag: string): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== flag) continue;
    const value = process.argv[index + 1];
    if (typeof value === 'string' && value.trim().length > 0) values.push(value.trim());
  }
  return values;
}

function parsePort(value: string | undefined): number {
  const port = Number.parseInt(value ?? '18765', 10);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('BAITONGHUB_LINUX_MCP_HTTP_PORT must be 0..65535');
  return port;
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

export async function main(): Promise<void> {
  const host = (process.env.BAITONGHUB_LINUX_MCP_HTTP_HOST ?? '127.0.0.1').trim();
  const authToken = process.env.BAITONGHUB_LINUX_MCP_HTTP_TOKEN?.trim() || undefined;
  if (!isLoopback(host) && authToken === undefined) {
    throw new Error('BAITONGHUB_LINUX_MCP_HTTP_TOKEN is required when HTTP binds beyond loopback');
  }
  const configuredHosts = [...readArgs('--allowed-host'), ...envList('BAITONGHUB_LINUX_MCP_HTTP_ALLOWED_HOSTS')];
  const allowedHostnames = configuredHosts.length > 0 ? configuredHosts : isLoopback(host) ? ['127.0.0.1', 'localhost', '[::1]'] : [host];
  const configuredOrigins = envList('BAITONGHUB_LINUX_MCP_HTTP_ALLOWED_ORIGINS');
  const workspaceReference = readArg('--workspace');
  const profile = readArg('--profile');
  const runtime = await createHeadlessRuntime({
    ...(workspaceReference === undefined ? {} : { workspaceReference }),
    ...(profile === undefined ? {} : { profile }),
    strictRoots: process.argv.includes('--strict-roots'),
    allowedRoots: readArgs('--allowed-root'),
    resetWorkspaces: process.argv.includes('--reset-workspaces'),
  });
  const handle = await startMcpHttp({
    host,
    port: parsePort(process.env.BAITONGHUB_LINUX_MCP_HTTP_PORT),
    ...(authToken === undefined ? {} : { authToken }),
    allowedHostnames,
    ...(configuredOrigins.length === 0 ? {} : { originPolicy: createOriginPolicy(configuredOrigins) }),
    services: runtime.runtime.services,
    actor: runtime.runtime.actor,
    activityTracker: runtime.runtime.activityTracker,
    codexToolsEnabled: runtime.runtime.codexToolsEnabled,
    profileProvider: runtime.runtime.profileProvider,
    allowAiDeleteProvider: runtime.runtime.allowAiDeleteProvider,
    destructivePolicyProvider: runtime.runtime.destructivePolicyProvider,
  });
  process.stderr.write(
    `baitonghub-linux-mcp MCP HTTP ready endpoint=${handle.endpoint.toString()} bind=${handle.address.host}:${handle.address.port}`
      + ` workspace=${runtime.workspace.id} profile=${runtime.profile}${authToken === undefined ? ' auth=loopback-only' : ' auth=bearer'}\n`,
  );

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { await handle.close(); } finally { await runtime.runtime.close().catch(() => undefined); }
  };
  process.on('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
  process.on('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
}

main().catch((error: unknown) => {
  process.stderr.write(`baitonghub-linux-mcp MCP HTTP failed: ${error instanceof Error ? error.message : 'unknown'}\n`);
  process.exit(1);
});
