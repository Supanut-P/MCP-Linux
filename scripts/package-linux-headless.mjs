import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await import('./build-headless.mjs');
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Headless Linux packaging currently requires Linux x64');

const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const buildDir = path.join(root, 'apps', 'cli', 'build-headless');
const packageRoot = path.join(root, 'dist', 'headless-package');
const appDir = path.join(packageRoot, 'opt', 'baitonghub-linux-mcp');
const debRoot = path.join(root, 'dist', 'headless-deb');
rmSync(packageRoot, { recursive: true, force: true });
rmSync(debRoot, { recursive: true, force: true });
mkdirSync(appDir, { recursive: true });
for (const file of ['mcp-stdio.cjs', 'mcp-http.cjs', 'admin.cjs', 'baitonghub-linux-mcp-node', 'baitonghub-linux-mcp']) {
  copyFileSync(path.join(buildDir, file), path.join(appDir, file));
}
for (const [source, destination] of [
  ['scripts/install-linux-tunnel-client.sh', 'install-linux-tunnel-client.sh'],
  ['scripts/start-baitonghub-linux-mcp-tunnel.sh', 'start-baitonghub-linux-mcp-tunnel.sh'],
  ['scripts/configure-linux-tunnel.sh', 'configure-linux-tunnel.sh'],
]) {
  copyTextFileWithLf(path.join(root, source), path.join(appDir, destination));
}
for (const file of ['baitonghub-linux-mcp-node', 'baitonghub-linux-mcp', 'install-linux-tunnel-client.sh', 'start-baitonghub-linux-mcp-tunnel.sh', 'configure-linux-tunnel.sh']) chmodSync(path.join(appDir, file), 0o755);
mkdirSync(path.join(packageRoot, 'usr', 'bin'), { recursive: true });
symlinkSync('/opt/baitonghub-linux-mcp/baitonghub-linux-mcp', path.join(packageRoot, 'usr', 'bin', 'baitonghub-linux-mcp'));
mkdirSync(path.join(packageRoot, 'usr', 'sbin'), { recursive: true });
symlinkSync('/opt/baitonghub-linux-mcp/configure-linux-tunnel.sh', path.join(packageRoot, 'usr', 'sbin', 'baitonghub-linux-mcp-tunnel-init'));
mkdirSync(path.join(packageRoot, 'lib', 'systemd', 'system'), { recursive: true });
writeFileSync(path.join(packageRoot, 'lib', 'systemd', 'system', 'baitonghub-linux-mcp@.service'), `[Unit]\nDescription=Baitonghub-Linux-mcp headless MCP HTTP server\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nUser=%i\nEnvironmentFile=-/home/%i/.config/baitonghub-linux-mcp/server.env\nExecStart=/usr/bin/baitonghub-linux-mcp mcp --http\nRestart=on-failure\nRestartSec=3\nNoNewPrivileges=true\nPrivateTmp=true\n\n[Install]\nWantedBy=multi-user.target\n`, 'utf8');
copyTextFileWithLf(
  path.join(root, 'packaging', 'linux-headless', 'baitonghub-linux-mcp-tunnel@.service'),
  path.join(packageRoot, 'lib', 'systemd', 'system', 'baitonghub-linux-mcp-tunnel@.service'),
);

const tarPath = path.join(root, 'dist', `Baitonghub-Linux-mcp-${version}-linux-x64.tar.gz`);
mkdirSync(path.dirname(tarPath), { recursive: true });
const tar = spawnSync('tar', ['-czf', tarPath, '-C', packageRoot, 'opt', 'usr', 'lib'], { encoding: 'utf8' });
if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr || 'unknown error'}`);

mkdirSync(path.join(debRoot, 'DEBIAN'), { recursive: true });
for (const directory of ['opt', 'usr', 'lib']) copyTree(path.join(packageRoot, directory), path.join(debRoot, directory));
writeFileSync(path.join(debRoot, 'DEBIAN', 'control'), `Package: baitonghub-linux-mcp\nVersion: ${version}\nSection: utils\nPriority: optional\nArchitecture: amd64\nMaintainer: Baitonghub\nDepends: ca-certificates, curl, git, ripgrep, unzip, libsecret-1-0, libsecret-tools\nDescription: Baitonghub-Linux-mcp headless MCP server\n Linux CLI and MCP STDIO/HTTP runtime for Ubuntu 24.04 x64.\n`, 'utf8');
writeFileSync(path.join(debRoot, 'DEBIAN', 'postinst'), `#!/bin/sh\nset -eu\nupdate-alternatives --remove-all baitonghub-linux-mcp 2>/dev/null || true\nln -sfn /opt/baitonghub-linux-mcp/baitonghub-linux-mcp /usr/bin/baitonghub-linux-mcp\nif command -v systemctl >/dev/null 2>&1; then systemctl daemon-reload || true; fi\nexit 0\n`, { encoding: 'utf8', mode: 0o755 });
const debPath = path.join(root, 'dist', `Baitonghub-Linux-mcp-${version}-amd64.deb`);
const deb = spawnSync('dpkg-deb', ['--build', '--root-owner-group', debRoot, debPath], { encoding: 'utf8' });
if (deb.status !== 0) throw new Error(`dpkg-deb failed: ${deb.stderr || 'unknown error'}`);

const checksums = [tarPath, debPath].map((file) => `${createHash('sha256').update(readFileSync(file)).digest('hex')}  ${path.basename(file)}`).join('\n') + '\n';
writeFileSync(path.join(root, 'dist', `Baitonghub-Linux-mcp-${version}-SHA256SUMS`), checksums, 'utf8');
process.stdout.write(`Headless packages written to ${path.join(root, 'dist')}\n${checksums}`);

function copyTree(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readDir(source)) {
    const from = path.join(source, entry);
    const to = path.join(destination, entry);
    const stat = statPath(from);
    if (stat.isDirectory()) copyTree(from, to);
    else if (stat.isSymbolicLink()) symlinkSync(readlinkPath(from), to);
    else copyFileSync(from, to);
  }
}
function copyTextFileWithLf(source, destination) {
  writeFileSync(destination, readFileSync(source, 'utf8').replace(/\r\n?/g, '\n'), 'utf8');
}
function readDir(directory) { return (awaitImportFs()).readdirSync(directory); }
function statPath(file) { return (awaitImportFs()).lstatSync(file); }
function readlinkPath(file) { return (awaitImportFs()).readlinkSync(file); }
function awaitImportFs() { return requireFs; }
import * as requireFs from 'node:fs';
