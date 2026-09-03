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

- [x] Build/test the exact commit on Ubuntu VM103 and run package smoke, package inspection, provenance, and upgrade/rollback preflight.
- [x] Copy artifacts/logs under `dist/v1.31.0-ubuntu-vm103/`, record hashes/counts, and commit proof only.
- [x] Stop before push/tag/release; the seven-day soak remains waived.

**Ubuntu VM103 proof (2026-09-03):** source commit
`b93c081d490114698306cd22d281bdf0b2bb76db` was built on Ubuntu 24.04.4
x64 with Node `v24.14.0` and pnpm `10.15.0`. Rebrand, lint, typecheck,
unit (24+2+3+3+3+2+3+5+24+2+6+4+8+20+53+7 files; 283 mcp-server
tests and all other project tests passed), integration (3), packaging (15),
release (10), catalog/contract (227 tools), v1 acceptance (5), and staged
diff checks all passed. DEB/tar package inspection and upgrade/rollback
preflight passed. Packaged STDIO smoke passed for both artifacts with
`toolCount=221`, `workspaceCheckpointAdvertised=true`,
`workspaceCheckpointEntries=10`, and truthful `degraded` diagnostics.
Source archive SHA-256 is
`6a8c2b9b7402ba892e0fb7242687ad2e7fe6d79a69d7f708bf311ced4e73d9f1`;
DEB SHA-256 is
`99addd45c7c943551a7092aa7877d611bcff3365b1ba0ef33ba278fd7b86246c`;
Linux tar SHA-256 is
`1bf839b66a389997ee46fbb7706c5f14e0ccaa3df1457491f485eb8fc831226d`.

## Definition of done

- [x] No checkpoint result or database row contains file contents or absolute paths.
- [x] A checkpoint created by one actor cannot be listed, read, or deleted by another actor.
- [x] Expired records are not returned; quotas and serialized output are bounded.
- [x] Local and Ubuntu unit/integration/package/release/catalog/contract/rebrand gates pass.
