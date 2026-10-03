# Baitonghub-Linux-mcp Version Roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grow the Linux-only headless MCP gateway from v0.1.0 into a stable v1.0 server-operations platform without weakening registered-root, confirmation, ownership, secret-redaction, or audit boundaries.

**Architecture:** Keep one Linux capability composition root shared by STDIO and HTTP. Add a small typed backend per operating-system domain, execute only fixed binaries with argument arrays and `shell: false`, and expose related actions through one operation-based MCP tool instead of multiplying tool names. Every backend reports `available`, `ready`, `provider`, `missingDependencies`, and sanitized failure reasons.

**Tech Stack:** Ubuntu 24.04 x64, Node.js 24, TypeScript, pnpm 10.15.0, Vitest, systemd, journalctl, procfs/sysfs, iproute2, apt/dpkg, Docker/Podman CLI, PostgreSQL/MySQL clients, OpenSSH, SQLite, OpenAI Secure MCP Tunnel.

---

## Release sequence

| Version | Theme | New public capability tools | Release outcome |
|---|---|---|---|
| v0.2.0 | Read-only Linux observability | extended `system_info`, `journal`, `network` | Diagnose a headless Ubuntu server without shell composition |
| v0.3.0 | Controlled server administration | `service`, `package`, `schedule` | Perform bounded administrative changes with preview and confirmation |
| v0.4.0 | Containers and developer operations | `container`, `archive`, `dependency_audit` | Operate application stacks and inspect dependency risk |
| v0.5.0 | Data and registered remote hosts | extended `db_inspect`/`db_query`, `remote_host` | Inspect databases and explicitly registered SSH targets |
| v1.0.0 | Stable contracts and production hardening | no mandatory new names | Freeze schemas and prove install, upgrade, recovery, and long-running tunnel behavior |

Each minor version is independently releasable. Do not start the next version until the current version passes its Ubuntu acceptance gate.

## Shared file map

- Modify `packages/capabilities/src/capability-tool-names.ts`: canonical public capability names.
- Modify `packages/capabilities/src/capability-descriptors.ts`: platform, permission, dependency, cancellation, and dry-run metadata.
- Modify `packages/capabilities/src/platform/runtime-factory.ts`: Linux backend composition only.
- Create `packages/capabilities/src/linux-command-runner.ts`: fixed-binary, argv-only subprocess boundary shared by new backends.
- Modify `packages/capabilities/src/local-capability-service.ts`: backend routing without policy decisions.
- Modify `packages/mcp-server/src/tools/capability-tools.ts`: MCP definitions and descriptions.
- Modify `packages/mcp-server/src/tools/schemas.ts`: strict operation-discriminated schemas.
- Modify `packages/mcp-server/src/destructive-policy.ts`: confirmation classification.
- Modify `packages/mcp-server/src/tool-registry.ts`: permission and audit enforcement.
- Modify `apps/cli/src/commands/doctor.ts`: dependency and provider readiness.
- Modify `scripts/package-linux-headless.mjs`: runtime dependencies and packaged resources.
- Modify `docs/linux/ARCHITECTURE.md`, `docs/linux/UBUNTU_ACCEPTANCE.md`, `README.md`: supported behavior and operator procedures.

## Global delivery rules

- New behavior starts with a failing unit or contract test.
- Read operations must not require `userConfirmed`.
- State-changing operations require both a registered target and `userConfirmed: true`.
- Commands use an executable plus argument array and `shell: false`; input never becomes a shell program.
- Output is bounded by rows, bytes, lines, or duration before it crosses the MCP boundary.
- API keys, passwords, environment secrets, systemd credentials, and database connection strings never appear in results, logs, audit rows, or incident output.
- A missing binary returns `CAPABILITY_UNAVAILABLE`; an unsupported action returns `PLATFORM_UNSUPPORTED`; missing interactive authority returns `CAPABILITY_CONSENT_REQUIRED`.
- Each version updates the generated tool catalog and release notes before packaging.

---

### Task 1: v0.2.0 read-only Linux observability

**Files:**
- Create: `packages/capabilities/src/linux-command-runner.ts`
- Create: `packages/capabilities/src/linux-command-runner.test.ts`
- Create: `packages/capabilities/src/linux-observability-backend.ts`
- Create: `packages/capabilities/src/linux-observability-backend.test.ts`
- Modify: `packages/capabilities/src/capability-tool-names.ts`
- Modify: `packages/capabilities/src/capability-descriptors.ts`
- Modify: `packages/capabilities/src/platform/runtime-factory.ts`
- Modify: `packages/capabilities/src/local-capability-service.ts`
- Modify: `packages/mcp-server/src/tools/schemas.ts`
- Modify: `packages/mcp-server/src/tools/capability-tools.ts`
- Modify: `apps/cli/src/commands/doctor.ts`
- Test: `packages/mcp-server/src/tool-registry.test.ts`

- [x] **Step 1: Write the fixed-command runner contract test**

```ts
it('executes a fixed executable with argv and never enables a shell', async () => {
  const spawn = vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'ok', stderr: '' });
  const runner = new LinuxCommandRunner({ spawn, allowedExecutables: ['/usr/bin/journalctl'] });
  await expect(runner.run('/usr/bin/journalctl', ['--no-pager', '-n', '20'])).resolves.toEqual({
    exitCode: 0, stdout: 'ok', stderr: '', truncated: false,
  });
  expect(spawn).toHaveBeenCalledWith('/usr/bin/journalctl', ['--no-pager', '-n', '20'], expect.objectContaining({ shell: false }));
});
```

- [x] **Step 2: Run the runner test and verify the red state**

Run: `corepack pnpm@10.15.0 --filter @baitonghub-linux-mcp/capabilities exec vitest run src/linux-command-runner.test.ts`

Expected: FAIL because `LinuxCommandRunner` does not exist.

- [x] **Step 3: Implement the bounded runner**

```ts
export interface LinuxCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

export class LinuxCommandRunner {
  public constructor(private readonly options: {
    readonly allowedExecutables: readonly string[];
    readonly maxBytes?: number;
  }) {}

  public async run(executable: string, args: readonly string[], signal?: AbortSignal): Promise<LinuxCommandResult> {
    if (!this.options.allowedExecutables.includes(executable)) throw new Error('Executable is not allowlisted');
    return runBoundedProcess(executable, [...args], {
      shell: false,
      signal,
      maxBytes: this.options.maxBytes ?? 256 * 1024,
    });
  }
}
```

- [x] **Step 4: Add failing observability tests**

Cover these exact operations:

```ts
expect(await backend.execute({ operation: 'summary' })).toMatchObject({ ok: true, value: { platform: 'linux' } });
expect(await backend.execute({ operation: 'disk', path: '/' })).toMatchObject({ ok: true, value: { mounts: expect.any(Array) } });
expect(await backend.execute({ operation: 'ports', limit: 50 })).toMatchObject({ ok: true, value: { listeners: expect.any(Array) } });
expect(await backend.execute({ operation: 'journal', unit: 'caddy.service', lines: 100 })).toMatchObject({ ok: true });
expect(await backend.execute({ operation: 'dns', host: 'localhost' })).toMatchObject({ ok: true });
```

Tests must prove line/row limits, invalid systemd unit rejection, timeout cancellation, and sanitized stderr.

- [x] **Step 5: Extend public capability names and strict schemas**

Add `journal` and `network` to `CapabilityToolName`. Keep `system_info` and extend it with:

```ts
const systemInfoSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('summary') }).strict(),
  z.object({ operation: z.literal('cpu') }).strict(),
  z.object({ operation: z.literal('memory') }).strict(),
  z.object({ operation: z.literal('disk'), path: z.string().max(4096).default('/') }).strict(),
  z.object({ operation: z.literal('processes'), limit: z.number().int().min(1).max(200).default(50) }).strict(),
  z.object({ operation: z.literal('ports'), limit: z.number().int().min(1).max(500).default(100) }).strict(),
]);
```

`journal` accepts only `unit`, `priority`, `since`, and `lines <= 1000`. `network` accepts only `interfaces`, `routes`, `dns`, `listeners`, and `connectivity` operations.

- [x] **Step 6: Compose the backend and expose health metadata**

Register the backend in `createPlatformCapabilityRuntime()` and report these dependencies through `doctor`: `journalctl`, `ip`, `ss`, `df`, and `/proc`.

- [x] **Step 7: Run v0.2.0 verification**

Run:

```sh
corepack pnpm@10.15.0 lint
corepack pnpm@10.15.0 typecheck
corepack pnpm@10.15.0 test
corepack pnpm@10.15.0 docs:tools:check
git diff --check
```

Expected: all commands exit 0; Linux `tools/list` contains `system_info`, `journal`, and `network` as READ tools.

- [ ] **Step 8: Commit v0.2.0 implementation (human gate)**

```sh
git add packages/capabilities packages/mcp-server apps/cli docs README.md
git commit -m "feat: add Linux observability tools"
```

**v0.2.0 acceptance:** On Ubuntu 24.04, diagnose CPU, memory, disk, processes, ports, routes, DNS, and bounded journal logs without invoking the generic shell tool.

---

### Task 2: v0.3.0 controlled server administration

**Files:**
- Create: `packages/capabilities/src/systemd-backend.ts`
- Create: `packages/capabilities/src/systemd-backend.test.ts`
- Create: `packages/capabilities/src/apt-backend.ts`
- Create: `packages/capabilities/src/apt-backend.test.ts`
- Create: `packages/capabilities/src/schedule-backend.ts`
- Create: `packages/capabilities/src/schedule-backend.test.ts`
- Modify: `packages/capabilities/src/capability-tool-names.ts`
- Modify: `packages/capabilities/src/capability-descriptors.ts`
- Modify: `packages/capabilities/src/platform/runtime-factory.ts`
- Modify: `packages/mcp-server/src/tools/schemas.ts`
- Modify: `packages/mcp-server/src/destructive-policy.ts`
- Modify: `packages/mcp-server/src/destructive-policy.test.ts`
- Modify: `packages/mcp-server/src/tool-registry.test.ts`
- Modify: `packaging/linux-headless/baitonghub-linux-mcp-tunnel@.service`

- [ ] **Step 1: Write confirmation-boundary tests**

```ts
await expect(registry.invoke('service', { operation: 'status', unit: 'caddy.service' }))
  .resolves.not.toMatchObject({ isError: true });
await expect(registry.invoke('service', { operation: 'restart', unit: 'caddy.service' }))
  .resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
await expect(registry.invoke('package', { operation: 'install', packages: ['jq'], userConfirmed: true, dryRun: true }))
  .resolves.not.toMatchObject({ isError: true });
```

- [ ] **Step 2: Run the boundary tests and verify they fail**

Run: `corepack pnpm@10.15.0 --filter @baitonghub-linux-mcp/mcp-server exec vitest run src/destructive-policy.test.ts src/tool-registry.test.ts`

Expected: FAIL because the three tools are not registered.

- [ ] **Step 3: Implement `service` operations**

Expose `list`, `status`, `is-enabled`, `start`, `stop`, `restart`, `reload`, `enable`, and `disable`. Validate unit names with:

```ts
const SYSTEMD_UNIT = /^[A-Za-z0-9_.@:-]{1,256}\.(service|socket|timer|path)$/;
```

Read operations call `systemctl show` with a fixed property list. Mutations call `systemctl <operation> <unit>` only after registry confirmation.

- [ ] **Step 4: Implement `package` operations**

Expose `search`, `show`, `installed`, `updates`, `install`, `remove`, and `upgrade`. Package names must match:

```ts
const DEBIAN_PACKAGE = /^[a-z0-9][a-z0-9+.-]{0,127}(?::(amd64|all))?$/;
```

All mutations first return an `apt-get --simulate` plan. Execution requires `userConfirmed: true`, a matching plan hash, and an allowlisted maximum of 50 packages.

- [ ] **Step 5: Implement systemd timer scheduling**

Store generated user units only under `${XDG_CONFIG_HOME}/systemd/user`. The `schedule` tool exposes `list`, `plan`, `create`, `enable`, `disable`, and `remove`; commands must reference the packaged CLI or an executable inside a registered root.

- [ ] **Step 6: Add hard blocks**

Tests must reject operations targeting shutdown/reboot/emergency/rescue units, package manager lock bypasses, unsigned repository additions, arbitrary apt flags, system-level cron files, and commands outside registered roots.

- [ ] **Step 7: Run v0.3.0 verification and Ubuntu acceptance**

Use a disposable `baitonghub-test.service` and a harmless package already available in Ubuntu. Prove status, dry-run, confirmed restart, timer enable/disable, and audit redaction. Confirm that missing confirmation returns `PERMISSION_REQUIRED` before a subprocess starts.

- [ ] **Step 8: Commit v0.3.0 implementation**

```sh
git add packages/capabilities packages/mcp-server packaging docs README.md
git commit -m "feat: add controlled Linux administration"
```

**v0.3.0 acceptance:** ChatGPT can inspect and deliberately administer systemd services, apt packages, and user timers while every mutation remains previewed, confirmed, bounded, and audited.

---

### Task 3: v0.4.0 containers and developer operations

**Files:**
- Create: `packages/capabilities/src/container-backend.ts`
- Create: `packages/capabilities/src/container-backend.test.ts`
- Create: `packages/capabilities/src/archive-backend.ts`
- Create: `packages/capabilities/src/archive-backend.test.ts`
- Create: `packages/capabilities/src/dependency-audit-backend.ts`
- Create: `packages/capabilities/src/dependency-audit-backend.test.ts`
- Modify: `packages/capabilities/src/platform/runtime-factory.ts`
- Modify: `packages/mcp-server/src/tools/schemas.ts`
- Modify: `packages/mcp-server/src/destructive-policy.ts`
- Modify: `packages/application/src/project-snapshot-service.ts`
- Test: `tests/integration/mcp-development-flow.test.ts`

- [ ] **Step 1: Add container lifecycle tests with a fake CLI**

```ts
expect(await backend.execute({ operation: 'list', all: true })).toMatchObject({ ok: true });
expect(await backend.execute({ operation: 'logs', container: 'api', tail: 200 })).toMatchObject({ ok: true });
expect(await backend.execute({ operation: 'remove', container: 'api' })).toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
```

The fake must capture executable, argv, cwd, signal, and `shell: false`.

- [ ] **Step 2: Implement Docker/Podman provider selection**

Prefer Docker when both are installed. Expose `status`, `list`, `inspect`, `logs`, `stats`, `compose-config`, `compose-up`, `compose-down`, `restart`, `stop`, and `remove`. Compose files must resolve inside a registered workspace; volume host paths must remain inside registered roots.

- [ ] **Step 3: Implement bounded archive operations**

Expose `list`, `extract-plan`, `extract`, and `create` for `.tar`, `.tar.gz`, and `.zip`. Reject absolute members, `..` traversal, symlink escape, device nodes, and extraction above 2 GiB or 100,000 members. Extraction requires confirmation when overwriting any file.

- [ ] **Step 4: Implement structured dependency audit**

Detect lockfiles and execute only these commands:

```ts
const AUDIT_COMMANDS = {
  pnpm: ['pnpm', ['audit', '--json']],
  npm: ['npm', ['audit', '--json']],
  python: ['python3', ['-m', 'pip', 'list', '--outdated', '--format=json']],
  cargo: ['cargo', ['audit', '--json']],
} as const;
```

Return normalized package, installed version, fixed version, severity, advisory ID, and source. Do not auto-upgrade dependencies.

- [ ] **Step 5: Extend project snapshots**

Add detected container runtime, compose files, lockfiles, audit provider availability, and the exact project command names already supported by `project_test`, `project_lint`, `project_typecheck`, and `project_build`.

- [ ] **Step 6: Run v0.4.0 integration acceptance**

In a disposable Docker Compose fixture, prove config validation, up, logs, stats, restart, down, ownership isolation, archive traversal rejection, and dependency audit parsing. Leave Docker prune, image removal, volume deletion, and dependency upgrades confirmation-gated.

- [ ] **Step 7: Commit v0.4.0 implementation**

```sh
git add packages/capabilities packages/application packages/mcp-server tests docs README.md
git commit -m "feat: add container and developer operations"
```

**v0.4.0 acceptance:** Operate a registered project’s Compose stack and inspect dependency risk without granting generic host-wide container authority.

---

### Task 4: v0.5.0 data and registered remote hosts

**Files:**
- Create: `packages/mcp-server/src/database-target-registry.ts`
- Create: `packages/mcp-server/src/database-target-registry.test.ts`
- Modify: `packages/mcp-server/src/database-runtime.ts`
- Modify: `packages/mcp-server/src/database-runtime.test.ts`
- Create: `packages/capabilities/src/remote-host-backend.ts`
- Create: `packages/capabilities/src/remote-host-backend.test.ts`
- Create: `packages/storage/src/remote-host-repository.ts`
- Create: `packages/storage/src/migrations/005_remote_hosts.sql`
- Modify: `packages/shared/src/secret-store.ts`
- Modify: `packages/mcp-server/src/tools/schemas.ts`
- Modify: `packages/mcp-server/src/destructive-policy.ts`

- [ ] **Step 1: Write database target registration tests**

```ts
await registry.register({ id: 'reporting', driver: 'postgres', secretRef: 'db/reporting', readOnly: true });
await expect(runtime.query({ targetId: 'reporting', sql: 'SELECT id FROM jobs LIMIT 10', maxRows: 10 }))
  .resolves.toMatchObject({ ok: true, value: { rows: expect.any(Array), truncated: false } });
await expect(runtime.query({ targetId: 'reporting', sql: 'DELETE FROM jobs' }))
  .resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
```

- [ ] **Step 2: Implement PostgreSQL and MySQL read-only providers**

Credentials are referenced by Secret Service keys, never accepted directly in MCP input. Set transaction read-only mode, statement timeout <= 30 seconds, row limit <= 1,000, and serialized result <= 2 MiB. `db_inspect` lists schemas, tables, columns, indexes, and foreign keys.

- [ ] **Step 3: Add registered SSH host storage**

Persist only host alias, hostname, port, username, pinned host-key fingerprint, allowed remote roots, and secret reference. Private keys and passphrases stay in Secret Service or root-only systemd credentials.

- [ ] **Step 4: Implement `remote_host` read operations first**

Expose `health`, `system_info`, `journal`, `network`, `file_read`, and `git_status`. SSH uses `BatchMode=yes`, `StrictHostKeyChecking=yes`, a generated known-hosts file, fixed connect timeout, no agent forwarding, no port forwarding, and no proxy command supplied by MCP input.

- [ ] **Step 5: Add confirmed remote mutations**

Expose only `service-restart`, `file-write`, and `project-command` in v0.5.0. Require registered remote roots, a preview hash, `userConfirmed: true`, and a separate audit target containing host alias plus remote workspace ID.

- [ ] **Step 6: Run v0.5.0 security acceptance**

Prove unknown hosts, changed host keys, paths outside remote roots, secret output, SQL mutations, multi-statements, oversized result sets, SSH forwarding flags, and commands without confirmation all fail closed.

- [ ] **Step 7: Commit v0.5.0 implementation**

```sh
git add packages/capabilities packages/mcp-server packages/storage packages/shared docs README.md
git commit -m "feat: add registered data and remote host tools"
```

**v0.5.0 acceptance:** Inspect registered databases and remote Linux machines safely; remote writes remain narrowly scoped and explicitly confirmed.

---

### Task 5: v1.0.0 stable contracts and production hardening

**Files:**
- Create: `docs/mcp/STABLE_TOOL_CONTRACT_V1.md`
- Create: `tests/acceptance/upgrade-v010-to-v100.test.ts`
- Create: `tests/acceptance/secret-leak-regression.test.ts`
- Create: `tests/acceptance/tunnel-reconnect.test.ts`
- Create: `scripts/soak-linux-headless.sh`
- Modify: `scripts/verify-linux-package.sh`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `SECURITY.md`
- Modify: `README.md`

- [ ] **Step 1: Freeze the v1 tool contract**

Document every advertised tool’s operations, required fields, permission level, destructive classification, result shape, availability states, and deprecation policy. Removing or renaming a v1 field requires a major release.

- [ ] **Step 2: Add schema snapshot tests**

Generate a canonical JSON snapshot from `tools/list`, strip descriptions only when explicitly designated non-contractual, and fail CI on unreviewed schema changes:

```ts
expect(canonicalizeToolSchemas(registry.list())).toEqual(readJsonFixture('tests/fixtures/tool-contract-v1.json'));
```

- [ ] **Step 3: Add upgrade and rollback acceptance**

Install v0.1.0, register a workspace, create audit/checkpoint state, upgrade to v1.0.0, and prove state remains readable. Then reinstall the previous DEB and prove the documented rollback behavior without deleting user data.

- [ ] **Step 4: Add secret-leak regression scanning**

Inject unique canary values into HTTP bearer, tunnel runtime key, database password, SSH key passphrase, and checkpoint key. Search stdout, stderr, journal, audit SQLite, crash output, package metadata, and generated diagnostics; the canaries must be absent everywhere.

- [ ] **Step 5: Run a seven-day soak gate**

`scripts/soak-linux-headless.sh` records process RSS, file descriptors, SQLite WAL size, task count, MCP request latency, tunnel reconnect count, and service restarts every five minutes. Release fails on unbounded growth, lost task ownership, corrupted state, or unrecovered tunnel disconnection.

- [ ] **Step 6: Expand clean-machine packaging matrix**

Test DEB install and tarball execution on clean Ubuntu 24.04 VMs with system Node absent. Verify checksums, systemd hardening, non-root runtime, missing optional dependency hints, upgrade, uninstall without data deletion, and reinstall.

- [ ] **Step 7: Run the final v1 gate**

```sh
corepack pnpm@10.15.0 install --frozen-lockfile
corepack pnpm@10.15.0 rebrand:check
corepack pnpm@10.15.0 lint
corepack pnpm@10.15.0 typecheck
corepack pnpm@10.15.0 test
corepack pnpm@10.15.0 test:integration
corepack pnpm@10.15.0 test:release-gate
corepack pnpm@10.15.0 docs:tools:check
corepack pnpm@10.15.0 package:linux:headless
sh scripts/verify-linux-package.sh dist
git diff --check
```

Expected: every command exits 0 on Ubuntu 24.04 x64 and the package contains no `.exe`, `.cmd`, `.bat`, `.ps1`, Electron, PowerShell, WSL, or Windows OCR resource.

- [ ] **Step 8: Commit v1.0.0 hardening**

```sh
git add docs tests scripts .github SECURITY.md README.md
git commit -m "release: harden stable Linux MCP v1 contract"
```

**v1.0.0 acceptance:** Stable schemas, clean install and upgrade proof, secret non-disclosure evidence, seven-day runtime stability, tunnel recovery, rollback documentation, and reproducible signed checksums.

---

## Version release checklist

For each version:

- [ ] Update root and workspace package versions with `node scripts/set-version.mjs <version>`.
- [ ] Update `README.md`, Linux architecture, Ubuntu acceptance, and release notes.
- [ ] Regenerate and verify the tool catalog.
- [ ] Run all local gates and Ubuntu VM gates.
- [ ] Build DEB, tarball, and SHA-256 sums from the exact release commit.
- [ ] Install the DEB on a clean Ubuntu 24.04 VM.
- [ ] Confirm STDIO, authenticated HTTP, and Secure MCP Tunnel transport.
- [ ] Confirm `git status --short` is empty and `git diff --check` exits 0.
- [ ] Pause for human approval before pushing the version tag or replacing a GitHub Release.

## Explicitly deferred beyond v1.0

- Desktop GUI and Electron.
- Wayland/X11 interactive desktop automation in the headless package.
- Windows migration or compatibility resources.
- ARM64, RPM, Alpine/musl, and Kubernetes cluster administration.
- Unrestricted root shell, arbitrary sudo, disk formatting, mounting, shutdown, or deletion of a registered workspace root.
