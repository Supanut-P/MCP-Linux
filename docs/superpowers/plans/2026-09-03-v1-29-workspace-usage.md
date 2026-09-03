# Baitonghub-Linux-mcp v1.29 Workspace Usage Plan

> **For agentic workers:** Use the executing-plans workflow task-by-task and
> stop at the human gate before any external push, tag, or release.

**Goal:** Add a read-only `workspace_snapshot` usage operation so an MCP client
can check bounded file count and byte usage before a larger workflow.

**Architecture:** Reuse the existing registered-root provider, canonical path
and symlink checks, regular-file-only scanner, 50,000-entry scan bound, owner
context, cancellation, and truthful truncation result. Usage sums metadata from
the bounded candidate scan without materializing file contents or returning
absolute paths. It adds no write, process, remote, or secret authority.

## Tasks

- [x] Lock the schema/service/packaged smoke contract with tests for usage
  totals, cancellation, invalid fields, and registry parsing.
- [x] Implement the bounded usage projection and fail-closed input rules.
- [x] Update version metadata, README, headless documentation, checklist,
  release notes, roadmap, and v1 fixture.
- [x] Run the full local and Ubuntu VM103 gates, build exact-commit DEB/tar
  artifacts, record checksums/provenance, and pause before external release.

## Proof recorded

Feature commit: `74de5d6d7ebf50c362178ec3b4d3e129abf80fd1`.
Ubuntu VM103 (Ubuntu 24.04.4 LTS x64, Node v24.14.0) passed capabilities
121/121, mcp-server 272/272, CLI 18/18, integration 3/3, packaging 15/15,
release gate 10/10, catalog/contract 225, and v1 acceptance 5/5. Packaged
smoke passed for DEB and tar with `toolCount=219`, `snapshotDiffUnchanged=10`,
`snapshotDiffTruncated=true`, `snapshotUsageFileCount=17`, and
`snapshotUsageTruncated=false`.

Source archive SHA-256:
`3ebace9cd2c1fbc57947147c24a7ca184ac9da4ba2e548840bd0201968bf60ff`.
DEB SHA-256:
`aca75aeb79ef69c4c140ea52821d47292faf66253bfe5ea657575941eb57b742`.
Linux x64 tar SHA-256:
`53df1b32a8757389e0c46776ddd69e81447d35a9f385a2a98753ea2656a221fc`.
The seven-day soak was waived and no external push, tag, or release was made.

## Verification commands

```bash
corepack pnpm@10.15.0 lint
corepack pnpm@10.15.0 typecheck
corepack pnpm@10.15.0 test
corepack pnpm@10.15.0 test:integration
corepack pnpm@10.15.0 test:packaging
corepack pnpm@10.15.0 test:release-gate
corepack pnpm@10.15.0 docs:tools:check
corepack pnpm@10.15.0 contract:v1
corepack pnpm@10.15.0 test:v1
git diff --check
```
