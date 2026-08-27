#!/bin/zsh
# Shared helpers for the two tmux-driven INTERACTIVE probes
# (interactive-capture.sh, interactive-ask-probe.sh). Sourced by them, not
# run on its own. The `-p` probes in this directory need none of this:
# an interactive `claude` needs a TTY, so it is driven inside a detached
# tmux session and answered through `tmux send-keys`.
#
# Nothing here ever approves a permission prompt. The only keys these
# helpers send are the three known STARTUP dialogs' acknowledgements
# (theme, workspace trust, bypassPermissions warning), the prompt text,
# Escape and /exit. Any screen that is not one of those aborts the run.

# Seed the isolated CLAUDE_CONFIG_DIR so an interactive `claude` does not
# fall into first-run onboarding. Without this the session stops on the
# theme picker and then on the login-method screen, and a login screen is
# not something a probe may answer. Only the onboarding flags are seeded;
# no account data is copied out of the operator's real config.
ug_sig_preseed_config() {
  local dir=$1
  python3 - "$dir" <<'PY'
import json, os, sys
d = sys.argv[1]
json.dump(
    {
        "hasCompletedOnboarding": True,
        "lastOnboardingVersion": "2.1.247",
        "theme": "dark",
        "numStartups": 5,
        "installMethod": "native",
        "autoUpdates": False,
    },
    open(os.path.join(d, ".claude.json"), "w"),
)
PY
}

ug_sig_pane() { tmux capture-pane -p -t "$1" 2>/dev/null; }

# Poll the pane until the composer is ready, answering only the three known
# startup dialogs. Returns 0 when ready, 1 on an unknown screen or timeout
# (with the pane dumped to stdout so the abort is diagnosable).
#   $1 tmux session name   $2 timeout seconds (default 90)
ug_sig_drive_startup() {
  local s=$1
  local timeout=${2:-90}
  local deadline=$(( $(date +%s) + timeout ))
  local theme=0 trust=0 bypass=0 pane=""
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if ! tmux has-session -t "$s" 2>/dev/null; then
      echo "ABORT: tmux session $s died during startup"
      return 1
    fi
    pane=$(ug_sig_pane "$s")
    case "$pane" in
      *"shift+tab to cycle"*)
        return 0 ;;
      *"Select login method"*)
        echo "ABORT: login screen shown; refusing to authenticate from a probe"
        echo "$pane"
        return 1 ;;
      *"Choose the text style"*)
        theme=$(( theme + 1 ))
        [ "$theme" -gt 3 ] && { echo "ABORT: theme dialog did not clear"; echo "$pane"; return 1; }
        tmux send-keys -t "$s" Enter; sleep 2; continue ;;
      *"one you trust"*)
        trust=$(( trust + 1 ))
        [ "$trust" -gt 3 ] && { echo "ABORT: workspace-trust dialog did not clear"; echo "$pane"; return 1; }
        tmux send-keys -t "$s" Enter; sleep 2; continue ;;
      *"Bypass Permissions mode"*)
        # Default selection is "No, exit"; move down to "Yes, I accept".
        bypass=$(( bypass + 1 ))
        [ "$bypass" -gt 3 ] && { echo "ABORT: bypass acknowledgement did not clear"; echo "$pane"; return 1; }
        tmux send-keys -t "$s" Down; sleep 1; tmux send-keys -t "$s" Enter; sleep 2; continue ;;
    esac
    sleep 2
  done
  echo "ABORT: composer never became ready within ${timeout}s"
  ug_sig_pane "$s"
  return 1
}

# Type a prompt and submit it.
ug_sig_send_prompt() {
  local s=$1 text=$2
  tmux send-keys -t "$s" -l "$text"
  sleep 1
  tmux send-keys -t "$s" Enter
}

# Wait for a file to become non-empty. $1 path, $2 timeout seconds.
ug_sig_wait_file() {
  local f=$1
  local deadline=$(( $(date +%s) + ${2:-120} ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    [ -s "$f" ] && return 0
    sleep 2
  done
  return 1
}

# Leave the session the way a human would, then make sure it is gone.
ug_sig_quit() {
  local s=$1
  tmux has-session -t "$s" 2>/dev/null || return 0
  tmux send-keys -t "$s" -l "/exit"
  sleep 1
  tmux send-keys -t "$s" Enter
  sleep 3
  tmux kill-session -t "$s" 2>/dev/null || true
}
