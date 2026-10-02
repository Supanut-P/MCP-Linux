#!/bin/sh
set -eu

evidence=${1:-}
if [ -z "$evidence" ] || [ ! -f "$evidence" ]; then
  echo "Usage: $0 <soak.tsv>" >&2
  exit 2
fi

min_duration=${SOAK_MIN_DURATION_SECONDS:-604800}
max_rss_growth=${SOAK_MAX_RSS_GROWTH_KB:-262144}
max_fd_growth=${SOAK_MAX_FD_GROWTH:-512}
max_wal_bytes=${SOAK_MAX_WAL_BYTES:-268435456}
case "$min_duration:$max_rss_growth:$max_fd_growth:$max_wal_bytes" in
  *[!0-9:]*|:*) echo 'Soak limits must be non-negative integers.' >&2; exit 2 ;;
esac

awk -F '\t' -v min_duration="$min_duration" -v max_rss_growth="$max_rss_growth" \
  -v max_fd_growth="$max_fd_growth" -v max_wal_bytes="$max_wal_bytes" '
  NR == 1 {
    expected = "timestamp\trss_kb\tfd_count\twal_bytes\ttask_count\ttunnel_reconnects\tservice_restarts\tpid\towner_uid"
    if ($0 != expected) { print "invalid soak header" > "/dev/stderr"; exit 1 }
    next
  }
  NF != 9 { print "invalid soak row at line " NR > "/dev/stderr"; exit 1 }
  {
    if ($1 !~ /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/) { print "invalid timestamp" > "/dev/stderr"; exit 1 }
    for (i = 2; i <= 9; i++) if ($i !~ /^[0-9]+$/) { print "invalid numeric field" > "/dev/stderr"; exit 1 }
    if (rows == 0) { first_ts = $1; first_rss = $2; first_fd = $3; pid = $8; owner = $9 }
    if ($1 < previous_ts) { print "timestamps are not monotonic" > "/dev/stderr"; exit 1 }
    if ($8 != pid || $9 != owner) { print "pid or owner changed" > "/dev/stderr"; exit 1 }
    if ($2 - first_rss > max_rss_growth) { print "RSS growth exceeds limit" > "/dev/stderr"; exit 1 }
    if ($3 - first_fd > max_fd_growth) { print "file-descriptor growth exceeds limit" > "/dev/stderr"; exit 1 }
    if ($4 > max_wal_bytes) { print "WAL size exceeds limit" > "/dev/stderr"; exit 1 }
    previous_ts = $1; last_ts = $1; rows++
  }
  END {
    if (rows < 2) { print "soak evidence needs at least two samples" > "/dev/stderr"; exit 1 }
    # Timestamps are fixed-width UTC ISO values, so lexical subtraction is
    # intentionally delegated to date(1) below; this awk check only ensures
    # ordering and complete rows.
    print rows " samples recorded for pid " pid " (owner " owner ")"
  }
' "$evidence"

first=$(sed -n '2p' "$evidence" | cut -f1)
last=$(tail -n 1 "$evidence" | cut -f1)
first_epoch=$(date -u -d "$first" +%s)
last_epoch=$(date -u -d "$last" +%s)
if [ "$last_epoch" -lt "$first_epoch" ] || [ $((last_epoch - first_epoch)) -lt "$min_duration" ]; then
  echo "soak duration is shorter than ${min_duration}s" >&2
  exit 1
fi
echo "Soak evidence verified: ${evidence} (${last_epoch} - ${first_epoch}s)."
