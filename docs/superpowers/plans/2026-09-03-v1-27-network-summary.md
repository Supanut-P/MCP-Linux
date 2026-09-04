# Baitonghub-Linux-mcp v1.27 Network Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe `remote_fleet` network operation that reports interface, up-state, and address counts without exposing remote topology.

**Architecture:** Reuse the existing registered-host `remote_host` network provider (`ip -j addr`) and the `RemoteFleetRuntime` fan-out, timeout, audit, redaction, and 256 KiB cap. Parse and project the provider response at the fleet boundary; no interface names, IP addresses, hostnames, credentials, or arbitrary commands cross the MCP boundary.

**Tech Stack:** TypeScript, Zod, Vitest, pnpm 10.15.0, Ubuntu 24.04 x64.

---

### Task 1: Contract and regression tests

**Files:**
- Modify: `packages/mcp-server/src/remote-fleet-runtime.test.ts`
- Modify: `packages/mcp-server/src/tool-registry.test.ts`
- Modify: `packages/mcp-server/src/tools/schemas.ts`

- [ ] Add tests for network parsing, topology redaction, and operation parsing.
- [ ] Run `corepack pnpm@10.15.0 --filter @baitonghub-linux-mcp/mcp-server exec vitest run src/remote-fleet-runtime.test.ts src/tool-registry.test.ts` and verify the new network test fails before implementation.

### Task 2: Runtime implementation

**Files:**
- Modify: `packages/mcp-server/src/remote-fleet-runtime.ts`
- Modify: `packages/mcp-server/src/tools/capability-tools.ts`
- Modify: `packages/mcp-server/src/upgrade-catalog.ts`

- [ ] Add the `network` operation literal and forward only `hostId` and `operation`.
- [ ] Project JSON interface output into `{ network: { interfaceCount, upCount, addressCount } }`; return a truthful unavailable summary when parsing fails.
- [ ] Run the focused tests and verify all pass.

### Task 3: Version and docs

**Files:**
- Modify: workspace package versions via `corepack pnpm@10.15.0 set-version 1.27.0`
- Modify: `README.md`, `HEADLESS_LINUX.md`, `.github/RELEASE_CHECKLIST.md`
- Create: `docs/releases/v1.27.0.md`
- Modify: `docs/superpowers/plans/2026-09-02-v1-12-to-v2-roadmap.md`

- [ ] Document the topology-safe summary, its fixed bounds, and the seven-day soak waiver.
- [ ] Regenerate the v1 fixture and run catalog/contract checks.

### Task 4: Ubuntu proof

- [ ] Run lint, typecheck, full unit, integration, packaging, release, catalog, contract, acceptance, and diff gates on VM103 with `set -euo pipefail`.
- [ ] Build and inspect DEB/tar from the exact source SHA and retain hashes under `dist/v1.27.0-ubuntu-vm103/`.
- [ ] Mark the roadmap task complete only after `GATE_EXIT=0` and `PACKAGE_EXIT=0`; do not push/tag/release without explicit user approval.

---
