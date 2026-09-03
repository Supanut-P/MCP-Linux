# Baitonghub-Linux-mcp v1.34 Workspace Checkpoint Prune Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give an owner an explicit, safe way to reclaim expired workspace-checkpoint metadata without touching the workspace filesystem.

**Architecture:** Extend the existing `workspace_checkpoint` tool with an additive `operation: "prune"`. The service calls the existing owner-scoped `pruneExpired` repository method exactly once and returns a deterministic deletion count. Other operations keep their current automatic expiry cleanup behavior.

**Safety:** `prune` accepts no workspace ID, path, checkpoint ID, or caller-selected age. It can delete only records already past their stored expiry for the authenticated owner fingerprint. It never scans files, invokes processes, contacts remote hosts, or changes a workspace. The operation remains auditable under the existing tool activity record.

## Tasks

### Task 1: Contract and tests

- [x] Add `prune` input/output types and strict schema validation.
- [x] Add service tests for owner isolation, expired-only deletion, idempotence, and rejection of unrelated fields.
- [x] Add tool, generated catalog/contract, and packaged-smoke coverage.
- [x] Run the focused suite and record the result.

### Task 2: Implement bounded retention cleanup

- [x] Reuse the existing repository `pruneExpired(ownerKey, now)` method and return `{ operation: "prune", deleted }`.
- [x] Preserve automatic cleanup for create/list/get/diff/compare/delete without double-deleting.
- [x] Keep output deterministic and bounded; no record details or absolute paths are returned.

### Task 3: Version and documentation

- [x] Bump workspace packages to `1.34.0`.
- [x] Update README, `HEADLESS_LINUX.md`, release notes, roadmap, and release checklist.
- [x] Run focused tests, full local gates, generated checks, and `git diff --check`.

### Task 4: Ubuntu proof and evidence

- [x] Build/test the exact commit on Ubuntu VM103, including package smoke, package inspection, provenance, and upgrade/rollback preflight.
- [x] Copy artifacts/logs under `dist/v1.34.0-ubuntu-vm103/`, record gate counts and SHA-256 values, and commit proof only.
- [x] Stop before push/tag/release; the seven-day soak remains waived.

**Ubuntu VM103 proof (2026-09-03):** exact source commit
`2f5dc62c4fe2ec05d64cd59ac8db794038418b7b` passed rebrand, lint, typecheck,
unit (capabilities 24 files/121 tests, mcp-server 53 files/286 tests, CLI 7
files/18 tests), integration (3/3), packaging (15/15), release gate (10/10),
catalog/contract (227 tools), v1 acceptance (5/5), and `git diff --check`.
DEB/tar package inspection, provenance generation, packaged smoke, and
upgrade/rollback preflight passed. Packaged smoke reported `toolCount=221`,
`workspaceCheckpointEntries=10`, `workspaceCheckpointDiffUnchanged=10`,
`workspaceCheckpointCompareUnchanged=10`, and `workspaceCheckpointPruned=0`.
SHA-256: source archive
`13cf085516b2417bc4235e20a9e90650e542922f5e50e948d0c1869d55328d84`, DEB
`1e5f60048736cc5760c5bb015cbd274c7e034a0588985507f7b63da4ed84a9bd`, Linux
tar `c6720b0273b02b1a1ee35e7332e2bfbbd43595a1670cd75ba625742745816679`.

## Definition of done

- [x] `workspace_checkpoint prune` deletes only expired records for the authenticated owner.
- [x] A repeated prune is idempotent and returns zero after cleanup.
- [x] No filesystem, process, secret, or remote authority is added.
- [x] Local and Ubuntu unit/integration/package/release/catalog/contract/rebrand gates pass.
- [x] DEB/tar smoke and forbidden-file inspection pass from the exact source commit.
