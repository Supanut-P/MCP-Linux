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
- [ ] Run the full local and Ubuntu VM103 gates, build exact-commit DEB/tar
  artifacts, record checksums/provenance, and pause before external release.

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
