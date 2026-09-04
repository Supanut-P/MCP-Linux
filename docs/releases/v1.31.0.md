# Baitonghub-Linux-mcp v1.31.0

## Workspace checkpoints

v1.31 adds the `workspace_checkpoint` MCP tool for carrying a safe workspace
manifest between agent turns. It supports `create`, `list`, `get`, and
`delete` operations backed by SQLite state.

- Only normalized relative paths, file sizes, timestamps, and optional hashes
  are stored; file contents, absolute paths, commands, environments, and
  secrets are excluded.
- Records are isolated by a one-way client/session owner fingerprint.
- Expired records are pruned automatically. Each owner is limited to 32
  records, 2 MiB of manifest metadata, and 256 KiB per record.
- Manifests are collected through the existing registered-root
  `workspace_snapshot` scanner, so symlink and special-file protections remain
  authoritative.

## Verification policy

The seven-day soak is waived for this development line and is not production
evidence. Build release artifacts only from a verified exact commit; record
Ubuntu 24.04 x64 test, package, provenance, and smoke results before any
external push, tag, or release.
