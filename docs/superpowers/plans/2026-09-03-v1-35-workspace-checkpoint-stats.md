# Baitonghub-Linux-mcp v1.35 Workspace Checkpoint Stats Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an owner inspect checkpoint metadata quota usage before starting another capture, without exposing checkpoint contents or filesystem paths.

**Architecture:** Extend the existing `workspace_checkpoint` tool with an additive `operation: "stats"`. After the normal owner-scoped expiry cleanup, the service reads the existing repository count and byte totals and returns fixed quota limits plus remaining capacity.

**Safety:** `stats` accepts no workspace ID, path, checkpoint ID, or caller-selected filter. It returns only bounded numeric metadata for the authenticated owner. It never scans files, invokes processes, contacts remote hosts, or changes workspace contents. Expired records are cleaned using the same existing owner-scoped repository method used by other checkpoint operations.

## Tasks

### Task 1: Contract and tests

- [x] Add `stats` input/output types and strict schema validation.
- [x] Add service tests for owner isolation, quota totals, expiry cleanup, and rejection of unrelated fields.
- [x] Add tool, generated catalog/contract, and packaged-smoke coverage.
- [x] Run the focused suite and record the result: 16/16 focused tests passed.

### Task 2: Implement bounded quota reporting

- [x] Reuse `count(ownerKey)` and `totalBytes(ownerKey)` after expiry cleanup.
- [x] Return fixed `maxRecords`/`maxBytes` and non-negative remaining capacity.
- [x] Keep output deterministic and numeric-only; never return record names, paths, IDs, or entries.

### Task 3: Version and documentation

- [x] Bump workspace packages to `1.35.0`.
- [x] Update README, `HEADLESS_LINUX.md`, release notes, roadmap, and release checklist.
- [x] Run focused tests, full local gates, generated checks, and `git diff --check`.

### Task 4: Ubuntu proof and evidence

- [x] Build/test the exact commit on Ubuntu VM103, including package smoke, package inspection, provenance, and upgrade/rollback preflight.
- [x] Copy artifacts/logs under `dist/v1.35.0-ubuntu-vm103/`, record gate counts and SHA-256 values, and commit proof only.
- [x] Stop before push/tag/release; the seven-day soak remains waived.

## Definition of done

- [x] `workspace_checkpoint stats` reports only the authenticated owner's bounded quota usage.
- [x] Expired records are not counted after the operation's cleanup pass.
- [x] No filesystem, process, secret, or remote authority is added.
- [x] Local and Ubuntu unit/integration/package/release/catalog/contract/rebrand gates pass.
- [x] DEB/tar smoke and forbidden-file inspection pass from the exact source commit.

## v1.35.0 proof

Commit `f436a0ae7290b4f8e3908f3c7b1bbe2f8375d923` was built from a clean
source archive and verified on Ubuntu 24.04 x64 VM103. The full unit gate passed
in 17 projects: capabilities `24 files / 121 tests`, mcp-server `53 files /
287 tests`, and CLI `7 files / 18 tests`; integration passed `3/3`, packaging
`15/15`, release gate `10/10`, acceptance `5/5`, catalog/contract `227`, and
rebrand passed. Packaged smoke reported `toolCount=221`,
`workspaceCheckpointStatsCount=1`, `workspaceCheckpointEntries=10`,
`workspaceCheckpointDiffUnchanged=10`, `workspaceCheckpointCompareUnchanged=10`,
and `workspaceCheckpointPruned=0`. DEB/tar package inspection and
upgrade/rollback preflight passed. The seven-day soak remains waived.

Artifacts and logs are retained under `dist/v1.35.0-ubuntu-vm103/`:

- Source archive SHA-256: `39569dd4a24ccda76080c3b3ec1808ad0b9f8c7c1f2dea53c2f86e6254c85d8a`
- DEB SHA-256: `a6487a7379859de480ac86857cad7de9ab64d382fba5a93f47db9dd345690ac8`
- Linux x64 tar SHA-256: `2fc8587718fb6acb1f83b93208c9bd6857de1af5efa0bde9f1ea64f2e2831d80`
- VM gate summary: `dist/v1.35.0-ubuntu-vm103/v135-gates-summary.out`
- Package inspection: `dist/v1.35.0-ubuntu-vm103/v135-verify-package.out`
- Upgrade/rollback: `dist/v1.35.0-ubuntu-vm103/v135-upgrade-rollback.out`
