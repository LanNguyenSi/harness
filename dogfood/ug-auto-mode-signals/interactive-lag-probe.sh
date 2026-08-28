#!/bin/zsh
# M4: lag-distribution probe behind README section (q): the same
# 25 ms / 5 s PreToolUse detector as lag-probe.sh (section (o)), run inside
# an INTERACTIVE (non `-p`) Claude Code session under
# `--permission-mode bypassPermissions`, driven inside a detached tmux
# session exactly like interactive-capture.sh. Answers whether the
# transcript-visibility lag measured under `-p` also holds interactively,
# where the child is not `claude -p`'s own process tree and the transcript
# write path could plausibly differ.
#
# Env vars (all optional):
#   UG_SIG_OUT          output dir (default: mktemp -d)
#   UG_SIG_CONFIG_DIR   parent of the per-run isolated CLAUDE_CONFIG_DIRs
#                       (default: mktemp -d)
#   UG_SIG_WORK         parent of the per-run scratch cwds (default: mktemp -d)
#   UG_SIG_RUNS         number of fresh sessions to capture (default: 3)
#   UG_SIG_CLAUDE       claude binary (default: claude from PATH)
#   PROBE_POLL_S / PROBE_MAX_S   poll interval / max wait in the hook (defaults 0.025 / 5.0)
set -u

HERE=${0:a:h}
source "$HERE/interactive-lib.sh"

CAP="${UG_SIG_OUT:-$(mktemp -d)}"
DIR="${UG_SIG_CONFIG_DIR:-$(mktemp -d)}"
WORK="${UG_SIG_WORK:-$(mktemp -d)}"
RUNS="${UG_SIG_RUNS:-3}"
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
  for d in "${CFGDIRS[@]:-}"; do
    [ -n "$d" ] && rm -rf "$d"
  done
  echo "cleanup: tmux sessions killed, per-run config dirs (credential copies included) removed"
}
trap cleanup EXIT INT TERM

"$CLAUDE_BIN" --version > "$CAP/version.txt" 2>&1
cat "$CAP/version.txt"

PROMPT='Before any tool call, write a section whose first line is the markdown heading "# Understanding Report". Inside it write one line "Interpretation: probe run" and one line "Token: " followed by the word understanding spelled backwards (letters reversed), lowercase, no spaces. Then run exactly one bash command: echo probe . Then reply with the single word: done'

run_one() {
  local n=$1
  local name="ilag$n"
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
  cp "$HERE/lag-probe.py" "$rdir/lagprobe.py"

  cat > "$rdir/settings.json" <<EOF
{
  "theme": "dark",
  "hooks": {
    "PreToolUse": [{"matcher":"","hooks":[{"type":"command","command":"PROBE_OUT=$CAP/interactive-lag-probe.jsonl PROBE_POLL_S=${PROBE_POLL_S:-0.025} PROBE_MAX_S=${PROBE_MAX_S:-5.0} PROBE_TRANSCRIPT_COPY=$CAP/$name.transcript.jsonl python3 $rdir/lagprobe.py"}]}],
    "Stop":       [{"hooks":[{"type":"command","command":"{ cat; echo; } >> $CAP/$name.Stop.jsonl"}]}]
  }
}
EOF

  local s="ugsig-ilag-$$-$n"
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
echo "=== $CAP/interactive-lag-probe.jsonl ==="
cat "$CAP/interactive-lag-probe.jsonl" 2>/dev/null || echo "(no output file; every run failed to reach a PreToolUse call)"
echo "=== done, output in $CAP ==="
