# Baitonghub-Linux-mcp v1.36.0

v1.36 adds a compact, owner-scoped change summary for saved workspace
checkpoints.

## Added

- `workspace_checkpoint` now supports `operation: "summary"`.
- Summary compares the current bounded manifest and returns only numeric
  `added`, `removed`, `changed`, and `unchanged` counts plus `truncated`.
- The operation accepts only an owner-scoped checkpoint ID and optional entry
  cap; it never returns paths, names, IDs, file contents, or provider output.
- Packaged MCP smoke verifies numeric-only summary output and path redaction.

## Safety and compatibility

- No filesystem, process, secret, or remote authority is added.
- Missing, foreign, and expired checkpoint IDs fail closed.
- Existing create/list/get/diff/compare/prune/stats/delete operations keep their
  v1 behavior.
- The v1 contract remains additive and generated catalog/fixture checks stay at
  227 tools.
- The seven-day soak remains waived; this release makes no production-soak
  claim.

## Verification

Ubuntu VM103 proof, package inspection, provenance, upgrade/rollback preflight,
and SHA-256 values are recorded under
`dist/v1.36.0-ubuntu-vm103/`. The exact source commit, DEB, and Linux x64 tar
hashes are listed in the v1.36 implementation plan and provenance files.
