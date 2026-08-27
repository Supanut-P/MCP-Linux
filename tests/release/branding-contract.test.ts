import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');

describe('Baitonghub Linux MCP branding contract', () => {
  it('uses the v0.2.0 package namespace across every workspace package', () => {
    const manifests = trackedFiles().filter((file) => file === 'package.json' || /^(apps|packages)\/.+\/package\.json$/.test(file));
    expect(manifests.length).toBeGreaterThan(10);
    for (const manifest of manifests) {
      const parsed = JSON.parse(readFileSync(path.join(repositoryRoot, manifest), 'utf8')) as { name?: string; version?: string };
      if (manifest === 'package.json') {
        expect(parsed.name).toBe('baitonghub-linux-mcp');
      } else {
        expect(parsed.name).toMatch(/^@baitonghub-linux-mcp\//);
      }
      expect(parsed.version).toBe('0.2.0');
    }
  });

  it('does not expose the upstream package namespace or environment prefix in runtime files', () => {
    const retiredPackageScope = ['@', 'ln', 'wjud', '/'].join('');
    const retiredEnvironmentPrefix = ['LN', 'WJUD', '_'].join('');
    const runtimeFiles = trackedFiles().filter((file) =>
      !file.startsWith('docs/')
      && file !== 'THIRD_PARTY_NOTICES.md'
      && file !== 'pnpm-lock.yaml'
      && file !== 'scripts/check-branding.mjs'
      && file !== 'tests/release/branding-contract.test.ts'
      && /\.(?:ts|tsx|js|mjs|json|ya?ml|toml|ps1|bat)$/.test(file),
    );
    const offenders = runtimeFiles.filter((file) => {
      const content = readFileSync(path.join(repositoryRoot, file), 'utf8');
      return content.includes(retiredPackageScope) || content.includes(retiredEnvironmentPrefix);
    });
    expect(offenders).toEqual([]);
  });

  it('keeps the public package Linux headless without a desktop application surface', () => {
    expect(execFileSync('git', ['ls-files', 'apps/desktop'], { cwd: repositoryRoot, encoding: 'utf8' }).trim()).toBe('');
    const rootPackage = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    expect(rootPackage.scripts?.desktop).toBeUndefined();
    expect(rootPackage.scripts?.['package:linux:headless']).toContain('@baitonghub-linux-mcp/cli');
  });
});

function trackedFiles(): readonly string[] {
  return execFileSync('git', ['ls-files'], { cwd: repositoryRoot, encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean)
    .map((file) => file.replaceAll('\\', '/'))
    .filter((file) => existsSync(path.join(repositoryRoot, file)));
}
