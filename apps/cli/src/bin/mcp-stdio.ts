import { startMcpStdio } from '@baitonghub-linux-mcp/mcp-server';
import { createHeadlessRuntime } from '../runtime/headless-runtime.js';

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

export async function main(): Promise<void> {
  const workspaceReference = readArg('--workspace');
  const profile = readArg('--profile');
  const serverProfile = readArg('--server-profile');
  const runtime = await createHeadlessRuntime({
    ...(workspaceReference === undefined ? {} : { workspaceReference }),
    ...(profile === undefined ? {} : { profile }),
    ...(serverProfile === undefined ? {} : { serverProfile }),
    strictRoots: process.argv.includes('--strict-roots'),
    allowedRoots: readArgs('--allowed-root'),
    resetWorkspaces: process.argv.includes('--reset-workspaces'),
  });
  process.stderr.write(
    `baitonghub-linux-mcp MCP stdio ready primary=${runtime.workspace.id} root=${runtime.workspace.realRootPath}`
      + ` permission_profile=${runtime.profile} server_profile=${runtime.serverProfile}`
      + (runtime.strictAllowedRoots === undefined ? '' : ` strict_roots=${runtime.strictAllowedRoots.length}`) + '\n',
  );

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { await handle.close(); } catch { /* transport may already be closed */ }
    try { await runtime.runtime.close(); } catch { /* runtime may already be closing */ }
    process.exit(0);
  };

  const handle = startMcpStdio({
    services: runtime.runtime.services,
    actor: runtime.runtime.actor,
    activityTracker: runtime.runtime.activityTracker,
    codexToolsEnabled: runtime.runtime.codexToolsEnabled,
    profileProvider: runtime.runtime.profileProvider,
    serverProfileProvider: (): import('@baitonghub-linux-mcp/mcp-server').ServerProfileName => runtime.serverProfile,
    allowAiDeleteProvider: runtime.runtime.allowAiDeleteProvider,
    destructivePolicyProvider: runtime.runtime.destructivePolicyProvider,
    onError: (error): void => {
      if (/EPIPE|ECONNRESET|broken pipe/i.test(error.message)) {
        process.stderr.write(`baitonghub-linux-mcp MCP stdio: peer closed (${error.message})\n`);
        void shutdown();
        return;
      }
      process.stderr.write(`baitonghub-linux-mcp MCP stdio error: ${error.message}\n`);
    },
  });

  process.stdin.on('end', () => { void shutdown(); });
  process.stdin.on('close', () => { void shutdown(); });
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE' || error.code === 'ECONNRESET') void shutdown();
  });
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
}

main().catch((error: unknown) => {
  process.stderr.write(`baitonghub-linux-mcp MCP stdio failed: ${error instanceof Error ? error.message : 'unknown'}\n`);
  process.exit(1);
});
