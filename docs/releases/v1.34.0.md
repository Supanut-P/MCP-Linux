# Baitonghub-Linux-mcp v1.34.0

v1.34 adds explicit retention cleanup for owner-isolated workspace checkpoints.

## Added

- `workspace_checkpoint` now supports `operation: "prune"`.
- Prune deletes only records already past their stored expiry for the
  authenticated owner and returns a bounded `deleted` count.
- Repeated prune calls are idempotent and cannot select a workspace, path,
  checkpoint ID, or custom retention age.
- Packaged MCP smoke verifies the zero-deletion/idempotent path.

## Safety and compatibility

- No filesystem, process, secret, or remote authority is added.
- Existing create/list/get/diff/compare/delete operations keep their v1 shape.
- The v1 contract remains additive and generated catalog/fixture checks stay at
  227 tools.
- The seven-day soak remains waived; this release makes no production-soak
  claim.

## Verification

The exact Ubuntu VM103 proof, package inspection, provenance, upgrade/rollback
preflight, and SHA-256 values are recorded in the v1.34 roadmap task after the
Ubuntu gate completes.
