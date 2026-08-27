#!/bin/zsh
# M2: how an INTERACTIVE (non `-p`) Claude Code session under
# `--permission-mode bypassPermissions` resolves a PreToolUse hook answer of
# `permissionDecision: "ask"`. Same hook shape as ask-probe.sh, driven inside
# a detached tmux session. Produces README results section (i) and the
# payloads/interactive-ask-bypass.* fixtures.
#
# The probe NEVER answers the permission prompt. If one appears it is left
# untouched for a settle window (to show it does not auto-resolve), the pane
# is captured, and the run is ended with Escape and /exit.
#
# Env vars (all optional):
#   UG_SIG_OUT          output dir (default: mktemp -d)
#   UG_SIG_CONFIG_DIR   parent of the per-run isolated CLAUDE_CONFIG_DIRs
#                       (default: mktemp -d)
#   UG_SIG_WORK         parent of the per-run scratch cwds (default: mktemp -d)
#   UG_SIG_RUNS         number of fresh sessions (default: 2)
#   UG_SIG_SETTLE       seconds to leave an appeared prompt untouched (default: 20)
#   UG_SIG_CLAUDE       claude binary (default: claude from PATH)
set -u

HERE=${0:a:h}
source "$HERE/interactive-lib.sh"

CAP="${UG_SIG_OUT:-$(mktemp -d)}"
DIR="${UG_SIG_CONFIG_DIR:-$(mktemp -d)}"
WORK="${UG_SIG_WORK:-$(mktemp -d)}"
RUNS="${UG_SIG_RUNS:-2}"
SETTLE="${UG_SIG_SETTLE:-20}"
CLAUDE_BIN="${UG_SIG_CLAUDE:-claude}"
mkdir -p "$CAP" "$DIR" "$WORK"
chmod 700 "$DIR"
umask 077

SESSIONS=()
CFGDIRS=()
cleanup() {
  for s in "${SESSIONS[@]:-}"; do
    [ -n "$s" ] && tmux kill-session -t "$s" 2>/dev/null
  done
  # Each entry is a per-run config dir this script created itself (a
  # subdirectory of $DIR), so removing the whole dir also drops the
  # session transcript Claude Code wrote into it; an operator-supplied
  # UG_SIG_CONFIG_DIR root is left in place.
  for d in "${CFGDIRS[@]:-}"; do
    [ -n "$d" ] && rm -rf "$d"
  done
  echo "cleanup: tmux sessions killed, per-run config dirs (credential copies included) removed"
}
trap cleanup EXIT INT TERM

"$CLAUDE_BIN" --version > "$CAP/version.txt" 2>&1

PROMPT="Run exactly this one bash command and nothing else: echo askprobe-executed . Then reply with the single word: done"

run_one() {
  local n=$1
  local name="iask$n"
  local rdir="$DIR/r$n"
  local rwork="$WORK/w$n"
  mkdir -p "$rdir" "$rwork"
  chmod 700 "$rdir"
  CFGDIRS+=("$rdir")

  if [ -f "$HOME/.claude/.credentials.json" ]; then
    cp "$HOME/.claude/.credentials.json" "$rdir/"
    chmod 600 "$rdir/.credentials.json"
    echo "creds: copied for $name"
  else
    echo "creds: no file (keychain-backed auth on this machine?)"
  fi

  ug_sig_preseed_config "$rdir"

  # PreToolUse on Bash: record the payload, then answer "ask" (byte-for-byte
  # the answer ask-probe.sh uses for the `-p` runs). PostToolUse,
  # PermissionRequest and PermissionDenied are plain recorders, so "did the
  # command run" and "did any permission event fire" are observable.
  cat > "$rdir/settings.json" <<EOF
{
  "theme": "dark",
  "hooks": {
    "PreToolUse":  [{"matcher":"Bash","hooks":[{"type":"command","command":"{ cat; echo; } >> $CAP/$name.PreToolUse.jsonl; printf '%s' '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"ask\",\"permissionDecisionReason\":\"askprobe: hook asked for operator confirmation\"}}'"}]}],
    "PostToolUse": [{"matcher":"Bash","hooks":[{"type":"command","command":"{ cat; echo; } >> $CAP/$name.PostToolUse.jsonl"}]}],
    "PermissionRequest": [{"hooks":[{"type":"command","command":"{ cat; echo; } >> $CAP/$name.PermissionRequest.jsonl"}]}],
    "PermissionDenied":  [{"hooks":[{"type":"command","command":"{ cat; echo; } >> $CAP/$name.PermissionDenied.jsonl"}]}],
    "Stop":              [{"hooks":[{"type":"command","command":"{ cat; echo; } >> $CAP/$name.Stop.jsonl"}]}]
  }
}
EOF

  local s="ugsig-iask-$$-$n"
  SESSIONS+=("$s")
  tmux kill-session -t "$s" 2>/dev/null
  tmux new-session -d -s "$s" -x 200 -y 50 \
    "cd $rwork && exec env -u CLAUDECODE CLAUDE_CONFIG_DIR=$rdir $CLAUDE_BIN --permission-mode bypassPermissions"

  echo "=== run $n: session $s ==="
  if ! ug_sig_drive_startup "$s" 90; then
    echo "run $n: startup failed"
    tmux kill-session -t "$s" 2>/dev/null
    return 1
  fi

  ug_sig_send_prompt "$s" "$PROMPT"

  # Watch for the first of: a permission dialog in the pane, PostToolUse
  # firing, or the turn ending at Stop.
  local prompted=0
  local deadline=$(( $(date +%s) + 90 ))
  local pane=""
  while [ "$(date +%s)" -lt "$deadline" ]; do
    pane=$(ug_sig_pane "$s")
    case "$pane" in
      *"Do you want to proceed"*|*"tell Claude what to do differently"*)
        prompted=1; break ;;
    esac
    [ -s "$CAP/$name.PostToolUse.jsonl" ] && break
    [ -s "$CAP/$name.Stop.jsonl" ] && break
    sleep 2
  done

  if [ "$prompted" = "1" ]; then
    echo "run $n: permission prompt shown; leaving it untouched for ${SETTLE}s"
    ug_sig_pane "$s" > "$CAP/$name.pane-at-prompt.txt"
    sleep "$SETTLE"
    ug_sig_pane "$s" > "$CAP/$name.pane-after-settle.txt"
    # Escape dismisses the prompt. This is a refusal, never an approval.
    tmux send-keys -t "$s" Escape
    sleep 5
  else
    # No prompt: give the turn a moment to finish so Stop lands.
    ug_sig_wait_file "$CAP/$name.Stop.jsonl" 60 >/dev/null || true
    sleep 3
  fi

  ug_sig_pane "$s" > "$CAP/$name.pane-final.txt"
  ug_sig_quit "$s"
  sleep 1

  echo "run $n: prompted=$prompted"
  echo "run $n: PreToolUse fired: $( [ -s "$CAP/$name.PreToolUse.jsonl" ] && echo YES || echo no )"
  echo "run $n: PostToolUse fired: $( [ -s "$CAP/$name.PostToolUse.jsonl" ] && echo YES || echo no )"
  echo "run $n: PermissionRequest fired: $( [ -s "$CAP/$name.PermissionRequest.jsonl" ] && echo YES || echo no )"
  echo "run $n: PermissionDenied fired: $( [ -s "$CAP/$name.PermissionDenied.jsonl" ] && echo YES || echo no )"
  echo "$prompted" > "$CAP/$name.prompted.txt"
}

n=1
while [ "$n" -le "$RUNS" ]; do
  run_one "$n" || echo "run $n: FAILED"
  n=$(( n + 1 ))
done

echo "=== summary ==="
python3 - "$CAP" "$RUNS" <<'PY'
import json, os, sys
cap, runs = sys.argv[1], int(sys.argv[2])
for n in range(1, runs + 1):
    name = f"iask{n}"
    def has(ev):
        p = os.path.join(cap, f"{name}.{ev}.jsonl")
        return os.path.exists(p) and os.path.getsize(p) > 0
    def first(ev):
        p = os.path.join(cap, f"{name}.{ev}.jsonl")
        if not os.path.exists(p):
            return None
        for line in open(p):
            if line.strip():
                return json.loads(line)
        return None
    pp = os.path.join(cap, f"{name}.prompted.txt")
    prompted = open(pp).read().strip() == "1" if os.path.exists(pp) else None
    pre = first("PreToolUse")
    stop = first("Stop")
    if prompted:
        verdict = "prompted"
    elif has("PostToolUse"):
        verdict = "allowed"
    elif has("PreToolUse") and stop is not None:
        verdict = "denied"
    else:
        verdict = "inconclusive"
    print(f"--- {name}")
    print("  PreToolUse permission_mode:", pre and pre.get("permission_mode"))
    print("  prompt shown              :", prompted)
    print("  PostToolUse fired         :", has("PostToolUse"))
    print("  PermissionRequest fired   :", has("PermissionRequest"))
    print("  PermissionDenied fired    :", has("PermissionDenied"))
    print("  Stop last_assistant_message:", (stop or {}).get("last_assistant_message"))
    print("  CLASSIFICATION            :", verdict)
PY
echo "=== done, output in $CAP ==="
