# Baitonghub-Linux-mcp v1.23.0

## Remote fleet drift diff

v1.23 adds `remote_fleet_diff` for detecting configuration drift across
registered Linux hosts. Pass a bounded snapshot returned by `remote_fleet`
as the baseline; the service fetches a fresh read-only snapshot and compares
the `health`, `inventory`, and `service-status` sections by stable hashes.

The result contains only per-host `changed`, `unchanged`, or `unavailable`
status and changed section names. Baselines are capped at 256 KiB, output at
128 KiB, and host IDs are limited to the existing 1–20 registered aliases.
No hostname, command, credential, or mutation input is accepted.

The seven-day soak remains waived; this note makes no production-soak claim.
