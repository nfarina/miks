Welcome! This repo is **Miks**: a terminal app for running many coding-agent
sessions at once. Workspaces in a sidebar, tabs in each, and each workspace's
agent status (working, needs you, done) at a glance. Nothing else, on purpose:
it exists because cmux grew far past that.

# Architecture

- `packages/daemon` (npm name `miks`): owns every PTY. Each pane is a
  `node-pty` process plus an `@xterm/headless` emulator fed every byte; a
  client attaching gets the emulator's screen serialized as VT sequences
  (`@xterm/addon-serialize`), then the live stream from exactly that point.
  Serves a WebSocket (`/ws`) and a small HTTP API on a Unix socket, never TCP:
  anything that can connect can type into your shells. Wire contract:
  `shared/protocol.ts`.
- `packages/ui`: a crosswing React app (xterm.js + WebGL). Talks to the daemon
  only through `window.miks`, the Electron preload bridge.
- `packages/app`: the Electron shell. A window, the menu (accelerators are how
  ⌘T etc. beat the terminal to the keystroke), and a pipe from the renderer to
  the daemon socket. Starts the daemon (a launchd job) if nothing is
  listening.
- `packages/crosswing`: wings-synced shared UI code (`.wings`); check
  `wings sync miks --dry-run` before committing, drift should be 0.

The point of the split: **reloading or relaunching the UI never touches a
session**. Stopping the daemon does, and that kills every terminal; say so
before doing it to the real one. Quitting Miks (⌘Q, or the last window
closing) does stop it, like any terminal app, after asking about programs
the next launch won't restore (`kept` in `/api/running`) or that are
mid-task (`active`), unless "Keep terminals running" is on or another
UI is still connected (`clients` in `/api/ping`). SIGUSR2 is the quit that
always leaves it running: `install:app` and `yarn dev`'s restarts send that.
Never SIGTERM a Miks UI; that's an ordinary quit.

# Running

- `yarn dev`: Vite with hot reload inside Electron. UI edits hot-reload,
  `packages/app` edits restart Electron, neither restarts the daemon. Daemon
  code changes need the daemon restarted, which ends every terminal: Miks →
  Restart daemon… in the app. The daemon names itself `miks-daemon`, so match
  that, not its script path (`pkill -f main.ts` misses it); for a scratch one,
  find it by its socket (`lsof -p <pid> | grep miks.sock`).
- Experiment against a scratch daemon, never the real one:
  `MIKS_BACKGROUND=1 MIKS_HOME=/tmp/mk yarn dev`. Keep `MIKS_HOME` short;
  macOS caps socket paths at 104 bytes. `MIKS_BACKGROUND` keeps its windows
  from taking focus (no Dock icon, `showInactive`); screenshots still work.
  Such a window renders no frames, so scroll events wait for one: take a
  screenshot after setting `scrollTop` from an eval.
  A page's own `window.close()` skips BrowserWindow's `close` event, so it
  can't test anything hooked there.
- `yarn install:app` builds Miks.app, signs it with the keychain's Developer
  ID (a stable signature is what keeps the permissions macOS grants Miks, and
  so everything in its terminals, across reinstalls), and rsyncs it over
  /Applications/Miks.app in place, relaunching it if it was running. In place,
  because the daemon outlives installs and macOS names it after wherever its
  bundle is: a bundle moved to the Trash turned permission prompts into
  "Miks 11-23-24-642". It quits only the UI (SIGUSR2), found by pid,
  excluding the daemon: never `pkill -x Miks`. The running daemon keeps its old code until
  it next starts. `--to <host>` installs it on another Mac over ssh, the
  same way (`installOn`). Only rsynced over a running Miks, that Mac's
  permissions went red once its daemon restarted, until Miks was quit and
  opened there again.
- Real state lives in `~/Library/Application Support/Miks` (socket,
  `daemon.log`, `state.json`, and Electron's profile in `UI/`). A window's
  page errors (console errors, uncaught ones, what `ui/ErrorBoundary.tsx`
  catches instead of the window going white) and its renderer dying go to
  `UI/renderer.log` (main's `logRenderer`); nothing else keeps them. The daemon
  saves its layout to `state.json` (each tab's cwd, via `lsof`, and its Claude
  session ID from the hooks) and restores it on start, resuming those
  sessions with `claude --resume`. The dev build and Miks.app
  share it, and so share one daemon.
- `yarn release <version>` (`scripts/release.ts`) notarizes and publishes a
  GitHub release with `Miks-macos.zip` and `update.json`, the feed
  `packages/app/updates.ts` reads (Electron's autoUpdater, Squirrel.Mac, in
  `serverType: "json"` mode) from `releases/latest/download/`. Notarizing
  uses notarytool's keychain profile `miks-notary`, which Claude Code's
  sandbox hides ("No Keychain password item found", though Keychain Access
  shows it): run the release outside the sandbox. Squirrel
  installs a downloaded update on any quit, and swaps the bundle, so a daemon
  kept running ("Keep terminals running") is left on the old one.
  `MIKS_UPDATE_FEED` points a packaged copy at a test feed; verified that way
  against a local `python3 -m http.server`. `miks update` (Miks's `.zshrc`)
  updates the Mac its terminal is on, so a remote window can: it opens
  `miks://update?status=<file>` (`CFBundleURLTypes`; `open-url` in main),
  and the app checks, downloads and installs without dialogs, appending each
  step to the file, which the command prints. A second `checkForUpdates`
  while one runs fails ("The command is disabled"), so there's one at a
  time. Testing it: Squirrel relaunches the updated copy without the test's
  environment, so on the real Miks home; catch it and SIGUSR2 it. And
  `lsregister -u` test copies, or `miks://` may go to them.
- Remote windows (Settings → Remotes; the Remotes menu, ⌃⌥⌘1–9): a window on
  another Mac's daemon through that Mac's gateway on Tailscale (below; Access
  from your other devices on there), as the iOS app reaches it. SSH tunnels
  came first, and went: passwordless SSH was a chore to set up, and one way
  in is less to keep working. `packages/app/remotes.ts` gives each remote a
  local Unix socket that pipes every connection to the gateway (TLS to its
  full name when it has a certificate, which it finds out by trying; else
  plain TCP), so the rest of main talks to it as to this Mac's socket:
  WebSocket, HTTP API (sent with `API_HEADER`, which the gateway requires,
  with no Origin, for `/api/`), and the page proxy. A remote's host is its
  Tailscale name (`neo`, looked up in `tailscale status`), or a full name or
  address, with `:port` for testing. `checkRemote` pings it first and says
  what's wrong in terms of what to do (`/api/ping`'s 404 means a Miks too old
  for this). Settings' Add a Mac lists the tailnet's Macs of yours. One
  window per daemon; each window's machine is in `windowRemotes`, and every
  daemon call must go to it. A remote window never starts, stops or restarts
  a daemon: quitting stops only this Mac's. It retries every 3s on its own.
  Dropped files are copied to its tmpdir and typed as full paths, so Claude
  Code attaches images as it does a local drop; with ⌥ held (any window),
  into the tab's folder instead ("name 2" if taken), with a toast, typing
  nothing. Both are `miks:sendFiles` in main: a tar stream per file to
  `POST /api/drop` (through the gateway, for a remote). ⌥ because it's
  Finder's copy modifier; ⌘ (move, to Finder) didn't work from Finder.
  `scripts/devtools.ts drop [--alt] <file>...` drops real files, as from Finder.
  ⌃V, Claude Code's paste of a clipboard image, reads the clipboard of the
  Mac Claude runs on, so in a remote window (terminal or chat panel) main
  sends this Mac's image over the same way (`miks:sendClipboardImage`) and
  types its path. Electron 44's `clipboard` is the async web-style API
  (`read()`, items by MIME type): there's no `readImage` any more.
  The last screen used sizes a pane: focusing a window (or a device's page
  showing again) re-sends its size and appearance, and so does its first
  key or click (captured, before the key) after another took the pane. The
  daemon sends the others `size` (never the window that sized it, which
  may have moved on mid-drag), and they draw at that size meanwhile. Open remote windows reopen at launch (`UI/remote-windows.json`).
  `PROTOCOL_VERSION` warns when two Miks disagree. A Mac's Miks quitting
  while another Mac's window is on its daemon sends `stopWhenIdle`, so the
  daemon stops when that window goes (which then asks, if programs run);
  its windows connecting send it false. Restart daemon… follows the focused
  window; a remote's restarts itself (`POST /api/restart`, through launchd),
  telling every window first (`restarting`), so a window on its own Mac waits
  for the new one (about 6s) to reconnect, rather than showing it stopped. Test
  without another Mac: a second daemon, `env -i HOME=$HOME PATH=… MIKS_HOME=/tmp/mkb
  MIKS_GATEWAY_PORT=2742 MIKS_GATEWAY_ALLOW_SELF=1 node packages/daemon/server/main.ts serve`
  with `{"tailnetAccess":true}` in its `machine.json`, and a remote whose host
  is this Mac's full name with `:2742` (verified so: typing, a drop, a page).
- Your other devices on Tailscale (Settings → Remotes → Access from your other
  devices, `tailnetAccess`): the daemon's gateway (`server/Gateway.ts`, started
  in `server/main.ts`, which follows the Mac's `machine.json`) serves the built UI
  (`packages/ui/dist`) and pipes `/ws` to the socket, on port 2741 of this
  Mac's Tailscale addresses only. It lets in only devices `tailscale whois`
  says are signed in as this Mac's owner (`UserProfile.ID`, vs `status`'s
  `Self.UserID`), never this Mac itself (its own address would let any page
  in a browser here in, as localhost would; `whois` gives `Node.StableID`,
  `status` gives the same as `Self.ID`), and `/ws` only from its own page's
  origin or none (a program: browsers always send one), `/api/` only with
  `API_HEADER` and no origin (a page can't send that header elsewhere
  without a preflight, which it never answers). The CLI (`/Applications/Tailscale.app/Contents/MacOS/Tailscale`)
  is the Mac app's own executable, and acts as the CLI only with `TERM`,
  `TERM_PROGRAM` or `SHLVL` set; the daemon (a launchd job) has none, so it
  passes `TERM=dumb` (without: "The Tailscale GUI failed to start"). Test a
  scratch daemon started under `env -i`, not from a terminal. With HTTPS
  certificates on for the tailnet (`CertDomains` in `status`), it serves
  HTTPS at the full name (`https://air.<tailnet>.ts.net:2741/`) with the
  certificate `tailscale cert` prints (to stdout: the CLI is the sandboxed
  app, and writing files elsewhere is "operation not permitted"; both halves, since
  it fails on `/dev/null`, "not a regular file"), held in
  memory, asked for again daily. The first takes about 35s. In a browser, `ui/webBridge.ts` is `window.miks`,
  with the device's own settings in localStorage. Plain http over Tailscale
  isn't a secure context: no `crypto.randomUUID` (sending threw once), no
  clipboard API. Verified from an iPad.
- While you're away (Settings → Remotes, `keepAvailable`, a Mac's own
  setting): asleep, a Mac drops off Tailscale. `locked` is `caffeinate -s`
  from the daemon (`server/Keeper.ts`): plugged in, it never idle-sleeps,
  and locks as usual. Behind the lock screen, with the display off, the
  daemon, terminals and Claude in Chrome all still work (it loaded, clicked
  and screenshotted pages), but screen captures are black, so not computer
  use. `unlocked` ("Stay awake, self-locked") is the keeper (`daemon/keeper/Keeper.swift`, kiosk's
  approach, ~/Code/kiosk), a daemon child that never lets the Mac lock
  (power assertions, and a mouse move in place for the screen saver's HID
  idle clock) and instead, after the AC display-sleep time (`pmset -g custom`,
  read again each minute; never is 10 minutes) without a person
  (hardware input, pid 0, or screen sharing) or at ⌃⌘Q, which it takes
  from macOS: a sheet over every screen, the built-in backlight off, and
  an event tap dropping hardware input until Touch ID or the password
  (`ODRecord.verifyPassword`). Its sheet is 99% opaque and
  `sharingType = .none`: fully opaque, macOS stopped drawing what it
  covered, and captures (`screencapture`, ScreenCaptureKit) came back white
  or missing the wallpaper and menu bar; this way they see everything, on
  every display. Create a window, then `setFrame` it onto a screen: with
  `screen:`, the rect counts from that screen's origin, which left a
  second display uncovered. It fails locked (`SACLockScreenImmediate`):
  unplugged, its stdin closing (the daemon gone), or told to quit with the
  sheet up, and the daemon runs `miks-keeper lock` if it dies with it up.
  All verified on an Air with an external display. Without Accessibility
  it never raises the sheet, and the Mac locks as usual. The daemon builds
  it from source when that's newer; `build-app.ts` builds it into the
  bundle. `MIKS_KEEPER_TEST=<s>` lowers the sheet by itself, for testing.
- The iOS app (`ios/`, see its README): chatwing's shared shell, synced as
  `{"name": "chatwing", "paths": ["ios/"]}` in `.wings` (wings syncs only
  those paths), plus Miks's own `ios/Miks/` and `Miks.xcodeproj`, without
  Firebase (the shell guards it with `canImport`). It loads the UI from
  the bundle `yarn deploy:web` puts at https://miks-app.nfarina.com (a
  Cloudflare Worker's static assets, `web/wrangler.jsonc`), cached and
  served from `crosswing://app/`. There the bridge (`ui/webBridge.ts`)
  connects to the Mac on screen (`miks-mac` in localStorage, of the ones in
  `miks-macs`; the sidebar's switcher) at `wss://<its full name>:2741/ws`,
  since an https page can't open plain ws, and the certificate is for the
  full name only, so the app (`ios/Miks/MiksPlugin.swift`) turns "air" into
  it: `getaddrinfo` by Tailscale's search domain, then `getnameinfo`. The
  others it watches over sockets of their own, which only `hello`, for what
  their agents are doing, which the chooser (`ui/MacChooser.tsx`, shown
  until one connects) lists on each Mac's card, with when it was last
  connected (`miks-macs-seen`). A connection that drops (a phone that
  slept) keeps the last screen up, faded, with a pill, while it retries;
  after 8s, a sheet to try again or open another Mac. Verified in headless
  Chrome at phone size with `WebSocket` swapped for a fake (CDP's
  `Page.addScriptToEvaluateOnNewDocument`). WebKit throws from `new WebSocket` for an address
  the page's CSP refuses (a short name), where Chrome only fails the
  socket; uncaught, that left the app white. The page's console and errors
  go to the app's log (`devicectl device process launch --console`).
  crosswing's `HostProvider` (in `main.tsx`) gives the screen's insets as
  `--safe-area-*` (the iPhone Duo's strip and fold included, as in sage);
  each region pads the edges it touches (`crosswing/safearea`), and
  `PanelLayout` clears the ones a panel beside it already has. On the Duo's
  inner screen, whose status and camera take the top-right corner (82pt of
  safe area), the tab bar and the sidebar's title row go up beside them, where
  the shell's `bars.top` says (crosswing's `safeAreaTopBar`, set only when
  that's above the safe area: an iPhone 18 Pro's is at it). The shell
  reports the on-screen keyboard's top (`viewport` in `HostContext`), and the
  app's root takes the height above it. On a touch screen nothing takes the
  keyboard on its own (`autoFocus()` in `ui/settings.ts`: focusing brings the
  on-screen keyboard up) unless a hardware one is connected, which the app
  knows from `GCKeyboard.coalesced` and tells the page. While a terminal
  has the on-screen keyboard, the key bar (`ui/KeyBar.tsx`) sits on it: Esc,
  Tab, ⇧Tab, Ctrl (`ui/keys.ts`: the next character typed goes as its
  control key; twice, locked), arrows that repeat while held (`typeKey`, in
  the program's cursor-key mode) and buried symbols. Its keys act on
  pointerdown and cancel touchend, so the terminal keeps focus (and the
  keyboard stays up). Two fingers scroll a terminal as a trackpad does
  (`ui/wheel.ts`). Both verified on an iPad. The app looks for a new web
  bundle every 30s while open, and reloads once it's there. Its keyboard
  shortcuts are the Mac menu's, from `buildMenu` in `ios/Miks/AppDelegate.swift`
  (keep the two lists alike), sent to the page as `miks_command`, which the
  bridge hands to `onCommand` as Electron's menu does. The
  shell's web view takes its view from `LaunchScreen.storyboard` (a scene
  `controller`, a progress bar tagged 1), and crashed at launch without it. The gateway marks its own page (`<meta name="miks-gateway">`) so a
  browser's connects back to it, and lets the app's origins in
  (`APP_ORIGINS`). `ios/build.sh device "iPad mini"` installs onto a
  paired device; there's an iPhone Duo simulator. To hand Nick a native
  build, run `ios/share.sh [device]` (chatwing's): it installs directly if
  the device is reachable, else (or if that fails: a sleeping iPhone gave
  "The peer is no longer reachable") makes an install link to tap in
  Safari, from anywhere, and prints it to pass on: a development-signed
  `.ipa` (export method `debugging`; Xcode's team profile lists every device
  ever paired, so the account needs nothing) with an `itms-services://`
  manifest, uploaded to the `ios-builds` R2 bucket (the "Nick Farina"
  Cloudflare account, by Wrangler's login) and served by `ios/builds/worker.js`
  at `https://ios-builds.nfarina.com/<App>/`, for every app and Mac. Each
  upload replaces the app's last; the bucket expires objects after 7 days.
  It was a launchd agent behind `tailscale serve` first (Tailscale's Mac app
  won't serve a folder), which meant a server running on every Mac. Verified
  both ways: an iPhone installed from each version's link.
- Miks keeps its Claude Code hooks in `~/.claude/settings.json` itself
  (`packages/app/claudeHooks.ts`, on launch and when the setting changes),
  running a copy of the script in Miks's home so the path is the same for
  every build. Not with `MIKS_HOME` set: a scratch Miks mustn't rewire the
  real Claude Code.
- The icon: `packages/app/icon/make-icon.sh` turns `source.png` (full-bleed
  square) into `icon.png` (dev Dock icon) and `Miks.icns`.
- The website (`site/`, one page, published to GitHub Pages by
  `.github/workflows/pages.yml` on pushes to main): its screenshots are the
  real UI on a made-up daemon (`site/screenshots/demo.js`, made-up projects
  only), taken by `site/screenshots/capture.mjs` in headless Chrome; the
  iPhone Duo's in the simulator (`site/screenshots/README.md`). Retake them
  when the UI changes visibly.
- `node scripts/devtools.ts screenshot out.png` / `eval '<js>'` drive the
  running dev app over its DevTools port (2739): how to check UI work without
  screen-recording permission. `curl --unix-socket <sock> http://miks/api/state`
  shows the daemon's view. `window.miks.send(JSON.stringify(msg))` in an eval
  sends any protocol message, e.g. typing into a pane.

# Checks

`yarn test` runs tsc (root, daemon, app), oxlint, and vitest.
`packages/daemon/server/daemon.test.ts` covers the reattach guarantees (screen
fidelity, alternate screen, no lost or repeated output mid-attach, no stray
resizes); keep it passing.

# Gotchas, verified

- The daemon and Electron main run TypeScript straight from source (Node 24 /
  Electron 44 type stripping): use `.ts` import extensions in the daemon,
  `import type` for types (`verbatimModuleSyntax` enforces it), no enums.
- The daemon runs on the app's plain helper ("Miks Helper", "Electron Helper"
  in dev) as Node (`ELECTRON_RUN_AS_NODE`): node-pty's prebuilt binary is
  Node-API, so no rebuild and nothing installed. Not the main binary:
  launching that makes macOS bounce Miks in the Dock until it gives up. It
  calls itself `miks-daemon` (`process.title`).
- The daemon is a launchd job (`<home>/daemon.plist`, label
  `com.nfarina.miks.daemon.<hash of home>`), never a child of the UI: macOS
  ties a process, for good, to the app that spawned it, and once that UI
  quit, the Local Network checks for its terminals ("Failed to get the
  signing identifier for <pid>: No such process" in the log) failed at
  random. As its own process it's Miks Helper (`com.nfarina.miks.helper`)
  to macOS, with grants of its own, so the helper carries the usage strings
  and Miks's entitlements. Its own restart (`/api/restart`) is `launchctl
  kickstart -k`, since a daemon it spawned would be tied to it the same way.
- Inside Miks.app, `node_modules/miks` is a stub package re-exporting
  `packages/daemon/shared`: Node won't strip types under node_modules, and the
  packager rewrites symlinks to absolute paths, which codesign rejects.
- macOS's Local Network privacy applies to everything in Miks's terminals:
  without `NSLocalNetworkUsageDescription` it never asked, and pings and
  connections to LAN machines failed at random ("Undefined error: 0" from
  ssh) while the router, the internet and VPN paths worked. Verified by
  running the same commands from a `launchctl submit` job, outside Miks.
  The prompt names itself "Miks Helper (Renderer)". It finds a process's
  bundle by its Mach-O UUID (in LaunchServices), and Electron's are the same
  in every Electron app, so the daemon once asked as the repo's "Electron
  Helper"; `build-app.ts` gives Miks's executables UUIDs of their own.
- Settings → Permissions lists what macOS lets the window's daemon's
  terminals do and asks for each ahead of time (`server/Permissions.ts`),
  by running `server/permissions.js` (JXA) under `osascript`, which as the
  daemon's child counts as Miks Helper. Statuses come from TCC's private
  `TCCAccessPreflight` (0 granted, 1 denied or off, 2 not asked), which never
  prompts; Local Network's from its rules in
  `/Library/Preferences/com.apple.networkextension.plist` (`plutil -p`).
  Completion handlers never run in JXA, so a request waits on preflight.
  tccd files most grants under the app the helper is in (Miks), not the
  helper (`AUTHREQ_SUBJECT` in tccd's log); only Accessibility and Input
  monitoring list Miks Helper. So it's Miks.app that goes into Developer
  tools and App management: the helper dragged in was switched on and
  counted for nothing. With Full Disk Access, reading Desktop or Downloads
  never asks, and their preflight stays "not asked". Location isn't listed: locationd goes by the
  executable asking (osascript, here), never the responsible app.
- `open` passes the calling shell's environment, so launching Miks.app from a
  Miks pane used to carry that pane's variables in.
- Third-party install scripts are off globally; `scripts/postinstall.ts` does
  the two Miks needs (node-pty's spawn-helper exec bit, Electron's download).
- Every size change is a SIGWINCH that makes full-screen programs (Claude Code,
  vim) redraw. Only the on-screen terminal sets a pane's size, after its WebGL
  renderer loads (the DOM renderer measures characters differently); hidden
  tabs attach without a size and adopt the pane's; and a new size reaches the
  daemon only once it has held for 100ms, so animating or dragging the
  sidebar (a PanelLayout) or the window edge sends one, not one per frame.
- With the sidebar hidden (⌘B), the traffic lights sit over the tab bar,
  which is inset to clear them; the sidebar's minimum width does the same.
  Where the sidebar would leave the terminals under 320px (a phone held
  upright), it goes over them instead (PanelLayout's `auto`), and picking a
  workspace hides it.
- xterm.js sends a full-screen program at most one wheel report (or arrow
  key) per wheel event, and scales trackpads down to 0.3, so scrolling in
  Claude Code crawled next to Ghostty. `ui/wheel.ts` sends one per line's
  height scrolled instead. The serializer restores mouse tracking but not
  its SGR encoding (1006), so `Pane.ts` appends that to snapshots.
- zsh panes get `ZDOTDIR=packages/daemon/shell/zsh`, whose startup files
  source yours (at the top level; inside a function, your `typeset`s would
  turn local) and then put `ZDOTDIR` back, adding OSC 133 prompt and command
  marks. The UI keeps them as xterm.js markers (`ui/commandMarks.ts`) for
  Select last command (⌘⇧A). Snapshots carry no marks, so after one the
  cursor's line counts as a prompt. Clear to start (⌘K) clears the UI's
  terminal and, by a `clear` message, the daemon's, or the next attach would
  bring it back.
- macOS's `/etc/zshrc` sets `HISTFILE=${ZDOTDIR:-$HOME}/.zsh_history`, and
  runs while ZDOTDIR is Miks's folder: without a HISTFILE of your own,
  history went inside Miks.app (invalidating its signature) until `.zshrc`
  put it back.
- Each tab has its own zsh history, like Terminal.app's: a `historyId` saved
  in `state.json`, and `MIKS_HISTORY` (`<home>/history/<id>.zsh`), which
  Miks's `.zshrc` appends each command to in preexec (zsh's history format)
  and `fc -R`s at the first prompt, so ↑ in a restored tab is its own last
  command. Not while `.zshrc` runs: zsh loads your HISTFILE only after the
  startup files, which put it after the tab's, so ↑ was any tab's last. Deleted when the tab closes; restore deletes orphans.
- `miks keep <command>` (a function in Miks's `.zshrc`) posts the command,
  shell-quoted, to `/api/keep`, then runs it. The daemon saves it with the
  tab (`keep` in `state.json`) and a restore runs it again (before any
  Claude session: one in that tab is the command's), until it's been seen
  in front and the shell is back. `Tab.kept` (↻ in the tab bar) covers that
  and resumable Claude sessions.
- What a session has running in the background (its footer's "1 shell, 1
  monitor") has no hook: `server/BackgroundTasks.ts` follows the transcript
  from its end for each start (`toolUseResult`: `backgroundTaskId`, a
  Monitor's `taskId` and `timeoutMs`, an agent's `async_launched`) and its
  `<task-notification>` with a `<status>`. A shell's end can reach the
  transcript only once Claude Code delivers it, and some ends never do, so a
  shell also ends when nothing has its output file open (its own shell writes
  it; foreground commands use the same folder), and a monitor (no output
  file) at its deadline. Verified against a real session. A resumed session
  doesn't start them again, so closing, quitting and restarting ask about
  them (`background` in `/api/running`).
- `claude -p` fires every hook, with SessionEnd 25ms after Stop (captured
  live), so Stop waits `DONE_DELAY` before `done`: one-shot runs (scripts)
  show working, then nothing, and never notify.
- Copying reaches the Mac you're at: Miks's zsh puts `shell/bin` first on
  PATH (in `.zshrc`, after yours, since macOS's `path_helper` reorders PATH
  in `/etc/zprofile`), whose `pbcopy` runs Apple's and also sends OSC 52, and
  every window writes OSC 52 to its own Mac's clipboard (`ui/osc52.ts`; reads
  are never answered). Claude Code copies a selection with plain `pbcopy`.
  Tests set `MIKS_REAL_PBCOPY` so they never touch the real clipboard.
- Only attached clients answer terminal queries (the headless emulator's
  replies are dropped, as in VS Code), and every one does: with a tab open
  on its Mac and in another Mac's window, gh's background-color query was
  answered twice, and the second landed at the prompt
  (`11;rgb:ffff/ffff/ffff1R`). So windows send answers as `input` with
  `reply` (xterm.js's internal `coreService.onUserInput` fires just before
  `onData` for keys, pastes and clicks, never for answers), and the pane
  passes them on only from the viewer last to size it or type into it.
- Panes strip `CMUX_*`, `GHOSTTY_*`, `TERM_PROGRAM*`, `CLAUDE*`,
  `ELECTRON_*` and inherited `MIKS_*` from the daemon's environment, or
  programs inside think they're in cmux, Electron apps start as plain Node, a
  Miks.app launched from a pane loads the dev server, and Claude Code, seeing
  `CLAUDE_CODE_CHILD_SESSION` from the session that launched Miks, saves no
  transcripts (so nothing can be resumed). install-app relaunches with a
  clean environment for the same reason.

# UI notes

- The chat panel (⌘⇧C, `ui/ChatPanel.tsx`) is another view of the
  terminal, never its own state. The daemon reads the tab's Claude session
  transcript (`transcript_path` from the hooks; `server/Transcript.ts`)
  and sends `chat` messages to whoever watches. The transcript is JSONL with
  one line per message (and per content block), each written once it's
  done, so text shows up when a block finishes, not as it streams. The
  format isn't a documented API, so the parser takes prompts, text and
  `tool_use` and skips everything else. Pasted text comes wrapped in
  `<pasted_content …>` tags, and a message sent while Claude works is an
  `attachment` line (`queued_command`), not a user message. The
  transcript is a tree (each line's `parentUuid`): a rewind carries on
  from an earlier line, leaving the rest in the file, so the panel shows
  the path back from the latest line, and a `reset` when it stops
  continuing the one shown. A compaction (`compact_boundary`) has no
  parent (its `logicalParentUuid` is in no line), so the path crosses it to
  the line written before it. Files run past 100MB (tool output);
  only the tree's lines (they start with `{"parentUuid"`) are parsed, and
  a 130MB one reads in about 300ms, in chunks, without holding up the
  event loop. `fs.watchFile`,
  not `fs.watch`, because a session has its path before the file exists.
  Sending pastes the message (bracketed, so newlines stay in it) and sends
  Return 100ms later. The Stop hook's `last_assistant_message` gives
  `replyLines`, which is how a long reply opens the panel. crosswing's
  `TextArea` with `autoTrim={false}` never takes a new `value` from outside
  (it wouldn't clear after sending), so the composer keeps the default.
  Each tab has its own panel, in its own area (`ChatLayout`), open or not
  per tab (window storage), and shown only while `tab.agent` is set.
  A session starting opens it, unless a restore brought it back
  (`AgentState.restored`, since protocol 14: the hook can't tell a restore's
  `--resume` from yours); closing one it opened within 20s stops that, and
  opening one yourself starts it again (`ChatPanel:autoOpen`). Opened so in
  the tab on screen, its composer takes the keyboard (as `autoFocus()` allows).
  Focus the composer with `preventScroll`: focusing it while the panel
  slides in scrolls the whole tab sideways, which looks like the terminal
  narrowing. A tab remembers whether the keyboard was in its panel and
  puts it back there on returning, reading that in a layout effect,
  before the terminal's own focus on coming on screen overwrites it. In
  overlay mode the terminal is `inert`. A background window (as in
  `MIKS_BACKGROUND` tests) gets no focus events at all, so test focus with
  CDP's `Emulation.setFocusEmulationEnabled`.
  The composer's paperclip types files as paths on the tab's Mac, as a drop
  does (`attachedText` in `TerminalView.tsx`); from a device without the
  Mac's files (the iOS app), the daemon writes them to its tmpdir
  (`sendFile`). Its microphone records with `MediaRecorder` (a timeslice,
  or Safari hands over nothing) and the daemon has Groq transcribe it
  (`server/Dictation.ts`, `whisper-large-v3-turbo`), with the key as
  `groq` in `keys.json` in Miks's home, never in a page: the iOS app's
  bundle is public. The iOS app needs the microphone and camera usage
  strings (the picker offers Take Photo). While it records, a waveform
  (`ui/Waveform.tsx`) covers the text, which stays (invisible) and keeps
  the focus, so the on-screen keyboard stays up. Headless Chrome tests it
  with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`.
  A tab's draft is every window's: each sends its own (`draft`, once
  typing pauses 300ms), and the daemon keeps it with the tab (saved in
  `state.json`), hands it to the others and, every tab's, empty ones too (a window that was away missed the emptying), to each window's `hello`; never
  in `state` (every window, every keystroke). A window takes another's
  only while its composer isn't focused, where its own goes out next.

- `miks version` (`/api/version`, `server/Version.ts`): what the daemon
  runs and on which Mac, from Miks.app's `build.json` (version, commit,
  build time, written by `build-app.ts`) or, in the repo, its version and
  checked-out commit; what's installed there now (read again then), which it
  runs only once restarted; and which Miks each window on it is, from
  `ClientInfo` in its `hello` (since protocol 15): the UI's build, stamped by
  Vite's `define` (`__MIKS_BUILD__`), and for the iOS app its own version
  (`appInfo`). The window it was typed in is the pane's viewer in use.
  The version warning's Details…, About Miks (the Mac's menu and the iPad's)
  and the iOS switcher's Versions… show the same (`ui/VersionDialog.tsx`,
  the `versions` command),
  from a `version` message (since protocol 16; what both say is in
  `shared/version.ts`); an older daemon can't answer, so then it shows only
  this window and the two protocols.
- Push notifications to the iOS app (`server/Push.ts`): the daemon decides,
  as Messages does. A tab's agent waiting or done goes to devices at once
  if this Mac's been idle a minute (`HIDIdleTime`, from `ioreg`), else
  after a minute unless the tab's been seen meanwhile; never to a device
  showing this Mac (`device` messages say so, `visible`). Seen anywhere
  (`seen`, `select`, answered, closed), its notification goes from every
  device: a background push with `clear_threads` (the shell's
  `AppNotifications`), the thread being the tab's `key`. A window here
  left on the tab says `seen` at once, so the daemon believes this Mac's
  windows only when it isn't idle. Pushes go through a relay
  (`push/worker.js`, https://miks-push.nfarina.com, `wrangler deploy` in
  `push/`) holding the APNs key as a secret: key B2ZPFV7BH3, the team's,
  shared with Phoenix and Sage (the team is at Apple's limit of keys). It
  seals a device's token and environment into the opaque id daemons keep
  (`devices.json` in Miks's home). Workers reach APNs over HTTP/2 on the
  edge, but local `wrangler dev` can't ("Network connection lost"): test
  with `--remote`. A made-up token answering `BadDeviceToken` (relay:
  `gone`) means the key and topic were accepted. The app says its
  environment from `embedded.mobileprovision` (development builds carry
  one; TestFlight's don't), and asks for permission once it's connected to
  a Mac. Building for a device after a capability change needs a new
  profile, which `xcodebuild` (with "No Accounts") makes with the App Store
  Connect key: `-allowProvisioningUpdates -authenticationKeyPath` (the
  key from the keychain, as `asc-api.mjs` reads it) `-authenticationKeyID
  -authenticationKeyIssuerID`.
- The iOS app restarts its Mac's daemon from the Mac switcher (Restart
  daemon…): `running`, to ask about what a restart loses (`describeRunning`,
  shared with the Mac app's), then `restart`, over the socket, since the
  gateway passes only `/ws`.
- `miks open <file>` and `miks edit [--wait] <file>` show a file in the
  tab's panel (`ui/FileView.tsx`, CodeMirror 6 with `@codemirror/language-data`
  loading each language as needed; chatwing's GitHub themes in
  `ui/highlighting`). They're `shell/bin/miks`, an executable rather than the
  `.zshrc` function (which hands them over), so programs can run them:
  `$EDITOR`/`$VISUAL` in Miks's zsh is `shell/bin/miks-editor`
  (`miks edit --wait`), for git, `crontab -e` and Claude Code's ⌃G. It's
  `POST /api/open` (the path as the body); with `wait=1` the request stays
  open until the file closes (Done, ✕, it opening again, the tab
  closing). The daemon reads, watches (`fs.watchFile`: git and editors
  replace files) and saves it, so a remote window edits that Mac's file. A
  save is refused if the file's mtime moved since the editor's copy, unless
  forced (`saveFile`); the editor then asks. In a Claude tab the panel
  switches Chat | file, both kept mounted (CSS hides one). The panel's
  open or not apart from the file (⌘⇧C, Escape in the editor once
  CodeMirror has nothing to close): hidden, the file stays as it was.
  A tab's panel holds up to 5 files (`Tab.files`, each in the switcher,
  every one mounted), and file messages name one by `fileId`. Older Miks
  knows only `Tab.file`, the latest, and sends no `fileId`, which means
  that one. Opening one that's open brings it to the front (`opened`
  counts up) as it is; for `miks edit`, unsaved changes kept. Past 5, the
  least recently opened goes, but never one waited on or with changes a
  window hasn't saved (`fileUnsaved`, per watcher).
- Markdown files open rendered (`ui/MarkdownView.tsx`, Preview | Source):
  marked and DOMPurify, through `ui/markdown.ts` like the chat panel's,
  sharing its styles and Copy buttons. Images never load from the page:
  each `src` comes out in a `<template>` before anything's in the document.
  A file's own images (`readImage`, by the extension of the file a link
  points at) come from its Mac, and are sent again only if their mtime
  moved. Web ones wait for Show images, then `fetchImage` gets them on that
  Mac too (image types, 10 MB, 15s): never from loopback, private,
  link-local, CGNAT, multicast or reserved addresses (IPv4 in IPv6 too),
  nor the networks of this Mac's own interfaces, checked as each
  connection (and redirect) is made, so DNS rebinding can't get past.
  `data:` images stay as they are.
- ⌘-click in a terminal (`ui/pathLinks.ts`, an xterm.js link provider):
  each token on the line that looks like a path (absolute, `~/`, `./`,
  `../`, with a `/` in it, or a markdown file's name; any `:line:col` off)
  goes to `findPaths`, which looks for it on the tab's Mac from where its
  shell was last polled (up to 2s old, so hovering starts no `lsof`, which
  would be a process per line the mouse crosses). Only what's there is a link,
  underlined only while ⌘ is down: markdown files open in the panel,
  folders in Finder (`showFolder`; a bundle is shown in its folder, not
  opened), only in a Miks window on this Mac, never a remote's or a
  browser's. The click looks again, from where the shell is that moment
  (`now`, an `lsof`), so a `cd` just before it counts.
- A click on code in a chat message (`ui/codeMenu.tsx`; not in a block or
  a link) shows a menu: Copy, and for one that's there on the tab's Mac
  (`findPaths`, from the tab's folder), Open (a file in the panel, a folder
  in Finder) and Reveal in Finder (`showFolder` with `reveal`, since
  protocol 18: `open -R`), the Finder ones only on this Mac; for a web
  address, Open link.

- `miks browse <url>` (`POST /api/browse`, `Tab.page`) shows a page in the
  panel (`ui/BrowseView.tsx`, a `<webview>`), switching Chat | file | page
  with whatever else it has. Everything it loads goes out from the tab's
  daemon, so a remote window's `localhost` is the remote's on every port:
  the webview's session (`persist:browse-<window key>`, one per daemon, so
  each Mac has its own cookies) has as its proxy a front in Electron main
  (`app/browse.ts`) on 127.0.0.1, which hands each connection to the
  daemon's socket (through the tunnel), where `server/Proxy.ts` makes it:
  CONNECT for HTTPS and WebSockets (end to end, no interception), full-URL
  requests for plain HTTP. Chromium takes a proxy only as host:port, not a
  socket. It never proxies loopback unless the bypass rules say
  `<-loopback>`. And it can't authenticate to SOCKS, so the front is HTTP,
  asking for a random password that `app.on("login")` gives only its
  sessions (any user of the Mac can reach 127.0.0.1). `will-attach-webview`
  strips the preload (`window.miks` types into shells) and Node, and allows
  only the window's own partition. A page's new windows (`target="_blank"`)
  open in the browser chosen in Settings (`openLink` in main, as terminal and
  chat links do), and reach it only with the webview's `allowpopups`, which
  React drops as `true`, so it's `""`: without it, such links did nothing.
  A hidden page is `visibility: hidden`, not `display: none`, so its
  webview keeps its size. The page is saved with its tab, at wherever it has
  navigated to (`pageNavigated`), so a restore reopens it there. Verified with the fake-ssh remote: a page and a
  fetch to another port both came from the remote daemon (by `lsof`).
  In the iOS app a page is the app's own `WKWebView` (`ios/Miks/Pages.swift`),
  over the app's at where `BrowseView` leaves room (`ui/nativePage.ts`
  follows it each frame, and hides it while hidden, under a modal, or under
  a PanelLayout's panel, by its shade, as the sidebar is on a phone):
  not under it, since every ancestor's background there would have to be
  clear. It loads through the gateway, which is the proxy too
  (`proxyConfigurations`, CONNECT over TLS to port 2741, even for plain
  http). WebKit never proxies `localhost`, so it loads as `mac.localhost`,
  which macOS (and so Node) resolves to the Mac itself and Vite allows
  (`mac.internal` got Vite's "Blocked request"). Plain http needs
  `NSAllowsArbitraryLoadsInWebContent`. A modal's layer spans the screen
  (crosswing's toasts' is always there), taking no touches where it has
  nothing, so only what takes touches counts as over a page. Verified from
  an iPad. The app has no web `Notification` (throwing for one blanked the
  page).
- ⌘⇧T (Reopen closed, `reopen`, since protocol 19) brings back the last
  tab, workspace, file or page you closed (not a shell that exited), from
  the daemon's last 20 (`Workspaces.closed`, in memory only: a restart
  restores what's open). A tab comes back where it was, as a restore
  would (directory, history, Claude session, kept command, panel), under
  its old `key`, so each window's state for it (panel open, draft) is
  back too; a plain shell's also starts from what its terminal showed
  (`Pane.snapshot`, without modes), its old prompt line wiped for the new
  one. A history file stays while ⌘⇧T could bring its tab back. Closing a
  workspace's last tab closes it, so that's remembered as the workspace.
  `state.json` keeps each tab's files now too.
- ⌘⇧F (or the tab bar's button beside the panel's) has the panel fill the
  tab, per tab like open or not: CSS over the same PanelLayout (nothing
  remounts, so a page keeps its state), the terminal keeping its full size
  under it (no SIGWINCH), and showing or hiding it fades rather than
  slides.

- Settings (`miks/shared/settings`) live in `settings.json`, owned by the
  Electron main process and pushed to every window; not localStorage, which
  is per origin, so the dev build and Miks.app would each have their own.
  A Mac's own (`MACHINE_SETTINGS`: `tailnetAccess`, `hidePathPrefix`) are
  its daemon's instead, in `machine.json` (seeded from `settings.json` the
  first time), in `state.machine` for every window on it and changed by any
  of them (`machineSettings`): a window on another Mac turns on that Mac's
  gateway and shows its prefix, and the iOS app needn't set its own. Not in
  `settings.json`, which main writes back whole on any change.
  Settings (⌘,) is a crosswing dialog; a dialog must take focus from the
  terminal, or keys (Escape included) go to the shell behind it.
- In dev, `window.miksCommand("<name>")` runs a menu command from DevTools,
  where menu shortcuts can't be sent.
- Drag to reorder is `crosswing/components/draggable`, moved from chatwing
  (where seven projects still have their own copy) and not yet in central
  crosswing: `wings sync` reports it as Creates awaiting approval. It needs a
  `data-draggable-root` ancestor, and only logs an error without one. The
  dragging copy is placed outside its list and sized from the item's border
  box: style items on their own, not from the parent, and put spacing inside
  them (padding around an inner box), never margins, or the copy grows and
  the list shifts.
- Notifications come from the renderer (`useAgentNotifications` in
  `App.tsx`): only for status changes seen while connected, and not for the
  tab on screen in a focused window. A finished turn's shows the start of its reply
  (the Stop hook's `last_assistant_message`, as `AgentState.reply`), as plain text.
- Claude Code sets DEC mode 2031 at startup and never queries the scheme, so
  the daemon (`Pane.ts`) reports the current one as soon as the mode is set,
  then on every change the UI reports (`appearance`). xterm.js has no 2031.

# Agent status

`packages/daemon/hooks/claude-hook.sh` is a Claude Code hook for every event;
it posts the hook JSON to `/api/hook?pane=$MIKS_PANE_ID` and is a no-op outside
Miks. Mapping in `Workspaces.applyHook`.

Interrupting a turn with Esc fires no hook. Claude Code's title does change:
◐/◑ while a turn runs, ✳ when it stops (verified live), so the spinner
stopping ends a `working` turn (`Workspaces.applyTitle`). Testing against a
real `claude` in a pane: start it in a trusted folder or it stops at the trust
prompt, and send a prompt's text and its Enter as separate writes, or Claude
Code takes the Enter as part of a paste.

# Style

Comments in Sentence case, ending with a period; UI text in Sentence case. No
useMemo/useCallback (React Compiler). Follow crosswing conventions
(`packages/crosswing`, and riot's `.claude/rules/crosswing.md`).
