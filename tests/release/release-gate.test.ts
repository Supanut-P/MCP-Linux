import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const execFileAsync = promisify(execFile);

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
    expect(workflow).toContain('generate-release-provenance.mjs');
    expect(workflow).toContain('PROVENANCE-SHA256SUMS');
    expect(workflow).toContain('SBOM.cdx.json');
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

  it('ships a fail-closed soak recorder and evidence verifier', async () => {
    const recorder = await readFile(path.join(repositoryRoot, 'scripts', 'soak-linux-headless.sh'), 'utf8');
    const verifier = await readFile(path.join(repositoryRoot, 'scripts', 'verify-soak-linux-headless.sh'), 'utf8');
    expect(recorder).toContain('owner_uid');
    expect(recorder).toContain('BAITONGHUB_LINUX_MCP_PID must be a positive process id greater than 1');
    expect(verifier).toContain('SOAK_MIN_DURATION_SECONDS');
    expect(verifier).toContain('soak evidence needs at least two samples');
    expect(verifier).toContain('RSS growth exceeds limit');
    expect(verifier).toContain('pid or owner changed');
  });

  it('ships a commit-bound provenance and SBOM generator', async () => {
    const generator = await readFile(path.join(repositoryRoot, 'scripts', 'generate-release-provenance.mjs'), 'utf8');
    const rollbackVerifier = await readFile(path.join(repositoryRoot, 'scripts', 'verify-upgrade-rollback.sh'), 'utf8');
    expect(generator).toContain("schema: 'baitonghub.release-provenance.v1'");
    expect(generator).toContain("bomFormat: 'CycloneDX'");
    expect(generator).toContain("sourceCommit: commit");
    expect(rollbackVerifier).toContain('PROVENANCE-SHA256SUMS');
    expect(rollbackVerifier).toContain('sourceDirty!==false');
  });

  it('documents the operator-only v1.5 evidence runbook', async () => {
    const runbook = await readFile(path.join(repositoryRoot, 'docs', 'linux', 'evidence', 'v1.5.0', 'RUNBOOK.md'), 'utf8');
    expect(runbook).toContain('disposable Ubuntu 24.04 x86_64 snapshot');
    expect(runbook).toContain('Upgrade, rollback, uninstall, and reinstall');
    expect(runbook).toContain('SOAK_DURATION_SECONDS=604800');
    expect(runbook).toContain('production proof');
  });

  it.runIf(process.platform !== 'win32')('executes the soak verifier and rejects invalid evidence', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.tmp-soak-gate-'));
    const verifier = path.join(repositoryRoot, 'scripts', 'verify-soak-linux-headless.sh');
    const header = 'timestamp\trss_kb\tfd_count\twal_bytes\ttask_count\ttunnel_reconnects\tservice_restarts\tpid\towner_uid\n';
    const valid = path.join(root, 'valid.tsv');
    const invalid = path.join(root, 'invalid.tsv');
    try {
      await writeFile(valid, `${header}2026-01-01T00:00:00Z\t100\t5\t0\t0\t0\t0\t1234\t1000\n2026-01-01T00:00:01Z\t110\t6\t0\t0\t0\t0\t1234\t1000\n`, 'utf8');
      const verified = await execFileAsync('sh', [verifier, valid], {
        cwd: repositoryRoot,
        env: { ...process.env, SOAK_MIN_DURATION_SECONDS: '1' },
      });
      expect(verified.stdout).toContain('Soak evidence verified');

      await writeFile(invalid, `${header}2026-01-01T00:00:00Z\t100\t5\t0\t0\t0\t0\t1234\t1000\n2026-01-01T00:00:01Z\t110\t6\t0\t0\t0\t0\t1234\t1001\n`, 'utf8');
      await expect(execFileAsync('sh', [verifier, invalid], {
        cwd: repositoryRoot,
        env: { ...process.env, SOAK_MIN_DURATION_SECONDS: '1' },
      })).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
