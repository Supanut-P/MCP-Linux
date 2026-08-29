<p align="center">
  <img src="assets/logo/logo-256x256.png" width="152" alt="Baitonghub-Linux-mcp" />
</p>

<h1 align="center">Baitonghub-Linux-mcp</h1>

<p align="center">
  <strong>Headless MCP runtime for trusted work on Linux</strong><br />
  Ubuntu 24.04 x64 · STDIO and HTTP · Secure workspace boundaries · OpenAI Secure MCP Tunnel
</p>

<p align="center">
  <a href="https://github.com/Supanut-P/MCP-Linux/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/Supanut-P/MCP-Linux" /></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-149647" /></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-Ubuntu%2024.04%20x64-E95420" />
  <img alt="Runtime" src="https://img.shields.io/badge/runtime-headless-0B3D2E" />
</p>

---

## Overview

Baitonghub-Linux-mcp lets an MCP client work with a Linux machine through a
controlled local runtime. It is intended for repository maintenance, coding,
testing, Git workflows, command execution, and long-running development tasks.

The v0.5.0 release is **headless**. It does not require Electron, a desktop
session, Chrome, Wayland, X11, or a system-installed Node.js runtime.

### What it can do

- Register trusted workspace roots.
- Inspect, search, create, and update files inside those roots.
- Read Git status, diffs, history, branches, and repository metadata.
- Run foreground and owned background processes.
- Stream logs, wait for jobs, cancel owned process groups, and collect exit
  results.
- Expose MCP over STDIO or authenticated Streamable HTTP.
- Store audit, checkpoint, backup, and runtime state in Linux XDG locations.
- Connect ChatGPT through the official outbound-only OpenAI Secure MCP Tunnel.
- Read bounded Linux observability data through `system_info`, `journal`, and
  `network` without composing a generic shell command.
- Inspect and deliberately administer systemd services through `service`.
- Inspect Debian packages and run bounded, previewed apt changes through
  `package`.
- Create and manage user-only systemd timers through `schedule`.
- Inspect and operate a registered Compose project through `container` (Docker
  first, Podman fallback) with confirmation-gated lifecycle actions.
- Create, inspect, and extract bounded tar/tar.gz/zip archives through `archive`
  with traversal and symlink checks.
- Run read-only lockfile-selected dependency audits through `dependency_audit`
  without upgrade authority.
- Inspect registered SQLite, PostgreSQL, and MySQL targets through `db_inspect`
  and bounded read-only `db_query` calls.
- Inspect explicitly registered Linux SSH hosts through `remote_host`; remote
  mutations require a preview hash, audit workspace ID, and confirmation.

### Security model

`full` means the complete advertised tool profile **inside registered roots**.
It never means unrestricted access to the Linux machine.

The runtime keeps these hard blocks:

- no automatic registration of `/`;
- no `sudo` or root escalation;
- no shutdown, disk formatting, or mounting;
- no workspace-root deletion;
- no symlink escape outside registered roots; and
- no termination of processes the runtime does not own.

Secrets are loaded through protected environment or systemd credential inputs.
They are redacted from stdout, application logs, audit records, and diagnostics.

## Supported platform

| Item | v0.5 support |
| --- | --- |
| Operating system | Ubuntu 24.04 LTS |
| Architecture | x86_64 / amd64 |
| User interface | Headless |
| MCP transports | STDIO, Streamable HTTP |
| ChatGPT connection | OpenAI Secure MCP Tunnel |
| Packages | DEB, Linux x64 tarball |

ARM64, RPM, GUI automation, Windows migration, and unrestricted root access are
outside the v0.5 release contract.

## Install

Download the latest package from
[GitHub Releases](https://github.com/Supanut-P/MCP-Linux/releases/latest).

The v0.5 administration tools add bounded, explicitly confirmed mutations. They
use `systemctl`, `apt`, `apt-cache`, and `dpkg-query` with fixed argv and never
compose a shell command. Observability tools remain read-only and use `journalctl`, `ip`, `ss`,
and `df` when those Ubuntu dependencies are available; a missing binary
returns structured `CAPABILITY_UNAVAILABLE` instead of a false success.

### Ubuntu DEB

```sh
 curl -LO https://github.com/Supanut-P/MCP-Linux/releases/download/v0.5.0/Baitonghub-Linux-mcp-0.5.0-amd64.deb
 curl -LO https://github.com/Supanut-P/MCP-Linux/releases/download/v0.5.0/Baitonghub-Linux-mcp-0.5.0-SHA256SUMS
 sha256sum --check --ignore-missing Baitonghub-Linux-mcp-0.5.0-SHA256SUMS
 sudo apt install ./Baitonghub-Linux-mcp-0.5.0-amd64.deb
```

### Linux x64 tarball

```sh
 curl -LO https://github.com/Supanut-P/MCP-Linux/releases/download/v0.5.0/Baitonghub-Linux-mcp-0.5.0-linux-x64.tar.gz
 tar -xzf Baitonghub-Linux-mcp-0.5.0-linux-x64.tar.gz
```

## Quick start: local STDIO

Choose one repository or project directory as the trusted root:

```sh
export BAITONGHUB_LINUX_MCP_WORKSPACE="$PWD"
export BAITONGHUB_LINUX_MCP_ALLOWED_ROOTS="$PWD"
export BAITONGHUB_LINUX_MCP_STRICT_ROOTS=1
export BAITONGHUB_LINUX_MCP_CHECKPOINT_KEY_BASE64="$(openssl rand -base64 32)"

baitonghub-linux-mcp mcp --stdio
```

The CLI writes MCP protocol messages to stdout. Operational output is kept away
from the protocol stream.

## Streamable HTTP

Loopback is the safe default:

```sh
export BAITONGHUB_LINUX_MCP_WORKSPACE=/srv/mcp-workspace
export BAITONGHUB_LINUX_MCP_ALLOWED_ROOTS=/srv/mcp-workspace
export BAITONGHUB_LINUX_MCP_STRICT_ROOTS=1
export BAITONGHUB_LINUX_MCP_HTTP_PORT=18765
export BAITONGHUB_LINUX_MCP_CHECKPOINT_KEY_BASE64="$(openssl rand -base64 32)"

baitonghub-linux-mcp mcp --http
```

To bind a LAN address, configure all of the following:

```sh
export BAITONGHUB_LINUX_MCP_HTTP_HOST=0.0.0.0
export BAITONGHUB_LINUX_MCP_HTTP_TOKEN='replace-with-a-long-random-token'
export BAITONGHUB_LINUX_MCP_HTTP_ALLOWED_HOSTS='linuxmcp.example.com'
export BAITONGHUB_LINUX_MCP_HTTP_ALLOWED_ORIGINS='https://chatgpt.com'
```

Do not expose an unauthenticated MCP listener to the Internet.

## ChatGPT through Secure MCP Tunnel

Baitonghub-Linux-mcp supports the official OpenAI `tunnel-client`. The tunnel
opens an outbound connection and launches the packaged STDIO server as its MCP
child. No public inbound port is required.

Install the verified client from the DEB installation:

```sh
sudo /opt/baitonghub-linux-mcp/install-linux-tunnel-client.sh
```

Create root-only credential files, initialize the tunnel profile, and enable the
service:

```sh
sudo baitonghub-linux-mcp-tunnel-init <linux-user> <tunnel-id>
sudo systemctl enable --now baitonghub-linux-mcp-tunnel@<linux-user>.service
sudo systemctl status baitonghub-linux-mcp-tunnel@<linux-user>.service
```

The packaged service uses systemd credentials so the runtime key is not stored
in the tunnel YAML, command line, or repository. See
[HEADLESS_LINUX.md](HEADLESS_LINUX.md) for the complete operator procedure.

Cloudflare or another reverse proxy is optional and remains external to this
project. If you use one, keep MCP authentication enabled.

## Linux data locations

| Data | Default path |
| --- | --- |
| Application data | `${XDG_DATA_HOME:-~/.local/share}/baitonghub-linux-mcp` |
| Configuration | `${XDG_CONFIG_HOME:-~/.config}/baitonghub-linux-mcp` |
| State and logs | `${XDG_STATE_HOME:-~/.local/state}/baitonghub-linux-mcp` |

## Build from source

Requirements:

- Ubuntu 24.04 x64
- Node.js 24.x
- Corepack

```sh
corepack enable
corepack pnpm@10.15.0 install --frozen-lockfile
corepack pnpm@10.15.0 build:headless
```

Build release packages:

```sh
corepack pnpm@10.15.0 package:linux:headless
```

Artifacts are written to `dist/`.

## Verification

```sh
corepack pnpm@10.15.0 lint
corepack pnpm@10.15.0 typecheck
corepack pnpm@10.15.0 test
corepack pnpm@10.15.0 test:integration
corepack pnpm@10.15.0 test:packaging
corepack pnpm@10.15.0 test:release-gate
corepack pnpm@10.15.0 docs:tools:check
git diff --check
```

Ubuntu release evidence and the VM acceptance checklist are recorded in
[docs/linux/UBUNTU_ACCEPTANCE.md](docs/linux/UBUNTU_ACCEPTANCE.md).

## Repository layout

```text
apps/cli/                    Headless CLI and release packaging
packages/mcp-server/         MCP transports and tool registry
packages/capabilities/       Linux capability composition and policies
packages/filesystem/         Registered-root filesystem boundary
packages/process/            Owned process lifecycle
packages/storage/            SQLite runtime state
scripts/                     Packaging, service, and tunnel helpers
tests/                       Integration, packaging, and release gates
docs/linux/                  Linux architecture and acceptance evidence
```

## Contributing

Contributions should preserve the Linux trust boundary and include the smallest
test that proves the change. Read [CONTRIBUTING.md](CONTRIBUTING.md) and
[SECURITY.md](SECURITY.md) before opening a change.

## License

Baitonghub-Linux-mcp is distributed under the MIT License. See [LICENSE](LICENSE).
Third-party notices for incorporated components are kept separately in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
