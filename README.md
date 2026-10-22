<img width="885" height="650" alt="miks" src="https://github.com/user-attachments/assets/da1287b6-3a96-496a-81e0-1d4436a3d69e" />

# Miks

Yo dawg, I heard you like terminals, so I made a terminal for your terminals!

Miks is a replacement for `Terminal.app` designed for running a bunch of coding agents (like Claude Code) at once. Inspired by `cmux`, Miks has "workspaces" in a sidebar, tabs in each, and your agent's status at a glance: working, needs you, or done.

I enjoyed [cmux](https://github.com/manaflow-ai/cmux) until I realized it bundled a browser, computer use and an 8 GB repo; Miks is the part of it I actually used.

- Workspaces and tabs, drag to reorder; ⌘1–9, ⌘⌃[ ] (or ⌘⌃← →) and ⌘⇧[ ] (on into the next workspace) to get around
- Live Claude Code status in the sidebar, plus a notification when an agent
  finishes or needs you (unless you're already looking)
- What each session has going in the background (shells, monitors, agents),
  next to its status
- Your iPad or phone can use it in a browser, over [Tailscale](https://tailscale.com):
  only your own devices, and only when you turn it on
- Terminals live in a background daemon, so reloading the UI never touches
  a session. Quitting ends them like any terminal app (asking first if
  anything's running), or turn on "Keep terminals running"
- Comes back where you left it: layout, each tab's folder and history, and
  its Claude session, resumed. `miks keep <command>` brings back your own
  long-running commands the same way
- A chat panel (⌘⇧C) beside the terminal: the tab's Claude Code
  conversation in proportional type with real markdown, and a box to write
  the next message in. It opens on its own for long replies
- `miks open <file>` and `miks edit <file>` show a file in that panel, with
  syntax highlighting and a proper editor; and `$EDITOR` in Miks tabs is
  that, so git's commit messages and Claude Code's ⌃G open there too
- `miks browse <url>` shows a web page in that panel, loaded from the Mac the
  terminal is on: in a remote window, `miks browse localhost:3000` is that
  Mac's dev server, every port of it, with no tunnels to set up. ⌘⇧F has
  the panel fill the tab
- Follows light and dark mode, and tells Claude Code when it changes
- Remote windows: a window on another Mac's terminals, over SSH, with
  copying landing on the Mac you're at and dropped files sent over. `miks update` in one updates Miks on that Mac
- Drop files in to type their paths, or hold ⌥ to copy them into the tab's
  folder
- Drop a folder on the Dock icon, or
  `open -a Miks <folder>`, for a workspace there (so it works as GitHub
  Desktop's custom shell)

macOS 13+, Apple Silicon.

## Install

[![Download Miks for macOS](https://img.shields.io/github/v/release/nfarina/miks?label=Download&logo=apple&style=for-the-badge)](https://github.com/nfarina/miks/releases/latest/download/Miks-macos.zip)

Or browse [all releases](https://github.com/nfarina/miks/releases). Miks
updates itself (Miks → Check for updates…).

Agent status works by adding hooks to `~/.claude/settings.json` that tell
Miks what Claude is up to. Outside Miks they do nothing. Turn them off in
Settings (⌘,) and Miks takes them back out.

## Build

Miks is Electron, xterm.js and React, with [node-pty](https://github.com/microsoft/node-pty)
in the daemon. With Node 24 and Yarn:

```bash
yarn install
yarn dev          # Hot-reloading dev build
yarn test         # Types, lint and tests
yarn install:app  # A signed Miks.app in /Applications (needs a Developer ID)
```

`AGENTS.md` has the architecture and the gotchas.

## Releasing

```bash
yarn release 0.2.0
```

This builds, signs, notarizes, tags, and publishes a GitHub release with the
app and the `update.json` every installed Miks checks for updates. It asks for
release notes in `$EDITOR`, or pass `--notes file.md`.

One-time setup: a Developer ID Application certificate in your keychain, and
`xcrun notarytool store-credentials miks-notary` (or set `NOTARY_PROFILE` in
`.env.release.local`).

## License

MIT License — see `LICENSE.txt`
