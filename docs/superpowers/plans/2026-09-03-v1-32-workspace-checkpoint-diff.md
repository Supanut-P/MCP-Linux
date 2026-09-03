# Baitonghub-Linux-mcp v1.32 Workspace Checkpoint Diff Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent compare a registered workspace with an owner-owned checkpoint without transporting the stored manifest through the client.

**Architecture:** Extend the existing `workspace_checkpoint` tool with a bounded `diff` operation. The service loads the owner-scoped metadata-only checkpoint, delegates the current scan and comparison to `WorkspaceSnapshotService`, and returns the existing sanitized diff shape. No new filesystem authority, persistence format, or file-content read is introduced.

**Safety:** `diff` requires a valid checkpoint ID and uses the checkpoint's registered workspace/path. It never accepts a caller-supplied baseline or alternate workspace. Missing/expired/foreign checkpoints return `FILE_NOT_FOUND`; scanner failures remain structured and sanitized. Existing 256 KiB diff cap and registered-root/symlink protections remain authoritative.

## Tasks

### Task 1: Contract and failing tests

- [ ] Extend the input/output types and add a failing service regression for changed/added/removed files.
- [ ] Add schema/tool tests for strict operation-specific `diff` validation.
- [ ] Add packaged-smoke coverage for checkpoint diff.
- [ ] Run focused tests and record the expected red failure before implementation.

### Task 2: Implement owner-scoped diff

- [ ] Add normalized `diff` input and output types.
- [ ] Load the checkpoint by owner, delegate `operation=diff` with its stored path and entries, and preserve bounded errors.
- [ ] Wire the provider type, tool description, and generated catalog/contract.

### Task 3: Version and documentation

- [ ] Bump workspace packages to `1.32.0`.
- [ ] Update README, `HEADLESS_LINUX.md`, release notes, roadmap, and release checklist.
- [ ] Run focused tests, full local gates, generated checks, and `git diff --check`.

### Task 4: Ubuntu proof and evidence

- [ ] Build/test the exact commit on Ubuntu VM103, including package smoke, package inspection, provenance, and upgrade/rollback preflight.
- [ ] Copy artifacts/logs under `dist/v1.32.0-ubuntu-vm103/`, record tool/test counts and hashes, and commit proof only.
- [ ] Stop before push/tag/release; the seven-day soak remains waived.

## Definition of done

- [ ] `workspace_checkpoint diff` is owner-isolated and cannot select a different workspace/path than the stored checkpoint.
- [ ] Diff output is bounded, metadata-only, and uses truthful `truncated`/sanitized failure states.
- [ ] Local and Ubuntu unit/integration/package/release/catalog/contract/rebrand gates pass.
- [ ] DEB/tar smoke and forbidden-file inspection pass from the exact source commit.
