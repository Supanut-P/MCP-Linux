# Baitonghub-Linux-mcp v1.33 Workspace Checkpoint Compare Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent compare two saved workspace checkpoints without rescanning the filesystem or moving either manifest through the client.

**Architecture:** Extend the existing `workspace_checkpoint` tool with a bounded `compare` operation. The service loads two checkpoints under the authenticated owner fingerprint, requires the same registered workspace and relative path, and compares their metadata entries in memory. The result reuses the existing snapshot diff shape and serialization cap.

**Safety:** `compare` accepts only two checkpoint IDs and `maxEntries`; it does not accept a workspace ID, path, or caller-supplied baseline. Foreign, missing, or expired checkpoints return `FILE_NOT_FOUND`. Cross-workspace/path comparisons fail closed. No filesystem, process, secret, or remote authority is added.

## Tasks

### Task 1: Contract and tests

- [x] Extend the input/output types and add a service regression for added/removed/changed metadata.
- [x] Add strict schema/tool tests for `compare` and cross-workspace rejection.
- [x] Add packaged-smoke coverage for checkpoint compare.
- [x] Run the focused suite after implementation and record the result.

### Task 2: Implement bounded owner-scoped comparison

- [x] Load both owner-scoped records and reject workspace/path mismatches.
- [x] Compare sorted metadata with the existing 256 KiB/truncation semantics.
- [x] Wire tool descriptions and generated catalog/contract fixtures.

### Task 3: Version and documentation

- [x] Bump workspace packages to `1.33.0`.
- [x] Update README, `HEADLESS_LINUX.md`, release notes, roadmap, and release checklist.
- [x] Run focused tests, full local gates, generated checks, and `git diff --check`.

### Task 4: Ubuntu proof and evidence

- [x] Build/test the exact commit on Ubuntu VM103, including package smoke, package inspection, provenance, and upgrade/rollback preflight.
- [x] Copy artifacts/logs under `dist/v1.33.0-ubuntu-vm103/`, record tool/test counts and hashes, and commit proof only.
- [x] Stop before push/tag/release; the seven-day soak remains waived.

**Ubuntu VM103 proof (2026-09-03):** exact source commit
`2c36673056effa3a18eaa0a1efe83efcb331c969` passed rebrand, lint, typecheck,
unit (capabilities 24 files/121 tests, mcp-server 53 files/285 tests, CLI 7
files/18 tests), integration (3/3), packaging (15/15), release gate (10/10),
catalog/contract (227 tools), v1 acceptance (5/5), and `git diff --check`.
DEB/tar package inspection, provenance generation, packaged smoke, and
upgrade/rollback preflight passed. Packaged smoke reported `toolCount=221`,
`workspaceCheckpointEntries=10`, `workspaceCheckpointDiffUnchanged=10`, and
`workspaceCheckpointCompareUnchanged=10`. SHA-256: source archive
`83167acc3ef7d7abb63db7b2a0bcf5fb6bc115a7dd03ce8697ee418587b9bc09`, DEB
`c6de51b3bfe742d0e15d48bc28fc503f704003ffdc0e38c7390ab6114304778e`, Linux
tar `411aae8b5aca6a96a4354a164a98f19910918927b25029f489fa4a44f6ad4273`.

## Definition of done

- [x] `workspace_checkpoint compare` is owner-isolated and cannot compare checkpoints from different workspace/path scopes.
- [x] Diff output is bounded, metadata-only, and marks truncation truthfully.
- [x] Local and Ubuntu unit/integration/package/release/catalog/contract/rebrand gates pass.
- [x] DEB/tar smoke and forbidden-file inspection pass from the exact source commit.
