# Baitonghub-Linux-mcp v1.25.0

## Headless environment preflight

This release adds the read-only `environment_preflight` MCP tool. It projects
the existing Linux health provider into a bounded readiness matrix containing
platform, display-server mode, Node runtime, capability availability/readiness,
consent flags, and sanitized missing-dependency names.

The tool is fail-closed when health is unavailable and ignores unknown provider
fields. It never returns hostnames, CPU models, absolute executable paths,
command lines, environment values, credentials, or mutation authority.

## Compatibility and evidence

- Linux headless only: Ubuntu 24.04 x64, Node.js 24.x, STDIO/Streamable HTTP.
- `release_verify` remains available for offline package provenance checks.
- v1 tool names and schemas remain additive; generated catalog/fixture checks
  stay mandatory.
- The seven-day soak is waived; this release makes no production-soak claim.
- Push, tag, and GitHub release remain separate human-gated operations.
