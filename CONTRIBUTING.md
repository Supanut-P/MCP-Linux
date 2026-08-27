# Contributing to Baitonghub-Linux-mcp

Thank you for helping improve the Baitonghub Linux MCP runtime.

## Project scope

The v0.1 product is a headless Ubuntu 24.04 x64 service. Changes should keep the
runtime usable without Electron, a display server, or system Node.js.

The security boundary is part of the product contract:

- operate only inside explicitly registered workspace roots;
- reject symlink escapes;
- keep root escalation and machine-level destructive operations blocked;
- terminate only runtime-owned process groups; and
- never place credentials in logs, audit records, diagnostics, argv, or Git.

## Development setup

Requirements:

- Ubuntu 24.04 x64
- Node.js 24.x
- Git and Corepack

```sh
corepack enable
corepack pnpm@10.15.0 install --frozen-lockfile
```

Do not update the pinned package manager or lockfile as part of an unrelated
change.

## Making a change

1. Keep the change focused.
2. Add the smallest test that fails without the change.
3. Preserve permission, registered-root, secret-redaction, and process-ownership
   checks.
4. Do not add machine-specific paths, credentials, tunnel IDs, or private logs.
5. Update public documentation when behavior or installation changes.

## Verification

Run the checks relevant to the change. Before a release, run the complete Linux
gate:

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

Package verification must be performed on Ubuntu 24.04 x64. Inspect the DEB
and tarball before publishing and verify the installed STDIO MCP launcher.

## Pull requests

Include:

- what changed and why;
- user-visible and security impact;
- commands run and their results; and
- migration or rollback notes when state formats change.

Security vulnerabilities must follow [SECURITY.md](SECURITY.md), not the public
issue tracker. By contributing, you agree to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).
