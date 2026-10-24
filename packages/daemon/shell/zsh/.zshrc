# macOS's /etc/zshrc, just run, set HISTFILE from ZDOTDIR, which was this
# folder: history would be saved inside Miks.app (breaking its signature, and
# lost with every update). Put it where it'd be without Miks, before yours.
[[ $HISTFILE == $__miks_zdotdir/* ]] && HISTFILE=${MIKS_USER_ZDOTDIR:-$HOME}/.zsh_history

ZDOTDIR=$MIKS_USER_ZDOTDIR
[[ -f $ZDOTDIR/.zshrc ]] && builtin source "$ZDOTDIR/.zshrc"
MIKS_USER_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$__miks_zdotdir

# Miks's pbcopy (../bin) ahead of Apple's. Here, after your startup files,
# because macOS's path_helper puts /usr/bin back in front of anything before.
path=("${__miks_zdotdir:h}/bin" $path)

# Files that programs open for you to edit (git's commit messages, crontab
# -e, Claude Code's ⌃G) open in the tab's panel, and the program goes on once
# you're done there. After your startup files, so it's this in Miks tabs.
export EDITOR="${__miks_zdotdir:h}/bin/miks-editor"
export VISUAL=$EDITOR

# This tab's own history (MIKS_HISTORY, kept by the daemon across restarts):
# each command it runs, written as it runs in zsh's history format, then read
# back last when the tab returns, so ↑ starts with what this tab was doing.
# Your shared history goes on as ever, before it. Read at the first prompt:
# zsh loads your HISTFILE only once the startup files are done, which put it
# after this tab's, and ↑ started with whatever any tab ran last.
if [[ -n $MIKS_HISTORY ]]; then
  __miks_read_history() {
    add-zsh-hook -d precmd __miks_read_history
    unfunction __miks_read_history
    [[ -s $MIKS_HISTORY ]] || return
    local -a lines=("${(@f)$(<$MIKS_HISTORY)}")
    # Only the last few hundred lines, cut where a command starts (after a
    # line that doesn't continue onto the next with a backslash).
    if (( $#lines > 400 )); then
      local start=$(( $#lines - 199 ))
      while (( start > 1 )) && [[ ${lines[start - 1]} == *\\ ]]; do
        (( start-- ))
      done
      builtin print -rl -- "${(@)lines[start,-1]}" >| $MIKS_HISTORY
    fi
    builtin fc -R $MIKS_HISTORY
  }
  __miks_remember() {
    # zsh's history format: a newline within a command follows a backslash.
    local nl=$'\n'
    builtin print -r -- "${${1%$nl}//$nl/\\$nl}" >> $MIKS_HISTORY
  }
fi

# `miks keep <command>`: runs it, and if Miks restores this tab while it's
# still running (a daemon restart, quitting and reopening), runs it again
# there. It stops being kept once it ends, however it ends.
miks() {
  case $1 in
    keep) shift; __miks_keep "$@" ;;
    update) __miks_update ;;
    # An executable (../bin/miks), so programs other than your shell can too.
    open|edit|browse|version) command miks "$@" ;;
    *)
      builtin print -u2 "Usage: miks keep <command> [arguments...]"
      builtin print -u2 "       miks update"
      builtin print -u2 "       miks open <file>"
      builtin print -u2 "       miks edit [--wait] <file>"
      builtin print -u2 "       miks browse <url>"
      builtin print -u2 "       miks version"
      return 2
      ;;
  esac
}

__miks_keep() {
  if (( $# == 0 )); then
    builtin print -u2 "Usage: miks keep <command> [arguments...]"
    return 2
  fi
  if [[ -n $MIKS_PANE_ID && -S $MIKS_SOCKET ]]; then
    # Quoted for the shell that runs it again.
    builtin print -rn -- "${(j: :)${(q-)@}}" |
      curl -sf -m 2 --unix-socket "$MIKS_SOCKET" --data-binary @- "http://miks/api/keep?pane=$MIKS_PANE_ID" >/dev/null
  fi
  "$@"
}

# Updates Miks on this Mac, wherever you're typing from: the app reports each
# step to a file, printed here as it goes.
__miks_update() {
  local file
  file=$(mktemp "${TMPDIR:-/tmp}/miks-update-XXXXXX") || return 1
  if ! open -g "miks://update?status=$file"; then
    rm -f "$file"
    return 1
  fi
  local -i printed=0 deadline=$(( SECONDS + 600 ))
  local -a lines
  while (( SECONDS < deadline )); do
    lines=("${(@f)$(<$file)}")
    while (( printed < ${#lines} )) && [[ -n ${lines[printed + 1]} ]]; do
      (( printed++ ))
      if [[ ${lines[printed]} == END ]]; then
        rm -f "$file"
        return 0
      fi
      builtin print -r -- "${lines[printed]}"
    done
    sleep 0.3
  done
  rm -f "$file"
  builtin print -u2 "Miks didn't answer."
  return 1
}

# Marks around each command (OSC 133, as Ghostty, iTerm and VS Code read
# them): A where a prompt starts, C where a command's output starts, D where
# it ends. "Select last command" (⌘⇧A) goes by them.
__miks_precmd() {
  local ret=$?
  if [[ -n $__miks_running ]]; then
    builtin print -n "\e]133;D;$ret\a"
    unset __miks_running
  fi
  builtin print -n "\e]133;A\a"
}
__miks_preexec() {
  __miks_running=1
  builtin print -n "\e]133;C\a"
}
autoload -Uz add-zsh-hook
add-zsh-hook precmd __miks_precmd
add-zsh-hook preexec __miks_preexec
if [[ -n $MIKS_HISTORY ]]; then
  add-zsh-hook precmd __miks_read_history
  add-zsh-hook preexec __miks_remember
fi

# ⌥←/→ by word. With Option as Meta, Miks sends them as xterm does
# (ESC [1;3D), which zsh leaves unbound; Terminal.app's ESC b/f already are.
# Yours win: only keys you haven't bound.
for __miks_key __miks_widget in '^[[1;3D' backward-word '^[[1;3C' forward-word; do
  [[ $(bindkey -- $__miks_key) == *undefined-key ]] && bindkey -- $__miks_key $__miks_widget
done
unset __miks_key __miks_widget

# Without -l there's no .zlogin to come.
[[ -o login ]] || __miks_restore_zdotdir
