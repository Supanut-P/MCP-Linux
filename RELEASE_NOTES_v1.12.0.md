# Baitonghub-Linux-mcp v1.12.0

## Bounded service logs

v1.12.0 adds the Linux-headless `service_logs` MCP tool. It reads one
validated systemd `.service` unit through `journalctl`, caps lines and
serialized bytes, returns an opaque unit-bound cursor for continuation, and
redacts credential-shaped fields. Missing providers and cancellation return
structured MCP errors; raw provider stderr and shell input are never exposed.

## Compatibility and security

- Existing v1 tool names and schemas remain unchanged; `service_logs` is
  additive and read-only.
- The tool is advertised only by the Linux capability registry when the local
  runtime is wired. It does not grant filesystem, process, remote-host, or
  Secret Service authority.
- The default local profile remains `full` inside registered roots. Secure
  Tunnel permission boundaries remain unchanged.
- The seven-day soak was not run and this release makes no production-soak
  claim.

## Verification status

Focused backend, capability composition, health, registry, typecheck, and
lint checks must pass before packaging. Ubuntu 24.04 package, integration,
provenance, and release-gate evidence is required before any external tag or
release. No push, tag, or GitHub Release is performed by this change alone.
