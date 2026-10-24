#!/bin/zsh
#
# Xcode Cloud runs this right after cloning, before building. It writes
# TestFlight's "What to Test" from the commit the release tag is on, which
# Xcode Cloud reads from TestFlight/WhatToTest.<locale>.txt beside the project
# (a committed copy is the fallback). The build number is Xcode Cloud's own:
# Phoenix found its run count is what ships, whatever the project says.
#
# Best-effort: nothing here may fail the build.

NOTES="$CI_PRIMARY_REPOSITORY_PATH/ios/TestFlight/WhatToTest.en-US.txt"
SUBJECT="$(git -C "$CI_PRIMARY_REPOSITORY_PATH" log -1 --pretty='%s' 2>/dev/null)"
SHORT="$(git -C "$CI_PRIMARY_REPOSITORY_PATH" log -1 --pretty='%h' 2>/dev/null)"

if [[ -n "$SUBJECT" ]]; then
  printf '%s\n\n(%s)\n' "$SUBJECT" "${CI_TAG:+$CI_TAG · }$SHORT" > "$NOTES"
  cat "$NOTES"
fi
exit 0
