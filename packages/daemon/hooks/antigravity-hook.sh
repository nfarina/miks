#!/bin/sh
# Antigravity hook: forwards the hook's JSON (on stdin) to the Miks daemon that
# owns this pane, as claude-hook.sh does for Claude Code. Antigravity waits for
# each hook, and wants JSON back, so it always answers, and never fails.
if [ -n "$MIKS_PANE_ID" ] && [ -S "$MIKS_SOCKET" ]; then
  curl -sf -m 2 --unix-socket "$MIKS_SOCKET" --data-binary @- \
    "http://miks/api/hook/antigravity?pane=$MIKS_PANE_ID" >/dev/null 2>&1
fi
echo '{}'
exit 0
