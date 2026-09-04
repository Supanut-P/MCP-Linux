# Baitonghub-Linux-mcp v1.18.0

## What changed

v1.18 extends the backwards-compatible `workspace_snapshot` tool with an
explicit `operation: "manifest"` mode for safe before/after comparisons.

- Returns sorted regular-file metadata: relative path, byte size, and mtime.
- Supports optional bounded SHA-256 hashes for small regular files.
- Uses an owner-bound opaque continuation cursor and a 256 KiB response cap.
- Traverses only the selected registered workspace root.
- Does not follow symlinks; symlink escapes and special files fail closed.
- Preserves the existing `{workspaceId}` identity snapshot response for older
  clients.

## Compatibility and safety

The v1 contract change is additive: callers that send only `workspaceId` keep
the previous identity/project metadata response. Manifest output contains no
file contents, absolute roots, command lines, environments, or credentials.
The seven-day soak remains waived; this note does not claim production-soak
evidence.

## Verification target

Before any external push, tag, or release, run the standard Ubuntu 24.04 x64
clean-checkout gate, including unit/integration/packaging/release/catalog/v1
contract checks and package secret/forbidden-file inspection. Artifacts must be
bound to the exact v1.18.0 commit and include provenance, SBOM, and SHA-256
manifests.
