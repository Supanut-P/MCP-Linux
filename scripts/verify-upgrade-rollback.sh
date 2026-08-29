#!/bin/sh
set -eu

# Reproducible, non-destructive package upgrade/rollback preflight. A clean VM
# operator may use the printed commands for install/upgrade/rollback evidence;
# this script itself never runs sudo or mutates the host package database.
artifact_dir=${1:-dist}
version=${VERSION:-}
if [ -z "$version" ]; then
  version=$(node -p "require('./package.json').version")
fi
deb="$artifact_dir/Baitonghub-Linux-mcp-${version}-amd64.deb"
tarball="$artifact_dir/Baitonghub-Linux-mcp-${version}-linux-x64.tar.gz"
sums="$artifact_dir/Baitonghub-Linux-mcp-${version}-SHA256SUMS"
for file in "$deb" "$tarball" "$sums"; do
  test -f "$file" || { echo "missing release artifact: $file" >&2; exit 1; }
done
(cd "$artifact_dir" && sha256sum --check "$(basename "$sums")")
dpkg-deb --info "$deb" >/dev/null
if tar -tzf "$tarball" | grep -Eiq '(^|/)([^/]+\.(exe|cmd|bat|ps1)|windows-ocr|powershell)(/|$)'; then
  echo 'forbidden Windows content found in Linux artifact' >&2
  exit 1
fi
echo "Upgrade/rollback preflight passed for v${version}."
echo "Clean VM evidence must additionally record: install -> upgrade -> rollback -> uninstall -> reinstall, XDG state hash, and service owner."
