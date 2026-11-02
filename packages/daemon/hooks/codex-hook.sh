#!/bin/sh
# Codex hook: forwards the hook's JSON (on stdin) to the Miks daemon that owns
# this pane, as claude-hook.sh does for Claude Code. Its own route, so a daemon
# too old to know Codex turns it away rather than saving it as a Claude session.
[ -n "$MIKS_PANE_ID" ] && [ -S "$MIKS_SOCKET" ] || exit 0
curl -sf -m 2 --unix-socket "$MIKS_SOCKET" --data-binary @- \
  "http://miks/api/hook/codex?pane=$MIKS_PANE_ID" >/dev/null 2>&1
exit 0
