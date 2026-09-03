# Baitonghub-Linux-mcp v1.33 Workspace Checkpoint Compare Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent compare two saved workspace checkpoints without rescanning the filesystem or moving either manifest through the client.

**Architecture:** Extend the existing `workspace_checkpoint` tool with a bounded `compare` operation. The service loads two checkpoints under the authenticated owner fingerprint, requires the same registered workspace and relative path, and compares their metadata entries in memory. The result reuses the existing snapshot diff shape and serialization cap.

**Safety:** `compare` accepts only two checkpoint IDs and `maxEntries`; it does not accept a workspace ID, path, or caller-supplied baseline. Foreign, missing, or expired checkpoints return `FILE_NOT_FOUND`. Cross-workspace/path comparisons fail closed. No filesystem, process, secret, or remote authority is added.

## Tasks

### Task 1: Contract and tests

- [ ] Extend the input/output types and add a service regression for added/removed/changed metadata.
- [ ] Add strict schema/tool tests for `compare` and cross-workspace rejection.
- [ ] Add packaged-smoke coverage for checkpoint compare.
- [ ] Run the focused suite after implementation and record the result.

### Task 2: Implement bounded owner-scoped comparison

- [ ] Load both owner-scoped records and reject workspace/path mismatches.
- [ ] Compare sorted metadata with the existing 256 KiB/truncation semantics.
- [ ] Wire tool descriptions and generated catalog/contract fixtures.

### Task 3: Version and documentation

- [ ] Bump workspace packages to `1.33.0`.
- [ ] Update README, `HEADLESS_LINUX.md`, release notes, roadmap, and release checklist.
- [ ] Run focused tests, full local gates, generated checks, and `git diff --check`.

### Task 4: Ubuntu proof and evidence

- [ ] Build/test the exact commit on Ubuntu VM103, including package smoke, package inspection, provenance, and upgrade/rollback preflight.
- [ ] Copy artifacts/logs under `dist/v1.33.0-ubuntu-vm103/`, record tool/test counts and hashes, and commit proof only.
- [ ] Stop before push/tag/release; the seven-day soak remains waived.

## Definition of done

- [ ] `workspace_checkpoint compare` is owner-isolated and cannot compare checkpoints from different workspace/path scopes.
- [ ] Diff output is bounded, metadata-only, and marks truncation truthfully.
- [ ] Local and Ubuntu unit/integration/package/release/catalog/contract/rebrand gates pass.
- [ ] DEB/tar smoke and forbidden-file inspection pass from the exact source commit.
