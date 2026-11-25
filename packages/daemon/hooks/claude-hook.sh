#!/bin/sh
# Claude Code hook: forwards the hook's JSON (on stdin) to the Miks daemon
# that owns this pane. Outside Miks there's no MIKS_PANE_ID, so it does
# nothing; it never fails or blocks, so it can't get in Claude's way.
[ -n "$MIKS_PANE_ID" ] && [ -S "$MIKS_SOCKET" ] || exit 0
# grok runs Claude Code's hooks too, and sets this for every one; it has
# grok-hook.sh, or a grok session would be saved as Claude's.
[ -z "$GROK_HOOK_EVENT" ] || exit 0
# A script's `claude -p` (or Agent SDK) run is `sdk-cli` (`sdk-ts`, …), not
# a session in the tab: it would open the tab's panel and show working.
case "$CLAUDE_CODE_ENTRYPOINT" in sdk*) exit 0 ;; esac
curl -sf -m 2 --unix-socket "$MIKS_SOCKET" --data-binary @- \
  "http://miks/api/hook?pane=$MIKS_PANE_ID" >/dev/null 2>&1
exit 0
