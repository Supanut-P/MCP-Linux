# MCP-Linux harness state

The authoritative [v2 roadmap](../superpowers/plans/2026-09-30-mcp-linux-v2-roadmap.md)
defines the accepted product and model-routing policy. Root `AGENTS.md` routes
to three compact repo-local skills; it does not install global configuration or
grant execution authority.

## Current milestone

v1.37.0 is the source candidate. Close its unit, integration, packaging,
release, catalog, contract, acceptance, Ubuntu runtime, and package gates
before starting v1.38 implementation. Supporting roadmap/skill documentation
does not mean the v1.38 runtime workflow exists.

See [local evidence](evidence/2026-09-30-v1.37-local.md) for exact results and
verification limits. Raw local logs are retained in the ignored
`dist/v1.37.0-local-20260930/` directory; copy them with the evidence when
handing off to another machine. A pre-existing working-tree patch is retained
there separately from this request's edits.

## Verification and authority

Evidence must name its source snapshot, command, exit status, artifacts, and
boundary. Do not equate Windows tests with Ubuntu behavior, fixture tests with
live SSH, byte savings with token savings, or CLI installation with provider
authentication/model selection/cancellation. A soak waiver is not a pass.

Use a disposable Ubuntu 24.04 x64 target for package install/upgrade/rollback;
obtain explicit authorization before preparing or mutating infrastructure or
a remote target. Existing v1.36 artifacts are historical evidence only.
