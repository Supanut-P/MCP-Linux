# Baitonghub-Linux-mcp v1.37.0 remote fleet journal plan

**Goal:** let an operator read a bounded systemd journal from several already
registered Linux hosts without opening an arbitrary remote shell.

## Contract

- Extend `remote_fleet` with read-only `operation: "journal"`.
- Accept only registered `hostIds`, an optional validated unit name, and
  `lines` from 1 to 1,000 (defaulting to the existing remote-host default).
- Forward only `hostId`, `operation`, `unit`, and `lines` to `remote_host`.
- Keep four concurrent sessions, per-host 30 second timeout, 256 KiB result cap,
  deterministic partial results, redaction, and sanitized audit events.
- Do not add mutations, raw journal queries, shell fragments, credentials,
  hostnames, or unregistered paths.

## TDD and gates

- [x] Add a failing runtime test for bounded journal forwarding and partial
  result redaction.
- [x] Implement schema, runtime, description, and docs changes.
- [x] Regenerate the tool catalog and frozen v1 fixture.
- [ ] Run focused unit tests, typecheck, lint, integration, packaging, release,
  catalog, contract, acceptance, and `git diff --check` gates.
- [ ] Build/inspect Linux packages and retain hashes/evidence before requesting
  approval to push, tag, or publish v1.37.0.

The seven-day soak remains waived and must not be represented as passing.

## 2026-09-30 local verification

Journal regression proof now includes filtering an irrelevant path and
validating trimmed unit names before provider dispatch. The focused RED run
had two failures; the repaired suite passes 15 tests. Catalog and v1 contract
checks are synchronized at 227 tools.

Windows source checks are recorded in
[`../../harness/evidence/2026-09-30-v1.37-local.md`](../../harness/evidence/2026-09-30-v1.37-local.md).
Integration tests and Linux-only cases skip on Windows. Ubuntu runtime,
package creation/inspection/install, and upgrade/rollback remain unverified.
The combined release gates above therefore remain open; do not start v1.38.
