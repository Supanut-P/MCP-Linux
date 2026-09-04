# Baitonghub-Linux-mcp v1.26.0

v1.26.0 is an additive Linux-headless maintenance release. The existing
`remote_fleet` MCP tool now supports two bounded read-only operations:

- `disk_usage`: collect `du --bytes` usage for a registered path on each host.
- `checksum`: collect a SHA-256 checksum for a registered regular file.

The operation accepts only registered host IDs and absolute paths validated by
the existing remote-host realpath boundary. Secret-looking checksum paths are
rejected, SSH pinning and Secret Service requirements remain unchanged, and
fan-out stays capped at 20 hosts with at most four concurrent sessions. Each
host response is sanitized and bounded to 256 KiB; a single host failure does
not hide other results.

Verification for this release must include the focused remote-fleet tests,
full Ubuntu 24.04 unit/integration/packaging/release gates, synchronized
225-tool catalog and v1 contract, DEB/tar package inspection, provenance, and
upgrade/rollback preflight. The seven-day soak is intentionally waived and is
not production-readiness evidence.
