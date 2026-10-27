#!/usr/bin/env bash
# CI only: runs a command inside a private D-Bus session with an unlocked GNOME Keyring, so the
# Secret Service (the Linux credential vault) is available. The keyring password below is a
# throwaway value for a disposable CI runner, not a secret.
set -euo pipefail
exec dbus-run-session -- bash -c '
  echo -n "ci-throwaway-keyring" | gnome-keyring-daemon --unlock --components=secrets >/dev/null
  exec "$@"
' bash "$@"
