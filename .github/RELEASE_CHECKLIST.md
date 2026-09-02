# Baitonghub-Linux-mcp release checklist

**Current version:** `v1.23.0`
**Target:** Ubuntu 24.04 LTS x64, headless

**Evidence note:** The product owner waived the seven-day soak on 2026-09-01
to continue version development. `v1.5.0` makes no production-readiness claim;
the machine-checked waiver is tracked at
`docs/linux/evidence/v1.5.0/SEVEN_DAY_SOAK_WAIVER.md`.

## Source verification

- [ ] Clean install completes with the pinned lockfile.
- [ ] Branding contract, lint, typecheck, full tests, integration tests,
      packaging tests, release gate, and generated tool catalog pass.
- [ ] `git diff --check` passes.
- [ ] No secret, API key, tunnel key, tunnel ID, private path, or runtime database
      is tracked.

## Security evidence

- [ ] Registered-root traversal and symlink escape tests fail closed.
- [ ] `/` is not registered automatically.
- [ ] Root escalation, shutdown, format, mount, workspace-root deletion, and
      unowned process termination remain blocked.
- [ ] Secret redaction covers stdout, logs, audit, diagnostics, and command
      arguments.
- [ ] Owned background process group cancellation is verified.
- [ ] Non-loopback Streamable HTTP requires bearer and Host checks.
- [ ] Support bundle dry-run/confirmation, redaction, 2 MiB cap, and 200-event
      cap pass with secret-canary fixtures.

## Ubuntu runtime evidence

- [ ] STDIO MCP handshake and tool listing pass on Ubuntu 24.04 x64.
- [ ] Streamable HTTP health and MCP calls pass.
- [ ] MCP Tasks task-augmented `shell` creation, reconnect, result, and cancel
      pass without exposing a resume token.
- [ ] File, search, Git, shell, logs, wait, cancel, checkpoint, backup, and audit
      flows pass inside a disposable workspace.
- [ ] `audit_query` returns owner-scoped, bounded, redacted summaries without
      command lines, paths, environments, client identity, or secrets.
- [ ] Multi-workspace ownership and isolation pass.

## Package evidence

- [ ] Build the amd64 DEB, Linux x64 tarball, and SHA-256 manifest on Ubuntu.
- [ ] Verify every checksum.
- [ ] Inspect both packages and reject `.exe`, `.cmd`, `.bat`, `.ps1`, Electron,
      Windows OCR, or Windows-native runtime helpers.
- [ ] Install the DEB on a clean Ubuntu VM.
- [ ] Run the installed-package smoke without system Node.js.

## Secure MCP Tunnel evidence

- [ ] Initialize with an operator-supplied tunnel ID and runtime key.
- [ ] Verify the systemd service is `active` and health reports `ready`.
- [ ] Call `health`, `workspace_list`, and a workspace read tool through ChatGPT.
- [ ] Restart the service and verify reconnect.
- [ ] Confirm the runtime key is absent from YAML, argv, stdout, journal, audit,
      and diagnostics.

Publish only artifacts built from the exact commit referenced by the release
tag.
