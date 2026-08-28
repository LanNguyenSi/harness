#!/bin/zsh
# Lag-distribution probe behind README section (o): how long after the
# PreToolUse hook fires does the assistant's mid-turn Understanding Report
# become visible in the transcript JSONL, sampled at a finer grain (25 ms
# poll, 5 s bound) than the section (e) probe (100 ms / 3 s) to build a
# distribution (p50, max) instead of confirming a single sample. Ten
# positive runs plus two negative controls, all under
# --permission-mode bypassPermissions. Detector: lag-probe.py (role-aware,
# token-based, same detector as transcript-probe.py, plus isSidechain /
# sessionId of the winning entry).
#
# Env vars (all optional):
#   UG_SIG_OUT          output dir (default: mktemp -d); result: $UG_SIG_OUT/lag-probe.jsonl
#   UG_SIG_CONFIG_DIR    isolated CLAUDE_CONFIG_DIR (default: mktemp -d)
#   UG_SIG_WORK          cwd the `claude -p` runs are launched from (default: mktemp -d)
#   PROBE_POLL_S / PROBE_MAX_S   poll interval / max wait in the hook (defaults 0.025 / 5.0)
set -u

HERE="${0:A:h}"
CAP="${UG_SIG_OUT:-$(mktemp -d)}"
DIR="${UG_SIG_CONFIG_DIR:-$(mktemp -d)}"
WORK="${UG_SIG_WORK:-$(mktemp -d)}"
mkdir -p "$CAP" "$DIR" "$WORK"
# The isolated config dir may receive a copy of real credentials below:
# make it private regardless of how UG_SIG_CONFIG_DIR was supplied, and
# keep the copy itself private from the moment it is created.
chmod 700 "$DIR"
umask 077

COPIED_CREDS=0
cleanup() {
  if [ "$COPIED_CREDS" = "1" ]; then
    rm -f "$DIR/.credentials.json"
    echo "cleanup: creds removed"
  fi
}
trap cleanup EXIT
if [ -f "$HOME/.claude/.credentials.json" ]; then
  cp "$HOME/.claude/.credentials.json" "$DIR/"
  chmod 600 "$DIR/.credentials.json"
  COPIED_CREDS=1
  echo "creds: copied"
else
  echo "creds: no file (keychain?)"
fi

cp "$HERE/lag-probe.py" "$DIR/lagprobe.py"
cat > "$DIR/settings.json" <<EOF
{ "hooks": {
  "PreToolUse": [{"matcher":"","hooks":[{"type":"command","command":"PROBE_OUT=$CAP/lag-probe.jsonl PROBE_POLL_S=${PROBE_POLL_S:-0.025} PROBE_MAX_S=${PROBE_MAX_S:-5.0} python3 $DIR/lagprobe.py"}]}]
} }
EOF

POS='Before any tool call, write a section whose first line is the markdown heading "# Understanding Report". Inside it write one line "Interpretation: probe run" and one line "Token: " followed by the word understanding spelled backwards (letters reversed), lowercase, no spaces. Then run exactly one bash command: echo probe . Then reply with the single word: done'
NEG='Run exactly one bash command: echo probe . Do not write any report or heading first. Then reply with the single word: done'

rm -f "$CAP/lag-probe.jsonl"
for i in 1 2 3 4 5 6 7 8 9 10; do
  ( cd "$WORK" && env -u CLAUDECODE CLAUDE_CONFIG_DIR="$DIR" claude -p "$POS" --max-turns 4 --output-format json --permission-mode bypassPermissions > "$CAP/lag-probe.pos$i.stdout.json" 2> "$CAP/lag-probe.pos$i.stderr.txt" < /dev/null )
  echo "pos $i exit=$?"
done
for i in 1 2; do
  ( cd "$WORK" && env -u CLAUDECODE CLAUDE_CONFIG_DIR="$DIR" claude -p "$NEG" --max-turns 4 --output-format json --permission-mode bypassPermissions > "$CAP/lag-probe.neg$i.stdout.json" 2> "$CAP/lag-probe.neg$i.stderr.txt" < /dev/null )
  echo "neg $i exit=$?"
done
echo "=== $CAP/lag-probe.jsonl ==="
cat "$CAP/lag-probe.jsonl"
