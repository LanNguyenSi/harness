#!/bin/zsh
# Block-and-retry probe behind README section (g): does a `claude -p` child
# retry a gated Bash call after a PreToolUse deny that tells it to (re-)emit
# its Understanding Report and retry? Three runs where the prompt asks for
# the report before the first tool call, three where it does not. All under
# --permission-mode bypassPermissions. Detector and deny text: retry-probe.py.
#
# Env vars (all optional):
#   UG_SIG_OUT          output dir (default: mktemp -d); result: $UG_SIG_OUT/retry-probe.jsonl
#   UG_SIG_CONFIG_DIR    isolated CLAUDE_CONFIG_DIR (default: mktemp -d)
#   UG_SIG_WORK          cwd the `claude -p` runs are launched from (default: mktemp -d)
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

cp "$HERE/retry-probe.py" "$DIR/retry.py"
cat > "$DIR/settings.json" <<EOF
{ "hooks": {
  "PreToolUse":  [{"matcher":"Bash","hooks":[{"type":"command","command":"PROBE_OUT=$CAP/retry-probe.jsonl python3 $DIR/retry.py"}]}],
  "PostToolUse": [{"matcher":"Bash","hooks":[{"type":"command","command":"PROBE_OUT=$CAP/retry-probe.jsonl python3 $DIR/retry.py"}]}]
} }
EOF

POS='Before any tool call, write a section whose first line is the markdown heading "# Understanding Report". Inside it write one line "Interpretation: probe run" and one line "Token: " followed by the word understanding spelled backwards (letters reversed), lowercase, no spaces. Then run exactly one bash command: echo probe . Then reply with the single word: done'
NEG='Run exactly one bash command: echo probe . Then reply with the single word: done'

rm -f "$CAP/retry-probe.jsonl"
summarize() {
  python3 -c "import json; d=json.load(open('$1')); print({k:d.get(k) for k in ('num_turns','result','permission_denials')})" | cut -c1-300
}
for i in 1 2 3; do
  ( cd "$WORK" && env -u CLAUDECODE CLAUDE_CONFIG_DIR="$DIR" claude -p "$POS" --max-turns 6 --output-format json --permission-mode bypassPermissions > "$CAP/retry-probe.pos$i.stdout.json" 2>/dev/null < /dev/null )
  echo "pos $i exit=$? $(summarize "$CAP/retry-probe.pos$i.stdout.json")"
done
for i in 1 2 3; do
  ( cd "$WORK" && env -u CLAUDECODE CLAUDE_CONFIG_DIR="$DIR" claude -p "$NEG" --max-turns 6 --output-format json --permission-mode bypassPermissions > "$CAP/retry-probe.neg$i.stdout.json" 2>/dev/null < /dev/null )
  echo "neg $i exit=$? $(summarize "$CAP/retry-probe.neg$i.stdout.json")"
done
echo "=== $CAP/retry-probe.jsonl ==="
cat "$CAP/retry-probe.jsonl"
