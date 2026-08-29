#!/bin/sh
set -eu

# Operator-run soak recorder. It records evidence; it does not claim that a
# seven-day run has completed. Use SOAK_DURATION_SECONDS=604800 for seven days.
interval=${SOAK_INTERVAL_SECONDS:-300}
duration=${SOAK_DURATION_SECONDS:-604800}
pid=${BAITONGHUB_LINUX_MCP_PID:-}
data_directory=${BAITONGHUB_LINUX_MCP_DATA:-${XDG_DATA_HOME:-$HOME/.local/share}/baitonghub-linux-mcp}
state_directory=${XDG_STATE_HOME:-$HOME/.local/state}/baitonghub-linux-mcp
output=${SOAK_OUTPUT:-$state_directory/soak-linux-headless.tsv}
tunnel_log=${TUNNEL_CLIENT_PROFILE_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/tunnel-client}/baitonghub-linux-mcp.log

case "$interval:$duration" in *[!0-9:]*|:*) echo 'SOAK_INTERVAL_SECONDS and SOAK_DURATION_SECONDS must be positive integers.' >&2; exit 2 ;; esac
if [ "$interval" -lt 1 ] || [ "$duration" -lt 1 ]; then echo 'Soak interval and duration must be positive.' >&2; exit 2; fi
if [ -z "$pid" ]; then pid=$$
fi
mkdir -p "$(dirname "$output")"
printf 'timestamp\trss_kb\tfd_count\twal_bytes\ttask_count\ttunnel_reconnects\tservice_restarts\n' > "$output"
started=$(date +%s)
while :; do
  now=$(date +%s)
  elapsed=$((now - started))
  if [ "$elapsed" -gt "$duration" ]; then break; fi
  if [ ! -r "/proc/$pid/status" ]; then echo "Process $pid is no longer running." >&2; exit 1; fi
  rss=$(awk '/^VmRSS:/ {print $2}' "/proc/$pid/status" 2>/dev/null || printf '0')
  fds=$(find "/proc/$pid/fd" -mindepth 1 -maxdepth 1 -type l 2>/dev/null | wc -l | tr -d ' ')
  wal=$(find "$data_directory" -type f -name '*.sqlite-wal' -printf '%s\n' 2>/dev/null | awk '{s+=$1} END {print s+0}')
  tasks=$(find "$data_directory" -type f -path '*/background-tasks/*' 2>/dev/null | wc -l | tr -d ' ')
  reconnects=$(grep -Eic 'reconnect|reconnected' "$tunnel_log" 2>/dev/null || printf '0')
  restarts=$(systemctl show "baitonghub-linux-mcp-tunnel@${USER}.service" --property=NRestarts --value 2>/dev/null || printf '0')
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$rss" "$fds" "$wal" "$tasks" "$reconnects" "$restarts" >> "$output"
  if [ "$elapsed" -ge "$duration" ]; then break; fi
  sleep "$interval"
done
printf 'Soak evidence recorded at %s; review for bounded growth and recovered reconnects.\n' "$output"
