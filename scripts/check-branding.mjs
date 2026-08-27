import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const allow = new Set([
  'THIRD_PARTY_NOTICES.md',
  'scripts/check-branding.mjs',
  'tests/release/branding-contract.test.ts',
]);
const binaryExtensions = new Set(['.ico', '.png', '.ttf']);
const offenders = [];
const retiredPackageScope = ['@', 'ln', 'wjud', '/'].join('');
const retiredEnvironmentPrefix = ['LN', 'WJUD', '_'].join('');

for (const relativePath of trackedFiles()) {
  if (allow.has(relativePath)) continue;
  if (binaryExtensions.has(path.extname(relativePath).toLowerCase())) continue;
  const content = readFileSync(path.join(root, relativePath));
  const text = content.toString('utf8');
  if (text.includes(retiredPackageScope) || text.includes(retiredEnvironmentPrefix)) offenders.push(relativePath);
}

if (offenders.length > 0) {
  process.stderr.write(`Upstream branding remains in runtime files:\n${offenders.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('Branding contract passed.\n');
}

function trackedFiles() {
  return execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean)
    .map((file) => file.replaceAll('\\', '/'))
    .filter((file) => existsSync(path.join(root, file)));
}
