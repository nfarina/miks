#!/usr/bin/env bash
# @chatwing
#
# Points the app on a device at a build to try, by opening a
# `<scheme>://dev-server/…` link in it (see ios/Shared/DevServer.swift). The
# app must be installed and in Developer mode (Settings → <App>), and an
# iPhone unlocked.
#
# By default it hands over a bundle: it builds and packages the web app from
# this working tree, serves it from this machine (riot's `bundle` task, over
# Tailscale), and has the device download and cache it. The app then runs that
# build against production wherever you take it, laptop closed or not. Naming
# a server, or --live, points the app at a live Vite server instead, for quick
# iteration with the laptop at hand. A project that can't package a bundle
# (no `package` script) always goes live.
#
# Usage:
#   ios/point.sh                    # a bundle of this tree, on the connected iPhone
#   ios/point.sh /some/page         # ...opened at a page
#   ios/point.sh "Nick's iPad"      # ...on another device (name fragment or id)
#   ios/point.sh /some/page mac     # ...in the Mac app on this machine
#   ios/point.sh --live [page] [device]
#                                   # this machine's live Vite server instead
#   ios/point.sh neo [page] [device]
#                                   # a live server from DevServers in Info.plist
#   ios/point.sh https://… [page] [device]
#                                   # any other live server
#   ios/point.sh production [page] [device]
#   ios/point.sh --backend=functions …
#                                   # a live server, against this machine's local
#                                   # server (functions) or its emulators
#                                   # (firestore); `none` for production again
#   ios/point.sh --restart …        # restart the app on the iPhone or iPad to
#                                   # deliver the link, for when it isn't taken
#                                   # up by the running app
#
# A bundle can't use a local backend: it would need this machine awake, which
# is what a bundle is for avoiding. Deploy the server side first, or use
# --live with --backend.
#
# Exits nonzero unless the device really switched, which it checks by reading
# the app's own settings and bundle back off the device.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

PROJECT="$(ls -d *.xcodeproj | head -1)"
APP_NAME="$(basename "$PROJECT" .xcodeproj)"

MODE="" # bundle or live; settled below if no flag says.
BACKEND=""
RESTART=0
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --bundle) MODE="bundle" ;;
    --live) MODE="live" ;;
    --backend=*) BACKEND="${arg#--backend=}" ;;
    --restart) RESTART=1 ;;
    *) ARGS+=("$arg") ;;
  esac
done
set -- "${ARGS[@]+"${ARGS[@]}"}"

case "$BACKEND" in
  "" | none | functions | firestore) ;;
  *)
    echo "--backend is none, functions, or firestore, not \"$BACKEND\"." >&2
    exit 1
    ;;
esac

TAILSCALE="$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)"
TAILNET_NAME="$("$TAILSCALE" status --json | python3 -c 'import json, sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
THIS_MACHINE="${TAILNET_NAME%%.*}"

INFO_PLIST="$APP_NAME/Info.plist"
SCHEME="$(/usr/libexec/PlistBuddy -c "Print :CFBundleURLTypes:0:CFBundleURLSchemes:0" "$INFO_PLIST")"
PRESETS="$(/usr/libexec/PlistBuddy -c "Print :DevServers" "$INFO_PLIST" 2>/dev/null || true)"

# The DevServers URL named by a preset's first host label, if there is one.
preset_url() {
  grep -oE "https?://$1\.[^ ]+" <<<"$PRESETS" | head -1 || true
}

# Whether the first argument names a server, rather than a page or a device.
is_server() {
  [[ "$1" == "production" || "$1" == *"://"* || -n "$(preset_url "$1")" ]]
}

# Whether this project can package a bundle for the app to cache.
can_bundle() {
  python3 -c 'import json, sys; sys.exit("package" not in json.load(open("../packages/app/package.json")).get("scripts", {}))' 2>/dev/null
}

FIRST="${1:-}"
if [[ -n "$FIRST" ]] && is_server "$FIRST"; then
  # Naming a server means that live server, as it always has.
  if [[ "$MODE" == "bundle" ]]; then
    echo "A bundle is built and served here; don't name a server with --bundle." >&2
    exit 1
  fi
  MODE="live"
  SERVER="$FIRST"
  shift
else
  if [[ -z "$MODE" ]]; then
    if [[ -n "$BACKEND" ]]; then
      MODE="live"
    elif can_bundle; then
      MODE="bundle"
    else
      MODE="live"
    fi
  fi
  SERVER="$THIS_MACHINE"
fi

if [[ "$MODE" == "bundle" && -n "$BACKEND" ]]; then
  echo "A bundle runs against production; --backend needs a live server (add --live)." >&2
  exit 1
fi
if [[ "$MODE" == "bundle" ]] && ! can_bundle; then
  echo "This project can't package a bundle (no \`package\` script in packages/app)." >&2
  exit 1
fi

# What's left is [page] [device]. A page starts with "/"; anything else in the
# first slot is a device, so `point.sh "Nick's iPad"` reads naturally.
PAGE=""
DEVICE_QUERY="${IOS_DEVICE:-}"
if [[ $# -ge 1 ]]; then
  if [[ "$1" == /* || $# -ge 2 ]]; then
    PAGE="$1"
    DEVICE_QUERY="${2:-$DEVICE_QUERY}"
  else
    DEVICE_QUERY="$1"
  fi
fi

if [[ "$MODE" == "live" && "$SERVER" == "$THIS_MACHINE" && -z "$(preset_url "$THIS_MACHINE")" ]]; then
  echo "No server for this machine ($THIS_MACHINE) in DevServers, so it can't go live. Leave off --live for a bundle." >&2
  exit 1
fi

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

  # How to run this again for a given device, for the "Pick a device" hints.
  if [[ "$MODE" == "bundle" ]]; then
    AGAIN="ios/point.sh ${PAGE:-/}"
  elif [[ "$SERVER" == "$THIS_MACHINE" ]]; then
    AGAIN="ios/point.sh --live ${PAGE:-/}"
  else
    AGAIN="ios/point.sh $SERVER ${PAGE:-/}"
  fi
  [[ -n "$BACKEND" ]] && AGAIN="$AGAIN --backend=$BACKEND"

  # Same rules as build.sh: a paired, physical iPhone or iPad that's ours.
  PICKED="$(python3 - "$WORK/devices.json" "$DEVICE_QUERY" "$AGAIN" <<'PY'
import json, sys

path, query, again = sys.argv[1:]
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
        print(f'  {again} "{name(d)}"', file=sys.stderr)
    print(f"  {again} mac", file=sys.stderr)
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
if [[ "$MODE" == "bundle" ]]; then
  PORT="$(python3 -c 'import json; print(json.load(open("../packages/app/firebase.json"))["emulators"]["hosting"]["port"])')"
  SERVER="https://$TAILNET_NAME:$PORT"

  # The bundle is built from the working tree, so it carries any uncommitted
  # work, including other sessions' in this checkout.
  DIRTY="$(git -C .. status --porcelain -- packages | wc -l | tr -d ' ')"
  if [[ "$DIRTY" != 0 ]]; then
    echo "Note: this includes uncommitted changes in $DIRTY file(s) under packages/."
  fi

  echo "Building and packaging the web app…"
  (cd .. && yarn workspace app build && yarn workspace app package) >"$WORK/build.log" 2>&1 || {
    tail -30 "$WORK/build.log" >&2
    echo "The build failed." >&2
    exit 1
  }
  if command -v riot >/dev/null; then
    # `tailscale serve` keeps listening on this port on the tailnet addresses,
    # and the hosting emulator refuses to start on a port anything holds, so
    # hand it back while the server starts (it's served again just below).
    if ! curl -sf "http://localhost:$PORT/bundle.json" >/dev/null; then
      "$TAILSCALE" serve --https="$PORT" off >/dev/null 2>&1 || true
    fi
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

URL="$(python3 - "$SCHEME" "$SERVER" "$PAGE" "$MODE" "$BACKEND" <<'PY'
import sys
from urllib.parse import quote, urlencode

scheme, server, page, mode, backend = sys.argv[1:]
query = {}
if "://" in server:
    name, query["url"] = "", server
    if mode == "bundle":
        query["bundle"] = "1"
else:
    name = quote(server)
if page:
    query["path"] = page
if backend:
    query["emulator"] = backend

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
  *) EXPECTED_SERVER="$(preset_url "$SERVER")" ;;
esac
EXPECTED_HASH=""
if [[ "$MODE" == "bundle" ]]; then
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
    echo "$DEVICE_NAME is on ${EXPECTED_SERVER:-production}${EXPECTED_HASH:+, running $EXPECTED_HASH}${BACKEND:+, backend $BACKEND}."
    exit 0
  fi
done

echo "$DEVICE_NAME didn't switch: $LEFT." >&2
if [[ -n "$DEVICE" && "$RESTART" == 0 ]]; then
  echo "A running app can miss the link. Try again with --restart." >&2
fi
exit 1
