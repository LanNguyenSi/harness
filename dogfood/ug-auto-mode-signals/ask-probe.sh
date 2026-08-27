#!/bin/zsh
# Measures how `claude -p` resolves a PreToolUse hook answer of
# permissionDecision "ask" in four permission modes. Faithful port of the
# scratch script behind README section (f) and the checked-in
# payloads/ask-probe-<mode>.{PreToolUse,result}.json fixtures.
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

# macOS-only, optional: copy real credentials into the isolated config dir.
# Deleted on exit via the trap below either way.
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

# PreToolUse on Bash: record the payload, then answer "ask". PostToolUse,
# PermissionRequest and PermissionDenied are plain recorders so the outcome
# (did the command run? did any permission event fire?) is observable.
gen() {
  local name=$1
  cat > "$DIR/settings.json" <<EOF
{ "hooks": {
  "PreToolUse":  [{"matcher":"Bash","hooks":[{"type":"command","command":"{ cat; echo; } >> $CAP/$name.PreToolUse.jsonl; printf '%s' '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"ask\",\"permissionDecisionReason\":\"askprobe: hook asked for operator confirmation\"}}'"}]}],
  "PostToolUse": [{"matcher":"Bash","hooks":[{"type":"command","command":"{ cat; echo; } >> $CAP/$name.PostToolUse.jsonl"}]}],
  "PermissionRequest": [{"hooks":[{"type":"command","command":"{ cat; echo; } >> $CAP/$name.PermissionRequest.jsonl"}]}],
  "PermissionDenied": [{"hooks":[{"type":"command","command":"{ cat; echo; } >> $CAP/$name.PermissionDenied.jsonl"}]}]
} }
EOF
}

PROMPT="Run exactly this one bash command and nothing else: echo askprobe-executed . Then reply with the single word: done"

run() {
  local name=$1; shift
  gen "$name"
  rm -f "$CAP/$name".*.jsonl 2>/dev/null || true
  echo "=== run $name: $* ==="
  # stdin is deliberately left attached, as in the original capture; Claude
  # Code then prints a harmless "no stdin data received in 3s" warning.
  ( cd "$WORK" && env -u CLAUDECODE CLAUDE_CONFIG_DIR="$DIR" claude -p "$PROMPT" --max-turns 3 --output-format json "$@" > "$CAP/$name.stdout.json" 2> "$CAP/$name.stderr.txt" )
  echo "exit=$?"
  python3 -c "import json; d=json.load(open('$CAP/$name.stdout.json')); print({k:d.get(k) for k in ('subtype','is_error','num_turns','permission_denials')})"
  echo "PostToolUse fired: $( [ -s "$CAP/$name.PostToolUse.jsonl" ] && echo YES || echo no )"
  for e in PermissionRequest PermissionDenied; do
    [ -s "$CAP/$name.$e.jsonl" ] && { echo "$e payload:"; head -c 800 "$CAP/$name.$e.jsonl"; echo; }
  done
}

run ask-default --allowedTools Bash
run ask-acceptedits --permission-mode acceptEdits --allowedTools Bash
run ask-bypass --permission-mode bypassPermissions
run ask-dangerously --dangerously-skip-permissions
echo "=== done: outputs in $CAP ==="
