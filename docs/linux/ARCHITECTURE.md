# Baitonghub Linux architecture

## Runtime shape

The v1.0 product is a headless Node.js runtime packaged with its own Node 24 x64
binary. MCP clients connect through STDIO, authenticated Streamable HTTP, or the
official outbound-only OpenAI Secure MCP Tunnel.

The composition root is
`packages/capabilities/src/platform/runtime-factory.ts`. It selects Linux
providers, storage locations, permission profiles, and the advertised tool
surface. Unsupported platform capabilities are not advertised.

The MCP registry is provider-filtered at runtime. `tools/list` reports only
capabilities that are reachable in the current headless environment; the
observed count is release evidence and must not be replaced with the larger
canonical schema count. The `shell` MCP operation is always non-blocking: a
`run` returns a durable task ID and callers use `status`, `logs`, `result`, or
`wait` to collect the result on the same connection.

Read-only observability is composed by `LinuxObservabilityBackend`. It exposes
`system_info` through Node/procfs and `df`, `journal` through `journalctl`, and
`network` through `ip`, `ss`, `/etc/resolv.conf`, and Node DNS. Every external
command passes through the fixed executable and argv-only command runner.

## Trust boundary

Every filesystem operation resolves a canonical real path against explicitly
registered roots. `/` is never registered automatically. A path that escapes
through a symlink or resolves outside all registered roots fails closed.

The complete tool profile may be enabled only inside those roots. The runtime
still blocks root escalation, shutdown, disk formatting, mounting,
workspace-root deletion, and termination of unowned processes.

## Processes

Commands are spawned with argument arrays and `shell:false`. Background work is
owned by the MCP session and workspace that created it. On Linux, cancellation
targets the owned Unix process group, sends `SIGTERM`, verifies exit, and only
then escalates that same group with `SIGKILL`.

## State and secrets

Default XDG locations are:

- data: `${XDG_DATA_HOME:-~/.local/share}/baitonghub-linux-mcp`;
- config: `${XDG_CONFIG_HOME:-~/.config}/baitonghub-linux-mcp`; and
- state/logs: `${XDG_STATE_HOME:-~/.local/state}/baitonghub-linux-mcp`.

Interactive Linux environments can use Secret Service through `secret-tool`.
Headless services use explicitly named environment or systemd credential inputs
and otherwise fail closed. There is no plaintext secret-file fallback.

## MCP transports

STDIO keeps protocol output isolated from operational logs. HTTP defaults to
loopback. A non-loopback listener requires a bearer token and explicit Host
allowlist; Origin is also checked when supplied by the client.

The Secure MCP Tunnel launches the packaged STDIO entrypoint. Its systemd unit
loads runtime and checkpoint keys through `LoadCredential`, and systemd owns the
service control group used for shutdown and restart.

## Packaging

`pnpm package:linux:headless` produces:

- an amd64 DEB;
- a Linux x64 tarball; and
- a SHA-256 manifest.

The release package excludes Electron, Windows executables, PowerShell bridges,
Windows-native helper binaries, and AppImage. `scripts/verify-linux-package.sh`
extracts both artifacts and runs the packaged MCP smoke workflow before the
package gate can pass.

## Operator probes, fleet, and recovery

`artifact_verify`, `http_probe`, and `storage_usage` are bounded read-only
probes. They use the registered-root filesystem boundary and an SSRF-safe
HTTP/DNS policy; they never compose a shell command from MCP input.

`remote_fleet` fans out only to registered SSH host IDs and fixed operations
(`health`, `inventory`, and `service-status`) with a maximum of four concurrent
sessions. Remote paths are canonicalized on the host immediately before use.

`backup` stores a versioned, self-verifying JSON manifest under a registered
root. Creation and restore require confirmation; restore materializes into a
staging directory, verifies every file hash, then renames atomically. Symlinks,
special files, traversal members, and workspace-root replacement are blocked.
