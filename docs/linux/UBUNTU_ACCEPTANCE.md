# Ubuntu 24.04 release acceptance

This checklist is the release gate for Baitonghub-Linux-mcp v0.2. It must run on
an x86_64 Ubuntu 24.04 VM, not only on a development host.

## Source gate

```sh
corepack pnpm@10.15.0 install --frozen-lockfile
corepack pnpm@10.15.0 lint
corepack pnpm@10.15.0 typecheck
corepack pnpm@10.15.0 test
corepack pnpm@10.15.0 test:integration
corepack pnpm@10.15.0 test:packaging
corepack pnpm@10.15.0 test:release-gate
corepack pnpm@10.15.0 docs:tools:check
git diff --check
```

## Runtime gate

- Register a non-root project root.
- Prove tree, read, write, patch, and search operations inside that root.
- Reject `/etc`, another user's home, and a symlink escape.
- Prove Git status, diff, and log.
- Prove foreground and background commands, logs, wait, cancel, and owned
  process-group cleanup.
- Prove STDIO and loopback HTTP MCP.
- Prove SQLite audit, checkpoint, and backup flows.
- Confirm secrets are absent from stdout, logs, audit, and diagnostics.

## v0.2 observability gate

- Run `system_info` summary, CPU, memory, disk, processes, and ports.
- Run `journal` for a valid unit and verify line limits and credential redaction.
- Run `network` for interfaces, routes, DNS, listeners, and localhost
  connectivity.
- Remove or mask one of `journalctl`, `ip`, `ss`, or `df` in a disposable test
  environment and verify the matching operation returns
  `CAPABILITY_UNAVAILABLE` without claiming success.
- Verify invalid systemd units, oversized line/row requests, and cancelled
  commands fail closed.

## Package gate

```sh
corepack pnpm@10.15.0 package:linux:headless
sha256sum --check dist/Baitonghub-Linux-mcp-0.2.0-SHA256SUMS
sudo apt install ./dist/Baitonghub-Linux-mcp-0.2.0-amd64.deb
```

- Run the installed STDIO launcher without system Node.js.
- Confirm the DEB metadata reports version `0.2.0` and architecture `amd64`.
- Inspect the DEB and tarball and reject `.exe`, `.cmd`, `.bat`, `.ps1`,
  Electron, and Windows OCR runtime files.
- Confirm service scripts never print runtime or checkpoint credentials.

## Secure tunnel gate

- Initialize a profile with a valid tunnel ID and runtime key.
- Start the systemd service and verify `active` and tunnel health `ready`.
- Call `health`, `workspace_list`, and one workspace read tool through ChatGPT.
- Restart the service and verify reconnect.
- Confirm credentials are absent from the profile YAML, process arguments,
  stdout, service journal, MCP audit, and incident diagnostics.

Publishing is allowed only after these gates pass and the release artifacts are
built from the commit referenced by the release tag.
