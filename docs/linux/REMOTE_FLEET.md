# Registered remote fleet inspection

`remote_fleet` is a read-only v1.3 facility for checking a bounded set of
Linux hosts that have already been registered in the remote-host registry. A
request contains only `hostIds` (1–20) and one fixed operation:

- `health` — verify the registered SSH connection;
- `inventory` — list up to 500 entries beneath a registered root (or an
  explicitly supplied path inside that root);
- `service-status` — read bounded systemd unit state.

Each host is inspected through `remote_host`. The registry supplies the host,
port, username, pinned fingerprint, key reference, and allowed roots; callers
cannot provide any of those values and cannot provide a raw SSH command. At
most four SSH sessions run concurrently. A failed host is returned as a
sanitized per-host error so one unavailable machine does not hide the rest of
the result.

Path operations run `realpath --canonicalize-existing` immediately before the
fixed remote operation and reject paths outside the selected host's registered
roots or paths that resolve through a symlink escape. Remote output remains
bounded and credentials are read from Secret Service by the existing
`remote_host` backend; credentials and private key material are not returned.

The individual `remote_host` tool additionally supports `disk_usage` and
`checksum` for registered paths. Checksums are SHA-256 and secret-looking files
are rejected. Remote mutations remain separate preview-plus-confirmation
operations and are not available through `remote_fleet`.
