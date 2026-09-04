# Baitonghub-Linux-mcp v0.5.0

v0.5 adds bounded data inspection and explicitly registered remote Linux hosts
to the headless MCP runtime.

## Included

- Read-only SQLite schema/query inspection with a 1,000-row and 2 MiB result
  boundary.
- Registered PostgreSQL/MySQL targets using `psql`/`mysql` argv execution,
  Secret Service credentials, server-side row limits, and side-effect-free
  query validation.
- Registered SSH host observability for system information, journal, network,
  Git status, and regular-file reads.
- Confirmed remote service restart, file write, and project command operations
  with preview hashes, registered-root checks, pinned host keys, audit
  workspace IDs, output redaction, and bounded process lifetime.
- Headless admin commands for listing and registering database/remote-host
  metadata. Secret values and private keys are never command-line arguments.

## Platform boundary

This release is Linux-only and headless. It does not add Electron, Windows
bridges, WSL, Office COM, or unrestricted host access. Remote and database
targets must be registered explicitly; missing Secret Service, host-key
verification, or provider binaries return structured unavailable results.

## Verification

The release gate includes lint, typecheck, generated tool-catalog check,
workspace tests, MCP STDIO/HTTP protocol integration, database and SSH
security tests, package inspection, and `git diff --check`.
