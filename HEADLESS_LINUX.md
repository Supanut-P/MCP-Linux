# Baitonghub-Linux-mcp headless server

The Linux server artifact is CLI-only. It does not start Electron, require a
desktop session, or require Chrome/Chromium, Wayland, X11, portals, or OCR.

## Run from the source tree

```sh
export BAITONGHUB_LINUX_MCP_WORKSPACE=/srv/mcp-workspace
export BAITONGHUB_LINUX_MCP_CHECKPOINT_KEY_BASE64='<32-byte base64 key>'
./apps/cli/build-headless/baitonghub-linux-mcp mcp --stdio
```

The advertised headless surface defaults to `full`. For a smaller explicit
surface, use `--server-profile core|operator|fleet|full` or set
`BAITONGHUB_LINUX_MCP_PROFILE`. This filters only `tools/list` and dispatch;
the separate permission profile (`--profile safe|balanced|full|custom`),
confirmation, registered-root, ownership, Secret Service, audit, and
redaction boundaries remain unchanged. Invalid server-profile values fail
closed. See [`docs/linux/SERVER_PROFILES.md`](docs/linux/SERVER_PROFILES.md).

For a loopback HTTP MCP endpoint:

```sh
export BAITONGHUB_LINUX_MCP_HTTP_PORT=18765
./apps/cli/build-headless/baitonghub-linux-mcp mcp --http
```

The default HTTP bind is `127.0.0.1`. If you deliberately bind a non-loopback
address, set `BAITONGHUB_LINUX_MCP_HTTP_TOKEN` and configure
`BAITONGHUB_LINUX_MCP_HTTP_ALLOWED_HOSTS` (and
`BAITONGHUB_LINUX_MCP_HTTP_ALLOWED_ORIGINS` when the client sends an Origin);
the server rejects requests without
the bearer token or an allowed `Host` header. The token is never written to
stdout, logs, or audit records.

## Registered database and SSH targets

Target metadata is persisted in the local SQLite state database; passwords and
SSH keys remain in Linux Secret Service and are referenced only by `secret-ref`.
Use the packaged admin CLI to inspect or register targets before calling MCP:

```sh
baitonghub-linux-mcp database add pg-main postgresql db.internal 5432 app readonly db-pg-main
baitonghub-linux-mcp database list
baitonghub-linux-mcp remote-host add vm103 192.168.1.39 22 adminops ssh-vm103 SHA256:<pinned-host-key> /srv/app
baitonghub-linux-mcp remote-host list
```

The MCP client can discover the safe aliases without receiving connection or
credential metadata:

```text
target_catalog {"operation":"list"}
target_catalog {"operation":"describe","kind":"remote-host","id":"vm103"}
```

Target replacement and removal stay local-admin operations. Removal requires
an exact repeated ID as confirmation:

```sh
baitonghub-linux-mcp database replace pg-main postgresql db.internal 5432 app readonly db-pg-main
baitonghub-linux-mcp database remove pg-main --confirm pg-main
baitonghub-linux-mcp remote-host replace vm103 192.168.1.39 22 adminops ssh-vm103 SHA256:<pinned-host-key> /srv/app
baitonghub-linux-mcp remote-host remove vm103 --confirm vm103
```

Database targets are stored as `readOnly=true` and accept only one bounded
read query. `remote_host` read operations stay inside registered roots; remote
mutations additionally require `workspaceId`, a matching dry-run hash, and
`userConfirmed: true`. The CLI accepts references only; never put a secret
value or private key on the command line. `remote_fleet` can fan out
read-only `health`, bounded `inventory`, `service-status`, `disk_usage`,
`checksum`, or topology-safe `network` summary checks to 1–20 registered hosts,
with at most four SSH sessions in flight. Snapshot combines the safe
health/inventory/service-status checks.
`maxParallel` is 1–4, host ordering is deterministic for snapshots, each host
result is capped at 256 KiB, and partial results are sanitized.

The `network` operation parses the registered host's JSON interface response
and returns only interface/up/address counts; interface names, addresses, and
other topology details are never returned by `remote_fleet`.

`remote_rollout` is optional and requires the durable local rollout store in
addition to `remote_host`. It plans and executes one fixed `.service` restart
with an expiring aggregate preview hash, canary-first batches, explicit
confirmation, cancellation, and sanitized per-host audit evidence. It never
accepts arbitrary remote shell input.

`remote_rollout_resume` is the additive recovery path for a failed or cancelled
rollout. Its preview selects only failed or unattempted registered hosts, never
restarts hosts whose latest result is `ok`, expires after 15 minutes, and caps
each host at two total attempts. Timeout or connection-loss results are
`unverified` and are not retried automatically.

`service_logs` is the read-only continuation-friendly service log view. It
accepts only a validated `.service` unit, a bounded line/byte limit, and an
opaque cursor issued for that same unit. It invokes `journalctl` with argv-only
arguments, redacts credential-shaped fields, and returns
`CAPABILITY_UNAVAILABLE` when the provider is missing; it never accepts a raw
journal query or shell fragment.

`runtime_metrics` is a bounded read-only snapshot for headless operations. It
reports numeric host load, memory, uptime, MCP request counters, and aggregate
owned-task states without returning hostname, command line, environment,
paths, client identity, or secrets. A task snapshot is returned only when the
runtime task port is wired; otherwise the tool fails closed with
`CAPABILITY_UNAVAILABLE`.

`audit_query` is a bounded read-only view of the current authenticated
transport session's MCP activity. It returns only sanitized timestamps, tool
names, result codes, durations, and hashed workspace aliases. Filters and an
opaque owner-bound cursor are supported; output is capped at 256 KiB. Command
arguments, paths, environments, client identity, secrets, approval material,
and provider stderr are never returned. If the local audit store is unavailable
the tool returns `CAPABILITY_UNAVAILABLE`.

`workspace_snapshot` keeps its original identity response when called with only
`workspaceId`. Set `operation: "manifest"` to receive a sorted, read-only
regular-file manifest (`path`, byte size, modification time, and optional
SHA-256) from that registered root. The manifest supports bounded `maxEntries`
and an opaque owner-bound `cursor`; it never follows symlinks, rejects escapes
and special files, and caps serialized output at 256 KiB. Files larger than the
bounded hash budget are returned without a hash rather than read without limit.

Set `operation: "diff"` with a prior bounded manifest in `baseline` to compare
the current registered-root snapshot. The result contains only `added`,
`removed`, `changed`, and `unchanged` regular-file metadata, is capped at
256 KiB, and reports `truncated: true` whenever either snapshot is incomplete
or the serialized diff must be shortened. Baseline paths must be unique,
relative POSIX paths; diff never accepts a continuation cursor or writes files.

Set `operation: "usage"` to receive a bounded regular-file `fileCount`,
`totalBytes`, `scannedEntries`, and `truncated` summary for the selected
registered root. Usage does not read file contents and accepts no cursor,
baseline, hash mode, or mutation fields; byte totals saturate safely at the
maximum JSON-safe integer and mark the result truncated.

`task_events` is a bounded, reconnect-safe lifecycle projection for an owned
durable shell task or remote rollout. It returns monotonic sequence numbers,
timestamps, state, sanitized phases/attempts, and terminal result codes. The
cursor is bound to the authenticated client/session and task ID. Command
lines, paths, output, environments, host keys, and secrets are never included;
the stream is derived from the durable task stores and supports a bounded
`waitMs` for reconnect polling.

`task_history` is a bounded, read-only history projection for the same owned
shell and remote-rollout tasks. Use `state`, `since`, `until`, and a redacted
`workspaceHash` to filter, then continue with its owner- and filter-bound
cursor. Entries contain only task ID, kind, state, timestamps, workspace hash,
result code, and duration; commands, paths, output, environments, hosts, and
secrets are excluded. Retention is capped at 500 entries and each page at 100.

`diagnostics_snapshot` is a single read-only incident view. It combines
sanitized health availability, runtime pressure counters, audit count, and
dependency readiness with fixed sections and a bounded serialized response.
It does not expose commands, paths, host topology, credentials, or provider
stderr, and a missing source provider is reported as degraded/unavailable.

`remote_fleet_diff` compares a previous bounded `remote_fleet` snapshot with a
fresh read-only snapshot of the same registered host aliases. It returns only
changed sections (`health`, `inventory`, or `service-status`) and sanitized
unavailable status; it accepts no hostname, command, credential, or mutation
input.

`release_verify` verifies an already-present Linux release before an operator
chooses an upgrade. Supply explicit relative paths for generated build
metadata, a checksum manifest, an optional CycloneDX SBOM, and one to four
artifacts with their expected SHA-256 values. The operation is offline and
read-only: it uses the registered-root `artifact_verify` capability, rejects
mismatched provenance, and never invokes shell, network, apt, dpkg, or an
installer.

`environment_preflight` gives a bounded readiness matrix before a workflow.
It delegates only to `health check_all` and returns platform, display-server,
Node major version, capability availability/readiness, consent counts, and
sanitized missing-dependency names. It never returns hostnames, absolute
paths, command lines, environment values, provider errors, or secrets.

`workflow_preflight` is an advisory, read-only composition for a larger
workflow. It combines the same environment matrix with the fixed redacted
`diagnostics_snapshot` sections and, when given a registered `workspaceId`,
the bounded regular-file usage summary from `workspace_snapshot`. A relative
`path` may narrow that workspace section; a path without a workspace ID is
rejected. It never authorizes or executes work, writes files, returns file
contents, or exposes absolute paths, commands, topology, credentials, or raw
provider errors. Missing sections remain explicitly `unavailable` and the
overall status is `ready`, `degraded`, or `unavailable`.

`workspace_checkpoint` stores a named, bounded manifest for the current actor
between turns. The checkpoint contains only normalized relative paths, byte
counts, timestamps, and optional hashes; it never stores file contents or
absolute paths. `create`, `list`, `get`, `diff`, and `delete` are owner-isolated
by a one-way client/session fingerprint, expired records are pruned, and each
owner is limited to 32 records and 2 MiB of manifest metadata. `diff` always
uses the checkpoint's registered workspace/path and returns the existing
bounded metadata-only snapshot comparison; it never accepts a caller-supplied
baseline or writes workspace files.

`workspace_checkpoint compare` compares two saved checkpoints for the same
owner, registered workspace, and relative path. It accepts only the two
checkpoint IDs plus an optional entry cap, so it does not rescan the filesystem
or accept a caller-supplied baseline. The result uses the same bounded,
metadata-only added/removed/changed/unchanged shape as `workspace_snapshot`
diff.

`workspace_checkpoint prune` explicitly removes only expired checkpoints for
the authenticated owner and returns the deleted count. It accepts no path,
workspace, checkpoint ID, or caller-selected retention age; repeated calls are
idempotent and do not touch workspace files.

`workspace_checkpoint stats` reports only numeric checkpoint count/bytes,
fixed owner quota limits, and remaining capacity after expiry cleanup. It
accepts no workspace, path, checkpoint ID, or filter and never returns names,
IDs, entries, or absolute paths.

`workspace_changes` provides a bounded snapshot/diff feed from an active
workspace watcher. Events contain only a monotonic sequence, a normalized
relative path, an event kind, and an observation timestamp. The feed never
returns file contents or absolute roots, is limited to 200 retained events,
and reports `WATCHER_NOT_RUNNING` instead of starting a watcher implicitly.

`support_bundle` creates a confirmation-gated, redacted diagnostic archive
inside a registered workspace. Start with `dry_run` to obtain the exact member
list and `previewHash`; creation is capped at 2 MiB uncompressed and in the
final archive, includes at most 200 recent error events, and returns only a
registered relative path, SHA-256, size, member count, and approval receipt ID.
See [`docs/linux/SUPPORT_BUNDLE.md`](docs/linux/SUPPORT_BUNDLE.md).

The packaged systemd template reads the per-user environment file from
`/home/<user>/.config/baitonghub-linux-mcp/server.env`; create it with mode
`600` before enabling `baitonghub-linux-mcp@<user>`. A system service must not
use `%h` for this file because `%h` resolves against the system manager's
home, not the `User=` instance.

When Caddy proxies the endpoint, preserve the MCP `Host` and bearer header,
for example:

```caddyfile
reverse_proxy 192.168.1.39:18765 {
    header_up Host linuxmcp.baitonghub.com
    header_up Authorization "Bearer {$LINUXMCP_BEARER_TOKEN}"
}
```

## Package

Run `pnpm package:linux:headless` on Ubuntu 24.04 x64. It produces a DEB, a
Linux x64 tarball, and SHA-256 sums under `dist/`. The package contains only
the CLI bundles and private Node 24 runtime. It does not contain Electron or
Windows executables. The systemd unit is a template and must be enabled by the
operator with an existing non-root user; it does not create a user or configure
Cloudflare.

Cloudflare tunnel configuration is intentionally external. Point the tunnel at
the authenticated local HTTP endpoint; do not publish an unauthenticated MCP
listener.

## OpenAI Secure MCP Tunnel (ChatGPT subscription path)

The ChatGPT connection uses the official outbound-only `tunnel-client`; it does not call the Responses API
for each prompt and does not require a public MCP listener.

Install the current verified official client as root:

```sh
/opt/baitonghub-linux-mcp/install-linux-tunnel-client.sh
```

Store the runtime key and checkpoint key as root-only systemd credential source
files under `/etc/baitonghub-linux-mcp/<user>/`, then initialize the profile:

```sh
baitonghub-linux-mcp-tunnel-init <user> tunnel_0123456789abcdef0123456789abcdef
systemctl enable --now baitonghub-linux-mcp-tunnel@<user>.service
```

The service runs the packaged STDIO launcher with the `full` profile,
strict registered roots, a seven-day MCP connection ceiling, a loopback-only
health endpoint on port `18766`, and systemd control-group shutdown. Runtime
secrets are supplied through `LoadCredential`; they are not written to the
tunnel YAML, command line, logs, or audit records.

`full` applies only inside registered roots. Root escalation, machine shutdown,
disk formatting, mounting, workspace-root deletion, symlink escapes, and
termination of unowned processes remain blocked by the runtime policy.

`policy_explain` is available on the core/full headless surfaces as a read-only
advisory. Pass a visible tool name, optional operation, and (for workspace
tools) `workspaceId` to receive the active server/permission profile, required
profile, capability readiness, registered-root requirement, and confirmation
reason. It never executes the named tool and cannot approve or bypass policy.
Unknown or profile-hidden names return a generic `TOOL_NOT_AVAILABLE` result
without revealing hidden tool metadata.

Create the tunnel in OpenAI Platform, associate it with the intended personal
Platform organization and ChatGPT workspace, then add it from
`https://chatgpt.com/plugins`. The tunnel ID is required before profile init.
