# Baitonghub-Linux-mcp Post-v1 Roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the v1.0.0 headless Linux MCP release into a reliable server-operations product, then add a small set of high-value Linux primitives without weakening registered-root, ownership, confirmation, audit, or secret-redaction boundaries.

**Architecture:** Ship a patch release before adding tools. Keep the stable v1 schemas additive, make `tools/list` truthful for the current runtime, prefer Node standard-library implementations over shell composition, and require a packaged-binary Ubuntu acceptance for every process or transport change. New remote and recovery functions remain registration-based and fail closed.

**Tech Stack:** TypeScript 6, Node.js 24, pnpm 10.15, Vitest, MCP SDK v2 (`2026-07-28`), SQLite, systemd, OpenSSH, DEB/tar packaging, Ubuntu 24.04 x86_64.

---

## Verified baseline and release order

The 2026-08-30 Ubuntu acceptance established this baseline:

- lint, typecheck, unit, integration, packaging, release, branding, generated catalog, and v1 schema contract gates pass;
- DEB and tarball checksum/package inspection pass and contain no Windows runtime files;
- packaged STDIO and loopback HTTP negotiate MCP `2026-07-28` and expose 199 tools for the tested headless environment;
- workspace tree/read/search/write/patch and Git status/diff succeed through the packaged MCP server;
- installed HTTP and tunnel systemd units are active, `/healthz` is live, and the public `/mcp` route reaches its authentication gate;
- packaged durable shell tasks running `/usr/bin/true` and `/usr/bin/printf` remain `running` until their deadline and become `timed_out`;
- desktop capabilities correctly report `display_session_unavailable` on the headless VM;
- the current release artifacts are DEB, Linux x64 tarball, and SHA-256 sums. AppImage is not a headless-server deliverable.

| Version | Theme | Public API change | Release gate |
| --- | --- | --- | --- |
| v1.0.1 | Reliability hotfix | No tool removals or renames | Packaged shell lifecycle must pass |
| v1.1.0 | Durable task recovery | Additive `resume_token` fields and implemented `shell.resume` | Reconnect/restart ownership proof |
| v1.2.0 | Read-only operator probes | Add `artifact_verify`, `http_probe`, `storage_usage` | No-shell, bounded, SSRF-safe proof |
| v1.3.0 | Registered remote fleet | Add `remote_fleet`; extend `remote_host` read operations | Registered-host-only fleet proof |
| v1.4.0 | Backup and recovery | Add `backup` | Create/verify/restore proof in registered roots |
| v1.5.0 | Production evidence | No mandatory new names | Clean VM, upgrade/rollback, seven-day soak |
| v2.0.0 | Breaking contract cleanup | Only after deprecation evidence | Separate future plan and explicit approval |

### Implementation status (2026-08-30)

- [x] v1.0.1 durable-shell reliability and packaged MCP smoke proof
- [x] v1.1.0 reconnect-safe durable task ownership and resume-token coverage
- [x] v1.2.0 bounded read-only operator probes
- [x] v1.3.0 registered remote fleet inspection
- [x] v1.4.0 registered-root backup and recovery
- [x] v1.5.0 release provenance, SBOM, and fail-closed artifact verification
- [ ] v1.5.0 clean-machine upgrade/rollback and seven-day production evidence
- [ ] v2.0.0 breaking contract design (requires deprecation and usage evidence)

The v1.4.0 implementation is complete and tested. The remaining unchecked
items are intentionally evidence or approval gates, not missing v1.4 code.

Do not increase the tool count merely to advertise a larger number. Each new tool below has a concrete provider, bounded result, health state, audit target, and packaged Ubuntu acceptance.

---

### Task 1: v1.0.1 durable shell hotfix and release truthfulness

**Files:**
- Modify: `packages/capabilities/src/durable-shell-task-store.ts`
- Modify: `packages/capabilities/src/durable-shell-task-store.test.ts`
- Create: `scripts/smoke-packaged-mcp.mjs`
- Modify: `scripts/verify-linux-package.sh`
- Modify: `tests/packaging/headless-linux-tunnel.test.ts`
- Modify: `docs/linux/UBUNTU_ACCEPTANCE.md`
- Modify: `docs/linux/ARCHITECTURE.md`
- Modify: `README.md`
- Modify: `package.json`

- [ ] **Step 1: Add the fast-child regression tests**

Add Linux tests that use native executables which can exit before asynchronous metadata persistence finishes:

```ts
it('records /usr/bin/true as completed instead of timing it out', async () => {
  const result = await runDurableNative('/usr/bin/true', []);
  expect(result).toMatchObject({
    ok: true,
    value: { state: 'completed', exit_code: 0, stdout: '', durable: true },
  });
});

it('captures output from a fast native process', async () => {
  const result = await runDurableNative('/usr/bin/printf', ['packaged-shell-pass\\n']);
  expect(result).toMatchObject({
    ok: true,
    value: { state: 'completed', exit_code: 0, stdout: 'packaged-shell-pass\\n' },
  });
});
```

Run on Ubuntu:

```sh
corepack pnpm@10.15.0 --filter @baitonghub-linux-mcp/capabilities test -- durable-shell-task-store.test.ts
```

Expected before the fix: both native-executable cases reproduce `state=timed_out`.

- [ ] **Step 2: Serialize metadata writes and attach process listeners before the first post-spawn await**

In `DURABLE_WORKER_SOURCE`, initialize a write queue before the first call to `persist()` and snapshot metadata at enqueue time:

```js
let persistQueue = Promise.resolve();

function persist() {
  const snapshot = JSON.stringify(metadata);
  persistQueue = persistQueue.then(() => writeFile(spec.metadataPath, snapshot, 'utf8'));
  return persistQueue;
}
```

Attach output and terminal listeners immediately after `spawn()`, before awaiting the child-PID metadata write:

```js
child = spawn(spec.executable, [...spec.arguments], {
  cwd: spec.cwd,
  env: { ...process.env },
  shell: false,
  detached: true,
});
child.stdout?.on('data', (chunk) => appendBounded(stdoutHandle, chunk, 'stdout'));
child.stderr?.on('data', (chunk) => appendBounded(stderrHandle, chunk, 'stderr'));
child.once('error', (error) => {
  void finish('failed', -1, 'Local task failed to start: ' + error.message);
});
child.once('close', (code) => {
  if (!stopTarget) void finish(code === 0 ? 'completed' : 'failed', code ?? -1);
});
metadata.child_pid = child.pid;
await persist();
```

This ordering prevents a fast process from emitting `close` while the worker is awaiting `task.json`, and the queue prevents an older `running` write from overwriting a terminal state.

- [ ] **Step 3: Prove timeout and cancellation behavior did not regress**

Retain the existing long-running cancellation cases and add assertions that worker PID, child PID, and process group are gone after `timed_out` or `cancelled`. Run:

```sh
corepack pnpm@10.15.0 --filter @baitonghub-linux-mcp/capabilities test
```

Expected: all capability tests pass on Ubuntu; no tested worker or child PID remains alive.

- [ ] **Step 4: Add a packaged MCP smoke client**

Create `scripts/smoke-packaged-mcp.mjs` using `Client` and `StdioClientTransport` pinned to `2026-07-28`. It must:

1. connect to the extracted packaged launcher;
2. call `workspace_list`, select the containing machine root, register the explicit disposable `--workspace` path with `workspace_register`, and retain the returned workspace ID;
3. call `workspace_tree`, `read_file`, `write_file`, `apply_patch`, and `git_status` against that ID;
4. call `shell run` with `/usr/bin/printf`;
5. poll `shell wait` on the same MCP connection;
6. require `state=completed`, `exit_code=0`, and `stdout=packaged-shell-pass\n`;
7. fail if a response contains `PERMISSION_DENIED`, `timed_out`, or `termination_unverified`.

The script accepts only explicit arguments:

```text
--launcher <absolute-path> --workspace <absolute-path> --expected-tools-min 190
```

It must not read tunnel credentials or use the public route.

- [ ] **Step 5: Make packaged smoke part of package verification**

After DEB extraction and ELF inspection, `scripts/verify-linux-package.sh` runs the smoke client on Linux with isolated XDG directories and a test-only checkpoint key. Add a packaging test that proves the verifier invokes the smoke script and rejects `timed_out`.

Run:

```sh
corepack pnpm@10.15.0 package:linux:headless
bash scripts/verify-linux-package.sh dist
```

Expected: both artifacts verify and the packaged shell output contains `packaged-shell-pass`.

- [ ] **Step 6: Correct v1 documentation drift**

Update the Ubuntu acceptance document from v0.2-specific filenames to a version variable. State that MCP `shell run` is always background and that foreground execution is tested at the lower process-service boundary. Document that:

- the canonical schema catalog has 205 tools;
- `tools/list` is environment/provider filtered and its count must not be hardcoded;
- headless releases ship DEB and tarball, not AppImage;
- the seven-day soak script exists but no seven-day completion claim is valid without its evidence artifact.

- [ ] **Step 7: Version and verify v1.0.1**

```sh
node scripts/set-version.mjs 1.0.1
corepack pnpm@10.15.0 rebrand:check
corepack pnpm@10.15.0 lint
corepack pnpm@10.15.0 typecheck
corepack pnpm@10.15.0 test
corepack pnpm@10.15.0 test:integration
corepack pnpm@10.15.0 test:packaging
corepack pnpm@10.15.0 test:release-gate
corepack pnpm@10.15.0 docs:tools:check
corepack pnpm@10.15.0 contract:v1
corepack pnpm@10.15.0 package:linux:headless
bash scripts/verify-linux-package.sh dist
git diff --check
```

Expected: every command exits 0 on Ubuntu 24.04 x86_64. Push, tag, release replacement, and VM package installation remain separate human gates.

**v1.0.1 acceptance:** `/usr/bin/true` and `/usr/bin/printf` complete through the packaged MCP shell lifecycle; no tool or schema is removed; documentation matches the headless artifacts and filtered runtime behavior.

---

### Task 2: v1.1.0 reconnect-safe durable task ownership

**Files:**
- Modify: `packages/capabilities/src/task-ownership.ts`
- Modify: `packages/capabilities/src/durable-shell-task-store.ts`
- Modify: `packages/capabilities/src/shell-backend.ts`
- Modify: `packages/mcp-server/src/tools/schemas.ts`
- Modify: `packages/mcp-server/src/tools/capability-tools.ts`
- Modify: `packages/mcp-server/src/tool-registry.test.ts`
- Create: `tests/integration/durable-task-reconnect.test.ts`
- Modify: `tests/acceptance/secret-leak-regression.test.ts`
- Modify: `docs/mcp/STABLE_TOOL_CONTRACT_V1.md`

- [ ] **Step 1: Add an opaque resume capability to the additive v1 schema**

Add optional `resume_token` to the shell schema. `shell run` returns a 32-byte base64url token once; `task.json` stores only its SHA-256 digest. `shell resume` requires `task_id`, `workspaceId`, and the token, compares digests with `timingSafeEqual`, rotates the token, and rebinds only the session identifier. The authenticated actor `clientId` and workspace ID must still match; the prior transport `sessionId` is the only ownership field allowed to change.

- [ ] **Step 2: Keep resume tokens out of all observability surfaces**

Redact the token field before MCP activity logging, SQLite audit writes, journal output, task metadata snapshots, and diagnostics. Add a canary token and scan stdout, stderr, activity log, SQLite, task JSON, and incident output.

- [ ] **Step 3: Prove reconnect and restart behavior**

The integration test starts a two-second durable task, disconnects the first MCP client, starts a replacement server/client using the same XDG state, resumes with the token, and obtains the completed result. Wrong token, wrong workspace, wrong client, and token reuse must return `PERMISSION_DENIED`.

- [ ] **Step 4: Run v1.1.0 gates**

Run the v1.0.1 command set plus:

```sh
corepack pnpm@10.15.0 exec vitest run tests/integration/durable-task-reconnect.test.ts
```

**v1.1.0 acceptance:** submitted tasks survive an MCP transport reconnect without becoming globally claimable, and no resume capability leaks into logs or stored plaintext.

---

### Task 3: v1.2.0 bounded read-only operator probes

**Files:**
- Create: `packages/capabilities/src/operator-probe-backend.ts`
- Create: `packages/capabilities/src/operator-probe-backend.test.ts`
- Modify: `packages/capabilities/src/platform/runtime-factory.ts`
- Modify: `packages/capabilities/src/capability-descriptors.ts`
- Modify: `packages/mcp-server/src/tools/schemas.ts`
- Modify: `packages/mcp-server/src/tools/capability-tools.ts`
- Modify: `packages/mcp-server/src/tool-registry.test.ts`
- Modify: `tests/fixtures/tool-contract-v1.json`
- Modify: `docs/architecture/TOOL_CONTRACT.md`

- [ ] **Step 1: Add `artifact_verify`**

Accept `workspaceId`, `path`, and optional expected SHA-256. Resolve through the registered-root filesystem boundary, reject symlink escape and special files, stream at most a configured maximum file size, and return `{ algorithm, digest, matches, bytes }`. Use `node:crypto`; do not invoke `sha256sum`.

- [ ] **Step 2: Add `http_probe`**

Accept `url`, method `HEAD|GET`, timeout up to 30 seconds, and response cap up to 64 KiB. Reuse the existing web-fetch network policy: reject credentials in URLs, link-local metadata destinations, disallowed private addresses, unsafe redirects, and non-HTTP protocols. Return status, bounded headers, latency, redirect chain, and optional TLS certificate summary.

- [ ] **Step 3: Add `storage_usage`**

Accept a registered path and operation `filesystem|directory|largest_files`. Use `fs.statfs` and bounded directory walking. Reject devices/FIFOs and symlink escape. Cap results at 500 entries and return bytes plus a truthful `truncated` flag.

- [ ] **Step 4: Advertise only ready providers and regenerate the additive contract**

Each tool is `READ`, `parallelSafe=true`, `supportsCancel=true`, and has a health descriptor. Update the v1 fixture additively and run `contract:v1:write`, followed by `contract:v1`.

**v1.2.0 acceptance:** ChatGPT can verify an artifact, diagnose an HTTP/TLS endpoint, and inspect storage pressure without composing a shell command or escaping a registered/network boundary.

---

### Task 4: v1.3.0 registered remote fleet inspection

**Files:**
- Modify: `packages/capabilities/src/remote-host-backend.ts`
- Modify: `packages/capabilities/src/remote-host-backend.test.ts`
- Modify: `packages/mcp-server/src/tools/schemas.ts`
- Modify: `packages/mcp-server/src/tools/capability-tools.ts`
- Create: `packages/mcp-server/src/remote-fleet-runtime.ts`
- Create: `packages/mcp-server/src/remote-fleet-runtime.test.ts`
- Modify: `packages/mcp-server/src/upgrade-catalog.ts`
- Modify: `packages/mcp-server/src/upgrade-runtime.ts`

- [ ] **Step 1: Extend registered remote reads**

Add `inventory`, `disk_usage`, `checksum`, and `service-status` operations. Every path is remotely canonicalized and checked against the selected registered remote workspace immediately before use. SSH remains `BatchMode=yes`, strict-known-hosts, argv-only, timeout bounded, and output capped.

- [ ] **Step 2: Add `remote_fleet` as a read-only aggregator**

Accept 1–20 registered host IDs and operation `health|inventory|service-status`. Run at most four SSH sessions concurrently, preserve per-host errors, return no secrets, and never accept a hostname, username, key path, or raw command from MCP input.

- [ ] **Step 3: Keep remote mutations narrow**

Do not add arbitrary SSH commands. Existing `service-restart`, `file-write`, and `project-command` retain preview hash, `userConfirmed: true`, host alias plus remote workspace audit target, regular-file checks, symlink checks, and process timeout.

**v1.3.0 acceptance:** one request can inventory a bounded set of explicitly registered Linux hosts, while an unregistered host/path or fingerprint mismatch fails with a sanitized structured result.

---

### Task 5: v1.4.0 registered-root backup and recovery

**Files:**
- Create: `packages/capabilities/src/backup-backend.ts`
- Create: `packages/capabilities/src/backup-backend.test.ts`
- Modify: `packages/capabilities/src/platform/runtime-factory.ts`
- Modify: `packages/mcp-server/src/tools/schemas.ts`
- Modify: `packages/mcp-server/src/tools/capability-tools.ts`
- Create: `tests/integration/backup-recovery-flow.test.ts`
- Modify: `docs/linux/ARCHITECTURE.md`

- [ ] **Step 1: Add `backup plan|create|list|verify|restore`**

`plan`, `list`, and `verify` are read-only. `create` is `WRITE`; `restore` is `DANGEROUS` and requires explicit confirmation. Backups contain a versioned JSON manifest, relative paths, sizes, modes, and SHA-256 values. Absolute paths, traversal members, symlinks outside the source, devices, sockets, and FIFOs are rejected.

- [ ] **Step 2: Make restore atomic and recoverable**

Extract to a sibling staging directory inside the registered root, verify every manifest entry, checkpoint overwritten files, then rename into place. Failure before the final rename leaves the destination unchanged. Workspace-root replacement and restore outside the original registered workspace are blocked.

- [ ] **Step 3: Prove corruption and rollback paths**

The integration test creates a fixture, backs it up, modifies files, restores with confirmation, verifies hashes, then corrupts the archive and proves restore fails before mutation.

**v1.4.0 acceptance:** local project and MCP state backups can be created, verified, and restored within registered roots without granting host-wide archive extraction authority.

---

### Task 6: v1.5.0 production evidence release

**Files:**
- Modify: `scripts/soak-linux-headless.sh`
- Create: `scripts/verify-upgrade-rollback.sh`
- Create: `docs/linux/evidence/v1.5.0/README.md`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `SECURITY.md`
- Modify: `README.md`

- [ ] **Step 1: Run clean-machine install, upgrade, rollback, uninstall, and reinstall**

Use disposable Ubuntu 24.04 x86_64 snapshots. Prove non-root service operation, bundled Node operation with system Node absent, state preservation, and uninstall without deleting XDG user data.

- [ ] **Step 2: Run the seven-day soak**

Run:

```sh
SOAK_DURATION_SECONDS=604800 SOAK_INTERVAL_SECONDS=300 bash scripts/soak-linux-headless.sh
```

Store the TSV, start/end system state, package hashes, service restart count, tunnel reconnect evidence, and acceptance summary under `docs/linux/evidence/v1.5.0/`. Fail on unbounded RSS/file-descriptor/WAL growth, owner loss, task corruption, or unrecovered tunnel disconnection.

- [x] **Step 3: Add release provenance**

Generate checksums, SBOM, and build metadata from the exact tag commit. Release workflow verifies the package manifest and refuses tag/package version mismatch. Signing keys and release credentials remain outside the repository.

- [ ] **Step 4: Run the complete release matrix**

Run every v1.0.1 gate plus reconnect, operator-probe, fleet, backup, upgrade/rollback, secret canary, and soak verification. A release note may claim production evidence only when the evidence directory contains the completed artifacts.

**v1.5.0 acceptance:** clean install, upgrade, rollback, recovery, secret non-disclosure, long-running tunnel stability, and reproducible artifacts are supported by retained evidence rather than documentation claims.

---

## v2.0 decision gate

Do not schedule v2.0 merely because v1.x has many tool names. Open a separate breaking-change plan only when usage evidence justifies at least one of these changes:

- remove or rename a v1 schema field after a documented deprecation window;
- remove scaffold-only tools that cannot acquire a truthful provider;
- replace the current permission/result model with an incompatible contract;
- split the server into independently versioned core, operator, and remote capability sets.

v2.0 requires an explicit migration guide, dual-version contract tests, and human approval before implementation or release.

## Release checklist for every version

- [ ] Work on a `codex/` branch; do not rewrite `main` or tags.
- [ ] Use TDD for the exact acceptance symptom.
- [ ] Keep all paths inside registered roots and all child processes argv-only with `shell:false`.
- [ ] Verify secret canaries are absent from stdout, stderr, audit, SQLite, journal, task metadata, and diagnostics.
- [ ] Run local gates and packaged Ubuntu VM acceptance.
- [ ] Confirm `git status --short` is empty and `git diff --check` exits 0.
- [ ] Build artifacts from the exact commit intended for the tag.
- [ ] Pause for explicit human approval before merge, push, tag, GitHub Release mutation, package installation, or infrastructure changes.
