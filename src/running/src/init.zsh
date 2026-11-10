# running — process browser (~/dev/projects/running). Loaded by: eval "$(command running init)"

# 1. Wrapper: lets "start" cd to a kept process's directory and put its
#    command on your prompt, as if you typed it.
running() {
  local f; f=$(mktemp -t running) || return
  RUNNING_ACTION_FILE=$f command running "$@"
  local rc=$?
  if [[ -s $f ]]; then
    local dir cmd
    { IFS= read -r dir; IFS= read -r cmd } < "$f"
    [[ -n $dir ]] && cd -- "$dir"
    [[ -n $cmd ]] && print -z -- "$cmd"
  fi
  command rm -f -- "$f"
  return $rc
}

# 2. Command log: what you typed and where (tty, dir, terminal tab). `running`
#    uses it only to name and locate processes — never for history/up-arrow.
#    Commands starting with a space are not logged.
zmodload zsh/datetime 2>/dev/null
typeset -g _running_log=${RUNNING_LOG_FILE:-${XDG_STATE_HOME:-$HOME/.local/state}/running/commands.log}
typeset -g _running_term="orca=${ORCA_TERMINAL_HANDLE-};tmux=${TMUX_PANE-};app=${TERM_PROGRAM-};apple=${TERM_SESSION_ID-};iterm=${ITERM_SESSION_ID-};wezterm=${WEZTERM_PANE-};kitty=${KITTY_WINDOW_ID-}"
_running_preexec() {
  [[ $1 == ' '* ]] && return
  [[ -d ${_running_log:h} ]] || mkdir -p -- ${_running_log:h}
  local c=${1//\\/\\\\}
  c=${c//$'\n'/\\n}
  c=${c//$'\t'/\\t}
  print -r -- "$EPOCHREALTIME"$'\t'"$TTY"$'\t'"$$"$'\t'"$PWD"$'\t'"$_running_term"$'\t'"$c" >>| $_running_log
}
autoload -Uz add-zsh-hook && add-zsh-hook preexec _running_preexec
