import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');

describe('Baitonghub Linux release verification gate', () => {
  it('runs CI and release verification on Ubuntu 24.04', async () => {
    for (const workflowName of ['ci.yml', 'release.yml']) {
      const workflow = await readFile(path.join(repositoryRoot, '.github', 'workflows', workflowName), 'utf8');
      expect(workflow).toContain('runs-on: ubuntu-24.04');
      expect(workflow).toContain('libsecret-1-0');
      expect(workflow).toContain('libsecret-tools');
      expect(workflow).toContain('ripgrep');
      expect(workflow).toContain('pnpm install --frozen-lockfile');
      expect(workflow).toContain('pnpm rebrand:check');
      expect(workflow).toContain('pnpm lint');
      expect(workflow).toContain('pnpm typecheck');
      expect(workflow).toContain('pnpm test');
      expect(workflow).toContain('pnpm test:integration');
      expect(workflow).toContain('pnpm test:release-gate');
      expect(workflow).toContain('pnpm docs:tools:check');
    }
  });

  it('publishes only verified Linux headless artifacts', async () => {
    const workflow = await readFile(path.join(repositoryRoot, '.github', 'workflows', 'release.yml'), 'utf8');
    expect(workflow).toContain('pnpm package:linux:headless');
    expect(workflow).toContain('sha256sum --check');
    expect(workflow).toContain('Baitonghub-Linux-mcp-*-amd64.deb');
    expect(workflow).toContain('Baitonghub-Linux-mcp-*-linux-x64.tar.gz');
    expect(workflow).toMatch(/exe\|cmd\|bat\|ps1/i);
    expect(workflow).not.toContain('package:windows');
  });

  it('rejects release tags that do not match the package version', async () => {
    const workflow = await readFile(path.join(repositoryRoot, '.github', 'workflows', 'release.yml'), 'utf8');
    expect(workflow).toContain('github.ref_name');
    expect(workflow).toContain('package.json');
    expect(workflow).toMatch(/tag.*match|match.*tag/i);
  });

  it('documents the Linux runtime and package acceptance evidence', async () => {
    const checklist = await readFile(path.join(repositoryRoot, '.github', 'RELEASE_CHECKLIST.md'), 'utf8');
    const normalized = checklist.toLowerCase();
    for (const evidence of [
      'Ubuntu 24.04',
      'symlink escape',
      'secret redaction',
      'STDIO',
      'Streamable HTTP',
      'process group',
      'installed-package smoke',
      'Secure MCP Tunnel',
      'git diff --check',
    ]) {
      expect(normalized).toContain(evidence.toLowerCase());
    }
  });

  it('keeps the public release scripts headless-only', async () => {
    const rootPackage = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(rootPackage.scripts?.['package:linux:headless']).toContain('@baitonghub-linux-mcp/cli');
    expect(rootPackage.scripts?.['package:windows']).toBeUndefined();
    expect(rootPackage.scripts?.desktop).toBeUndefined();
  });
});
