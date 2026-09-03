# Baitonghub-Linux-mcp v1.34 Workspace Checkpoint Prune Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give an owner an explicit, safe way to reclaim expired workspace-checkpoint metadata without touching the workspace filesystem.

**Architecture:** Extend the existing `workspace_checkpoint` tool with an additive `operation: "prune"`. The service calls the existing owner-scoped `pruneExpired` repository method exactly once and returns a deterministic deletion count. Other operations keep their current automatic expiry cleanup behavior.

**Safety:** `prune` accepts no workspace ID, path, checkpoint ID, or caller-selected age. It can delete only records already past their stored expiry for the authenticated owner fingerprint. It never scans files, invokes processes, contacts remote hosts, or changes a workspace. The operation remains auditable under the existing tool activity record.

## Tasks

### Task 1: Contract and tests

- [ ] Add `prune` input/output types and strict schema validation.
- [ ] Add service tests for owner isolation, expired-only deletion, idempotence, and rejection of unrelated fields.
- [ ] Add tool, generated catalog/contract, and packaged-smoke coverage.
- [ ] Run the focused suite and record the result.

### Task 2: Implement bounded retention cleanup

- [ ] Reuse the existing repository `pruneExpired(ownerKey, now)` method and return `{ operation: "prune", deleted }`.
- [ ] Preserve automatic cleanup for create/list/get/diff/compare/delete without double-deleting.
- [ ] Keep output deterministic and bounded; no record details or absolute paths are returned.

### Task 3: Version and documentation

- [ ] Bump workspace packages to `1.34.0`.
- [ ] Update README, `HEADLESS_LINUX.md`, release notes, roadmap, and release checklist.
- [ ] Run focused tests, full local gates, generated checks, and `git diff --check`.

### Task 4: Ubuntu proof and evidence

- [ ] Build/test the exact commit on Ubuntu VM103, including package smoke, package inspection, provenance, and upgrade/rollback preflight.
- [ ] Copy artifacts/logs under `dist/v1.34.0-ubuntu-vm103/`, record gate counts and SHA-256 values, and commit proof only.
- [ ] Stop before push/tag/release; the seven-day soak remains waived.

## Definition of done

- [ ] `workspace_checkpoint prune` deletes only expired records for the authenticated owner.
- [ ] A repeated prune is idempotent and returns zero after cleanup.
- [ ] No filesystem, process, secret, or remote authority is added.
- [ ] Local and Ubuntu unit/integration/package/release/catalog/contract/rebrand gates pass.
- [ ] DEB/tar smoke and forbidden-file inspection pass from the exact source commit.
