#!/bin/sh
# grok hook: forwards the hook's JSON (on stdin) to the Miks daemon that owns
# this pane, as claude-hook.sh does for Claude Code. It prints nothing, which
# grok takes as no decision (a Stop hook's answer could keep it working).
[ -n "$MIKS_PANE_ID" ] && [ -S "$MIKS_SOCKET" ] || exit 0
curl -sf -m 2 --unix-socket "$MIKS_SOCKET" --data-binary @- \
  "http://miks/api/hook/grok?pane=$MIKS_PANE_ID" >/dev/null 2>&1
exit 0
