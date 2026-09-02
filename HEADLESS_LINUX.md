# Baitonghub-Linux-mcp headless server

The Linux server artifact is CLI-only. It does not start Electron, require a
desktop session, or require Chrome/Chromium, Wayland, X11, portals, or OCR.

## Run from the source tree

```sh
export BAITONGHUB_LINUX_MCP_WORKSPACE=/srv/mcp-workspace
export BAITONGHUB_LINUX_MCP_CHECKPOINT_KEY_BASE64='<32-byte base64 key>'
./apps/cli/build-headless/baitonghub-linux-mcp mcp --stdio
```

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
read-only `health`, bounded `inventory`, or `service-status` checks to 1–20
registered hosts, with at most four SSH sessions in flight.

`remote_rollout` is optional and requires the durable local rollout store in
addition to `remote_host`. It plans and executes one fixed `.service` restart
with an expiring aggregate preview hash, canary-first batches, explicit
confirmation, cancellation, and sanitized per-host audit evidence. It never
accepts arbitrary remote shell input.

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

Create the tunnel in OpenAI Platform, associate it with the intended personal
Platform organization and ChatGPT workspace, then add it from
`https://chatgpt.com/plugins`. The tunnel ID is required before profile init.
