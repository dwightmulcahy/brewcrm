#!/usr/bin/env bash
# Download the PocketBase binary pinned by `ARG PB_VERSION` in the Dockerfile, verify it
# against the release's checksums.txt, and print its path. Used by the e2e tests.
#   PB_BIN=$(scripts/fetch-pocketbase.sh) npm run test:e2e
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
version="$(sed -n 's/^ARG PB_VERSION=\(.*\)$/\1/p' "$root/Dockerfile")"
[ -n "$version" ] || { echo "PB_VERSION not found in Dockerfile" >&2; exit 1; }

case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) echo "unsupported OS" >&2; exit 1 ;; esac
case "$(uname -m)" in x86_64|amd64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) echo "unsupported arch" >&2; exit 1 ;; esac

dest="$root/.cache/pocketbase/$version-$os-$arch"
bin="$dest/pocketbase"
if [ ! -x "$bin" ]; then
  mkdir -p "$dest"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  base="https://github.com/pocketbase/pocketbase/releases/download/v$version"
  zip="pocketbase_${version}_${os}_${arch}.zip"
  curl -fsSL -o "$tmp/$zip" "$base/$zip"
  curl -fsSL -o "$tmp/checksums.txt" "$base/checksums.txt"
  (cd "$tmp" && grep " $zip\$" checksums.txt > expected.sha256 && test -s expected.sha256 && sha256sum -c expected.sha256 >&2)
  unzip -q -o "$tmp/$zip" pocketbase -d "$dest"
  chmod 0755 "$bin"
fi
echo "$bin"
