# Baitonghub-Linux-mcp v1.35 Workspace Checkpoint Stats Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an owner inspect checkpoint metadata quota usage before starting another capture, without exposing checkpoint contents or filesystem paths.

**Architecture:** Extend the existing `workspace_checkpoint` tool with an additive `operation: "stats"`. After the normal owner-scoped expiry cleanup, the service reads the existing repository count and byte totals and returns fixed quota limits plus remaining capacity.

**Safety:** `stats` accepts no workspace ID, path, checkpoint ID, or caller-selected filter. It returns only bounded numeric metadata for the authenticated owner. It never scans files, invokes processes, contacts remote hosts, or changes workspace contents. Expired records are cleaned using the same existing owner-scoped repository method used by other checkpoint operations.

## Tasks

### Task 1: Contract and tests

- [ ] Add `stats` input/output types and strict schema validation.
- [ ] Add service tests for owner isolation, quota totals, expiry cleanup, and rejection of unrelated fields.
- [ ] Add tool, generated catalog/contract, and packaged-smoke coverage.
- [ ] Run the focused suite and record the result.

### Task 2: Implement bounded quota reporting

- [ ] Reuse `count(ownerKey)` and `totalBytes(ownerKey)` after expiry cleanup.
- [ ] Return fixed `maxRecords`/`maxBytes` and non-negative remaining capacity.
- [ ] Keep output deterministic and numeric-only; never return record names, paths, IDs, or entries.

### Task 3: Version and documentation

- [ ] Bump workspace packages to `1.35.0`.
- [ ] Update README, `HEADLESS_LINUX.md`, release notes, roadmap, and release checklist.
- [ ] Run focused tests, full local gates, generated checks, and `git diff --check`.

### Task 4: Ubuntu proof and evidence

- [ ] Build/test the exact commit on Ubuntu VM103, including package smoke, package inspection, provenance, and upgrade/rollback preflight.
- [ ] Copy artifacts/logs under `dist/v1.35.0-ubuntu-vm103/`, record gate counts and SHA-256 values, and commit proof only.
- [ ] Stop before push/tag/release; the seven-day soak remains waived.

## Definition of done

- [ ] `workspace_checkpoint stats` reports only the authenticated owner's bounded quota usage.
- [ ] Expired records are not counted after the operation's cleanup pass.
- [ ] No filesystem, process, secret, or remote authority is added.
- [ ] Local and Ubuntu unit/integration/package/release/catalog/contract/rebrand gates pass.
- [ ] DEB/tar smoke and forbidden-file inspection pass from the exact source commit.
