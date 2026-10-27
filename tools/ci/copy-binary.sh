#!/usr/bin/env bash
# CI only: copies the freshly built app binary for a brand into e2e-bin/<brand>/.
# Tauri names it after mainBinaryName; fall back to the Cargo package name.
set -euo pipefail
brand="$1"
ext=""
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) ext=".exe" ;; esac
mkdir -p "e2e-bin/$brand"
for name in "$brand" dojix-desktop; do
  if [ -f "target/release/$name$ext" ]; then
    cp "target/release/$name$ext" "e2e-bin/$brand/$brand$ext"
    echo "e2e-bin/$brand/$brand$ext (from target/release/$name$ext)"
    exit 0
  fi
done
echo "no binary found for $brand in target/release" >&2
ls -la target/release >&2 || true
exit 1
