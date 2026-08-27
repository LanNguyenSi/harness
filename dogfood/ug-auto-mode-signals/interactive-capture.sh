#!/bin/zsh
# M1: hook-payload capture from an INTERACTIVE (non `-p`) Claude Code
# session under `--permission-mode bypassPermissions`, driven inside a
# detached tmux session. Produces README results section (h) and the
# payloads/interactive-bypass.* fixtures.
#
# What it answers that the `-p` captures (capture.sh) could not:
#   - the `permission_mode` value a PreToolUse payload carries interactively
#   - whether the hook env's CLAUDE_CODE_SESSION_ID equals the payload's
#     `session_id` in an interactive session
#   - CLAUDE_CODE_ENTRYPOINT's value interactively
#
# Env vars (all optional):
#   UG_SIG_OUT          output dir (default: mktemp -d)
#   UG_SIG_CONFIG_DIR   parent of the per-run isolated CLAUDE_CONFIG_DIRs
#                       (default: mktemp -d)
#   UG_SIG_WORK         parent of the per-run scratch cwds (default: mktemp -d)
#   UG_SIG_RUNS         number of fresh sessions to capture (default: 2)
#   UG_SIG_CLAUDE       claude binary (default: claude from PATH)
set -u

HERE=${0:a:h}
source "$HERE/interactive-lib.sh"

CAP="${UG_SIG_OUT:-$(mktemp -d)}"
DIR="${UG_SIG_CONFIG_DIR:-$(mktemp -d)}"
WORK="${UG_SIG_WORK:-$(mktemp -d)}"
RUNS="${UG_SIG_RUNS:-2}"
CLAUDE_BIN="${UG_SIG_CLAUDE:-claude}"
mkdir -p "$CAP" "$DIR" "$WORK"
# The per-run config dirs receive a copy of real credentials below: keep
# the tree private regardless of how UG_SIG_CONFIG_DIR was supplied.
chmod 700 "$DIR"
umask 077

SESSIONS=()
CFGDIRS=()
cleanup() {
  for s in "${SESSIONS[@]:-}"; do
    [ -n "$s" ] && tmux kill-session -t "$s" 2>/dev/null
  done
  for d in "${CFGDIRS[@]:-}"; do
    [ -n "$d" ] && rm -f "$d/.credentials.json"
  done
  echo "cleanup: tmux sessions killed, credential copies removed"
}
trap cleanup EXIT INT TERM

"$CLAUDE_BIN" --version > "$CAP/version.txt" 2>&1
cat "$CAP/version.txt"

PROMPT="Run exactly this one bash command and nothing else: echo interactive-probe . Then reply with the single word: done"

run_one() {
  local n=$1
  local name="int$n"
  local rdir="$DIR/r$n"
  local rwork="$WORK/w$n"
  mkdir -p "$rdir" "$rwork"
  chmod 700 "$rdir"
  CFGDIRS+=("$rdir")

  # macOS-only, optional: copy real credentials into the isolated config dir
  # so the session can authenticate without touching the operator's default
  # CLAUDE_CONFIG_DIR. Removed by the trap above either way.
  if [ -f "$HOME/.claude/.credentials.json" ]; then
    cp "$HOME/.claude/.credentials.json" "$rdir/"
    chmod 600 "$rdir/.credentials.json"
    echo "creds: copied for $name"
  else
    echo "creds: no file (keychain-backed auth on this machine?)"
  fi

  ug_sig_preseed_config "$rdir"

  # Recorders on every event this probe can reach, plus a second PreToolUse
  # hook that dumps the hook process's own CLAUDE*/AI_AGENT environment next
  # to the payload for the same tool call.
  cat > "$rdir/settings.json" <<EOF
{
  "theme": "dark",
  "hooks": {
    "SessionStart":     [{"hooks":[{"type":"command","command":"{ cat; echo; } >> $CAP/$name.SessionStart.jsonl"}]}],
    "UserPromptSubmit": [{"hooks":[{"type":"command","command":"{ cat; echo; } >> $CAP/$name.UserPromptSubmit.jsonl"}]}],
    "PreToolUse":       [{"matcher":"","hooks":[
                          {"type":"command","command":"{ cat; echo; } >> $CAP/$name.PreToolUse.jsonl"},
                          {"type":"command","command":"{ env | grep -E '^(CLAUDE|AI_AGENT)' | sed -E 's/(TOKEN|BRIDGE_SESSION_ID)=.*/\\\\1=<redacted>/' | sort; echo; } >> $CAP/$name.hook-env.txt"}]}],
    "PostToolUse":      [{"matcher":"","hooks":[{"type":"command","command":"{ cat; echo; } >> $CAP/$name.PostToolUse.jsonl"}]}],
    "Stop":             [{"hooks":[{"type":"command","command":"{ cat; echo; } >> $CAP/$name.Stop.jsonl"}]}],
    "SessionEnd":       [{"hooks":[{"type":"command","command":"{ cat; echo; } >> $CAP/$name.SessionEnd.jsonl"}]}],
    "SubagentStart":    [{"hooks":[{"type":"command","command":"{ cat; echo; } >> $CAP/$name.SubagentStart.jsonl"}]}],
    "SubagentStop":     [{"hooks":[{"type":"command","command":"{ cat; echo; } >> $CAP/$name.SubagentStop.jsonl"}]}]
  }
}
EOF

  local s="ugsig-int-$$-$n"
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
  echo "run $n: composer ready"

  ug_sig_send_prompt "$s" "$PROMPT"
  if ug_sig_wait_file "$CAP/$name.Stop.jsonl" 120; then
    echo "run $n: Stop hook fired"
  else
    echo "run $n: TIMEOUT waiting for Stop"
  fi
  ug_sig_pane "$s" > "$CAP/$name.pane.txt"
  ug_sig_quit "$s"
  sleep 1
  echo "run $n: files:"; ls "$CAP" | grep "^$name\." || true
}

n=1
while [ "$n" -le "$RUNS" ]; do
  run_one "$n" || echo "run $n: FAILED"
  n=$(( n + 1 ))
done

echo "=== summary ==="
python3 - "$CAP" "$RUNS" <<'PY'
import json, os, re, sys
cap, runs = sys.argv[1], int(sys.argv[2])
for n in range(1, runs + 1):
    name = f"int{n}"
    def first(ev):
        p = os.path.join(cap, f"{name}.{ev}.jsonl")
        if not os.path.exists(p):
            return None
        for line in open(p):
            line = line.strip()
            if line:
                return json.loads(line)
        return None
    pre = first("PreToolUse")
    env_path = os.path.join(cap, f"{name}.hook-env.txt")
    env = {}
    if os.path.exists(env_path):
        for line in open(env_path):
            if "=" in line:
                k, v = line.rstrip("\n").split("=", 1)
                env.setdefault(k, v)
    print(f"--- {name}")
    print("  PreToolUse permission_mode:", pre and pre.get("permission_mode"))
    print("  payload session_id        :", pre and pre.get("session_id"))
    print("  hook CLAUDE_CODE_SESSION_ID:", env.get("CLAUDE_CODE_SESSION_ID"))
    print("  agree                     :", bool(pre) and pre.get("session_id") == env.get("CLAUDE_CODE_SESSION_ID"))
    print("  CLAUDE_CODE_ENTRYPOINT    :", env.get("CLAUDE_CODE_ENTRYPOINT"))
    print("  AI_AGENT                  :", env.get("AI_AGENT"))
    for ev in ("SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd", "SubagentStart", "SubagentStop"):
        d = first(ev)
        print(f"  {ev:17s}", "fields=" + ",".join(sorted(d)) if d else "(no payload)")
PY
echo "=== done, output in $CAP ==="
