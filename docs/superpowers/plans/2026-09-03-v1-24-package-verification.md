# Baitonghub-Linux-mcp v1.24.0 Package Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** เพิ่มเครื่องมือ read-only สำหรับตรวจสอบ provenance, SHA-256, metadata และ SBOM ของ artifact Linux ที่มีอยู่แล้ว ก่อนผู้ดูแลจะตัดสินใจ upgrade โดยไม่ดาวน์โหลด ติดตั้ง หรือแก้ไขไฟล์ใด ๆ

**Architecture:** สร้าง `release_verify` ใน `mcp-server` เป็น orchestration layer ที่อ่าน manifest แบบ bounded ผ่าน `FileService` และเรียก capability `artifact_verify` ที่มีอยู่เพื่อคำนวณ hash ของไฟล์เป้าหมาย บังคับให้ทุก path อยู่ใน registered workspace และคืนผลลัพธ์แบบ sanitized/fail-closed เมื่อ manifest, checksum, signature หรือ artifact ไม่ตรงกัน ไม่เพิ่มสิทธิ์ใหม่และไม่เรียก shell/apt/dpkg/network

**Tech Stack:** TypeScript, Zod, Node.js 24, MCP SDK, Vitest, pnpm 10.15.0, Ubuntu 24.04 x64, existing registered-root and `artifact_verify` boundaries.

---

## Scope and public contract

Input schema (strict):

```ts
{
  workspaceId: string,
  version?: string,
  metadataPath: string,
  checksumsPath: string,
  sbomPath?: string,
  artifacts: Array<{ path: string, sha256: string }>
}
```

The result contains only `verified`, normalized relative artifact names, `version`, `sourceCommit`, SBOM component count, and sanitized `reasonCode` values. It never returns manifest contents, absolute paths, signatures, command lines, environment variables, or provider errors. At least one and at most four artifacts are accepted; total manifest input and serialized output are capped at 256 KiB. A missing or malformed optional SBOM is a verification failure when `sbomPath` is supplied.

`release_verify` is additive and read-only. It is advertised only when the existing `artifact_verify` capability and workspace root resolver are available. It does not replace or widen `artifact_verify`.

## Files and responsibilities

- Create `packages/mcp-server/src/release-verify-service.ts`: bounded manifest parsing, checksum-line matching, metadata/SBOM validation, orchestration of `artifact_verify`, sanitized result projection.
- Create `packages/mcp-server/src/tools/release-verify-tools.ts`: MCP tool definition, READ annotations, missing-service behavior.
- Modify `packages/mcp-server/src/tools/schemas.ts`: strict `releaseVerifySchema`.
- Modify `packages/mcp-server/src/tools/tool-types.ts`, `tool-registry.ts`, `server-profile.ts`, and `index.ts`: optional service wiring, core profile registration, exports.
- Modify `apps/cli/src/stdio-mcp-runtime.ts`: construct the service from existing file/capability services.
- Modify `scripts/generate-tool-catalog.mjs` and `tests/acceptance/tool-contract-v1.test.ts`: deterministic catalog and contract stubs.
- Create `packages/mcp-server/src/release-verify-service.test.ts` and extend registry tests with unavailable/available filtering.
- Modify `tests/packaging/headless-linux-tunnel.test.ts` and `scripts/smoke-packaged-mcp.mjs`: package contract check that the tool is advertised without attempting installation.
- Modify `README.md`, `HEADLESS_LINUX.md`, `.github/RELEASE_CHECKLIST.md`, and this roadmap: v1.24 contract and explicit no-soak statement.

## Task 1: Lock the contract with failing tests

**Files:**
- Create `packages/mcp-server/src/release-verify-service.test.ts`
- Modify `packages/mcp-server/src/tools/schemas.ts`

- [ ] **Step 1: Add schema and service red tests**

Cover: valid request; unknown-key rejection; zero/five artifacts rejection; malformed SHA-256; checksum filename mismatch; metadata product/version mismatch; SBOM wrong format; capability hash mismatch; missing workspace/file service; and output byte cap.

- [ ] **Step 2: Run focused tests**

```bash
corepack pnpm@10.15.0 exec vitest run packages/mcp-server/src/release-verify-service.test.ts
```

Expected: FAIL because the schema, service, and tool do not exist.

## Task 2: Implement the bounded verification service

**Files:**
- Create `packages/mcp-server/src/release-verify-service.ts`

- [ ] **Step 1: Implement strict request validation and bounded reads**

Use `zod` parsing, a 256 KiB UTF-8 limit for metadata/checksum/SBOM reads, and `FileService.readFile` with `startLine`/`endLine` only after a bounded file-size probe. Convert all read failures to `CAPABILITY_UNAVAILABLE` with stable reason codes.

- [ ] **Step 2: Parse and verify manifests**

Require metadata JSON fields `product === 'Baitonghub-Linux-mcp'`, semver `version`, forty-character lowercase `sourceCommit`, and `sourceDirty === false`. Parse GNU checksum lines (`<64 hex><two spaces><relative filename>`), match each requested artifact by normalized relative path, and reject duplicates, traversal, symlink/special-file results, and unrequested entries that exceed limits. If `sbomPath` is present, require CycloneDX `bomFormat`, supported `specVersion`, and an array of bounded component objects.

- [ ] **Step 3: Delegate hashes and project sanitized output**

Call `CapabilityService.execute('artifact_verify', { workspaceId, path, expected_sha256 })` once per requested artifact, never shell or network. Return `verified: false` on any mismatch/unavailable result and include only `{path, verified, bytes}` per artifact. Ensure `JSON.stringify(result).length <= 256 * 1024`.

- [ ] **Step 4: Run focused tests**

```bash
corepack pnpm@10.15.0 exec vitest run packages/mcp-server/src/release-verify-service.test.ts
```

Expected: all service tests pass, including fail-closed and no-side-effect mocks.

## Task 3: Register the MCP tool

**Files:**
- Create `packages/mcp-server/src/tools/release-verify-tools.ts`
- Modify `packages/mcp-server/src/tools/tool-types.ts`
- Modify `packages/mcp-server/src/tools/tool-registry.ts`
- Modify `packages/mcp-server/src/server-profile.ts`
- Modify `packages/mcp-server/src/index.ts`

- [ ] **Step 1: Add a READ-only definition**

Register `release_verify` with `readOnlyHint: true`, `destructiveHint: false`, the strict schema, and `missingService()` when optional wiring is absent.

- [ ] **Step 2: Add service wiring and filtering tests**

Prove the default full profile lists the tool only when the service exists, operator/fleet profiles cannot elevate it, and the tool handler passes the request and abort signal unchanged.

- [ ] **Step 3: Run MCP tests and typecheck**

```bash
corepack pnpm@10.15.0 exec vitest run packages/mcp-server/src/tool-registry.test.ts packages/mcp-server/src/release-verify-service.test.ts
corepack pnpm@10.15.0 --filter @baitonghub-linux-mcp/mcp-server typecheck
```

Expected: focused tests pass and typecheck exits `0`.

## Task 4: Wire CLI, generated catalog, and package smoke

**Files:**
- Modify `apps/cli/src/stdio-mcp-runtime.ts`
- Modify `scripts/generate-tool-catalog.mjs`
- Modify `tests/acceptance/tool-contract-v1.test.ts`
- Modify `scripts/smoke-packaged-mcp.mjs`
- Modify `tests/packaging/headless-linux-tunnel.test.ts`

- [ ] **Step 1: Construct the service in STDIO runtime**

Pass the existing `file` and `capability` services; do not create a second filesystem guard or a network client.

- [ ] **Step 2: Regenerate catalog and fixture**

```bash
corepack pnpm@10.15.0 docs:tools
corepack pnpm@10.15.0 contract:v1:write
corepack pnpm@10.15.0 docs:tools:check
corepack pnpm@10.15.0 contract:v1
```

Expected: catalog count increases from 223 to 224 with one `release_verify` row and stable ordering.

- [ ] **Step 3: Extend packaged smoke**

Assert `tools/list` contains `release_verify`; do not pass an installation command or package path from the smoke script. Keep existing diagnostics and remote-fleet checks intact.

## Task 5: Version, documentation, and release evidence

**Files:**
- Modify `package.json` and all workspace package versions via the existing version script.
- Modify `README.md`, `HEADLESS_LINUX.md`, `.github/RELEASE_CHECKLIST.md`, `docs/superpowers/plans/2026-09-02-v1-12-to-v2-roadmap.md`.
- Create `docs/releases/v1.24.0.md`.

- [ ] **Step 1: Set version to `1.24.0`**

Use the repository versioning script so `APP_VERSION`, package versions, README badges, and release notes agree.

- [ ] **Step 2: Document the contract and threat boundary**

State that verification is offline/read-only, requires explicit registered artifact paths, fails closed on checksum/provenance/SBOM mismatch, and does not prove an upgrade is safe or perform one. Keep the seven-day soak waiver explicit.

- [ ] **Step 3: Run the complete Ubuntu VM103 gate**

```bash
corepack pnpm@10.15.0 rebrand:check
corepack pnpm@10.15.0 lint
corepack pnpm@10.15.0 typecheck
corepack pnpm@10.15.0 test
corepack pnpm@10.15.0 test:integration
corepack pnpm@10.15.0 test:packaging
corepack pnpm@10.15.0 test:release-gate
corepack pnpm@10.15.0 docs:tools:check
corepack pnpm@10.15.0 contract:v1
corepack pnpm@10.15.0 test:v1
git diff --check
```

Expected: zero failures, no Linux-only skips, catalog/fixture count 224.

- [ ] **Step 4: Build and inspect artifacts**

```bash
corepack pnpm@10.15.0 package:linux:headless
node scripts/generate-release-provenance.mjs dist
bash scripts/verify-linux-package.sh dist
bash scripts/verify-upgrade-rollback.sh dist
```

Expected: DEB and Linux x64 tar pass provenance/checksum, forbidden-file, install/rollback, and STDIO/HTTP smoke checks; no `.exe`, `.cmd`, `.bat`, `.ps1`, Electron GUI binary, or Windows OCR helper is present.

- [ ] **Step 5: Commit only after gates pass**

```bash
git add packages apps scripts tests README.md HEADLESS_LINUX.md .github docs/releases/v1.24.0.md docs/superpowers/plans
git commit -m "feat: add offline release verification"
```

Do not push, force-update `main`, create a tag, or publish a release without a separate explicit user gate.

## Forward roadmap after v1.24

- **v1.25 environment preflight:** read-only dependency/runtime matrix with exact executable paths, versions, display-server state, and sanitized missing-dependency hints.
- **v1.26 workspace transfer manifest:** resumable, hash-verified export/import of registered workspace files without arbitrary archive extraction or symlink escapes.
- **v1.27 scheduled headless jobs:** opt-in systemd user-timer integration for bounded existing tools, with durable task ownership and confirmation for every write/destructive action.
- **v1.28 remote fleet policy bundles:** signed, local-only policy snapshots for registered host aliases; never accept arbitrary host/user/key/command input.
- **v2.0 decision:** only after a real client incompatibility or a measured v1 contract limit; require a frozen v1 fixture, migration/rollback proof, and explicit approval.

## Self-review

- Every release step is read-only until the user separately approves package install, push, tag, release, or VM mutation.
- The tool delegates hashing to the existing registered-root `artifact_verify` capability and cannot invoke shell, apt, dpkg, network, or arbitrary paths.
- The tests cover malformed manifests, checksum mismatch, metadata/SBOM mismatch, missing providers, output caps, tool filtering, generated catalog, packaging smoke, and Ubuntu Linux execution.
- No seven-day soak or production-readiness claim is made.
