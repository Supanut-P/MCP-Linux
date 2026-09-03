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

- [ ] Lock the schema/service/packaged smoke contract with tests for usage
  totals, cancellation, invalid fields, and registry parsing.
- [ ] Implement the bounded usage projection and fail-closed input rules.
- [ ] Update version metadata, README, headless documentation, checklist,
  release notes, roadmap, and v1 fixture.
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
