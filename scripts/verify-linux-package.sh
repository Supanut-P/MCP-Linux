#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
installer_dir=${1:-"$repository_root/dist"}
version=$(node -p "require('$repository_root/package.json').version")
deb="$installer_dir/Baitonghub-Linux-mcp-${version}-amd64.deb"
tarball="$installer_dir/Baitonghub-Linux-mcp-${version}-linux-x64.tar.gz"
checksums="$installer_dir/Baitonghub-Linux-mcp-${version}-SHA256SUMS"

for artifact in "$deb" "$tarball" "$checksums"; do
  if [ ! -f "$artifact" ]; then
    echo "Missing Linux package artifact: $artifact" >&2
    exit 1
  fi
done

(cd "$installer_dir" && sha256sum -c "$(basename "$checksums")")

metadata=$(dpkg-deb -f "$deb" Package Version Architecture Maintainer Depends)
printf '%s\n' "$metadata"
for dependency in ca-certificates curl git ripgrep unzip libsecret-1-0 libsecret-tools; do
  printf '%s\n' "$metadata" | grep -F "$dependency" >/dev/null || {
    echo "DEB is missing runtime dependency: $dependency" >&2
    exit 1
  }
done

inspection_root=$(mktemp -d /tmp/baitonghub-linux-package.XXXXXX)
cleanup() {
  case "$inspection_root" in
    /tmp/baitonghub-linux-package.*) rm -rf -- "$inspection_root" ;;
    *) echo "Refusing to remove unexpected inspection path: $inspection_root" >&2 ;;
  esac
}
trap cleanup EXIT HUP INT TERM

mkdir "$inspection_root/deb" "$inspection_root/tar"
dpkg-deb -x "$deb" "$inspection_root/deb"
tar -xzf "$tarball" -C "$inspection_root/tar"

forbidden_file=$(find "$inspection_root" -type f \( -iname '*.exe' -o -iname '*.cmd' -o -iname '*.ps1' -o -ipath '*windows-ocr*' \) -print -quit)
if [ -n "$forbidden_file" ]; then
  echo "Forbidden Windows resource in Linux package: $forbidden_file" >&2
  exit 1
fi

bundled_node="$inspection_root/deb/opt/baitonghub-linux-mcp/baitonghub-linux-mcp-node"
launcher="$inspection_root/deb/opt/baitonghub-linux-mcp/baitonghub-linux-mcp"
tar_node="$inspection_root/tar/opt/baitonghub-linux-mcp/baitonghub-linux-mcp-node"
tar_launcher="$inspection_root/tar/opt/baitonghub-linux-mcp/baitonghub-linux-mcp"
if [ ! -x "$bundled_node" ] || [ ! -x "$launcher" ] || [ ! -x "$tar_node" ] || [ ! -x "$tar_launcher" ]; then
  echo "Linux packages do not contain executable private Node and CLI launcher files" >&2
  exit 1
fi
node_version=$($bundled_node --version)
tar_node_version=$($tar_node --version)
case "$node_version" in
  v24.*) ;;
  *) echo "Expected bundled Node 24.x, got $node_version" >&2; exit 1 ;;
esac
if [ "$tar_node_version" != "$node_version" ]; then
  echo "DEB/tarball bundled Node versions differ: $node_version vs $tar_node_version" >&2
  exit 1
fi

printf 'Bundled runtime: %s\n' "$node_version"
file "$bundled_node"
printf 'Linux package inspection passed.\n'
