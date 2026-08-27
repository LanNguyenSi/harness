#!/bin/zsh
# Reproduces payloads/hook-env-probe.txt: dumps the hook process's own
# environment plus its parent process chain, from inside a PreToolUse hook,
# alongside the raw hook payload for the same tool call.
#
# Env vars (all optional):
#   UG_SIG_OUT          output dir (default: mktemp -d)
#   UG_SIG_CONFIG_DIR    isolated CLAUDE_CONFIG_DIR (default: mktemp -d)
#   UG_SIG_WORK          cwd the `claude -p` run is launched from (default: mktemp -d)
set -u

CAP="${UG_SIG_OUT:-$(mktemp -d)}"
DIR="${UG_SIG_CONFIG_DIR:-$(mktemp -d)}"
WORK="${UG_SIG_WORK:-$(mktemp -d)}"
mkdir -p "$CAP" "$DIR" "$WORK"
# The isolated config dir may receive a copy of real credentials below:
# make it private regardless of how UG_SIG_CONFIG_DIR was supplied, and
# keep the copy itself private from the moment it is created.
chmod 700 "$DIR"
umask 077

# macOS-only, optional credential copy; see capture.sh for the same pattern.
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
fi

cat > "$DIR/settings.json" <<EOF
{ "hooks": {
  "PreToolUse": [{"matcher":"","hooks":[{"type":"command","command":"{ echo '--- HOOK ENV ---'; env | grep -E '^(CLAUDE|AI_AGENT|SHLVL|PPID|_=)' | sort | sed -E 's/(TOKEN)=.*/\\\\1=<redacted>/'; echo '--- PARENT ---'; ps -o pid=,ppid=,comm= -p \$PPID; ps -o pid=,ppid=,comm= -p \$\$; echo '--- PAYLOAD ---'; cat; echo; } >> $CAP/envprobe.PreToolUse.txt"}]}]
} }
EOF

( cd "$WORK" && env -u CLAUDECODE CLAUDE_CONFIG_DIR="$DIR" claude -p "Run exactly this one bash command and nothing else: echo probe . Then reply with the single word: done" --max-turns 3 --output-format json --permission-mode bypassPermissions > "$CAP/envprobe.stdout.json" 2> "$CAP/envprobe.stderr.txt" )
echo "exit=$?"; cat "$CAP/envprobe.PreToolUse.txt"
