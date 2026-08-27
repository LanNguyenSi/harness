#!/bin/zsh
# M3: does a subagent (the Agent tool) share its parent's session id, and do
# SubagentStart / SubagentStop fire? Runs a `claude -p` parent under
# `--permission-mode bypassPermissions` whose only job is to delegate one
# bash command to a general-purpose subagent. Produces README results
# section (j) and the payloads/subagent-bypass.* fixtures.
#
# Env vars (all optional):
#   UG_SIG_OUT          output dir (default: mktemp -d)
#   UG_SIG_CONFIG_DIR   isolated CLAUDE_CONFIG_DIR (default: mktemp -d)
#   UG_SIG_WORK         cwd the `claude -p` runs are launched from (default: mktemp -d)
#   UG_SIG_RUNS         number of runs (default: 2)
#   UG_SIG_CLAUDE       claude binary (default: claude from PATH)
set -u

CAP="${UG_SIG_OUT:-$(mktemp -d)}"
DIR="${UG_SIG_CONFIG_DIR:-$(mktemp -d)}"
WORK="${UG_SIG_WORK:-$(mktemp -d)}"
RUNS="${UG_SIG_RUNS:-2}"
CLAUDE_BIN="${UG_SIG_CLAUDE:-claude}"
mkdir -p "$CAP" "$DIR" "$WORK"
# The isolated config dir may receive a copy of real credentials below:
# make it private regardless of how UG_SIG_CONFIG_DIR was supplied.
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
trap cleanup EXIT INT TERM
if [ -f "$HOME/.claude/.credentials.json" ]; then
  cp "$HOME/.claude/.credentials.json" "$DIR/"
  chmod 600 "$DIR/.credentials.json"
  COPIED_CREDS=1
  echo "creds: copied"
else
  echo "creds: no file (keychain-backed auth on this machine?)"
fi

"$CLAUDE_BIN" --version > "$CAP/version.txt" 2>&1

gen_settings() {
  local name=$1
  cat > "$DIR/settings.json" <<EOF
{
  "hooks": {
    "UserPromptSubmit": [{"hooks":[{"type":"command","command":"{ cat; echo; } >> $CAP/$name.UserPromptSubmit.jsonl"}]}],
    "SubagentStart": [{"hooks":[{"type":"command","command":"{ cat; echo; } >> $CAP/$name.SubagentStart.jsonl"}]}],
    "SubagentStop":  [{"hooks":[{"type":"command","command":"{ cat; echo; } >> $CAP/$name.SubagentStop.jsonl"}]}],
    "PreToolUse":    [{"matcher":"","hooks":[{"type":"command","command":"{ cat; echo; } >> $CAP/$name.PreToolUse.jsonl"}]}],
    "PostToolUse":   [{"matcher":"","hooks":[{"type":"command","command":"{ cat; echo; } >> $CAP/$name.PostToolUse.jsonl"}]}],
    "Stop":          [{"hooks":[{"type":"command","command":"{ cat; echo; } >> $CAP/$name.Stop.jsonl"}]}]
  }
}
EOF
}

PROMPT="Use the Agent tool (subagent_type general-purpose) to run exactly one bash command: echo subagent-probe . Do not run bash yourself. Then reply with the single word: done"

run_one() {
  local n=$1
  local name="sub$n"
  gen_settings "$name"
  rm -f "$CAP/$name".*.jsonl 2>/dev/null || true
  echo "=== run $n ==="
  ( cd "$WORK" && env -u CLAUDECODE CLAUDE_CONFIG_DIR="$DIR" "$CLAUDE_BIN" -p "$PROMPT" \
      --max-turns 6 --output-format json --permission-mode bypassPermissions \
      > "$CAP/$name.stdout.json" 2> "$CAP/$name.stderr.txt" )
  echo "exit=$?"
  ls "$CAP" | grep "^$name\." || true
}

n=1
while [ "$n" -le "$RUNS" ]; do
  run_one "$n"
  n=$(( n + 1 ))
done

echo "=== summary ==="
python3 - "$CAP" "$RUNS" <<'PY'
import json, os, sys
cap, runs = sys.argv[1], int(sys.argv[2])
for n in range(1, runs + 1):
    name = f"sub{n}"
    def rows(ev):
        p = os.path.join(cap, f"{name}.{ev}.jsonl")
        if not os.path.exists(p):
            return []
        return [json.loads(l) for l in open(p) if l.strip()]
    ups = rows("UserPromptSubmit")
    parent_sid = ups[0]["session_id"] if ups else None
    print(f"--- {name}  parent session_id={parent_sid}")
    for ev in ("SubagentStart", "SubagentStop"):
        rs = rows(ev)
        print(f"  {ev}: {len(rs)} payload(s)")
        for r in rs:
            print("    fields:", ",".join(sorted(r)))
            print("    session_id == parent:", r.get("session_id") == parent_sid)
    for r in rows("PreToolUse"):
        print(f"  PreToolUse tool={r.get('tool_name')} session_id_matches_parent={r.get('session_id') == parent_sid}")
        extra = sorted(set(r) - {"session_id","transcript_path","cwd","prompt_id","permission_mode",
                                 "effort","hook_event_name","tool_name","tool_input","tool_use_id"})
        if extra:
            print("    extra fields:", ",".join(extra))
        if r.get("tool_name") == "Bash":
            print("    transcript_path:", os.path.basename(r.get("transcript_path", "")))
PY
echo "=== done, output in $CAP ==="
