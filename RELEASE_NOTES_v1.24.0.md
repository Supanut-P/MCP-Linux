# Baitonghub-Linux-mcp v1.24.0

## Offline release verification

This release adds the read-only `release_verify` MCP tool. It verifies local
DEB/tar artifacts against explicit SHA-256 values, generated Baitonghub
provenance metadata, and an optional CycloneDX SBOM before an operator chooses
an upgrade.

The verifier is bounded to registered workspaces, accepts one to four explicit
relative artifact paths, caps manifest and output size at 256 KiB, rejects path
traversal and duplicate entries, and delegates hashing to the existing
`artifact_verify` capability. It does not download, install, execute, or
mutate anything and returns sanitized reason codes on mismatch.

## Compatibility and evidence

- Linux headless only: Ubuntu 24.04 x64, Node.js 24.x, STDIO/Streamable HTTP.
- v1 tool names and schemas remain additive and generated catalog checks stay
  mandatory.
- The seven-day soak is waived; this release makes no production-soak claim.
- Push, tag, and GitHub release remain separate human-gated operations.
