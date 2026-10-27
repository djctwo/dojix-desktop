#!/usr/bin/env bash
# CI only (ubuntu): install each brand's .deb, run the installed app's --self-test, remove it;
# then run each AppImage's --self-test. Run inside tools/ci/with-keyring.sh.
set -euo pipefail
artifacts="$1"
failures=0
for brand in dojix greenwick; do
  deb=$(ls "$artifacts/$brand"/*.deb | head -1)
  pkg=$(dpkg-deb -f "$deb" Package)
  echo "== $brand .deb ($pkg)"
  if sudo apt-get install -y "$(realpath "$deb")" >/dev/null; then
    bin=$(dpkg -L "$pkg" | grep -E '^/usr/bin/' | head -1)
    if out=$("$bin" --self-test) && echo "$out" | grep -q '"webviewPrivate":true'; then
      echo "self-test: $out"
      echo "ok - $brand .deb install and self-test"
    else
      echo "::error::$brand .deb self-test failed: $out"; failures=$((failures + 1))
    fi
    sudo apt-get remove -y "$pkg" >/dev/null
    if [ -e "$bin" ]; then echo "::error::$bin still present after removal"; failures=$((failures + 1)); fi
  else
    echo "::error::$brand .deb install failed"; failures=$((failures + 1))
  fi

  appimage=$(ls "$artifacts/$brand"/*.AppImage | head -1)
  echo "== $brand AppImage"
  chmod +x "$appimage"
  if out=$(APPIMAGE_EXTRACT_AND_RUN=1 "$appimage" --self-test) \
    && echo "$out" | grep -q '"webviewPrivate":true'; then
    echo "self-test: $out"
    echo "ok - $brand AppImage self-test"
  else
    echo "::error::$brand AppImage self-test failed: $out"; failures=$((failures + 1))
  fi
done
if [ "$failures" -gt 0 ]; then echo "$failures check(s) failed"; exit 1; fi
echo "All Linux installer smoke checks passed."
