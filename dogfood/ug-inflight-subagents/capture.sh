#!/bin/zsh
# T-005 dogfood: does a real `claude -p` parent plus one Agent-tool
# subagent actually pass Bash/Edit through the understanding gate after
# approval (Variant A), and does a lifecycle boundary that fires while
# the subagent is running block the PARENT's next write without
# touching the subagent's in-flight calls (Variant B)?
#
# Wired against the REAL production hook chain, not a recorder: the
# BUILT harness CLI of this worktree (`dist/cli/main.js`), reached
# through a PATH shim (`harness pack hook ...` is what `harness apply`
# actually renders into settings.json; the shim resolves that bare name
# to this worktree's dist so the capture exercises the code under
# review, not whatever the operator's real ~/.harness install points
# at). Everything lives under a fresh HARNESS_HOME and fresh scratch
# directories; the operator's ~/.harness, ~/.claude/settings.json and
# paused real install are never read or written by this script. Two
# touches on the operator's real ~/.claude remain, both Claude Code's
# own and outside --setting-sources: the ambient auth file it reads
# for login, and the session transcript every `claude -p` run writes
# under ~/.claude/projects/<cwd-slug>/ (one directory per scratch cwd;
# the script prints their paths at the end and never deletes them).
#
# Isolation mechanics (see README "Method" for the write-up):
#   1. PATH shim: a fresh dir holding an executable `harness` that
#      execs `node <this-worktree>/dist/cli/main.js "$@"`, prepended to
#      PATH for every harness invocation in this script AND for the
#      `claude -p` child (hook commands inherit the parent's env/PATH).
#   2. HARNESS_HOME=<fresh mktemp -d> for the manifest, the generated
#      dir, the approval marker and the in-flight records; exported for
#      apply, approve, the hooks, and the synthetic boundary call below.
#   3. `harness apply --target <file> --force` renders settings.json
#      into a throwaway file instead of any real settings location.
#   4. `claude -p --setting-sources project` (with a fresh, empty
#      scratch cwd) so the operator's user-level ~/.claude/settings.json
#      hook wiring never loads alongside our --settings file; no
#      CLAUDE_CONFIG_DIR override is used (unlike the interactive
#      dogfood scripts in ../ug-auto-mode-signals/), since
#      --setting-sources is a documented, more surgical way to keep the
#      operator's global hooks out of the run (`claude --help`, "-p,
#      --print"; confirmed empirically below).
#   5. The shim additionally tees every `harness pack hook <verb>`
#      invocation's stderr into $HARNESS_HOME/hook-stderr.log, one line
#      per stderr line, prefixed with a UTC timestamp and the verb, so
#      the allow/deny diagnostics are captured on disk even though this
#      Claude Code version's stream-json actually DOES carry a hook
#      call's stderr on its own `hook_response` system event (see
#      README "Method" for that finding) -- belt and suspenders.
#
# Variant B mechanics: the subagent is asked to `sleep 8` before its own
# Bash/Edit calls. The script launches `claude -p` in the BACKGROUND,
# polls for the in-flight record file under
# $HARNESS_HOME/harness.generated/.inflight/<sid>/ to appear (written by
# the SubagentStart hook as soon as the Agent tool call starts, well
# before the sleep elapses), and the moment it appears, feeds a
# synthetic PostToolUse `echo BOUNDARY` payload to
# `harness pack hook post-tool-use` (same shim, same HARNESS_HOME) so
# the session marker is cleared while the subagent is still asleep.
#
# One deliberate deviation from the task's literal Variant B prompt,
# recorded here and in the README: the parent's post-boundary probe
# command is `touch after.txt`, NOT `echo after`. `echo` is a member of
# `SIMPLE_READ_ONLY_BINS` (src/runtime/read-only-bash.ts) and the
# PreToolUse blocker allows any read-only Bash command unconditionally,
# regardless of marker state (the read-only-bash exemption is checked
# AFTER the marker/in-flight checks have already missed). A literal
# `echo after` would therefore be ALLOWED even with the marker cleared,
# which cannot demonstrate the "parent's post-boundary Bash denied"
# criterion this variant exists to show. `touch after.txt` is not
# read-only, so it actually exercises the deny path.
#
# Env vars (all optional):
#   UG_INFLIGHT_OUT     output/payload capture dir (default: mktemp -d)
#   UG_INFLIGHT_CLI     path to the built CLI entrypoint (default:
#                       <this-worktree>/dist/cli/main.js; the script
#                       refuses to run without a real build there)
#   UG_INFLIGHT_CLAUDE  claude binary (default: claude from PATH)
#   UG_INFLIGHT_BOUNDARY_WAIT  seconds to poll for the in-flight record
#                       before giving up on Variant B (default: 30)
#
# Costs 2 `claude -p` API calls (Variant A, Variant B), each spawning
# one Agent-tool subagent. Do not raise this script's own run count.
set -u

HERE="${0:A:h}"
REPO="${HERE:h:h}"
CAP="${UG_INFLIGHT_OUT:-$(mktemp -d)}"
CLI="${UG_INFLIGHT_CLI:-$REPO/dist/cli/main.js}"
CLAUDE_BIN="${UG_INFLIGHT_CLAUDE:-claude}"
BOUNDARY_WAIT="${UG_INFLIGHT_BOUNDARY_WAIT:-30}"

HH="$(mktemp -d)"
SHIMDIR="$(mktemp -d)"
WORK_A="$(mktemp -d)"
WORK_B="$(mktemp -d)"
mkdir -p "$CAP" "$HH" "$SHIMDIR" "$WORK_A" "$WORK_B"
chmod 700 "$HH"
umask 077

FAIL=0
fail() {
  echo "capture.sh: FAIL: $1" >&2
  FAIL=1
}

if [ ! -f "$CLI" ]; then
  echo "capture.sh: no built CLI at $CLI (run \`npm run build\` first, or set UG_INFLIGHT_CLI)" >&2
  exit 1
fi
if ! command -v "$CLAUDE_BIN" >/dev/null 2>&1; then
  echo "capture.sh: no \`$CLAUDE_BIN\` on PATH" >&2
  exit 1
fi

"$CLAUDE_BIN" --version > "$CAP/claude.version.txt" 2>&1
node "$CLI" --version > "$CAP/harness.version.txt" 2>&1

# --- PATH shim: bare `harness` -> this worktree's built dist. Also
# tees every `harness pack hook <verb>` call's stderr into
# HARNESS_HOME/hook-stderr.log with a timestamp + verb prefix, so the
# hook's own diagnostics are captured on disk regardless of what the
# launcher's stdout/stderr capture does.
cat > "$SHIMDIR/harness" <<EOF
#!/bin/zsh
set -u
DIST="$CLI"
LOG="\${HARNESS_HOME:-/tmp}/hook-stderr.log"
if [[ "\${1:-}" == "pack" && "\${2:-}" == "hook" ]]; then
  verb="\${3:-unknown}"
  errfile=\$(mktemp)
  node "\$DIST" "\$@" 2> "\$errfile"
  code=\$?
  ts=\$(date -u +%Y-%m-%dT%H:%M:%SZ)
  while IFS= read -r line; do
    printf '%s [%s] %s\n' "\$ts" "\$verb" "\$line" >> "\$LOG"
  done < "\$errfile"
  cat "\$errfile" >&2
  rm -f "\$errfile"
  exit \$code
else
  exec node "\$DIST" "\$@"
fi
EOF
chmod +x "$SHIMDIR/harness"
export PATH="$SHIMDIR:$PATH"
export HARNESS_HOME="$HH"
# Matches `reportsDirForManifest($HH/harness.yaml)`, the same value
# `harness apply` bakes into the rendered settings.json's hook-command
# env (see UNDERSTANDING_GATE_REPORT_DIR in the settings.json this
# script renders below). Exported globally so `harness approve` and the
# synthetic boundary call below resolve the SAME reports dir instead of
# defaulting to whatever this script's own cwd happens to be.
export UNDERSTANDING_GATE_REPORT_DIR="$HH/.understanding-gate/reports"
: > "$HH/hook-stderr.log"

# --- fixture manifest: understanding-before-execution only, grill_me,
# no auto_approve, expire_on_bash_match for the BOUNDARY probe.
cat > "$HH/harness.yaml" <<'EOF'
version: 1
policy_packs:
  - name: understanding-before-execution
    enabled: true
    config:
      mode: grill_me
      approval_lifecycle:
        expire_on_bash_match:
          - '^echo BOUNDARY'
EOF

SETTINGS="$(mktemp -d)/settings.json"
harness apply --target "$SETTINGS" --force --quiet \
  > "$CAP/apply.stdout.txt" 2> "$CAP/apply.stderr.txt"
APPLY_EXIT=$?
if [ "$APPLY_EXIT" != "0" ] || [ ! -f "$SETTINGS" ]; then
  fail "harness apply did not produce $SETTINGS (exit=$APPLY_EXIT)"
fi

new_uuid() { python3 -c 'import uuid; print(uuid.uuid4())'; }

SID_A="$(new_uuid)"
SID_B="$(new_uuid)"
echo "SID_A(full)=$SID_A" > "$CAP/session-ids.full.txt"
echo "SID_B(full)=$SID_B" >> "$CAP/session-ids.full.txt"

echo "=== approving session A ($SID_A) ==="
harness approve understanding --session "$SID_A" > "$CAP/approve.A.txt" 2>&1
echo "=== approving session B ($SID_B) ==="
harness approve understanding --session "$SID_B" > "$CAP/approve.B.txt" 2>&1
if ! grep -q '✓' "$CAP/approve.A.txt"; then fail "approve A did not report a written marker"; fi
if ! grep -q '✓' "$CAP/approve.B.txt"; then fail "approve B did not report a written marker"; fi

PROMPT_A='Perform these steps in order, calling tools directly, with no narration:
1. Call the Bash tool with the command: echo parent
2. Call the Edit tool on the file a.txt to replace the word alpha with ALPHA.
3. Call the Agent tool with subagent_type general-purpose using exactly this task prompt: Perform these steps in order, calling tools directly: (a) Call the Bash tool with the command: echo subagent. (b) Call the Edit tool, never Bash and never sed, on the file b.txt to replace the word beta with BETA. (c) Reply with the single word: done.
4. After the Agent tool call returns, reply with the single word: done.'

PROMPT_B='Perform these steps in order, calling tools directly, with no narration:
1. Call the Bash tool with the command: echo parent
2. Call the Edit tool on the file a.txt to replace the word alpha with ALPHA.
3. Call the Agent tool with subagent_type general-purpose using exactly this task prompt: Perform these steps in order, calling tools directly: (a) Call the Bash tool with the command: sleep 8. (b) Call the Bash tool with the command: echo subagent. (c) Call the Edit tool, never Bash and never sed, on the file b.txt to replace the word beta with BETA. (d) Reply with the single word: done.
4. After the Agent tool call returns, call the Bash tool with the command: touch after.txt
5. Reply with the single word: done.'

echo -n "alpha" > "$WORK_A/a.txt"
echo -n "beta" > "$WORK_A/b.txt"
echo -n "alpha" > "$WORK_B/a.txt"
echo -n "beta" > "$WORK_B/b.txt"

# ============================= Variant A =============================
echo "=== Variant A: parent + subagent, both pass gated Bash/Edit ==="
( cd "$WORK_A" && env -u CLAUDECODE "$CLAUDE_BIN" -p "$PROMPT_A" \
    --session-id "$SID_A" --settings "$SETTINGS" --setting-sources project \
    --permission-mode bypassPermissions --output-format stream-json \
    --include-hook-events --verbose --max-turns 20 \
    < /dev/null > "$CAP/variantA.stream.jsonl" 2> "$CAP/variantA.launch.stderr.txt" )
VARIANT_A_EXIT=$?
echo "Variant A claude exit=$VARIANT_A_EXIT"
cp "$HH/hook-stderr.log" "$CAP/variantA.hook-stderr.txt"
: > "$HH/hook-stderr.log"

A_ALLOW_COUNT=$(grep -c 'approved via marker' "$CAP/variantA.hook-stderr.txt")
A_SUBSTART=$(grep -c 'subagent-start: wrote in-flight record' "$CAP/variantA.hook-stderr.txt")
A_SUBSTOP=$(grep -c 'subagent-stop: cleared in-flight record' "$CAP/variantA.hook-stderr.txt")
A_TXT="$(cat "$WORK_A/a.txt" 2>/dev/null)"
B_TXT="$(cat "$WORK_A/b.txt" 2>/dev/null)"

echo "Variant A: marker-allow lines=$A_ALLOW_COUNT subagent-start=$A_SUBSTART subagent-stop=$A_SUBSTOP a.txt=$A_TXT b.txt=$B_TXT"

[ "$A_ALLOW_COUNT" -ge 4 ] || fail "Variant A: expected >=4 'approved via marker' lines, got $A_ALLOW_COUNT"
[ "$A_SUBSTART" -ge 1 ] || fail "Variant A: no subagent-start in-flight-record-written diagnostic"
[ "$A_SUBSTOP" -ge 1 ] || fail "Variant A: no subagent-stop in-flight-record-cleared diagnostic"
[ "$A_TXT" = "ALPHA" ] || fail "Variant A: a.txt is '$A_TXT', expected ALPHA (parent Edit did not land)"
[ "$B_TXT" = "BETA" ] || fail "Variant A: b.txt is '$B_TXT', expected BETA (subagent Edit did not land)"

# ============================= Variant B =============================
echo "=== Variant B: boundary fires mid-subagent, blocks the parent only ==="
( cd "$WORK_B" && env -u CLAUDECODE "$CLAUDE_BIN" -p "$PROMPT_B" \
    --session-id "$SID_B" --settings "$SETTINGS" --setting-sources project \
    --permission-mode bypassPermissions --output-format stream-json \
    --include-hook-events --verbose --max-turns 20 \
    < /dev/null > "$CAP/variantB.stream.jsonl" 2> "$CAP/variantB.launch.stderr.txt" ) &
CLAUDE_B_PID=$!

INFLIGHT_DIR="$HH/harness.generated/.inflight/$SID_B"
DEADLINE=$((SECONDS + BOUNDARY_WAIT))
RECORD_FOUND=0
while [ "$SECONDS" -lt "$DEADLINE" ]; do
  if [ -d "$INFLIGHT_DIR" ] && [ -n "$(ls -A "$INFLIGHT_DIR" 2>/dev/null)" ]; then
    RECORD_FOUND=1
    break
  fi
  sleep 0.2
done
echo "Variant B: in-flight record appeared after $((SECONDS - (DEADLINE - BOUNDARY_WAIT)))s (found=$RECORD_FOUND)"

if [ "$RECORD_FOUND" = "1" ]; then
  printf '{"session_id":"%s","hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"echo BOUNDARY"},"tool_response":{}}' "$SID_B" \
    | harness pack hook post-tool-use \
      > "$CAP/variantB.boundary.stdout.txt" 2> "$CAP/variantB.boundary.stderr.txt"
  echo "Variant B: boundary call exit=$?"
else
  fail "Variant B: in-flight record never appeared under $INFLIGHT_DIR within ${BOUNDARY_WAIT}s"
fi

wait "$CLAUDE_B_PID"
VARIANT_B_EXIT=$?
echo "Variant B claude exit=$VARIANT_B_EXIT"
cp "$HH/hook-stderr.log" "$CAP/variantB.hook-stderr.txt"

B_INFLIGHT_ALLOW=$(grep -c 'in-flight subagent record for agent' "$CAP/variantB.hook-stderr.txt")
B_PARENT_DENY=$(grep -c "no approval marker for session $SID_B" "$CAP/variantB.hook-stderr.txt")
A_TXT_B="$(cat "$WORK_B/a.txt" 2>/dev/null)"
B_TXT_B="$(cat "$WORK_B/b.txt" 2>/dev/null)"
AFTER_EXISTS=0
[ -f "$WORK_B/after.txt" ] && AFTER_EXISTS=1

echo "Variant B: inflight-allow lines=$B_INFLIGHT_ALLOW parent-deny lines=$B_PARENT_DENY a.txt=$A_TXT_B b.txt=$B_TXT_B after.txt exists=$AFTER_EXISTS"

if [ "$RECORD_FOUND" = "1" ]; then
  [ "$B_INFLIGHT_ALLOW" -ge 1 ] || fail "Variant B: no 'in-flight subagent record for agent ... allowing' diagnostic"
  [ "$B_PARENT_DENY" -ge 1 ] || fail "Variant B: no 'no approval marker for session $SID_B' deny diagnostic for the parent's post-boundary call"
  [ "$B_TXT_B" = "BETA" ] || fail "Variant B: b.txt is '$B_TXT_B', expected BETA (subagent Edit should still have landed)"
  [ "$AFTER_EXISTS" = "0" ] || fail "Variant B: after.txt exists; the parent's post-boundary Bash should have been denied"
fi

# --- Redact and stage payloads -----------------------------------------
# Same redaction shape as ../ug-auto-mode-signals/README.md's table: the
# machine's scratch/temp-dir prefix (both its plain form, which every
# mktemp -d path here is under, and its `/private` and project-transcript
# slug forms), the operator's home directory, and full session ids down
# to an 8-char prefix. Per-message/tool-call uuids (hook_id, tool_use_id,
# message uuid, request_id) are throwaway and kept as-is, same treatment
# the existing dogfood gives its own throwaway session_id values.
mkdir -p "$CAP/redacted"
SID_A_PREFIX=$(echo "$SID_A" | cut -c1-8)
SID_B_PREFIX=$(echo "$SID_B" | cut -c1-8)
TMPDIR_PLAIN="${TMPDIR%/}"
TMPDIR_PRIVATE="/private${TMPDIR_PLAIN}"
TMPDIR_PLAIN_SLUG=$(echo "$TMPDIR_PLAIN" | sed -e 's#^/##' -e 's#/#-#g')
TMPDIR_PRIVATE_SLUG=$(echo "$TMPDIR_PRIVATE" | sed -e 's#^/##' -e 's#/#-#g')
for f in variantA.stream.jsonl variantA.hook-stderr.txt variantA.launch.stderr.txt \
         variantB.stream.jsonl variantB.hook-stderr.txt variantB.launch.stderr.txt \
         variantB.boundary.stdout.txt variantB.boundary.stderr.txt \
         approve.A.txt approve.B.txt apply.stdout.txt; do
  [ -f "$CAP/$f" ] || continue
  sed \
    -e "s#$TMPDIR_PRIVATE_SLUG#<scratch-slug>#g" \
    -e "s#$TMPDIR_PLAIN_SLUG#<scratch-slug>#g" \
    -e "s#$TMPDIR_PRIVATE#<scratch>#g" \
    -e "s#$TMPDIR_PLAIN#<scratch>#g" \
    -e "s#$HOME#<home>#g" \
    -e "s#$SID_A#${SID_A_PREFIX}#g" \
    -e "s#$SID_B#${SID_B_PREFIX}#g" \
    "$CAP/$f" > "$CAP/redacted/$f"
done

echo "=== summary ==="
echo "Variant A: FAIL=$FAIL (see counters above)"
echo "Output dir: $CAP"
# Claude Code writes one transcript directory per cwd under the operator's
# ~/.claude/projects/, keyed by the cwd with every non-alphanumeric
# character replaced by '-'. Named here so the debris is visible; never
# removed by this script (operator data, even if throwaway).
for w in "$WORK_A" "$WORK_B"; do
  slug=$(echo "$w" | sed -e 's#[^A-Za-z0-9]#-#g')
  echo "Claude Code transcript dir (not removed): $HOME/.claude/projects/$slug"
done
echo "Redacted payloads: $CAP/redacted"

exit $FAIL
