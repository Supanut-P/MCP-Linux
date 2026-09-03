# Baitonghub-Linux-mcp v1.30 Workflow Preflight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one bounded read-only MCP tool that tells an agent whether the
headless runtime and an optional registered workspace are ready before a large
workflow.

**Architecture:** Compose the existing `environment_preflight`,
`diagnostics_snapshot`, and `workspace_snapshot(operation="usage")` services in
a small application service. Each section is independently sanitized and
truthful when unavailable; the composite never executes commands, writes
files, grants permission, or exposes absolute paths. A workspace section is
included only when the caller supplies a registered `workspaceId` and optional
relative path.

**Tech Stack:** TypeScript, Zod, MCP ToolRegistry, Vitest, pnpm 10.15.0,
Ubuntu 24.04 x64 package smoke.

---

### Task 1: Lock the service contract with failing tests

**Files:**
- Create: `packages/mcp-server/src/workflow-preflight-service.test.ts`
- Create: `packages/mcp-server/src/tools/workflow-preflight-tools.test.ts`

- [ ] **Step 1: Write tests for a ready composite and unavailable sections**

```ts
it('returns sanitized environment, diagnostics, and optional workspace usage', async () => {
  const service = new WorkflowPreflightService({
    environmentPreflight: { execute: async () => ok({ operation: 'environment_preflight', status: 'ready', platform: 'linux', displayServer: 'headless', runtime: { nodeVersion: 'v24.0.0', nodeMajor: 24 }, capabilities: { total: 1, available: 1, ready: 1, consentRequired: 0, notReady: [], missingDependencies: [] } }) },
    diagnosticsSnapshot: { execute: async () => ok({ snapshotAt: '2026-01-01T00:00:00.000Z', status: 'ready', health: { available: true, ready: true, unavailableCount: 0, consentRequiredCount: 0, missingDependencies: [] }, runtime: { available: true, ready: true }, audit: { available: true, ready: true, count: 0, truncated: false }, dependencies: { ready: true, missingDependencies: [] } }) },
    workspaceSnapshot: { execute: async (_actor, input) => ok({ operation: 'usage', workspaceId: input.workspaceId, path: input.path ?? '.', fileCount: 2, totalBytes: 6, scannedEntries: 3, truncated: false }) },
  });
  await expect(service.execute(actor, { workspaceId: 'workspace-1', path: 'src' })).resolves.toMatchObject({
    ok: true,
    value: { status: 'ready', workspace: { fileCount: 2, totalBytes: 6, truncated: false } },
  });
});

it('keeps provider failures truthful and never throws', async () => {
  const service = new WorkflowPreflightService({
    environmentPreflight: { execute: async () => err(appError('CAPABILITY_UNAVAILABLE', 'private', true)) },
    diagnosticsSnapshot: { execute: async () => { throw new Error('private'); } },
  });
  await expect(service.execute(actor, {})).resolves.toMatchObject({ ok: true, value: { status: 'unavailable', workspace: undefined } });
});
```

- [x] **Step 2: Run the focused tests and verify they fail**

Run: `corepack pnpm@10.15.0 exec vitest run packages/mcp-server/src/workflow-preflight-service.test.ts packages/mcp-server/src/tools/workflow-preflight-tools.test.ts`

Expected: FAIL because the service, tool factory, and schema do not exist.

### Task 2: Implement the bounded service and MCP surface

**Files:**
- Create: `packages/mcp-server/src/workflow-preflight-service.ts`
- Create: `packages/mcp-server/src/tools/workflow-preflight-tools.ts`
- Modify: `packages/mcp-server/src/tools/schemas.ts`
- Modify: `packages/mcp-server/src/tools/tool-types.ts`
- Modify: `packages/mcp-server/src/tool-registry.ts`
- Modify: `packages/mcp-server/src/index.ts`

- [x] **Step 1: Add strict input and service interfaces**

Use `workflowPreflightSchema` with only optional `workspaceId` and `path`; a
path without a workspace ID is invalid. The service output contains only
`operation`, `status`, `environment`, `diagnostics`, and optional `workspace`
projections, with a 128 KiB serialized cap.

- [x] **Step 2: Implement provider projection**

Call the three existing services with the caller actor and signal. Map rejected
or thrown providers to `{ available: false, ready: false }` section states;
return `CAPABILITY_UNAVAILABLE` only when all requested providers are absent
or unavailable. Preserve `PROCESS_TIMEOUT` when the signal is aborted. Copy
only the documented bounded fields from each provider and never include raw
errors, paths, commands, or credentials.

- [x] **Step 3: Register and export the tool**

Register `workflow_preflight` after `environment_preflight`, with READ,
`readOnlyHint: true`, and a description that states it is advisory and cannot
authorize or execute work. Add the optional service to `McpApplicationServices`
and export both service and tool factory.

- [x] **Step 4: Run focused tests and verify they pass**

Run the command from Task 1. Expected: all service and tool tests pass.

### Task 3: Update version, generated contracts, docs, and packaged smoke

**Files:**
- Modify: all version metadata via `corepack pnpm@10.15.0 set-version 1.30.0`
- Modify: `README.md`, `HEADLESS_LINUX.md`, `.github/RELEASE_CHECKLIST.md`
- Create: `RELEASE_NOTES_v1.30.0.md`
- Modify: `scripts/smoke-packaged-mcp.mjs`, generated catalog, v1 fixture
- Modify: `docs/superpowers/plans/2026-09-02-v1-12-to-v2-roadmap.md`

- [x] **Step 1: Add registry and packaged smoke assertions**

The smoke fixture invokes `workflow_preflight` with no workspace and checks a
bounded status plus `environment`/`diagnostics` section presence. The v1
fixture remains additive and tool count increases by exactly one.

- [x] **Step 2: Update public docs and release notes**

Document the optional workspace usage section, truthful unavailable states,
read-only boundary, and the waived seven-day soak. Do not advertise new
filesystem or process authority.

- [x] **Step 3: Regenerate and check contracts**

Run `corepack pnpm@10.15.0 docs:tools` and
`corepack pnpm@10.15.0 contract:v1`; inspect the diff for only the intended
tool row/schema.

### Task 4: Run gates and record proof

- [x] **Step 1: Run local gates**

Run lint, typecheck, full test, integration, packaging, release gate,
rebrand, catalog, contract, v1 acceptance, and `git diff --check`.

- [x] **Step 2: Run the exact-commit Ubuntu VM103 gate and package smoke**

Build DEB/tar from the feature commit, run the Linux-only tests and package
inspection, generate provenance/SBOM/checksums, and retain the VM log/artifacts
under `dist/v1.30.0-ubuntu-vm103/`.

- [x] **Step 3: Record checksums and commit only local proof**

Update this plan and the v1.12–v2 roadmap with exact counts/hashes, commit the
implementation and proof, and stop before external push/tag/release.

#### Proof recorded (2026-09-03, Ubuntu 24.04.4 x64 VM103)

- Source: commit `df6495d994656fb394a0db7b4912ef9cb8ca14f9`, archive
  `8775b5ba5d69f14db835e0e5272a3c03b68d667016641503338b19b507c5a66d`.
- Gates: branding, lint, typecheck, catalog, contract, full unit suite,
  integration (3/3), packaging (15/15), release gate (10/10), v1 acceptance
  (5/5), and staged `git diff --check` all passed. Full unit output included
  capabilities 24 files/121 tests, mcp-server 51 files/277 tests, and CLI
  7 files/18 tests; one workspace test was intentionally skipped.
- Exact package smoke (DEB and tar): `toolCount=220`,
  `workflowPreflightAdvertised=true`, `workflowPreflightStatus=degraded`,
  `snapshotDiffUnchanged=10`, `snapshotDiffTruncated=true`,
  `snapshotUsageFileCount=17`, `snapshotUsageTruncated=false`.
- Artifacts: DEB SHA-256
  `5072c2d959133146b0d07e7e78bbbbd92ec070e8cd38ae55149fa46a825d2270`,
  Linux tar SHA-256
  `5f8e4a39b8ecc26ec62338a6f2aa674e2486e5866bc164fa4a901182895be788`,
  provenance checksum SHA-256
  `4c73fc5ba7bc5feceeecdbe1fd328b37c20f5a2ee184510057265667e9f3b46f`.
- `verify-linux-package.sh` and `verify-upgrade-rollback.sh` passed. The
  seven-day soak remains explicitly waived; no external push/tag/release was
  performed.
