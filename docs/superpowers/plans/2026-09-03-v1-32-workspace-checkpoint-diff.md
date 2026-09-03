# Baitonghub-Linux-mcp v1.32 Workspace Checkpoint Diff Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent compare a registered workspace with an owner-owned checkpoint without transporting the stored manifest through the client.

**Architecture:** Extend the existing `workspace_checkpoint` tool with a bounded `diff` operation. The service loads the owner-scoped metadata-only checkpoint, delegates the current scan and comparison to `WorkspaceSnapshotService`, and returns the existing sanitized diff shape. No new filesystem authority, persistence format, or file-content read is introduced.

**Safety:** `diff` requires a valid checkpoint ID and uses the checkpoint's registered workspace/path. It never accepts a caller-supplied baseline or alternate workspace. Missing/expired/foreign checkpoints return `FILE_NOT_FOUND`; scanner failures remain structured and sanitized. Existing 256 KiB diff cap and registered-root/symlink protections remain authoritative.

## Tasks

### Task 1: Contract and failing tests

- [x] Extend the input/output types and add a service regression for changed/added/removed files.
- [x] Add schema/tool tests for strict operation-specific `diff` validation.
- [x] Add packaged-smoke coverage for checkpoint diff.
- [x] Run the focused suite after implementation; all 13 tests passed.

### Task 2: Implement owner-scoped diff

- [x] Add normalized `diff` input and output types.
- [x] Load the checkpoint by owner, delegate `operation=diff` with its stored path and entries, and preserve bounded errors.
- [x] Wire the provider type, tool description, and generated catalog/contract.

### Task 3: Version and documentation

- [x] Bump workspace packages to `1.32.0`.
- [x] Update README, `HEADLESS_LINUX.md`, release notes, roadmap, and release checklist.
- [x] Run focused tests, full local gates, generated checks, and `git diff --check`.

### Task 4: Ubuntu proof and evidence

- [x] Build/test the exact commit on Ubuntu VM103, including package smoke, package inspection, provenance, and upgrade/rollback preflight.
- [x] Copy artifacts/logs under `dist/v1.32.0-ubuntu-vm103/`, record tool/test counts and hashes, and commit proof only.
- [x] Stop before push/tag/release; the seven-day soak remains waived.

**Ubuntu VM103 proof (2026-09-03):** exact source commit
`2e7cab22d495189bc0adb60e9888a02a8e770379` passed rebrand, lint, typecheck,
unit (capabilities 24 files/121 tests, mcp-server 53 files/283 tests, CLI 7
files/18 tests; all other workspace projects passed), integration 3/3,
packaging 15/15, release 10/10, catalog/contract 227 tools, v1 acceptance
5/5, and `git diff --check`. DEB/tar package inspection, provenance, and
upgrade/rollback preflight passed. Packaged smoke passed for both artifacts
with `toolCount=221`, `workspaceCheckpointAdvertised=true`,
`workspaceCheckpointEntries=10`, and `workspaceCheckpointDiffUnchanged=10`.
Source archive SHA-256 is
`a0eaab7c816adde4081ad0ab4af734cea3faa497d6bc78a653ed9ba8ae3f1319`;
DEB SHA-256 is
`01b890f861be314b7ec1fabff468e1582af683c6c5c347745b9e9171bcb2bfbc`;
Linux tar SHA-256 is
`80560d5786d8eed0d34e592549631622ac310fbfd4323ad3aad1f64046e10619`.

## Definition of done

- [x] `workspace_checkpoint diff` is owner-isolated and cannot select a different workspace/path than the stored checkpoint.
- [x] Diff output is bounded, metadata-only, and uses truthful `truncated`/sanitized failure states.
- [x] Local and Ubuntu unit/integration/package/release/catalog/contract/rebrand gates pass.
- [x] DEB/tar smoke and forbidden-file inspection pass from the exact source commit.
