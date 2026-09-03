# Baitonghub-Linux-mcp v1.36 Workspace Checkpoint Summary Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an owner see the numeric change summary for a saved workspace checkpoint without transferring a path list or file metadata.

**Architecture:** Extend the existing `workspace_checkpoint` tool with an additive `operation: "summary"`. Reuse the owner-scoped checkpoint lookup and bounded manifest diff already used by `operation: "diff"`, then reduce the result to fixed numeric counters.

**Safety:** `summary` accepts only an owner-scoped checkpoint ID and an optional bounded entry limit. It returns no checkpoint ID, workspace ID, path, filename, content, command, provider output, or secret. It performs no writes and adds no filesystem, process, remote, or secret authority. If the underlying scan is incomplete, `truncated: true` is preserved rather than implying a complete comparison.

## Tasks

### Task 1: Contract and tests

- [ ] Add `summary` input/output types and strict schema validation.
- [ ] Add service tests for numeric counts, owner isolation, truncation propagation, and rejection of unrelated fields.
- [ ] Add tool, generated catalog/contract, and packaged-smoke coverage.
- [ ] Run the focused suite and record the result.

### Task 2: Implement bounded numeric reduction

- [ ] Reuse the existing owner-scoped checkpoint `diff` path and bounded manifest limits.
- [ ] Return only `added`, `removed`, `changed`, `unchanged`, `scanned`, and `truncated` numeric/boolean fields.
- [ ] Preserve fail-closed errors from missing, foreign, or expired checkpoints.

### Task 3: Version and documentation

- [ ] Bump workspace packages to `1.36.0`.
- [ ] Update README, `HEADLESS_LINUX.md`, release notes, roadmap, and release checklist.
- [ ] Run focused tests, full local gates, generated checks, and `git diff --check`.

### Task 4: Ubuntu proof and evidence

- [ ] Build/test the exact commit on Ubuntu VM103, including package smoke, package inspection, provenance, and upgrade/rollback preflight.
- [ ] Copy artifacts/logs under `dist/v1.36.0-ubuntu-vm103/`, record gate counts and SHA-256 values, and commit proof only.
- [ ] Stop before push/tag/release; the seven-day soak remains waived.

## Definition of done

- [ ] `workspace_checkpoint summary` exposes only bounded numeric change counts for the authenticated owner.
- [ ] Foreign, missing, and expired checkpoint IDs fail closed.
- [ ] Incomplete scans remain explicitly truncated.
- [ ] No filesystem, process, secret, or remote authority is added.
- [ ] Local and Ubuntu unit/integration/package/release/catalog/contract/rebrand gates pass.
- [ ] DEB/tar smoke and forbidden-file inspection pass from the exact source commit.
