# Releasing the iOS app (Xcode Cloud → TestFlight)

Set up as Phoenix's is (see its `ios/RELEASING.md`, which has the history
and what was learned getting there), on the "Nick Farina" team `RCRD96UZHN`.

- Bundle ID `com.nfarina.miks.ios`, registered through the API on
  2026-10-24 (id `49R82KDW9G`). Builds before that were signed with Xcode's
  wildcard team profile, which `share.sh` still uses.
- Versions come from build settings: `MARKETING_VERSION` (bump by hand for a
  new public version) and the build number, which Xcode Cloud sets from its
  run count whatever `CURRENT_PROJECT_VERSION` says (Phoenix verified that).
- `ITSAppUsesNonExemptEncryption` is false in `Miks/Info.plist`: only HTTPS
  and WebSockets over TLS, so builds don't wait on "Missing Compliance".
- `ci_scripts/ci_post_clone.sh` writes TestFlight's "What to Test" from the
  tagged commit; `TestFlight/WhatToTest.en-US.txt` is the fallback.

## Cutting a TestFlight build

Push a tag starting `ios-` (`git tag ios-1.0 && git push origin ios-1.0`):
the `Release` workflow archives it and uploads it to TestFlight. A tag is
the only thing that ships one, and it reaches every tester, the public
link's included: not for unattended work unless a native release was asked
for.

## Not done or not verified yet

- The App Store Connect app record (only the website can make one).
- The Xcode Cloud product and its `Release` workflow (Xcode connects the
  GitHub repo the first time): it must use "Latest Beta or Release", since
  the project's JSON format needs Xcode 27.2 or later.
- TestFlight groups, the public link, and Beta App Review details (a
  reviewer has no Mac running Miks: say so, with a video).
