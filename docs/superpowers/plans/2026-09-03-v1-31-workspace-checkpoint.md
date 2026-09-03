# Baitonghub-Linux-mcp v1.31 Workspace Checkpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a headless agent save and retrieve a bounded workspace manifest between turns without storing file contents or widening the registered-root trust boundary.

**Architecture:** Add a strict `workspace_checkpoint` MCP tool backed by a small SQLite repository. The service derives an owner fingerprint from the request actor, delegates manifest collection to the existing `WorkspaceSnapshotService`, stores only paths and file metadata, prunes expired records, and enforces per-owner count/byte quotas. `create` and `delete` mutate only MCP state; they never write workspace files.

**Safety:** Workspace IDs and paths remain resolved by the existing registered-root scanner. Checkpoint IDs and names are validated before storage lookup. Results are bounded and sanitized; no content, command, environment, secret, or absolute path is persisted or returned.

## Tasks

### Task 1: Define the contract and failing tests

- [x] Add the service/repository types, schema, tool description, and acceptance shape.
- [x] Add service tests for create/list/get/delete, owner isolation, TTL pruning, quota rejection, no-content persistence, and scanner errors.
- [x] Add tool/registry/acceptance tests.
- [x] Run focused tests and record the expected red failure before implementation.

### Task 2: Implement bounded persistence and runtime wiring

- [x] Add SQLite migration `010_workspace_checkpoints` and a repository with owner-scoped queries and expiry pruning.
- [x] Implement the service with strict input validation, deterministic owner fingerprint, 32-record/2 MiB per-owner quota, and 60-second to 7-day TTL.
- [x] Wire the service into `McpApplicationServices`, CLI runtime, tool registry, exports, and the generated tool contract.

### Task 3: Update version and documentation

- [x] Bump workspace packages to `1.31.0`.
- [x] Update README, `HEADLESS_LINUX.md`, release notes, catalog/fixture, and the v1.12–v2 roadmap.
- [x] Run focused tests, full local gates, generated checks, and `git diff --check`.

### Task 4: Ubuntu proof and local evidence

- [ ] Build/test the exact commit on Ubuntu VM103 and run package smoke, package inspection, provenance, and upgrade/rollback preflight.
- [ ] Copy artifacts/logs under `dist/v1.31.0-ubuntu-vm103/`, record hashes/counts, and commit proof only.
- [ ] Stop before push/tag/release; the seven-day soak remains waived.

## Definition of done

- [ ] No checkpoint result or database row contains file contents or absolute paths.
- [ ] A checkpoint created by one actor cannot be listed, read, or deleted by another actor.
- [ ] Expired records are not returned; quotas and serialized output are bounded.
- [ ] Local and Ubuntu unit/integration/package/release/catalog/contract/rebrand gates pass.
