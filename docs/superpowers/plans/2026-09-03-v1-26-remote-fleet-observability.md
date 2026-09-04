# Baitonghub-Linux-mcp v1.26 Remote Fleet Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing read-only `remote_fleet` MCP tool so operators can collect bounded disk-usage and SHA-256 file-integrity results from explicitly registered Linux hosts.

**Architecture:** Reuse `RemoteFleetRuntime` and the existing `remote_host` fixed-operation boundary. Add only two operation literals (`disk_usage`, `checksum`); host addresses, credentials, canonical-root checks, secret-path rejection, SSH pinning, timeouts, and per-host audit remain inside `RemoteHostBackend`. Direct fleet results are bounded before returning, while the existing four-session limit and partial-result semantics remain unchanged.

**Tech Stack:** TypeScript, Zod, Vitest, pnpm 10.15.0, Ubuntu 24.04 x64, existing MCP catalog/contract generators.

---

### Task 1: Lock the public operation contract with failing tests

**Files:**
- Modify: `packages/mcp-server/src/remote-fleet-runtime.test.ts`
- Modify: `packages/mcp-server/src/tool-registry.test.ts`
- Modify: `packages/mcp-server/src/tools/schemas.ts`

- [ ] **Step 1: Add failing runtime coverage.** Add a test that invokes `remote_fleet` with `operation: 'disk_usage'` and `operation: 'checksum'`, asserts the forwarded request contains only `hostId`, `operation`, and the registered `path`, and asserts oversized direct output returns `truncated: true` with a bounded value.

- [ ] **Step 2: Run the focused test before implementation.**

```bash
corepack pnpm@10.15.0 --filter @baitonghub-linux-mcp/mcp-server exec vitest run src/remote-fleet-runtime.test.ts
```

Expected: FAIL because the operation parser and schema reject the new literals.

- [ ] **Step 3: Extend the schema and registry parse assertions.** Add `disk_usage` and `checksum` to `remoteFleetCapabilitySchema` and assert both literals parse in `tool-registry.test.ts` without changing tool names or permissions.

- [ ] **Step 4: Run the focused test again.**

```bash
corepack pnpm@10.15.0 --filter @baitonghub-linux-mcp/mcp-server exec vitest run src/remote-fleet-runtime.test.ts src/tool-registry.test.ts
```

Expected: runtime forwarding still fails until Task 2; schema/registry parsing passes.

### Task 2: Implement bounded fleet forwarding

**Files:**
- Modify: `packages/mcp-server/src/remote-fleet-runtime.ts`
- Modify: `packages/mcp-server/src/tools/capability-tools.ts`
- Modify: `packages/mcp-server/src/upgrade-catalog.ts`

- [ ] **Step 1: Add the operation literals.** Extend `RemoteFleetOperation` and `parseRequest` with `disk_usage` and `checksum`; preserve 1–20 host IDs, maxParallel 1–4, and path validation.

- [ ] **Step 2: Bound direct results.** Run `redactRemoteValue(result.value)` through the existing `boundValue` helper for every non-snapshot operation. Return `truncated: true` when the 256 KiB fleet value cap is exceeded, and include the same flag in the audit event.

- [ ] **Step 3: Update user-facing descriptions.** State that `remote_fleet` supports health, inventory, service status, disk usage, checksum, and the aggregate snapshot; do not advertise arbitrary commands or unregistered paths.

- [ ] **Step 4: Run focused tests.**

```bash
corepack pnpm@10.15.0 --filter @baitonghub-linux-mcp/mcp-server exec vitest run src/remote-fleet-runtime.test.ts src/tool-registry.test.ts
```

Expected: all focused runtime and registry tests pass.

### Task 3: Version, documentation, and release metadata

**Files:**
- Modify: root and workspace `package.json` files via `corepack pnpm@10.15.0 set-version 1.26.0`
- Modify: `README.md`
- Modify: `HEADLESS_LINUX.md`
- Modify: `.github/RELEASE_CHECKLIST.md`
- Create: `docs/releases/v1.26.0.md`
- Modify: `docs/superpowers/plans/2026-09-02-v1-12-to-v2-roadmap.md`

- [ ] **Step 1: Bump all package versions and lockfile metadata.** Run `corepack pnpm@10.15.0 set-version 1.26.0` and verify every workspace package reports `1.26.0`.

- [ ] **Step 2: Document the feature.** Add examples that use a registered host ID and a registered absolute path, explain the checksum secret-path restriction, and state the four-session/max-20-host bounds. Keep the seven-day soak waiver explicit.

- [ ] **Step 3: Add release notes.** Record the additive operation change, safety boundaries, and test evidence placeholders as concrete commands to be filled after the Ubuntu gate.

### Task 4: Generated contracts and verification

**Files:**
- Verify/update: `docs/architecture/TOOL_CONTRACT.md`
- Verify/update: `tests/fixtures/tool-contract-v1.json`
- Modify: `docs/superpowers/plans/2026-09-02-v1-12-to-v2-roadmap.md`

- [ ] **Step 1: Run local proof.** Run lint, typecheck, focused tests, full unit tests, integration, packaging, release gate, catalog/contract checks, v1 acceptance, and `git diff --check`.

- [ ] **Step 2: Run Ubuntu VM103 proof.** From a prefixed Git source archive, run the same full gate with `set -euo pipefail`; build DEB/tar, generate provenance from the exact HEAD SHA, run package inspection and upgrade/rollback preflight, and retain SHA-256 artifacts under `dist/v1.26.0-ubuntu-vm103/`.

- [ ] **Step 3: Record evidence.** Mark this task complete only after `GATE_EXIT=0`, `PACKAGE_EXIT=0`, packaging 15/15, catalog/contract synchronization, and artifact hashes are captured. Do not push/tag/release without explicit user approval.

---

## Self-review

- The change is additive and keeps the frozen v1 tool name/schema boundary; only the existing operation enum grows.
- No remote authority is added: all paths still pass registered-root realpath checks and checksums reject secret-looking paths.
- Direct output receives the same bounded 256 KiB cap as aggregate snapshots, preventing an oversized host response from exhausting MCP context.
- Ubuntu is the release authority; the seven-day soak remains waived and must not be reported as production evidence.
