#!/bin/sh
set -eu

# Reproducible, non-destructive package upgrade/rollback preflight. A clean VM
# operator may use the printed commands for install/upgrade/rollback evidence;
# this script itself never runs sudo or mutates the host package database.
artifact_dir=${1:-dist}
script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH= cd -- "$script_directory/.." && pwd)
version=${VERSION:-}
if [ -z "$version" ]; then
  version=$(node -e 'console.log(require(process.argv[1]).version)' "$repository_root/package.json")
fi
deb="$artifact_dir/Baitonghub-Linux-mcp-${version}-amd64.deb"
tarball="$artifact_dir/Baitonghub-Linux-mcp-${version}-linux-x64.tar.gz"
sums="$artifact_dir/Baitonghub-Linux-mcp-${version}-SHA256SUMS"
metadata="$artifact_dir/Baitonghub-Linux-mcp-${version}-BUILD-METADATA.json"
sbom="$artifact_dir/Baitonghub-Linux-mcp-${version}-SBOM.cdx.json"
provenance_sums="$artifact_dir/Baitonghub-Linux-mcp-${version}-PROVENANCE-SHA256SUMS"
for file in "$deb" "$tarball" "$sums" "$metadata" "$sbom" "$provenance_sums"; do
  test -f "$file" || { echo "missing release artifact: $file" >&2; exit 1; }
done
(cd "$artifact_dir" && sha256sum --check "$(basename "$sums")")
(cd "$artifact_dir" && sha256sum --check "$(basename "$provenance_sums")")
node -e "const fs=require('fs'); const m=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); if(m.product!=='Baitonghub-Linux-mcp'||m.version!==process.argv[2]||m.sourceDirty!==false) process.exit(1)" "$metadata" "$version"
node -e "const fs=require('fs'); const b=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); if(b.bomFormat!=='CycloneDX'||b.specVersion!=='1.5'||!Array.isArray(b.components)) process.exit(1)" "$sbom"
dpkg-deb --info "$deb" >/dev/null
if tar -tzf "$tarball" | grep -Eiq '(^|/)([^/]+\.(exe|cmd|bat|ps1)|windows-ocr|powershell)(/|$)'; then
  echo 'forbidden Windows content found in Linux artifact' >&2
  exit 1
fi
echo "Upgrade/rollback preflight passed for v${version}."
echo "Clean VM evidence must additionally record: install -> upgrade -> rollback -> uninstall -> reinstall, XDG state hash, and service owner."
