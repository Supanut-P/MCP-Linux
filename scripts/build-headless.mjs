import { chmodSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'apps', 'cli', 'build-headless');
const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);
if (nodeMajor !== 24) throw new Error(`Headless package requires Node.js 24.x; got ${process.versions.node}`);

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const bundle = async (entry, outfile) => build({
  absWorkingDir: root,
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['x11'],
  outfile: path.join(output, outfile),
  sourcemap: false,
  minify: false,
  legalComments: 'none',
});

await bundle('apps/cli/src/bin/mcp-stdio.ts', 'mcp-stdio.cjs');
await bundle('apps/cli/src/bin/mcp-http.ts', 'mcp-http.cjs');
await bundle('apps/cli/src/bin/headless-admin.ts', 'admin.cjs');
copyFileSync(process.execPath, path.join(output, 'baitonghub-linux-mcp-node'));
chmodSync(path.join(output, 'baitonghub-linux-mcp-node'), 0o755);

const launcher = `#!/bin/sh
set -eu
SELF=$(readlink -f "$0" 2>/dev/null || printf '%s' "$0")
BASE=$(CDPATH= cd -- "$(dirname -- "$SELF")" && pwd)
NODE_BIN="$BASE/baitonghub-linux-mcp-node"
[ -x "$NODE_BIN" ] || { echo "baitonghub-linux-mcp: bundled Node runtime missing" >&2; exit 1; }
if [ "\${1:-}" = "mcp" ] && [ "\${2:-}" = "--stdio" ]; then
  shift 2
  exec "$NODE_BIN" "$BASE/mcp-stdio.cjs" "$@"
fi
if [ "\${1:-}" = "mcp" ] && [ "\${2:-}" = "--http" ]; then
  shift 2
  exec "$NODE_BIN" "$BASE/mcp-http.cjs" "$@"
fi
if [ "\${1:-}" = "status" ] || [ "\${1:-}" = "doctor" ] || [ "\${1:-}" = "workspace" ]; then
  exec "$NODE_BIN" "$BASE/admin.cjs" "$@"
fi
echo "Usage: baitonghub-linux-mcp status|doctor|workspace add <path>|workspace list|mcp --stdio|--http [--workspace PATH]" >&2
exit 2
`;
const launcherPath = path.join(output, 'baitonghub-linux-mcp');
writeFileSync(launcherPath, launcher, { encoding: 'utf8', mode: 0o755 });
chmodSync(launcherPath, 0o755);
process.stdout.write(`Headless bundles written to ${output}\n`);
