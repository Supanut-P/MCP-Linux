# Baitonghub-Linux-mcp v1.13.0

## Runtime metrics snapshot

v1.13.0 adds the Linux-headless `runtime_metrics` MCP tool. It returns a
bounded numeric snapshot of host load, memory, uptime, MCP request counters,
and aggregate owned-task states. The tool never reads process command lines or
environments and never returns hostname, paths, client identity, task IDs,
credentials, or raw provider errors.

## Compatibility and security

- Existing v1 tool names and schemas remain unchanged; `runtime_metrics` is
  additive and read-only.
- The host/runtime scopes work without task wiring. Requesting `tasks` fails
  closed with `CAPABILITY_UNAVAILABLE` when the optional aggregate task port is
  not configured.
- Output is capped at 64 KiB and task counters accept only a fixed allowlist of
  non-negative bounded states.
- The default local profile remains `full` inside registered roots. Secure
  Tunnel permission boundaries remain unchanged.
- The seven-day soak was not run and this release makes no production-soak
  claim.

## Verification status

Focused service, registry, typecheck, lint, integration, package, provenance,
and release-gate checks must pass before any external tag or release. No push,
tag, or GitHub Release is performed by this change alone.
