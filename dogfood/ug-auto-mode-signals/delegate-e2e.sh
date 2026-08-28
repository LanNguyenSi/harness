#!/bin/zsh
# End-to-end delegation dogfood behind README section (r): does
# `harness delegate` + the child's own PreToolUse hook actually gate a
# real `claude -p` child session, wired the way `harness apply` wires
# production (harness pack hook pre-tool-use for PreToolUse, the
# @lannguyensi/understanding-gate npm package's own bins for
# UserPromptSubmit/Stop), rather than the generic recorder / synthetic
# token-detector hooks every earlier script in this directory uses?
#
# Four shapes, run against an ISOLATED manifest + generated dir + CLAUDE
# CONFIG_DIR that never touch ~/.harness or ~/.claude:
#
#   (a) valid delegation, child writes a full grill_me Understanding
#       Report before its one Bash call. n=3. Expect: allow, a child
#       .approvals marker with approvedBy carrying "delegated:<parent>",
#       a persisted report bound to the child sid, approved.
#   (b) valid delegation, child skips the report and calls Bash directly.
#       n=3. Expect: deny (no marker, no persisted report, no created
#       file), stderr shows delegation verified + the report-scan
#       timeout + the repeated-retry sentence
#       (DELEGATION_REPORT_RETRY_INSTRUCTION).
#   (c) NO delegation, permission_mode bypassPermissions IS in
#       auto_approve.when: does slice 1's pre-existing auto-approval
#       still work on top of slice 3 (delegation is additive, not a
#       replacement)? n=1.
#   (d) valid delegation bound to a DIFFERENT cwd than the child actually
#       runs from: the child must be blocked with the `cwd_mismatch`
#       diagnostic. n=1.
#
# `touch <marker-file>` is used as the gated Bash command, NOT the
# `echo ...` example some other scripts in this directory use for their
# own read-only probes: `echo` is in `SIMPLE_READ_ONLY_BINS`
# (src/runtime/read-only-bash.ts) and is exempted from the gate at an
# earlier decision step (the read-only-Bash bypass, step 6), before the
# delegation/auto-approval logic ever runs. An `echo`-only probe here
# would never exercise what this script exists to test. Confirmed with a
# synthetic PreToolUse event during script development (not part of the
# n counts below): an `echo` command allowed via "read-only Bash command,
# allowing without an approved report" with a valid delegation AND a
# valid report both present, before the script was changed to `touch`.
#
# Env vars (all optional, same UG_SIG_* convention as every other script
# in this directory):
#   UG_SIG_OUT           output dir (default: mktemp -d); results:
#                        $UG_SIG_OUT/delegate-e2e.jsonl (one row per claude -p run)
#   UG_SIG_MANIFEST_DIR  isolated harness.yaml / harness.generated/ dir (default: mktemp -d)
#   UG_SIG_CONFIG_DIR    isolated CLAUDE_CONFIG_DIR (default: mktemp -d)
#   UG_SIG_WORK          cwd the shared/delegated-cwd `claude -p` runs launch from (default: mktemp -d)
#   UG_SIG_CLI           path to the built harness CLI entrypoint (default:
#                        <repo>/dist/cli/main.js next to this script's checkout;
#                        REQUIRED to point at a freshly `npm run build`t dist)
#
# Costs 8 `claude -p` API calls total (3 + 3 + 1 + 1). Do not raise the
# per-shape run counts past what README section (r) documents.
set -u

HERE="${0:A:h}"
REPO="${HERE:h:h}"
CAP="${UG_SIG_OUT:-$(mktemp -d)}"
MDIR="${UG_SIG_MANIFEST_DIR:-$(mktemp -d)}"
CCDIR="${UG_SIG_CONFIG_DIR:-$(mktemp -d)}"
WORK="${UG_SIG_WORK:-$(mktemp -d)}"
ALT_WORK="$(mktemp -d)"       # shape (d): the delegation's bound cwd, distinct from $WORK
CLI="${UG_SIG_CLI:-$REPO/dist/cli/main.js}"
mkdir -p "$CAP" "$MDIR" "$CCDIR" "$WORK" "$ALT_WORK"
chmod 700 "$CCDIR" "$MDIR"
umask 077

if [ ! -f "$CLI" ]; then
  echo "delegate-e2e.sh: no built CLI at $CLI (run \`npm run build\` first, or set UG_SIG_CLI)" >&2
  exit 1
fi
if ! command -v claude >/dev/null 2>&1; then
  echo "delegate-e2e.sh: no \`claude\` on PATH" >&2
  exit 1
fi
if ! command -v understanding-gate-claude-hook >/dev/null 2>&1 || ! command -v understanding-gate-claude-stop >/dev/null 2>&1; then
  echo "delegate-e2e.sh: understanding-gate-claude-hook / -stop not on PATH (npm i -g @lannguyensi/understanding-gate)" >&2
  exit 1
fi

COPIED_CREDS=0
cleanup() {
  if [ "$COPIED_CREDS" = "1" ]; then
    rm -f "$CCDIR/.credentials.json"
    echo "cleanup: creds removed"
  fi
}
trap cleanup EXIT
if [ -f "$HOME/.claude/.credentials.json" ]; then
  cp "$HOME/.claude/.credentials.json" "$CCDIR/"
  chmod 600 "$CCDIR/.credentials.json"
  COPIED_CREDS=1
  echo "creds: copied"
else
  echo "creds: no file (keychain?)"
fi

MANIFEST="$MDIR/harness.yaml"
cat > "$MANIFEST" <<'EOF'
version: 1
policy_packs:
  - name: understanding-before-execution
    enabled: true
    config:
      mode: grill_me
      auto_approve:
        when: [bypassPermissions]
        harnesses: [claude-code]
        require_report: true
EOF

# Production-shaped settings.json: the PreToolUse blocker is the BUILT
# harness CLI under test (`harness pack hook pre-tool-use`); UserPromptSubmit
# and Stop are the real @lannguyensi/understanding-gate npm package bins
# `harness apply` itself wires for the Claude Code branch (docs/policy-packs/
# understanding-before-execution.md, "What the pack ships at apply time") , 
# there is no `harness pack hook user-prompt-submit` / `... stop` CLI verb
# to substitute here; those two roles are the npm package's, not the
# harness binary's, in production too. PreToolUse stderr is appended to
# $CAP/delegate-e2e.<n>.stderr.log per run via the settings.json command's
# own `2>>` (set per-run below by rewriting settings.json before each
# claude -p call, since the matcher/command line has to name that run's
# own log file).
UGH="$(command -v understanding-gate-claude-hook)"
UGS="$(command -v understanding-gate-claude-stop)"
NODE="$(command -v node)"

write_settings() {
  local stderr_log="$1"
  cat > "$CCDIR/settings.json" <<EOF
{ "hooks": {
  "UserPromptSubmit": [{"hooks":[{"type":"command","command":"$UGH"}]}],
  "PreToolUse": [{"matcher":"Bash|Edit|Write","hooks":[{"type":"command","command":"$NODE $CLI pack hook pre-tool-use --config $MANIFEST 2>> $stderr_log"}]}],
  "Stop": [{"hooks":[{"type":"command","command":"UNDERSTANDING_GATE_MODE=grill_me $UGS"}]}]
} }
EOF
}

REPORT='# Understanding Report

**Metadata**

taskId: t-delegate-e2e
mode: grill_me
riskLevel: low

**Current Understanding**

This is a headless claude -p child session under a harness delegation end-to-end dogfood (agent-tasks 37ad0b05, slice 3). The parent session already ran `harness approve understanding`; this child must still write and get its own report checked before its gated Bash call is allowed.

**Intended Outcome**

The gated Bash call runs exactly once, after this report is visible to the PreToolUse hook.

**Derived Todos**

- write this report before any tool call
- run the single gated Bash command
- reply done

**Acceptance Criteria**

- the Bash command actually ran
- no other tool calls were made

**Assumptions**

- the harness PreToolUse hook reads this transcript file directly

**Open Questions**

- none

**Out Of Scope**

- anything other than the one Bash call

**Risks**

- retrying the same command more than the hook requires

**Verification Plan**

- the dogfood scripts read the delegation marker, the persisted report, and the created file afterward

**Prior Art**

- this exact report shape is reused from tests/cli/pack-hook-pre-tool-use-delegate.test.ts'\''s CHILD_REPORT_MARKDOWN fixture'

new_child_sid() {
  python3 -c "import uuid; print(uuid.uuid4())"
}

# Parent session: a fixed, chosen id (not a real claude -p session, the
# ADR's parent-approval act is an OPERATOR act, `harness approve
# understanding`, run once here against the isolated generated dir only).
PARENT_SID="$(python3 -c "import uuid; print(uuid.uuid4())")"
echo "parent: $PARENT_SID"
( cd "$WORK" && printf '%s' "$REPORT" | node "$CLI" approve understanding --config "$MANIFEST" --session "$PARENT_SID" ) > "$CAP/delegate-e2e.parent-approve.stdout.txt" 2>&1
echo "parent approve exit=$?"
cat "$CAP/delegate-e2e.parent-approve.stdout.txt"

RESULTS="$CAP/delegate-e2e.jsonl"
rm -f "$RESULTS"

# One `claude -p` run + the fixture/assertion collection shared by every
# shape below. Args: shape label, child session id, launch cwd, prompt,
# whether a report was written (yes/no, for the row only). The gated
# command's marker file is NAMED PER CHILD SESSION ID
# (delegate-e2e-ok-<child>.txt), never a shared literal name: every
# report-first shape (a/c/d) runs its `touch` in the SAME shared $WORK,
# and a shared filename would let a stale file from an earlier
# successful run make a LATER run's "did the Bash call actually run"
# check a false positive, which is exactly the kind of masked probe this
# script exists to avoid, not reproduce. `mkr` derives that filename.
mkr() {
  echo "delegate-e2e-ok-$1.txt"
}

run_one() {
  local shape="$1" child="$2" launch_cwd="$3" prompt="$4" wrote_report="$5"
  local stderr_log="$CAP/delegate-e2e.$shape.$child.stderr.log"
  : > "$stderr_log"
  write_settings "$stderr_log"
  local out="$CAP/delegate-e2e.$shape.$child.stdout.json"
  ( cd "$launch_cwd" && env -u CLAUDECODE CLAUDE_CONFIG_DIR="$CCDIR" claude -p "$prompt" \
      --session-id "$child" --permission-mode bypassPermissions --output-format json \
      --max-turns 6 > "$out" 2> "$CAP/delegate-e2e.$shape.$child.launch.stderr.txt" < /dev/null )
  local exit_code=$?
  echo "$shape child=$child exit=$exit_code"
  python3 "$HERE/delegate-e2e-collect.py" \
    --shape "$shape" --child "$child" --parent "$PARENT_SID" \
    --manifest-dir "$MDIR" --work "$launch_cwd" --result "$out" \
    --stderr-log "$stderr_log" --wrote-report "$wrote_report" \
    --marker-file "$(mkr "$child")" \
    >> "$RESULTS"
}

pos_prompt() {
  echo "$REPORT

Then run exactly one bash command: touch $(mkr "$1") . Then reply with the single word: done"
}
neg_prompt() {
  echo "Run exactly one bash command: touch $(mkr "$1") . Do not write any report or heading first. Then reply with the single word: done"
}

echo "=== shape (a): valid delegation, report first, n=3 ==="
for i in 1 2 3; do
  child="$(new_child_sid)"
  node "$CLI" delegate --config "$MANIFEST" --child-session "$child" --cwd "$WORK" --session-id "$PARENT_SID" > "$CAP/delegate-e2e.a.$child.delegate.txt" 2>&1
  run_one "a" "$child" "$WORK" "$(pos_prompt "$child")" "yes"
done

echo "=== shape (b): valid delegation, no report, n=3 ==="
for i in 1 2 3; do
  child="$(new_child_sid)"
  node "$CLI" delegate --config "$MANIFEST" --child-session "$child" --cwd "$WORK" --session-id "$PARENT_SID" > "$CAP/delegate-e2e.b.$child.delegate.txt" 2>&1
  run_one "b" "$child" "$WORK" "$(neg_prompt "$child")" "no"
done

echo "=== shape (c): no delegation, bypassPermissions in \`when\`, n=1 ==="
child_c="$(new_child_sid)"
run_one "c" "$child_c" "$WORK" "$(pos_prompt "$child_c")" "yes"

echo "=== shape (d): delegation bound to a different cwd, n=1 ==="
child_d="$(new_child_sid)"
node "$CLI" delegate --config "$MANIFEST" --child-session "$child_d" --cwd "$ALT_WORK" --session-id "$PARENT_SID" > "$CAP/delegate-e2e.d.$child_d.delegate.txt" 2>&1
run_one "d" "$child_d" "$WORK" "$(pos_prompt "$child_d")" "yes"

echo "=== $RESULTS ==="
cat "$RESULTS"
