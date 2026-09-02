import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..', '..');

describe('headless Linux Secure MCP Tunnel packaging', () => {
  it('installs the latest official client only after checksum verification', async () => {
    const installer = await readFile(path.join(root, 'scripts', 'install-linux-tunnel-client.sh'), 'utf8');
    expect(installer).toContain('openai/tunnel-client/releases/latest');
    expect(installer).toContain('SHA256SUMS.txt');
    expect(installer).toContain('sha256sum --check');
    expect(installer).not.toMatch(/tunnel-client-v\d/);
    expect(installer).not.toContain('.exe');
  });

  it('runs the tunnel as full strict-root stdio with systemd credentials', async () => {
    const launcher = await readFile(path.join(root, 'scripts', 'start-baitonghub-linux-mcp-tunnel.sh'), 'utf8');
    const unit = await readFile(path.join(root, 'packaging', 'linux-headless', 'baitonghub-linux-mcp-tunnel@.service'), 'utf8');
    expect(launcher).toContain('BAITONGHUB_LINUX_MCP_STDIO_PROFILE=full');
    expect(launcher).toContain('BAITONGHUB_LINUX_MCP_STRICT_ROOTS=1');
    expect(launcher).toContain('doctor');
    expect(launcher).toContain('exec "$tunnel_client" run');
    expect(unit).toContain('LoadCredential=control_plane_api_key:');
    expect(unit).toContain('LoadCredential=checkpoint_key_base64:');
    expect(unit).toContain('KillMode=control-group');
    expect(unit).toContain('Restart=always');
  });

  it('keeps tunnel identity out of package source and uses the direct stdio launcher', async () => {
    const configure = await readFile(path.join(root, 'scripts', 'configure-linux-tunnel.sh'), 'utf8');
    expect(configure).toContain('sample_mcp_stdio_local');
    expect(configure).toContain('/usr/bin/baitonghub-linux-mcp mcp --stdio');
    expect(configure).toContain('env:CONTROL_PLANE_API_KEY');
    expect(configure).not.toMatch(/tunnel_[a-z0-9]{32}/);
  });

  it('packages tunnel installer dependencies and reloads systemd units', async () => {
    const packager = await readFile(path.join(root, 'scripts', 'package-linux-headless.mjs'), 'utf8');
    expect(packager).toContain('Depends: ca-certificates, curl, git, ripgrep, unzip');
    expect(packager).toContain('systemctl daemon-reload');
  });

  it('normalizes packaged POSIX launchers to LF from any checkout', async () => {
    const packager = await readFile(path.join(root, 'scripts', 'package-linux-headless.mjs'), 'utf8');
    expect(packager).toContain("replace(/\\r\\n?/g, '\\n')");
    expect(packager).toContain('copyTextFileWithLf');
  });

  it('runs the extracted DEB and tar launchers through the same MCP smoke workflow', async () => {
    const verifier = await readFile(path.join(root, 'scripts', 'verify-linux-package.sh'), 'utf8');
    const smoke = await readFile(path.join(root, 'scripts', 'smoke-packaged-mcp.mjs'), 'utf8');
    expect(verifier).toContain('smoke-packaged-mcp.mjs');
    expect(verifier).toContain('run_packaged_smoke deb');
    expect(verifier).toContain('run_packaged_smoke tar');
    expect(smoke).toContain("['mcp', '--stdio', '--workspace', workspace]");
    expect(smoke).toContain("'workspace_list'");
    expect(smoke).toContain("'workspace_register'");
    expect(smoke).toContain("'apply_patch'");
    expect(smoke).toContain("'workspace_snapshot'");
    expect(smoke).toContain("operation: 'manifest'");
    expect(smoke).toContain("'task_events'");
    expect(smoke).toContain("'/usr/bin/printf'");
  });

  it('publishes the tagged release from Ubuntu with headless artifacts only', async () => {
    const workflow = await readFile(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');
    expect(workflow).toContain('runs-on: ubuntu-24.04');
    expect(workflow).toContain('pnpm package:linux:headless');
    expect(workflow).toContain('Baitonghub-Linux-mcp-*-amd64.deb');
    expect(workflow).toContain('Baitonghub-Linux-mcp-*-linux-x64.tar.gz');
    expect(workflow).not.toContain('windows-latest');
    expect(workflow).not.toMatch(/\.exe\s*$/m);
  });
});
