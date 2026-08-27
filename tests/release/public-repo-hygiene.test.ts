import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');

async function trackedFiles(): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['ls-files', '-z'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  const candidates = stdout.split('\0').filter(Boolean).map((entry) => entry.replaceAll('\\', '/'));
  const present: string[] = [];
  for (const candidate of candidates) {
    try {
      await access(path.join(repositoryRoot, candidate));
      present.push(candidate);
    } catch {
      // A deleted path remains in git ls-files until the clean-root commit is created.
    }
  }
  return present;
}

describe('public repository hygiene', () => {
  it('tracks only Linux-headless platform sources and artifacts', async () => {
    const tracked = await trackedFiles();
    const forbidden = tracked.filter((file) =>
      file.startsWith('apps/desktop/')
      || file.startsWith('native/windows-ocr/')
      || /(^|\/)(?:windows|wsl|electron|powershell)[^/]*$/i.test(file)
      || /\.(?:exe|cmd|bat|ps1|ico)$/i.test(file),
    );

    expect(forbidden, `non-Linux files found: ${forbidden.join(', ')}`).toEqual([]);
  });

  it('ignores exported baitonghub-linux-mcp diagnostic text logs at the repository root', async () => {
    const ignore = await readFile(path.join(repositoryRoot, '.gitignore'), 'utf8');
    expect(ignore).toContain('baitonghub-linux-mcp-*-logs.txt');
  });

  it('does not track generated stdio bundles', async () => {
    const tracked = await trackedFiles();
    const generated = [
      'apps/cli/build-headless/mcp-stdio.cjs',
      'apps/cli/build-headless/mcp-http.cjs',
      'apps/cli/build-headless/admin.cjs',
      'apps/cli/build-headless/baitonghub-linux-mcp-node',
    ];

    for (const file of generated) {
      expect(tracked, `${file} must be generated during build, not committed`).not.toContain(file);
    }
  });

  it('does not publish developer-specific paths or private project names', async () => {
    const tracked = await trackedFiles();
    const textExtensions = new Set([
      '.cjs', '.cmd', '.css', '.html', '.js', '.json', '.md', '.mjs', '.ps1', '.py', '.toml', '.ts', '.tsx', '.txt', '.yaml', '.yml',
    ]);
    const forbidden = [
      new RegExp(['Zenith', ' sphere'].join(''), 'i'),
      new RegExp(['rsn-ayb-', 'pc-planning'].join(''), 'i'),
      new RegExp(['C:', '\\\\', 'Users', '\\\\', 'developer'].join(''), 'i'),
      new RegExp(['\\.gemini', '\\\\', 'antigravity'].join(''), 'i'),
    ];
    const leaks: string[] = [];

    for (const relativePath of tracked) {
      if (!textExtensions.has(path.extname(relativePath).toLowerCase())) continue;
      const content = await readFile(path.join(repositoryRoot, relativePath), 'utf8');
      if (forbidden.some((pattern) => pattern.test(content))) leaks.push(relativePath);
    }

    expect(leaks, `developer-specific content found in: ${leaks.join(', ')}`).toEqual([]);
  });

  it('documents the package version and Linux release artifact rather than a stale release', async () => {
    const readme = await readFile(path.join(repositoryRoot, 'README.md'), 'utf8');
    const rootPackage = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8')) as { version?: unknown };
    expect(typeof rootPackage.version).toBe('string');

    expect(readme).toContain(`releases/download/v${rootPackage.version as string}`);
    expect(readme).toContain(`Baitonghub-Linux-mcp-${rootPackage.version as string}-amd64.deb`);
    expect(readme).toContain('The v0.1 release is **headless**');
    expect(readme).not.toContain('current source/release candidate is');
    expect(readme).not.toContain('pending publication');
    expect(readme).not.toContain('Windows installer');
    expect(readme).not.toContain('DPAPI');
    expect(readme).not.toContain('127.0.0.1:39200/mcp');
  });

  it('does not link README readers to ignored local documentation', async () => {
    const readme = await readFile(path.join(repositoryRoot, 'README.md'), 'utf8');
    const tracked = new Set(await trackedFiles());
    const localDocLinks = Array.from(readme.matchAll(/\[[^\]]+\]\((docs\/[^)#]+)(?:#[^)]+)?\)/g), (match) => match[1]);
    const missing = localDocLinks.filter((link): link is string => link !== undefined && !tracked.has(link));

    expect(missing, `README links to untracked docs: ${missing.join(', ')}`).toEqual([]);
  });

  it('documents the headless MCP port and OpenAI tunnel client', async () => {
    const envExample = await readFile(path.join(repositoryRoot, '.env.example'), 'utf8');
    const readme = await readFile(path.join(repositoryRoot, 'README.md'), 'utf8');

    expect(envExample).toContain('BAITONGHUB_LINUX_MCP_HTTP_PORT=18765');
    expect(envExample).toContain('BAITONGHUB_LINUX_MCP_STRICT_ROOTS=1');
    expect(envExample).not.toContain('BAITONGHUB_LINUX_MCP_UNRESTRICTED=1');
    expect(readme).toContain('OpenAI Secure MCP Tunnel');
    expect(readme).toContain('BAITONGHUB_LINUX_MCP_HTTP_PORT=18765');
    expect(readme).not.toContain('Cloudflare Remote Tunnel');
  });

  it('keeps workspace discovery as a read-only operation', async () => {
    const source = await readFile(
      path.join(repositoryRoot, 'packages', 'mcp-server', 'src', 'tools', 'workspace-tools.ts'),
      'utf8',
    );
    const start = source.indexOf("name: 'workspace_list'");
    const end = source.indexOf("name: 'workspace_register'");
    const descriptor = source.slice(start, end);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(descriptor).toContain("permission: 'READ'");
    expect(descriptor).not.toContain("permission: 'DANGEROUS'");
  });
});
