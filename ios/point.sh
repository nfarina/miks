#!/usr/bin/env bash
# @chatwing
#
# Points the app on a device at a development server, live, by opening a
# `<scheme>://dev-server/…` link in it (see ios/Shared/DevServer.swift). The
# app must be installed and in Developer mode (Settings → <App>), and an
# iPhone unlocked.
#
# Usage:
#   ios/point.sh                    # this machine, on the connected iPhone
#   ios/point.sh neo                # a server from DevServers in Info.plist
#   ios/point.sh production
#   ios/point.sh https://…          # any other server
#   ios/point.sh air /some/page     # and open a page there
#   ios/point.sh air / "Nick's iPad"  # pick a device (name fragment or id)
#   ios/point.sh air / mac          # the Mac app on this machine instead
#   ios/point.sh --bundle [page] [device]
#                                   # build and package the web app here, serve
#                                   # it (riot's `bundle` task, over Tailscale),
#                                   # and have the device cache it - so it keeps
#                                   # working away from this machine. The way to
#                                   # hand over a build to try.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

PROJECT="$(ls -d *.xcodeproj | head -1)"
APP_NAME="$(basename "$PROJECT" .xcodeproj)"

BUNDLE=0
ARGS=()
for arg in "$@"; do
  if [[ "$arg" == "--bundle" ]]; then BUNDLE=1; else ARGS+=("$arg"); fi
done
set -- "${ARGS[@]+"${ARGS[@]}"}"

TAILSCALE="$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)"
THIS_MACHINE="$("$TAILSCALE" status --json | python3 -c 'import json, sys; print(json.load(sys.stdin)["Self"]["DNSName"].split(".")[0])')"

if [[ "$BUNDLE" == 1 ]]; then
  # Built here, so served from here.
  SERVER="$THIS_MACHINE"
  PAGE="${1:-}"
  DEVICE_QUERY="${2:-${IOS_DEVICE:-}}"
else
  SERVER="${1:-$THIS_MACHINE}"
  PAGE="${2:-}"
  DEVICE_QUERY="${3:-${IOS_DEVICE:-}}"
fi

SCHEME="$(/usr/libexec/PlistBuddy -c "Print :CFBundleURLTypes:0:CFBundleURLSchemes:0" "$APP_NAME/Info.plist")"

# The bundle is served by the app's hosting emulator, which serves its dist
# folder from disk, so a rebuild needs no restart. `tailscale serve` is
# configuration kept by Tailscale itself, not a process: setting it again is a
# no-op, and it outlasts reboots.
if [[ "$BUNDLE" == 1 ]]; then
  PRESET="$(/usr/libexec/PlistBuddy -c "Print :DevServers" "$APP_NAME/Info.plist" | grep -oE "https?://$SERVER\.[^ ]+" | head -1)" || {
    echo "No server for this machine ($SERVER) in DevServers." >&2
    exit 1
  }
  PORT="$(python3 -c 'import json; print(json.load(open("../packages/app/firebase.json"))["emulators"]["hosting"]["port"])')"
  SERVER="${PRESET%:*}:$PORT"

  (cd .. && yarn workspace app build && yarn workspace app package) >/dev/null
  if command -v riot >/dev/null; then
    (cd .. && riot start .:bundle) >/dev/null
  else
    curl -sf "http://localhost:$PORT/bundle.json" >/dev/null || {
      echo "Start the bundle server first: yarn workspace app serve" >&2
      exit 1
    }
  fi
  "$TAILSCALE" serve --bg --https="$PORT" "http://localhost:$PORT" >/dev/null
  echo "Serving $(cat ../packages/app/dist/bundle.json) at $SERVER"
fi

URL="$(python3 - "$SCHEME" "$SERVER" "$PAGE" "$BUNDLE" <<'PY'
import sys
from urllib.parse import quote, urlencode

scheme, server, page, bundle = sys.argv[1:]
query = {}
if "://" in server:
    name, query["url"] = "", server
    if bundle == "1":
        query["bundle"] = "1"
else:
    name = quote(server)
if page:
    query["path"] = page

print(f"{scheme}://dev-server/{name}" + (f"?{urlencode(query)}" if query else ""))
PY
)"

if [[ "$DEVICE_QUERY" == "mac" ]]; then
  echo "Opening $URL"
  open "$URL"
  exit 0
fi

# The app's bundle id: the shortest in the project, as extensions and the
# watch app append to it. The first pattern is the JSON format, the second a
# pbxproj. Files only: `project.*` also matches the project.xcworkspace
# folder, and grep's error on it ends the script under pipefail.
BUNDLE_ID="$(find "$PROJECT" -maxdepth 1 -type f -name 'project.*' -exec grep -ohE '"PRODUCT_BUNDLE_IDENTIFIER" *: *"[^"]+"|PRODUCT_BUNDLE_IDENTIFIER = [^;]+;' {} + \
  | sed -E 's/.*[:=] *"?([^";]+)"?;?$/\1/' | awk '{ print length, $0 }' | sort -n | head -1 | cut -d' ' -f2)"

DEVICE_JSON="$(mktemp)"
trap 'rm -f "$DEVICE_JSON"' EXIT
xcrun devicectl list devices --json-output "$DEVICE_JSON" >/dev/null 2>&1

# Same rules as build.sh: a paired, physical iPhone or iPad that's ours.
DEVICE="$(python3 - "$DEVICE_JSON" "$DEVICE_QUERY" <<'PY'
import json, sys

path, query = sys.argv[1], sys.argv[2]
devices = json.load(open(path))["result"]["devices"]

def usable(d):
    hw, conn = d.get("hardwareProperties", {}), d.get("connectionProperties", {})
    return (
        hw.get("reality") == "physical"
        and hw.get("platform") == "iOS"
        and conn.get("pairingState") == "paired"
        and conn.get("tunnelState") != "unavailable"
    )

def name(d):
    return d.get("deviceProperties", {}).get("name", "?")

matches = [d for d in devices if usable(d)]
if query:
    q = query.lower()
    matches = [d for d in matches if q in name(d).lower() or q in d["identifier"].lower()]

if len(matches) != 1:
    print("Pick a device:" if matches else "No device found.", file=sys.stderr)
    for d in matches:
        print(f'  ios/point.sh <server> <page> "{name(d)}"', file=sys.stderr)
    sys.exit(1)

print(matches[0]["identifier"])
print(f"Opening on {name(matches[0])}", file=sys.stderr)
PY
)"

echo "$URL"
xcrun devicectl device process launch --device "$DEVICE" --payload-url "$URL" "$BUNDLE_ID" >/dev/null
