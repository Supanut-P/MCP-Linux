# Baitonghub-Linux-mcp v1.15.0

v1.15.0 extends the existing registered-host inspection path with a bounded
remote fleet snapshot. It is still Linux-headless and read-only.

## Included

- `remote_fleet` accepts `operation: "snapshot"` for a combined health,
  inventory, and service-status read on each registered host.
- `maxParallel` is explicitly bounded to 1–4; host results are returned in
  deterministic host-ID order.
- Partial host failures remain visible beside successful hosts.
- Each host result is capped at 256 KiB and reports `truncated` when bounded;
  per-host duration is included for operational diagnosis.
- Hostnames, usernames, key paths, credentials, and raw commands remain
  registration-only and cannot be supplied by the caller.

## Compatibility and safety

Existing `health`, `inventory`, and `service-status` operations remain
compatible. The snapshot only composes those existing `remote_host` reads; it
does not add remote mutation or shell authority. Pinned fingerprints, Secret
Service credentials, registered roots, and sanitized per-host errors remain
enforced by the existing backend.

The seven-day soak remains waived for this development checkpoint. Package and
external release mutation require the explicit release gate.
