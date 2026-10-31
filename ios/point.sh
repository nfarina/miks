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
#   ios/point.sh --restart …        # restart the app on the iPhone or iPad to
#                                   # deliver the link, for when it isn't taken
#                                   # up by the running app
#
# Exits nonzero unless the device really switched, which it checks by reading
# the app's own settings and bundle back off the device.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

PROJECT="$(ls -d *.xcodeproj | head -1)"
APP_NAME="$(basename "$PROJECT" .xcodeproj)"

BUNDLE=0
RESTART=0
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --bundle) BUNDLE=1 ;;
    --restart) RESTART=1 ;;
    *) ARGS+=("$arg") ;;
  esac
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

# The app's bundle id: the shortest in the project, as extensions and the
# watch app append to it. The first pattern is the JSON format, the second a
# pbxproj. Files only: `project.*` also matches the project.xcworkspace
# folder, and grep's error on it ends the script under pipefail.
BUNDLE_ID="$(find "$PROJECT" -maxdepth 1 -type f -name 'project.*' -exec grep -ohE '"PRODUCT_BUNDLE_IDENTIFIER" *: *"[^"]+"|PRODUCT_BUNDLE_IDENTIFIER = [^;]+;' {} + \
  | sed -E 's/.*[:=] *"?([^";]+)"?;?$/\1/' | awk '{ print length, $0 }' | sort -n | head -1 | cut -d' ' -f2)"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Copies the app's saved settings to $WORK/prefs.plist, and its cached bundle's
# manifest to $WORK/bundle.json, removing either that can't be read.
read_app_state() {
  rm -f "$WORK/prefs.plist" "$WORK/bundle.json"
  if [[ -n "$DEVICE" ]]; then
    for file in "Library/Preferences/$BUNDLE_ID.plist:prefs.plist" "Documents/dist/bundle.json:bundle.json"; do
      xcrun devicectl device copy from --device "$DEVICE" --domain-type appDataContainer \
        --domain-identifier "$BUNDLE_ID" --source "${file%%:*}" --destination "$WORK/${file##*:}" >/dev/null 2>&1 || true
    done
  else
    defaults export "$BUNDLE_ID" "$WORK/prefs.plist" 2>/dev/null || true
    cp "$HOME/Library/Containers/$BUNDLE_ID/Data/Documents/dist/bundle.json" "$WORK/bundle.json" 2>/dev/null || true
  fi
}

DEVICE=""
DEVICE_NAME="the Mac app"

# Settled before anything else, as a build takes a while to end in a question.
if [[ "$DEVICE_QUERY" != "mac" ]]; then
  xcrun devicectl list devices --json-output "$WORK/devices.json" >/dev/null 2>&1

  # Same rules as build.sh: a paired, physical iPhone or iPad that's ours.
  PICKED="$(python3 - "$WORK/devices.json" "$DEVICE_QUERY" "$SERVER" "$BUNDLE" <<'PY'
import json, sys

path, query, server, bundle = sys.argv[1:]
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
        args = "--bundle <page>" if bundle == "1" else f"{server} <page>"
        print(f'  ios/point.sh {args} "{name(d)}"', file=sys.stderr)
    print('  ios/point.sh ' + ("--bundle <page>" if bundle == "1" else f"{server} <page>") + " mac", file=sys.stderr)
    sys.exit(1)

print(matches[0]["identifier"])
print(name(matches[0]))
PY
)"
  DEVICE="${PICKED%%$'\n'*}"
  DEVICE_NAME="${PICKED##*$'\n'}"

  if xcrun devicectl device info lockState --device "$DEVICE" 2>/dev/null | grep -q "passcodeRequired: true"; then
    echo "Unlock $DEVICE_NAME first." >&2
    exit 1
  fi
fi

# Links are ignored without Developer mode, and nothing tells you so. Only a
# build we can read the settings of can be checked (not TestFlight, say).
read_app_state
if [[ -f "$WORK/prefs.plist" ]] && ! python3 -c 'import plistlib, sys; sys.exit(not plistlib.load(open(sys.argv[1], "rb")).get("developer_mode"))' "$WORK/prefs.plist"; then
  echo "Developer mode is off on $DEVICE_NAME. Turn it on in Settings → $APP_NAME, or Developer Settings… (⌥⌘,) in the Mac app." >&2
  exit 1
fi


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

echo "$URL"
if [[ -n "$DEVICE" ]]; then
  echo "Opening on $DEVICE_NAME"
  LAUNCH_ARGS=()
  if [[ "$RESTART" == 1 ]]; then LAUNCH_ARGS=(--terminate-existing); fi
  xcrun devicectl device process launch --device "$DEVICE" ${LAUNCH_ARGS[@]+"${LAUNCH_ARGS[@]}"} --payload-url "$URL" "$BUNDLE_ID" >/dev/null
else
  if [[ "$RESTART" == 1 ]]; then echo "--restart only applies to an iPhone or iPad."; fi
  echo "Opening on $DEVICE_NAME"
  open "$URL"
fi

# What the device should end up with: "" for production.
case "$SERVER" in
  production) EXPECTED_SERVER="" ;;
  *://*) EXPECTED_SERVER="$SERVER" ;;
  *) EXPECTED_SERVER="$(/usr/libexec/PlistBuddy -c "Print :DevServers" "$APP_NAME/Info.plist" | grep -oE "https?://$SERVER\.[^ ]+" | head -1 || true)" ;;
esac
EXPECTED_HASH=""
if [[ "$BUNDLE" == 1 ]]; then
  EXPECTED_HASH="$(python3 -c 'import json; print(json.load(open("../packages/app/dist/bundle.json"))["hash"])')"
fi

# Prints why the device hasn't switched yet, or nothing once it has.
what_is_left() {
  python3 - "$WORK" "$EXPECTED_SERVER" "$EXPECTED_HASH" <<'PY'
import json, plistlib, sys

work, server, bundle_hash = sys.argv[1:]

try:
    prefs = plistlib.load(open(f"{work}/prefs.plist", "rb"))
except OSError:
    sys.exit("couldn't read its settings")

current = prefs.get("development_server") if prefs.get("use_development_server") else ""
if (current or "") != server:
    sys.exit(f"it's still on {current or 'production'}")

if bool(prefs.get("use_cached_web_bundle")) != (bool(bundle_hash) or not server):
    sys.exit("its bundle caching hasn't changed")

if bundle_hash:
    try:
        cached = json.load(open(f"{work}/bundle.json"))["hash"]
    except OSError:
        cached = "no bundle"
    if cached != bundle_hash:
        sys.exit(f"it has {cached}, not {bundle_hash}")
PY
}

# The bundle download is what takes the time, and it's a few seconds at most.
LEFT=""
for _ in $(seq 1 15); do
  sleep 2
  read_app_state
  if LEFT="$(what_is_left 2>&1)"; then
    echo "$DEVICE_NAME is on ${EXPECTED_SERVER:-production}${EXPECTED_HASH:+, running $EXPECTED_HASH}."
    exit 0
  fi
done

echo "$DEVICE_NAME didn't switch: $LEFT." >&2
if [[ -n "$DEVICE" && "$RESTART" == 0 ]]; then
  echo "A running app can miss the link. Try again with --restart." >&2
fi
exit 1
