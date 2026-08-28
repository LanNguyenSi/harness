#!/bin/zsh
# Retry-distribution probe behind README section (p): does the attempt
# distribution and success rate of block-and-retry differ between a deny
# text that asks for a single retry (the section (g) text) and one that
# asks for repeated retries? Same detector and same "report first" /
# "no report first" shapes as retry-probe.sh, but the "no report first"
# case (the one that hit the transcript lag in section (g)) is run n=10
# per text instead of n=3, since that is the case the two texts are
# expected to separate on; "report first" stays at n=3 per text (already
# established not to lag). All under --permission-mode bypassPermissions,
# --max-turns 6. Detector and deny texts: retry-probe.py, selected via
# PROBE_DENY_KIND ("single" | "repeated"); see that file for the exact
# sentences, reproduced verbatim in README section (p).
#
# Env vars (all optional):
#   UG_SIG_OUT          output dir (default: mktemp -d); result: $UG_SIG_OUT/retry-probe-v2.jsonl
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

POS='Before any tool call, write a section whose first line is the markdown heading "# Understanding Report". Inside it write one line "Interpretation: probe run" and one line "Token: " followed by the word understanding spelled backwards (letters reversed), lowercase, no spaces. Then run exactly one bash command: echo probe . Then reply with the single word: done'
NEG='Run exactly one bash command: echo probe . Then reply with the single word: done'

summarize() {
  python3 -c "import json; d=json.load(open('$1')); print({k:d.get(k) for k in ('num_turns','result','permission_denials')})" | cut -c1-300
}

rm -f "$CAP/retry-probe-v2.jsonl"
for kind in single repeated; do
  cat > "$DIR/settings.json" <<EOF
{ "hooks": {
  "PreToolUse":  [{"matcher":"Bash","hooks":[{"type":"command","command":"PROBE_OUT=$CAP/retry-probe-v2.jsonl PROBE_DENY_KIND=$kind python3 $DIR/retry.py"}]}],
  "PostToolUse": [{"matcher":"Bash","hooks":[{"type":"command","command":"PROBE_OUT=$CAP/retry-probe-v2.jsonl PROBE_DENY_KIND=$kind python3 $DIR/retry.py"}]}]
} }
EOF

  for i in 1 2 3; do
    ( cd "$WORK" && env -u CLAUDECODE CLAUDE_CONFIG_DIR="$DIR" claude -p "$POS" --max-turns 6 --output-format json --permission-mode bypassPermissions > "$CAP/retry-probe-v2-$kind-pos$i.stdout.json" 2>/dev/null < /dev/null )
    echo "$kind pos $i exit=$? $(summarize "$CAP/retry-probe-v2-$kind-pos$i.stdout.json")"
  done
  for i in 1 2 3 4 5 6 7 8 9 10; do
    ( cd "$WORK" && env -u CLAUDECODE CLAUDE_CONFIG_DIR="$DIR" claude -p "$NEG" --max-turns 6 --output-format json --permission-mode bypassPermissions > "$CAP/retry-probe-v2-$kind-neg$i.stdout.json" 2>/dev/null < /dev/null )
    echo "$kind neg $i exit=$? $(summarize "$CAP/retry-probe-v2-$kind-neg$i.stdout.json")"
  done
done
echo "=== $CAP/retry-probe-v2.jsonl ==="
cat "$CAP/retry-probe-v2.jsonl"
