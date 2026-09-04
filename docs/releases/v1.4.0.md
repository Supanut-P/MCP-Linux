# Baitonghub-Linux-mcp v1.4.0

This release extends the headless Linux MCP runtime with additive, bounded
operator and recovery capabilities while preserving the v1 tool contract.

## Included

- reconnect-safe durable shell tasks with one-time resume tokens;
- read-only `artifact_verify`, `http_probe`, and `storage_usage` probes;
- registered-host `remote_host` inventory, disk usage, checksums, and service
  status, plus bounded `remote_fleet` inspection;
- registered-root backup `plan`, `create`, `list`, `verify`, and confirmation-
  gated `restore` with SHA-256 manifest checks;
- detached process-group cleanup and post-spawn failure recovery; and
- headless Ubuntu 24.04 x86_64 DEB and Linux tarball packaging checks.

## Security boundaries

All filesystem and remote paths remain inside registered roots. Remote
mutations and backup restore require explicit confirmation. Child processes use
argv arrays with `shell:false`, process ownership is verified before cleanup,
and secrets are excluded from logs, audit records, and task metadata.

## Verification

The release was exercised on Ubuntu 24.04 x86_64 with the recursive unit suite,
integration flows, generated tool catalog and v1 contract checks, and packaged
MCP STDIO smoke tests. The v1.5.0 clean-machine upgrade/rollback and seven-day
soak evidence gate remains separate and is not claimed by this release.

v2.0.0 remains an evidence-gated future breaking-contract release; no v1
schema removal or rename is included here.
