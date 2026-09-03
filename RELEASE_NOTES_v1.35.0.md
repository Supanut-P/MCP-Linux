# Baitonghub-Linux-mcp v1.35.0

v1.35 adds a bounded quota view for owner-isolated workspace checkpoints.

## Added

- `workspace_checkpoint` now supports `operation: "stats"`.
- Stats reports owner-scoped checkpoint count, metadata bytes, fixed limits, and
  remaining capacity after expired-record cleanup.
- The result is numeric-only and never includes checkpoint IDs, names, paths,
  entries, or file contents.
- Packaged MCP smoke verifies the quota view and its relation to `prune`.

## Safety and compatibility

- No filesystem, process, secret, or remote authority is added.
- Existing create/list/get/diff/compare/prune/delete operations keep their v1
  behavior.
- The v1 contract remains additive and generated catalog/fixture checks stay at
  227 tools.
- The seven-day soak remains waived; this release makes no production-soak
  claim.

## Verification

The exact Ubuntu VM103 proof, package inspection, provenance, upgrade/rollback
preflight, and SHA-256 values are recorded in the v1.35 roadmap task after the
Ubuntu gate completes.
