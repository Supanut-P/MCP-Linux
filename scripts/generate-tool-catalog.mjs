import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractPath = path.join(repositoryRoot, 'docs', 'architecture', 'TOOL_CONTRACT.md');
const registryModulePath = path.join(repositoryRoot, 'packages', 'mcp-server', 'dist', 'tool-registry.js');
const startMarker = '<!-- BEGIN GENERATED TOOL REGISTRY -->';
const endMarker = '<!-- END GENERATED TOOL REGISTRY -->';
const checkOnly = process.argv.includes('--check');

const { ToolRegistry } = await import(pathToFileURL(registryModulePath).href);
const registry = new ToolRegistry({
  targetCatalog: {
    list: async () => ({ ok: true, value: [] }),
    describe: async () => ({ ok: false, error: { code: 'INVALID_INPUT', message: 'Not available in catalog generation', recoverable: false } }),
    },
  remoteRollout: { execute: async () => ({ ok: true, value: {} }) },
  remoteRolloutResume: { resume: async () => ({ ok: true, value: {} }) },
  supportBundle: { execute: async () => ({ ok: true, value: {} }) },
  auditQuery: { execute: async () => ({ ok: true, value: { entries: [], count: 0, truncated: false } }) },
  taskEvents: { execute: async () => ({ ok: true, value: { taskId: 'catalog-task', state: 'completed', events: [], count: 0, truncated: false } }) },
  taskHistory: { execute: async () => ({ ok: true, value: { entries: [], count: 0, truncated: false } }) },
  diagnosticsSnapshot: { execute: async () => ({ ok: true, value: { snapshotAt: new Date(0).toISOString(), status: 'ready', health: { available: true, ready: true, unavailableCount: 0, consentRequiredCount: 0, missingDependencies: [] }, runtime: { available: true, ready: true }, audit: { available: true, ready: true, count: 0, truncated: false }, dependencies: { ready: true, missingDependencies: [] } } }) },
  remoteFleetDiff: { execute: async () => ({ ok: true, value: { operation: 'remote_fleet_diff', hosts: [], summary: { requested: 0, changed: 0, unchanged: 0, unavailable: 0, maxParallel: 4 } } }) },
  releaseVerify: { execute: async () => ({ ok: true, value: { operation: 'release_verify', verified: true, artifacts: [], reasonCodes: [] } }) },
}, { clientId: 'catalog-generator', clientName: 'catalog-generator' }, { codexToolsEnabled: true });
const tools = registry.list();
const current = await readFile(contractPath, 'utf8');
const newline = current.includes('\r\n') ? '\r\n' : '\n';
const rows = tools.map((tool, index) => {
  const readOnly = tool.annotations.readOnlyHint === true ? 'yes' : 'no';
  const destructive = tool.annotations.destructiveHint === true ? 'yes' : 'no';
  return `| ${index + 1} | \`${tool.name}\` | ${tool.permission} | ${readOnly} | ${destructive} |`;
});
const block = [
  startMarker,
  '## Generated live ToolRegistry index',
  '',
  `This block is generated from the built \`ToolRegistry\`. Current count: **${tools.length} tools**.`,
  'Run `pnpm docs:tools` after intentionally changing the registry; CI runs `pnpm docs:tools:check` and fails on drift.',
  '',
  '| # | Tool | Permission | Read-only | Destructive |',
  '| ---: | --- | --- | :---: | :---: |',
  ...rows,
  endMarker,
].join(newline);
const start = current.indexOf(startMarker);
const end = current.indexOf(endMarker);
let expected;
if (start >= 0 && end >= start) {
  expected = current.slice(0, start) + block + current.slice(end + endMarker.length);
} else {
  const insertionPoint = current.indexOf('## Protocol and result rules');
  if (insertionPoint < 0) throw new Error('Tool contract insertion point was not found');
  expected = current.slice(0, insertionPoint) + block + newline + newline + current.slice(insertionPoint);
}

const normalizeLineEndings = (value) => value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

if (checkOnly) {
  if (normalizeLineEndings(current) !== normalizeLineEndings(expected)) {
    process.stderr.write(`Tool catalog drift detected: runtime advertises ${tools.length} tools. Run: corepack pnpm@10.15.0 docs:tools\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Tool catalog is synchronized with ${tools.length} runtime tools.\n`);
  }
} else {
  await writeFile(contractPath, expected, 'utf8');
  process.stdout.write(`Generated ToolRegistry catalog with ${tools.length} tools.\n`);
}
