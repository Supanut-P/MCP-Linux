# Resuming a partial remote rollout

`remote_rollout_resume` recovers a failed or cancelled `remote_rollout` on
registered Linux SSH hosts. It never retries a host whose latest recorded
result is `ok`.

## Safe workflow

1. Call `remote_rollout_resume` with `operation: "preview"`, the rollout UUID,
   and its original `workspaceId`.
2. Review the returned selected `hostIds`, `retryCounts`, expiry, and fresh
   `previewHash`.
3. Call it again with `operation: "execute"`, the same preview hash, and
   `userConfirmed: true`.

Only failed or unattempted hosts are selected. Each host has at most two total
attempts. The runtime keeps the original fixed systemd unit, registered host
IDs, and concurrency limit; credentials, addresses, commands, and raw provider
errors never enter the persisted preview.

An SSH timeout, connection drop, or provider-unavailable response is recorded as
`unverified`. That result is intentionally not retried automatically. Inspect
the host and create a new operator-approved rollout when its state is known.

Resume previews expire after 15 minutes and are single-use. A mismatched
workspace, hash, expired preview, missing confirmation, or concurrent claim is
rejected before any remote mutation.
