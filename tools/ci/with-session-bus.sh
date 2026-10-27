#!/usr/bin/env bash
# CI only: runs a command inside a private D-Bus session bus with NO service activation, so no
# Secret Service (credential vault) can appear. Used to test the "Linux without a keyring"
# mode (SPEC 6.4: App Lock mandatory, wrapped key in the data folder).
set -euo pipefail
conf="$(mktemp -d)/session.conf"
cat > "$conf" <<'XML'
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:tmpdir=/tmp</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
XML
exec dbus-run-session --config-file="$conf" -- "$@"
