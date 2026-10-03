# Approved baseline drift

`drift` adds durable capture, explicit baseline approval, comparison and status to
the fleet/full profiles. Existing `remote_fleet_diff` remains unchanged.

Capture supplies a registered workspace and 1–20 targets with unique IDs. Each
target names a registered host and either a service unit or a config/artifact
path inside that host's registered roots. The existing checksum provider still
checks canonical roots, regular files and secret exclusions. Four probes at most
share one 60-second request deadline. Service values retain stable allowlisted
states; files retain SHA-256 digests. Raw paths, content and errors are omitted
from public observations.

Option-shaped service units beginning with `-` are rejected before dispatch.
The v1.55 hardening review must also audit option separation on the existing
remote-host service-status surface; admission here protects only this new tool.

Approve requires a complete capture, its exact snapshot hash and explicit
`userConfirmed:true`, current READ/WRITE permission and unchanged registrations.
This is caller-attested baseline selection. It grants no remote mutation
authority and does not authenticate a separate human approver.

Compare supplies a new snapshot ID plus the approved baseline ID/hash. Targets
come exclusively from that baseline. Results distinguish stale, unavailable,
truncated, changed and unchanged in that precedence. Digest equality establishes
byte equality, not effective configuration or service behavior. Historical
observations stay immutable; current registration readiness is reported
separately.

Repeating an ID with the same request reads existing evidence without new probes.
Changed inputs fail. Expired interrupted collection retains gaps and never
automatically resumes. SQLite migration 016 adds separate owner-isolated tables;
older binaries ignore them. Limits are 32 snapshots per owner, 256 globally,
20 evidence rows per snapshot, 32 KiB header and 64 KiB evidence total.

v1.48 is an implementation candidate until local, Ubuntu/package, lifecycle and
installed STDIO/HTTP gates close. This guide does not establish live fleet
readiness, native Codex authentication or publication approval.
