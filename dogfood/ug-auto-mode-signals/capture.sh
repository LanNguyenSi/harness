#!/bin/zsh
# Reproduces the four-mode `claude -p` hook-payload capture behind
# dogfood/ug-auto-mode-signals/README.md. Faithful port of the scratch
# script that produced the checked-in payloads/claude-p-<mode>.<Event>.json
# fixtures; parameterized so it can run from any machine without touching
# the operator's real Claude Code config.
#
# Env vars (all optional):
#   UG_SIG_OUT          output dir for captured jsonl/stdout (default: mktemp -d)
#   UG_SIG_CONFIG_DIR    isolated CLAUDE_CONFIG_DIR (default: mktemp -d)
#   UG_SIG_WORK          cwd the `claude -p` runs are launched from (default: mktemp -d)
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

# macOS-only, optional: copy real credentials into the isolated config dir
# so `claude -p` can authenticate without touching the operator's default
# CLAUDE_CONFIG_DIR. Deleted on exit via the trap below either way.
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
  echo "creds: no file (keychain-backed auth on this machine?)"
fi

claude --version > "$CAP/version.txt" 2>&1

gen_settings() {
  local name=$1
  cat > "$DIR/settings.json" <<EOF
{
  "hooks": {
    "SessionStart":     [{"hooks":[{"type":"command","command":"{ cat; echo; } >> $CAP/$name.SessionStart.jsonl"}]}],
    "UserPromptSubmit": [{"hooks":[{"type":"command","command":"{ cat; echo; } >> $CAP/$name.UserPromptSubmit.jsonl"}]}],
    "PreToolUse":       [{"matcher":"","hooks":[{"type":"command","command":"{ cat; echo; } >> $CAP/$name.PreToolUse.jsonl"}]}],
    "PostToolUse":      [{"matcher":"","hooks":[{"type":"command","command":"{ cat; echo; } >> $CAP/$name.PostToolUse.jsonl"}]}],
    "Stop":             [{"hooks":[{"type":"command","command":"{ cat; echo; } >> $CAP/$name.Stop.jsonl"}]}],
    "SessionEnd":       [{"hooks":[{"type":"command","command":"{ cat; echo; } >> $CAP/$name.SessionEnd.jsonl"}]}]
  }
}
EOF
}

PROMPT="Run exactly this one bash command and nothing else: env | grep -i -E 'claude|permission' | sort . Then reply with the single word: done"

run() {
  local name=$1; shift
  gen_settings "$name"
  echo "=== run $name: $* ==="
  ( cd "$WORK" && env -u CLAUDECODE CLAUDE_CONFIG_DIR="$DIR" claude -p "$PROMPT" --max-turns 4 --output-format json "$@" > "$CAP/$name.stdout.json" 2> "$CAP/$name.stderr.txt" )
  echo "exit=$? ; files:"; ls "$CAP" | grep "^$name\."
}

run default --allowedTools Bash
run bypass --permission-mode bypassPermissions
run dangerously --dangerously-skip-permissions
run acceptedits --permission-mode acceptEdits --allowedTools Bash

echo "=== done, output in $CAP ==="
