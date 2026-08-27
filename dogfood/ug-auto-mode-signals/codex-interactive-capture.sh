#!/usr/bin/env bash
# Interactive (TUI) counterpart of codex-capture.sh: what `permission_mode`
# a Codex PreToolUse payload carries in a live `codex` TUI session per
# approval/sandbox shape, driven inside a detached tmux session. Produces
# payloads/codex-tui-<shape>.<Event>.jsonl and a pane dump per run.
#
# Nothing here ever approves a command-approval prompt. The only keys
# sent are: Enter on the directory-trust dialog for the scratch cwd this
# script created itself, the prompt text plus Enter, and `/quit`. Any other
# screen aborts the run with the pane dumped for diagnosis.
#
# Env vars (all optional):
#   UG_SIG_OUT          output dir (default: mktemp -d)
#   UG_SIG_CODEX_HOME   parent of the per-run isolated CODEX_HOMEs (default: mktemp -d)
#   UG_SIG_WORK         parent of the per-run scratch cwds (default: mktemp -d)
#   UG_SIG_ONLY         space-separated run names to execute (default: all)
set -u

CAP="${UG_SIG_OUT:-$(mktemp -d)}"
DIR="${UG_SIG_CODEX_HOME:-$(mktemp -d)}"
WORK="${UG_SIG_WORK:-$(mktemp -d)}"
mkdir -p "$CAP" "$DIR" "$WORK"
chmod 700 "$DIR"
umask 077

SESSIONS=()
HOMES=()
cleanup() {
  for s in "${SESSIONS[@]:-}"; do
    [ -n "$s" ] && tmux kill-session -t "$s" 2>/dev/null
  done
  # Each entry is a per-run CODEX_HOME this script created itself (a
  # subdirectory of $DIR) holding a copy of auth.json: remove the whole
  # tree, session rollouts included.
  for h in "${HOMES[@]:-}"; do
    [ -n "$h" ] && rm -rf "$h"
  done
  echo "cleanup: tmux sessions killed, per-run CODEX_HOMEs (auth copies included) removed"
}
trap cleanup EXIT INT TERM

{ codex --version; uname -a; } > "$CAP/version.txt" 2>&1

PROMPT="Run exactly this one shell command and nothing else: echo tui-probe . Then reply with the single word: done"

pane() { tmux capture-pane -p -t "$1" 2>/dev/null; }

# Poll until the composer is ready, answering only the directory-trust
# dialog. Returns 1 on any unknown blocking screen or timeout.
drive_startup() {
  local s=$1 timeout=${2:-60}
  local deadline=$(( $(date +%s) + timeout )) trust=0 p
  while [ "$(date +%s)" -lt "$deadline" ]; do
    tmux has-session -t "$s" 2>/dev/null || { echo "ABORT: tmux session $s died"; return 1; }
    p=$(pane "$s")
    case "$p" in
      *"Ask Codex to do anything"*) return 0 ;;
      *"Do you trust the contents of this directory"*)
        trust=$(( trust + 1 ))
        [ "$trust" -gt 3 ] && { echo "ABORT: trust dialog did not clear"; echo "$p"; return 1; }
        tmux send-keys -t "$s" Enter; sleep 3; continue ;;
      *"Sign in"*|*"log in"*|*"Log in"*)
        echo "ABORT: login screen shown; refusing to authenticate from a probe"; echo "$p"; return 1 ;;
    esac
    sleep 2
  done
  echo "ABORT: composer never became ready within ${timeout}s"; pane "$s"; return 1
}

# Wait for the turn to finish: the pane shows the final "done" reply and
# the composer placeholder again. Returns 1 on timeout or on an approval
# prompt (which this probe never answers).
wait_turn() {
  local s=$1 timeout=${2:-120}
  local deadline=$(( $(date +%s) + timeout )) p
  while [ "$(date +%s)" -lt "$deadline" ]; do
    p=$(pane "$s")
    # Only the finished turn ends the wait. A command-approval prompt, if
    # one appears, is deliberately never answered: the run then times out
    # below with the pane dumped, which is the recorded outcome.
    case "$p" in
      *"• done"*) return 0 ;;
    esac
    sleep 3
  done
  echo "TIMEOUT waiting for the turn"; pane "$s"; return 1
}

gen_hooks() {
  local home=$1 name=$2
  cat > "$home/hooks.json" <<EOF
{
  "hooks": {
    "SessionStart":      [{"hooks":[{"type":"command","command":"{ cat; echo; } >> $CAP/$name.SessionStart.jsonl"}]}],
    "UserPromptSubmit":  [{"hooks":[{"type":"command","command":"{ cat; echo; } >> $CAP/$name.UserPromptSubmit.jsonl"}]}],
    "PreToolUse":        [{"hooks":[
      {"type":"command","command":"{ cat; echo; } >> $CAP/$name.PreToolUse.jsonl"},
      {"type":"command","command":"{ env | grep -E '^(CODEX|CLAUDE|OPENAI|SHLVL|PPID|PWD|_=)' | sort; echo ---; ps -o pid=,ppid=,comm= -p \$PPID; ps -o pid=,ppid=,comm= -p \$\$; echo ===; } >> $CAP/$name.PreToolUse.env.txt"}
    ]}],
    "PermissionRequest": [{"hooks":[{"type":"command","command":"{ cat; echo; } >> $CAP/$name.PermissionRequest.jsonl"}]}],
    "PostToolUse":       [{"hooks":[{"type":"command","command":"{ cat; echo; } >> $CAP/$name.PostToolUse.jsonl"}]}],
    "Stop":              [{"hooks":[{"type":"command","command":"{ cat; echo; } >> $CAP/$name.Stop.jsonl"}]}]
  }
}
EOF
}

wanted() {
  [ -z "${UG_SIG_ONLY:-}" ] && return 0
  case " $UG_SIG_ONLY " in *" $1 "*) return 0;; esac
  return 1
}

# run <name> <config-lines...> -- <codex flags...>
run() {
  local name=$1; shift
  wanted "$name" || return 0
  local cfg=() flags=()
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do cfg+=("$1"); shift; done
  [ $# -gt 0 ] && shift
  flags=("$@")
  local home="$DIR/$name" work="$WORK/$name" s="ugcodex-$name-$$"
  mkdir -p "$home" "$work"; chmod 700 "$home"
  HOMES+=("$home"); SESSIONS+=("$s")
  if [ -f "$HOME/.codex/auth.json" ]; then
    cp "$HOME/.codex/auth.json" "$home/auth.json"; chmod 600 "$home/auth.json"
  fi
  : > "$home/config.toml"
  [ ${#cfg[@]} -gt 0 ] && printf '%s\n' "${cfg[@]}" >> "$home/config.toml"
  printf '[features]\nhooks = true\n' >> "$home/config.toml"
  gen_hooks "$home" "$name"
  printf '%s\n' "${flags[*]:-}" > "$CAP/$name.flags.txt"
  cp "$home/config.toml" "$CAP/$name.config.toml"
  echo "=== run $name: flags=[${flags[*]:-}] config=[${cfg[*]:-}] ==="
  tmux new-session -d -s "$s" -x 200 -y 50 \
    "cd '$work' && CODEX_HOME='$home' codex --dangerously-bypass-hook-trust ${flags[*]:-}"
  if ! drive_startup "$s" 60; then
    pane "$s" > "$CAP/$name.pane.txt"; tmux kill-session -t "$s" 2>/dev/null; return 1
  fi
  # Optional TUI mode cycling before the prompt: UG_SIG_CYCLE_<name>=N sends
  # Shift+Tab N times (the TUI's "shift+tab to cycle" mode switch).
  local cycle_var="UG_SIG_CYCLE_${name//-/_}" n
  for (( n = 0; n < ${!cycle_var:-0}; n++ )); do tmux send-keys -t "$s" BTab; sleep 2; done
  # Optional `/permissions` profile selection: UG_SIG_PERM_<name>=K picks
  # the K-th entry of the TUI's "Update Model Permissions" menu (1 = Ask
  # for approval, 2 = Approve for me, 3 = Full Access) before the prompt.
  local perm_var="UG_SIG_PERM_${name//-/_}" k
  if [ "${!perm_var:-0}" -gt 0 ]; then
    tmux send-keys -t "$s" "/permissions"; sleep 1; tmux send-keys -t "$s" Enter; sleep 3
    if ! pane "$s" | grep -q "Update Model Permissions"; then
      echo "ABORT: /permissions menu did not open"; pane "$s" > "$CAP/$name.pane.txt"
      tmux kill-session -t "$s" 2>/dev/null; return 1
    fi
    for (( k = 1; k < ${!perm_var}; k++ )); do tmux send-keys -t "$s" Down; sleep 1; done
    pane "$s" > "$CAP/$name.permissions-menu.txt"
    tmux send-keys -t "$s" Enter; sleep 3
  fi
  pane "$s" | grep -v '^$' | tail -1 > "$CAP/$name.footer.txt"
  tmux send-keys -t "$s" "$PROMPT"; sleep 2; tmux send-keys -t "$s" Enter
  wait_turn "$s" 120; local rc=$?
  pane "$s" > "$CAP/$name.pane.txt"
  tmux send-keys -t "$s" "/quit"; sleep 1; tmux send-keys -t "$s" Enter; sleep 3
  tmux kill-session -t "$s" 2>/dev/null
  echo "turn rc=$rc ; footer: $(cat "$CAP/$name.footer.txt") ; files:"; ls "$CAP" | grep "^$name\."
}

run tui-default
UG_SIG_CYCLE_tui_plan=1 run tui-plan
UG_SIG_PERM_tui_perm_approve_for_me=2 run tui-perm-approve-for-me
UG_SIG_PERM_tui_perm_full_access=3 run tui-perm-full-access
run tui-never          -- -a never
run tui-bypass         -- --dangerously-bypass-approvals-and-sandbox
run tui-readonly       -- -s read-only
run tui-fullaccess     -- -s danger-full-access
run tui-approve-for-me -- --approve-for-me
run tui-config-never   'approval_policy = "never"' 'sandbox_mode = "danger-full-access"' --
run tui-config-never-ws 'approval_policy = "never"' 'sandbox_mode = "workspace-write"' --

echo "=== done, output in $CAP ==="
