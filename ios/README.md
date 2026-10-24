# Miks for iPhone and iPad

A thin native shell around the Miks UI: chatwing's shared iOS shell
(`Shared/`, `SharedMac/`, `build.sh`, `asc-api.mjs`, synced by `wings` as
`{"name": "chatwing", "paths": ["ios/"]}` in `.wings`) and Miks's own
`Miks/` (the AppDelegate, Info.plist, icon, Settings bundle) and
`Miks.xcodeproj/project.xcproj` (Xcode's JSON format, 27.2+, edited by hand).
No Firebase: the shared shell builds without it.

The UI is the web bundle at https://miks-app.nfarina.com (`yarn deploy:web`),
downloaded and cached on the device, served from `crosswing://app/`. Its
terminals are a Mac's: it connects over Tailscale to that Mac's daemon's
gateway (Miks → Settings → Remotes → Open from your other devices), by the
full name the setting shows.

- `./build.sh sim`: build for the simulator (no signing).
- `./build.sh device "iPad mini"`: build and install onto a paired device.
- `./share.sh [device]`: install it on a device this Mac can reach, or else
  print a link that installs it from Safari, anywhere (any device paired
  with Xcode once), from https://ios-builds.nfarina.com (`builds/`).
- Settings → Miks: a development server (Vite on a Mac, `yarn dev`) instead
  of the bundle.
