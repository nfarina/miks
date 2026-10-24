#!/usr/bin/env bash
# @chatwing
#
# Gets a native build onto one of Nick's devices, wherever it is: installed
# directly if this Mac can reach it (`build.sh device`), else as a link to
# tap in Safari, which installs it from anywhere, no cable or Xcode. Either
# way it goes on devices in the team's development profile: any device
# that's been paired with Xcode once.
#
# Usage:
#   ios/share.sh                    # the one reachable device, else a link
#   ios/share.sh "Nick's iPhone"    # that device (a name fragment or id), else a link
#   ios/share.sh --link             # a link, without trying a device
#
# The link: an archive, exported (method "debugging") to an .ipa, beside an
# install manifest and a page with the itms-services:// link, uploaded to the
# ios-builds R2 bucket on Nick's Cloudflare account (Wrangler's login) and
# served at https://ios-builds.nfarina.com/<App>/ by ios/builds/worker.js,
# one for every app and every Mac. Each upload replaces that app's last, and
# the bucket deletes anything a week old. iOS installs from a manifest only
# over HTTPS with a trusted certificate.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

if [[ "${1:-}" != "--link" ]]; then
  # A device that's asleep or away fails here (no match, or "Connection was
  # invalidated"), and the link is the way round that. Done only if devicectl
  # says where it installed it: one failure came with "exit code 0".
  mkdir -p build
  if ./build.sh device "${1:-}" 2>&1 | tee build/share-install.log && grep -q "installationURL" build/share-install.log; then
    exit 0
  fi
  echo
  echo "Couldn't install it directly, so here's a link instead."
fi

if [[ -f project.yml ]]; then
  xcodegen generate >/dev/null
fi

PROJECT="$(ls -d *.xcodeproj | head -1)"
SCHEME="$(basename "$PROJECT" .xcodeproj)"
WORK=build/share.noindex
ARCHIVE="$WORK/$SCHEME.xcarchive"

OUT="$WORK/upload"
BUCKET=ios-builds

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
BASE="https://ios-builds.nfarina.com/$SCHEME"

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

# From builds/, whose wrangler.jsonc names the account.
echo "Uploading to $BASE/"
for file in "$SCHEME.ipa:application/octet-stream" "manifest.plist:application/xml" "index.html:text/html; charset=utf-8"; do
  (cd builds && npx --yes wrangler r2 object put "$BUCKET/$SCHEME/${file%%:*}" \
    --file "../$OUT/${file%%:*}" --content-type "${file#*:}" --remote >/dev/null)
done

echo
echo "Install $NAME $VERSION (open in Safari on the device):"
echo "  $BASE/"
