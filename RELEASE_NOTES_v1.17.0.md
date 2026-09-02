# Baitonghub-Linux-mcp v1.17.0

## What changed

v1.17 adds `audit_query`, a read-only, session-scoped view of recent MCP
activity. It is intended for troubleshooting and operational review without
opening the raw SQLite audit database or exposing request data.

- Supports tool, result-code, workspace, and ISO timestamp filters.
- Uses an opaque cursor bound to the authenticated client and transport
  session; cursors cannot be reused by another session or with different
  filters.
- Returns only sanitized event ID, timestamp, tool, result code, duration, and
  a hashed workspace alias.
- Caps each response at 256 KiB and returns deterministic descending order.
- Fails closed with `CAPABILITY_UNAVAILABLE` when audit storage is unavailable
  and `PROCESS_TIMEOUT` when the request is cancelled.
- Adds actor, result-code, time-range, and descending-cursor filtering to the
  SQLite audit repository.

## Compatibility and safety

The MCP contract remains additive and Linux headless. Existing tool names and
schemas are unchanged; the v1 fixture is regenerated to include the new
read-only tool. The `audit_query` tool is available in the explicit `core`
server profile when the audit service is configured.

The response never includes command lines, file paths, environment variables,
client identity, API keys, approval receipts, raw provider stderr, or audit
metadata. The seven-day soak remains waived; this note does not claim
production-soak evidence.

## Verification target

Before any external push, tag, or release, run the standard Ubuntu 24.04 x64
clean-checkout gate, including unit/integration/packaging/release/catalog/v1
contract checks and package secret/forbidden-file inspection. Artifacts must be
bound to the exact v1.17.0 commit and include provenance, SBOM, and SHA-256
manifests.
