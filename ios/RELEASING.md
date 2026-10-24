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

## As configured

Set up through the API (`asc-api.mjs`) on 2026-10-24; re-check with
`node ios/asc-api.mjs "/v1/ciProducts/246ee4d5-5822-4245-9a3c-d0bf5d53dc85/workflows"`,
and see what a tag started with
`node ios/asc-api.mjs "/v1/ciWorkflows/98DBE289-BBEC-48B5-AE4B-CC3AA31E3156/buildRuns?limit=3&sort=-number"`.

- App `6826695067`, Xcode Cloud product `246ee4d5-5822-4245-9a3c-d0bf5d53dc85`
  (`Miks.xcodeproj/xcshareddata/xcodecloud/manifest.json` ties the project
  to it). Xcode Cloud builds only a shared scheme: without
  `xcshareddata/xcschemes/Miks.xcscheme`, Integrate → Create Workflow was
  greyed out (and so it was while Xcode wasn't signed in to the account).
- `Release` (`98DBE289-BBEC-48B5-AE4B-CC3AA31E3156`), the default workflow
  renamed: starts on tags with the prefix `ios-`, or by hand on any branch;
  Archive – iOS of the `Miks` scheme, `APP_STORE_ELIGIBLE`. On "Latest Beta
  or Release" Xcode and macOS, as Phoenix's are (its JSON project failed on
  27.0). "Latest Release" was Xcode 27.1 then, and the default workflow's
  first build (run 1) succeeded on it, so 27.1 may do too. A PATCH to a workflow
  clears every start condition it leaves out, so send them all together.
- TestFlight groups, both "Friends & Family" as in Phoenix, though the
  external one is `Public`: the internal one
  (`2bf2e54d-e469-43ae-b326-7422101041ff`, every build, nfarina@me.com) and
  `Public` (`cfafb174-770b-491a-856f-b20310a87c19`), with the public link
  https://testflight.apple.com/join/CChNubyp, no limit. An external group
  gets only the builds added to it, and each goes through Beta App Review:
  `POST /v1/betaGroups/<id>/relationships/builds`, then
  `POST /v1/betaAppReviewSubmissions` with the build (how 1.0 (2) went).
- Test information (en-US) and Beta App Review details: contact, no demo
  account, and notes saying it needs a Mac running Miks on the tester's
  tailnet.

## Not done or not verified yet

- Whether Beta App Review passes 1.0 (2), submitted 2026-10-24, and whether
  later builds of the same version skip it.
- Whether a build ever reaches `Public` without being added (Phoenix's
  shipped ones were added by hand, as far as is known).
