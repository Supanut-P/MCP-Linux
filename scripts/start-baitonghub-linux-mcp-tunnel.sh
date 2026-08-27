#!/bin/sh
set -eu

tunnel_client=${BAITONGHUB_LINUX_MCP_TUNNEL_CLIENT:-/usr/local/bin/tunnel-client}
profile_name=${BAITONGHUB_LINUX_MCP_TUNNEL_PROFILE:-baitonghub-linux-mcp}
profile_directory=${TUNNEL_CLIENT_PROFILE_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/tunnel-client}
state_directory=${XDG_STATE_HOME:-$HOME/.local/state}/baitonghub-linux-mcp
credential_directory=${CREDENTIALS_DIRECTORY:-}

if [ ! -x "$tunnel_client" ]; then
  echo "tunnel-client is unavailable at $tunnel_client" >&2
  exit 1
fi
if [ ! -f "$profile_directory/$profile_name.yaml" ]; then
  echo "Tunnel profile $profile_name is not configured." >&2
  exit 1
fi
if [ -z "$credential_directory" ] || [ ! -s "$credential_directory/control_plane_api_key" ]; then
  echo "The systemd control-plane credential is unavailable." >&2
  exit 1
fi
if [ ! -s "$credential_directory/checkpoint_key_base64" ]; then
  echo "The systemd checkpoint credential is unavailable." >&2
  exit 1
fi

umask 077
mkdir -p "$profile_directory" "$state_directory"
CONTROL_PLANE_API_KEY=$(tr -d '\r\n' < "$credential_directory/control_plane_api_key")
BAITONGHUB_LINUX_MCP_CHECKPOINT_KEY_BASE64=$(tr -d '\r\n' < "$credential_directory/checkpoint_key_base64")
export CONTROL_PLANE_API_KEY BAITONGHUB_LINUX_MCP_CHECKPOINT_KEY_BASE64
export BAITONGHUB_LINUX_MCP_STDIO_PROFILE=full
export BAITONGHUB_LINUX_MCP_STRICT_ROOTS=1
export TUNNEL_CLIENT_PROFILE_DIR="$profile_directory"

if [ -n "${BAITONGHUB_LINUX_MCP_WORKSPACE:-}" ]; then
  export BAITONGHUB_LINUX_MCP_ALLOWED_ROOTS="$BAITONGHUB_LINUX_MCP_WORKSPACE"
fi

"$tunnel_client" doctor \
  --profile "$profile_name" \
  --profile-dir "$profile_directory" \
  --explain

exec "$tunnel_client" run \
  --profile "$profile_name" \
  --profile-dir "$profile_directory" \
  --log.file "$state_directory/tunnel-client.log" \
  --health.listen-addr 127.0.0.1:18766 \
  --mcp.connection-max-ttl 168h0m0s
