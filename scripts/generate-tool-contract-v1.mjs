/* global process */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { z } = await import(pathToFileURL(path.join(root, 'packages', 'mcp-server', 'node_modules', 'zod', 'index.js')).href);
const { ToolRegistry } = await import(pathToFileURL(path.join(root, 'packages', 'mcp-server', 'dist', 'tool-registry.js')).href);
const output = path.join(root, 'tests', 'fixtures', 'tool-contract-v1.json');
const checkOnly = process.argv.includes('--check');
const registry = new ToolRegistry({
  targetCatalog: {
    list: async () => ({ ok: true, value: [] }),
    describe: async () => ({ ok: false, error: { code: 'INVALID_INPUT', message: 'Not available in contract generation', recoverable: false } }),
  },
  remoteRollout: { execute: async () => ({ ok: true, value: {} }) },
  remoteRolloutResume: { resume: async () => ({ ok: true, value: {} }) },
  supportBundle: { execute: async () => ({ ok: true, value: {} }) },
  auditQuery: { execute: async () => ({ ok: true, value: { entries: [], count: 0, truncated: false } }) },
  taskEvents: { execute: async () => ({ ok: true, value: { taskId: 'contract-task', state: 'completed', events: [], count: 0, truncated: false } }) },
}, { clientId: 'contract-generator', clientName: 'contract-generator' }, { codexToolsEnabled: true });
const canonicalize = (value) => Array.isArray(value)
  ? value.map(canonicalize)
  : typeof value !== 'object' || value === null
    ? value
    : Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonicalize(child)]));
const tools = registry.list().map((tool) => ({
  name: tool.name,
  permission: tool.permission,
  annotations: tool.annotations,
  inputSchema: canonicalize(z.toJSONSchema(tool.inputSchema, { target: 'draft-7' })),
})).sort((a, b) => a.name.localeCompare(b.name));
const expected = JSON.stringify({ contractVersion: '1.0.0', descriptions: 'non-contractual', tools }, null, 2) + '\n';
const normalizeLineEndings = (value) => value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
if (checkOnly) {
  const current = await readFile(output, 'utf8').catch(() => '');
  if (normalizeLineEndings(current) !== normalizeLineEndings(expected)) { process.stderr.write(`v1 tool contract drift detected for ${tools.length} tools. Run: corepack pnpm@10.15.0 contract:v1\n`); process.exitCode = 1; }
  else process.stdout.write(`v1 tool contract is synchronized with ${tools.length} tools.\n`);
} else {
  await writeFile(output, expected, 'utf8');
  process.stdout.write(`Wrote v1 tool contract with ${tools.length} tools.\n`);
}
