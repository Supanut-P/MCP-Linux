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
- [x] Run unit, typecheck, lint, integration, packaging, release, catalog,
  contract, acceptance, and diff-check gates on the disposable Ubuntu snapshot.
- [x] Build/inspect Linux packages and retain hashes/evidence on Ubuntu.
- [ ] Stop at the human gate before push, tag, or release.
The seven-day soak remains waived and must not be represented as passing.

## 2026-09-30 local verification

Journal regression proof now includes filtering an irrelevant path and
validating trimmed unit names before provider dispatch. The focused RED run
had two failures; the repaired suite passes 15 tests. Catalog and v1 contract
checks are synchronized at 227 tools.

Windows source checks are recorded in
[`../../harness/evidence/2026-09-30-v1.37-local.md`](../../harness/evidence/2026-09-30-v1.37-local.md).
Integration tests and Linux-only cases skip on Windows. Ubuntu evidence is recorded separately for its own source snapshot; it does not rewrite or supersede this historical receipt. Full v1.37 closure remains open on secure-tunnel and complete remote-fleet MCP evidence; do not start v1.38.

## 2026-09-30 Ubuntu verification and remaining closure

The Ubuntu source/package gates, install lifecycle, provenance, and package
smoke passed for the clean disposable source snapshot
`1cfef54ce980aa2c0f4cd6628bded64b65d06b14`. Its 578-file manifest SHA-256 is
`a92a01d35fa82df345efcbf76dfd858b3796b7e08823c885204c98ac440e6ca3`; DEB and
tar hashes and counts are recorded in the [Ubuntu receipt](../../harness/evidence/2026-09-30-v1.37-ubuntu.md).

The full v1.37 milestone remains **OPEN** because secure-tunnel health and a
complete remote-fleet MCP flow were not established. External connector health
and `workspace_list` returned `404 tunnel_client_not_seen` after 300 seconds.
The registered loopback SSH test is limited backend evidence. Do not start
v1.38 until this remaining gate is closed. No push, tag, release, or seven-day
soak pass is claimed. The local Windows receipt remains unchanged and applies
to its original source snapshot only.

## 2026-10-01 follow-up

The documented public launcher failed to route `remote-host` and `database`
admin commands. A Linux runtime regression reproduced refusal; the repaired
launcher preserves arguments and passes the focused regression. The new clean
verification snapshot `bbd47e10c0575f9ddb9312d8c61e752f1a8858c9` passed all
14 Ubuntu source/package gates and the actual install/upgrade/rollback cycle.
Installed HTTP MCP fleet inspection now passes with native Secret Service and
pinned loopback SSH. See the [new candidate receipt](../../harness/evidence/2026-10-01-packaged-fleet.md)
for source/artifact hashes, retained logs, and fixture limits.

The configured connector was verified online, but still runs 1.36. The
authorized adminops password attempt failed, so candidate install and tunnel
restart/reconnect there remain open. Do not start 1.38 until those gates close.

## 2026-10-02 verification closure

The user-specified SSH identity resolved access to the existing test VM. The
exact follow-up 1.37 candidate is now installed there; native connector reads,
explicit tunnel restart/reconnect, installed-byte binding, SQLite integrity,
and bounded known-credential checks including incident diagnostics passed.
Independent QA found no remaining material findings. v1.37 milestone
verification is closed; earlier open reports above remain historical.
See the [configured tunnel receipt](../../harness/evidence/2026-10-02-configured-tunnel.md).
Publication remains unapproved; the seven-day soak remains waived.


