# Baitonghub-Linux-mcp v1.22.0

## Diagnostics snapshot

v1.22 adds `diagnostics_snapshot`, a read-only incident summary for headless
Linux deployments. It combines:

- aggregate capability health and consent/dependency readiness;
- bounded host, runtime, and owned-task pressure counters; and
- a redacted MCP audit count.

The response has fixed sections, sanitized availability states, and a 128 KiB
serialized cap. It never returns commands, paths, host topology, credentials,
or provider stderr. Missing providers produce a truthful degraded or
unavailable status.

## Verification

The release gate requires Ubuntu 24.04 x64 unit, integration, package smoke,
catalog, v1 contract, provenance, and upgrade/rollback checks. The seven-day
soak remains waived; this note makes no production-soak claim.
