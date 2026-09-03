# Baitonghub-Linux-mcp v1.28 Workspace Snapshot Diff Plan

> **For agentic workers:** Use the executing-plans workflow task-by-task and
> stop at the human gate before any external push, tag, or release.

**Goal:** Add a read-only `workspace_snapshot` diff operation so an MCP client
can compare two bounded manifests without receiving file contents or absolute
paths.

**Architecture:** Reuse `WorkspaceSnapshotService` and its registered-root,
realpath, symlink, cursor, hash, owner, and serialized-byte boundaries. A diff
accepts a unique relative POSIX baseline manifest, obtains a fresh bounded
manifest, and returns only added, removed, changed, unchanged, and truncation
state. It never mutates files or widens workspace authority.

## Tasks

- [x] Lock the schema and service contract with focused regression tests for
  diff classification, duplicate baselines, traversal, and absolute paths.
- [x] Implement bounded diff projection and fail-closed input normalization.
- [x] Update version metadata, README, headless documentation, checklist, and
  release notes while keeping the v1 tool name and permission unchanged.
- [x] Run the full local and Ubuntu VM103 gates, build exact-commit DEB/tar
  artifacts, record checksums/provenance, and pause before external release.

VM103 evidence: `GATE_EXIT=0`, `PACKAGE_EXIT=0`; capabilities `121/121`,
mcp-server `271/271`, CLI `18/18`, integration `3/3`, packaging `15/15`,
release `10/10`, acceptance `5/5`, catalog/contract `225`. Packaged smoke
exercised the diff operation (`snapshotDiffUnchanged=10`). Source commit
`eeafd825baaa9699f491e61b3130bfd7e27a0b3a`; source archive SHA-256
`f8a2b1029019f325f4e5e90207e7c5ec2a714d4f74c564d64ad57a8b77c358f0`; DEB
SHA-256 `2ceb47850105e1333330bd2f23862b71275bfd262330bf84be61c20bfd56b34a`;
Linux x64 tar SHA-256
`a4f2306844fd072003196ce6a76531e11bd00c4e52d73fc8e7bd594f82f85594`.

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
