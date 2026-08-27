#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this command as root." >&2
  exit 1
fi
if [ "$#" -ne 2 ]; then
  echo "Usage: baitonghub-linux-mcp-tunnel-init <linux-user> <tunnel_id>" >&2
  exit 1
fi

tunnel_user=$1
tunnel_id=$2
case "$tunnel_id" in
  tunnel_[a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9]) ;;
  *) echo "Invalid tunnel ID." >&2; exit 1 ;;
esac

tunnel_home=$(getent passwd "$tunnel_user" | cut -d: -f6)
if [ -z "$tunnel_home" ] || [ ! -d "$tunnel_home" ]; then
  echo "Linux user or home directory not found: $tunnel_user" >&2
  exit 1
fi

tunnel_client=${BAITONGHUB_LINUX_MCP_TUNNEL_CLIENT:-/usr/local/bin/tunnel-client}
credential_file="/etc/baitonghub-linux-mcp/$tunnel_user/control-plane-api-key"
profile_directory="$tunnel_home/.config/tunnel-client"
if [ ! -x "$tunnel_client" ]; then
  echo "tunnel-client is unavailable at $tunnel_client" >&2
  exit 1
fi
if [ ! -s "$credential_file" ]; then
  echo "Missing tunnel credential for $tunnel_user." >&2
  exit 1
fi

umask 077
mkdir -p "$profile_directory"
CONTROL_PLANE_API_KEY=$(tr -d '\r\n' < "$credential_file")
export CONTROL_PLANE_API_KEY
HOME="$tunnel_home" XDG_CONFIG_HOME="$tunnel_home/.config" \
  "$tunnel_client" init \
    --force \
    --sample sample_mcp_stdio_local \
    --profile baitonghub-linux-mcp \
    --profile-dir "$profile_directory" \
    --tunnel-id "$tunnel_id" \
    --control-plane-api-key-ref env:CONTROL_PLANE_API_KEY \
    --health-listen-addr 127.0.0.1:18766 \
    --mcp-command "/usr/bin/baitonghub-linux-mcp mcp --stdio"
unset CONTROL_PLANE_API_KEY
chown -R "$tunnel_user:$tunnel_user" "$profile_directory"
chmod 700 "$profile_directory"
chmod 600 "$profile_directory/baitonghub-linux-mcp.yaml"
