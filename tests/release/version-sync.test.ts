import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');

describe('version synchronization', () => {
  it.each(['\n', '\r\n'])('updates current README references with %j newlines and preserves older history', async (newline) => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'mcp-version-sync-'));
    try {
      await mkdir(path.join(fixture, 'scripts'), { recursive: true });
      await mkdir(path.join(fixture, 'apps'), { recursive: true });
      await mkdir(path.join(fixture, 'packages/shared/src'), { recursive: true });
      await writeFile(path.join(fixture, 'scripts/set-version.mjs'), await readFile(path.join(repositoryRoot, 'scripts/set-version.mjs')));
      await writeFile(path.join(fixture, 'package.json'), JSON.stringify({ name: 'baitonghub-linux-mcp', version: '1.37.0' }));
      await writeFile(path.join(fixture, 'packages/shared/package.json'), JSON.stringify({ version: '1.37.0' }));
      await writeFile(path.join(fixture, 'packages/shared/src/index.ts'), "export const APP_NAME = 'baitonghub-linux-mcp';\nexport const APP_VERSION = '1.37.0';\n");
      const fixtureReadme = [
        '## Current version: v1.37.0',
        'The v1.37.0 release is **headless**.',
        '## Install',
        'The v1.37.0 links below become downloadable when approved.',
        'curl -LO https://example.test/releases/download/v1.37.0/Baitonghub-Linux-mcp-1.37.0-amd64.deb',
        'sha256sum --check Baitonghub-Linux-mcp-1.37.0-SHA256SUMS',
        'Historical release v1.36.0 remains archived.',
        '## Older release',
        'Release `v1.36.0`',
        'https://example.test/releases/download/v1.36.0/Baitonghub-Linux-mcp-1.36.0-amd64.deb',
        '',
      ].join(newline);
      await writeFile(path.join(fixture, 'README.md'), fixtureReadme);
      const history = 'Historical v1.37.0 and v1.36.0 release records stay unchanged.\n';
      await writeFile(path.join(fixture, 'VERSION_HISTORY.md'), history);

      await execFileAsync(process.execPath, [path.join(fixture, 'scripts/set-version.mjs'), '1.38.0']);

      const readme = await readFile(path.join(fixture, 'README.md'), 'utf8');
      expect(readme).toContain('The v1.38.0 release is **headless**');
      expect(readme).toContain('## Current version: v1.38.0');
      expect(readme).toContain('releases/download/v1.38.0/Baitonghub-Linux-mcp-1.38.0-amd64.deb');
      expect(readme).toContain('Baitonghub-Linux-mcp-1.38.0-SHA256SUMS');
      expect(readme).toContain('Historical release v1.36.0 remains archived');
      expect(readme).toContain('releases/download/v1.36.0/Baitonghub-Linux-mcp-1.36.0-amd64.deb');
      expect(readme).toContain('Release `v1.36.0`');
      expect(await readFile(path.join(fixture, 'VERSION_HISTORY.md'), 'utf8')).toBe(history);
      expect(JSON.parse(await readFile(path.join(fixture, 'package.json'), 'utf8')).version).toBe('1.38.0');
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
