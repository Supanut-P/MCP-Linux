# Baitonghub-Linux-mcp v1.27.0

v1.27.0 adds a topology-safe network summary to the existing read-only
`remote_fleet` MCP tool.

- `operation: "network"` queries the fixed registered-host network provider.
- The returned projection contains only `interfaceCount`, `upCount`, and
  `addressCount`.
- Interface names, IP addresses, hostnames, credentials, and raw commands are
  never returned by the fleet surface.

The existing bounds remain: 1–20 registered host IDs, at most four concurrent
SSH sessions, pinned host fingerprints, Secret Service credentials, per-host
timeouts, sanitized errors, and bounded output. A provider response that is
not valid JSON becomes a truthful `network.status: "unavailable"` summary.

The seven-day soak remains waived and is not production-readiness evidence.
