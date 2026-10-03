#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer as root." >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64|amd64) tunnel_arch=amd64 ;;
  aarch64|arm64) tunnel_arch=arm64 ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

for dependency in curl unzip sha256sum; do
  if ! command -v "$dependency" >/dev/null 2>&1; then
    echo "Missing dependency: $dependency" >&2
    exit 1
  fi
done

release_url='https://github.com/openai/tunnel-client/releases/latest'
resolved_release_url=$(curl -fsSL -o /dev/null -w '%{url_effective}' "$release_url")
tunnel_version=${resolved_release_url##*/}
case "$tunnel_version" in
  v[0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "Could not resolve a valid tunnel-client release tag." >&2; exit 1 ;;
esac

asset="tunnel-client-${tunnel_version}-linux-${tunnel_arch}.zip"
download_base="https://github.com/openai/tunnel-client/releases/download/${tunnel_version}"
temporary_directory=$(mktemp -d)
trap 'rm -rf -- "$temporary_directory"' EXIT HUP INT TERM

curl -fsSL --retry 3 --output "$temporary_directory/$asset" "$download_base/$asset"
curl -fsSL --retry 3 --output "$temporary_directory/SHA256SUMS.txt" "$download_base/SHA256SUMS.txt"

awk -v asset="$asset" '$2 == asset { print }' "$temporary_directory/SHA256SUMS.txt" > "$temporary_directory/asset.sha256"
if [ ! -s "$temporary_directory/asset.sha256" ]; then
  echo "The official checksum manifest does not contain $asset." >&2
  exit 1
fi
(cd "$temporary_directory" && sha256sum --check asset.sha256)

mkdir "$temporary_directory/extracted"
unzip -q "$temporary_directory/$asset" -d "$temporary_directory/extracted"
tunnel_binary=$(find "$temporary_directory/extracted" -type f -name tunnel-client -print)
if [ "$(printf '%s\n' "$tunnel_binary" | sed '/^$/d' | wc -l)" -ne 1 ]; then
  echo "The verified archive did not contain exactly one tunnel-client binary." >&2
  exit 1
fi

install -o root -g root -m 0755 "$tunnel_binary" /usr/local/bin/tunnel-client
/usr/local/bin/tunnel-client --version
