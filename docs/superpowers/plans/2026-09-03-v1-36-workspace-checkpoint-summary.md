# Baitonghub-Linux-mcp v1.36 Workspace Checkpoint Summary Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an owner see the numeric change summary for a saved workspace checkpoint without transferring a path list or file metadata.

**Architecture:** Extend the existing `workspace_checkpoint` tool with an additive `operation: "summary"`. Reuse the owner-scoped checkpoint lookup and bounded manifest diff already used by `operation: "diff"`, then reduce the result to fixed numeric counters.

**Safety:** `summary` accepts only an owner-scoped checkpoint ID and an optional bounded entry limit. It returns no checkpoint ID, workspace ID, path, filename, content, command, provider output, or secret. It performs no writes and adds no filesystem, process, remote, or secret authority. If the underlying scan is incomplete, `truncated: true` is preserved rather than implying a complete comparison.

## Tasks

### Task 1: Contract and tests

- [x] Add `summary` input/output types and strict schema validation.
- [x] Add service tests for numeric counts, owner isolation, truncation propagation, and rejection of unrelated fields.
- [x] Add tool, generated catalog/contract, and packaged-smoke coverage.
- [x] Run the focused suite and record the result: 2/2 focused tests passed.

### Task 2: Implement bounded numeric reduction

- [x] Reuse the existing owner-scoped checkpoint `diff` path and bounded manifest limits.
- [x] Return only `added`, `removed`, `changed`, `unchanged`, and `truncated` numeric/boolean fields.
- [x] Preserve fail-closed errors from missing, foreign, or expired checkpoints.

### Task 3: Version and documentation

- [x] Bump workspace packages to `1.36.0`.
- [x] Update README, `HEADLESS_LINUX.md`, release notes, roadmap, and release checklist.
- [x] Run focused tests, full local gates, generated checks, and `git diff --check`.

### Task 4: Ubuntu proof and evidence

- [x] Build/test the exact commit on Ubuntu VM103, including package smoke, package inspection, provenance, and upgrade/rollback preflight.
- [x] Copy artifacts/logs under `dist/v1.36.0-ubuntu-vm103/`, record gate counts and SHA-256 values, and commit proof only.
- [x] Stop before push/tag/release; the seven-day soak remains waived.

## Definition of done

- [x] `workspace_checkpoint summary` exposes only bounded numeric change counts for the authenticated owner.
- [x] Foreign, missing, and expired checkpoint IDs fail closed.
- [x] Incomplete scans remain explicitly truncated.
- [x] No filesystem, process, secret, or remote authority is added.
- [x] Local and Ubuntu unit/integration/package/release/catalog/contract/rebrand gates pass.
- [x] DEB/tar smoke and forbidden-file inspection pass from the exact source commit.

## v1.36.0 proof

Commit `0363947fdc9c7ea602270cecea80bf41813c23a2` was built from a clean
source archive and verified on Ubuntu 24.04 x64 VM103. The full unit gate passed
in 17 projects: capabilities `24 files / 121 tests`, mcp-server `53 files /
288 tests`, and CLI `7 files / 18 tests`; integration passed `3/3`, packaging
`15/15`, release gate `10/10`, acceptance `5/5`, catalog/contract `227`, and
rebrand passed. Packaged smoke reported `toolCount=221`,
`workspaceCheckpointSummaryChanged=0`, `workspaceCheckpointStatsCount=1`,
`workspaceCheckpointEntries=10`, `workspaceCheckpointDiffUnchanged=10`,
`workspaceCheckpointCompareUnchanged=10`, and `workspaceCheckpointPruned=0`.
DEB/tar package inspection and upgrade/rollback preflight passed. The seven-day
soak remains waived.

Artifacts and logs are retained under `dist/v1.36.0-ubuntu-vm103/`:

- Source archive SHA-256: `94e6852db67bdfd5b4a0b4199c828f164bb07aa9389cfbc20abb01dd36babb88`
- DEB SHA-256: `16d73d1811d55d13c7060063369f7d67a5fc5091062923b1ef37b89daf724888`
- Linux x64 tar SHA-256: `cb3a37815e1f7aa6f877d88ae552e91902fd491a1befa8fb5a24bebd334f2efe`
- VM gate summary: `dist/v1.36.0-ubuntu-vm103/v136-gates-summary.out`
- Package inspection: `dist/v1.36.0-ubuntu-vm103/v136-verify-package.out`
- Upgrade/rollback: `dist/v1.36.0-ubuntu-vm103/v136-upgrade-rollback.out`
