#!/usr/bin/env bash
# @chatwing
#
# Builds the iOS app, signed for development, and hands it out as a link to
# tap on any of your devices on Tailscale (in Safari): it installs from
# anywhere, no cable or Xcode. It installs on the devices in the team's
# development profile, which is any device that's been paired with Xcode
# once.
#
# Usage:
#   ios/share.sh
#
# How: an archive, exported (method "debugging") to an .ipa, beside an
# install manifest and a page with the itms-services:// link, in
# ~/Library/Application Support/iOS Builds/<App>/, served at this Mac's
# Tailscale name on port 8443. iOS installs from a manifest only over HTTPS
# with a trusted certificate, which Tailscale's is. Tailscale's Mac app
# can't serve a folder itself ("Path serving is not supported on macOS due to
# sandbox restrictions"), so a launchd agent runs python3's http.server on
# 127.0.0.1:8442 and `tailscale serve` puts it on 8443. Both are set up the
# first time and stay: the agent across reboots, serve in Tailscale's config.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

if [[ -f project.yml ]]; then
  xcodegen generate >/dev/null
fi

PROJECT="$(ls -d *.xcodeproj | head -1)"
SCHEME="$(basename "$PROJECT" .xcodeproj)"
WORK=build/share.noindex
ARCHIVE="$WORK/$SCHEME.xcarchive"

ROOT="$HOME/Library/Application Support/iOS Builds"
OUT="$ROOT/$SCHEME"
PORT=8443
LOCAL_PORT=8442
AGENT=local.ios-builds

TAILSCALE="$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)"
HOST="$("$TAILSCALE" status --json | python3 -c 'import json, sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"

echo "Archiving $SCHEME"
rm -rf "$WORK"
mkdir -p "$WORK"
xcodebuild \
  -project "$PROJECT" \
  -scheme "$SCHEME" \
  -destination generic/platform=iOS \
  -derivedDataPath build/DerivedData.noindex \
  -archivePath "$ARCHIVE" \
  -allowProvisioningUpdates \
  -quiet \
  archive

TEAM="$(xcodebuild -project "$PROJECT" -scheme "$SCHEME" -destination generic/platform=iOS \
  -derivedDataPath build/DerivedData.noindex -showBuildSettings 2>/dev/null | awk '/ DEVELOPMENT_TEAM =/{print $3; exit}')"

cat >"$WORK/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>debugging</string>
	<key>signingStyle</key>
	<string>automatic</string>
	<key>teamID</key>
	<string>$TEAM</string>
	<key>thinning</key>
	<string>&lt;none&gt;</string>
</dict>
</plist>
EOF

echo "Exporting $SCHEME.ipa"
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportPath "$WORK/export" \
  -exportOptionsPlist "$WORK/ExportOptions.plist" \
  -allowProvisioningUpdates \
  >"$WORK/export.log" 2>&1 || {
  tail -20 "$WORK/export.log" >&2
  exit 1
}

INFO="$(ls -d "$ARCHIVE"/Products/Applications/*.app | head -1)/Info.plist"
BUNDLE_ID="$(/usr/libexec/PlistBuddy -c "Print CFBundleIdentifier" "$INFO")"
VERSION="$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$INFO")"
NAME="$(/usr/libexec/PlistBuddy -c "Print CFBundleDisplayName" "$INFO" 2>/dev/null ||
  /usr/libexec/PlistBuddy -c "Print CFBundleName" "$INFO")"
BUILT="$(date "+%b %-d, %-I:%M %p")"
# In every URL, so a device never installs a copy it cached from before.
STAMP="$(date +%s)"
BASE="https://$HOST:$PORT/$SCHEME"

mkdir -p "$OUT"
cp "$WORK/export/$SCHEME.ipa" "$OUT/$SCHEME.ipa"

cat >"$OUT/manifest.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>items</key>
	<array>
		<dict>
			<key>assets</key>
			<array>
				<dict>
					<key>kind</key>
					<string>software-package</string>
					<key>url</key>
					<string>$BASE/$SCHEME.ipa?$STAMP</string>
				</dict>
			</array>
			<key>metadata</key>
			<dict>
				<key>bundle-identifier</key>
				<string>$BUNDLE_ID</string>
				<key>bundle-version</key>
				<string>$VERSION</string>
				<key>kind</key>
				<string>software</string>
				<key>title</key>
				<string>$NAME</string>
			</dict>
		</dict>
	</array>
</dict>
</plist>
EOF

MANIFEST_URL="$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$BASE/manifest.plist?$STAMP")"
cat >"$OUT/index.html" <<EOF
<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Install $NAME</title>
<style>
  body { font: 17px -apple-system, system-ui, sans-serif; margin: 0; min-height: 100vh; display: flex; flex-flow: column; align-items: center; justify-content: center; gap: 14px; background: #f5f5f7; color: #1d1d1f; }
  a { padding: 14px 28px; border-radius: 14px; background: #0071e3; color: #fff; text-decoration: none; font-weight: 600; }
  p { margin: 0; color: #6e6e73; font-size: 14px; }
  @media (prefers-color-scheme: dark) { body { background: #000; color: #f5f5f7; } }
</style>
<a href="itms-services://?action=download-manifest&amp;url=$MANIFEST_URL">Install $NAME</a>
<p>Built $BUILT on $(hostname -s)</p>
EOF

# The local server, once: a launchd agent, so it's there after a reboot.
if ! curl -s -o /dev/null "http://127.0.0.1:$LOCAL_PORT/"; then
  echo "Starting the builds server (launchd agent $AGENT)"
  PLIST="$HOME/Library/LaunchAgents/$AGENT.plist"
  mkdir -p "$(dirname "$PLIST")"
  cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$AGENT</string>
	<key>ProgramArguments</key>
	<array>
		<string>/usr/bin/python3</string>
		<string>-m</string>
		<string>http.server</string>
		<string>$LOCAL_PORT</string>
		<string>--bind</string>
		<string>127.0.0.1</string>
		<string>--directory</string>
		<string>$ROOT</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
</dict>
</plist>
EOF
  launchctl bootout "gui/$(id -u)/$AGENT" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  for _ in {1..20}; do
    curl -s -o /dev/null "http://127.0.0.1:$LOCAL_PORT/" && break
    sleep 0.25
  done
fi

# And on Tailscale, once: serve keeps it in Tailscale's own configuration.
if ! "$TAILSCALE" serve status 2>/dev/null | grep -q "$HOST:$PORT"; then
  echo "Serving it on Tailscale at port $PORT"
  "$TAILSCALE" serve --bg --https="$PORT" "http://127.0.0.1:$LOCAL_PORT" >/dev/null
fi

echo
echo "Install $NAME $VERSION (open in Safari, on a device on Tailscale):"
echo "  $BASE/"
