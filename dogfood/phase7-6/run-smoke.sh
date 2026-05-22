#!/usr/bin/env bash
# Phase 7 #6 dogfood — Risk Gate enforcement, end-to-end.
#
# Drives `harness policy intercept` against the real grounding-mcp +
# real ~/.evidence-ledger/ledger.db (the same wire the Claude Code
# PreToolUse hook uses) and verifies every Risk Gate decision outcome:
#
#   1. deny             — smoke-deny blocks (decision=block).
#   2. warn             — smoke-warn proceeds (empty stdout) and the
#                         --verbose stderr names a `warn` decision.
#   3. require_approval — smoke-approval blocks; `harness approve risk`
#                         records risk-approved:<session>; the rerun
#                         then allows (empty stdout). The allow case.
#   4. canonical case   — `kubectl delete namespace prod` blocks via the
#                         built-in dangerous-shell classifier + a
#                         require_approval policy, then allows after
#                         approval (the ROADMAP Phase 7 exit-gate line).
#
# Transcripts land under transcript/. Exits non-zero on any unexpected
# step so a release gate / CI wrapper can trust the exit code.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
HARNESS_DIR="${HARNESS_DIR:-$(cd "$ROOT/../.." && pwd)}"
GROUNDING_DIR="${GROUNDING_DIR:-$(cd "$HARNESS_DIR/../agent-grounding" && pwd)}"
HARNESS_BIN="node $HARNESS_DIR/dist/cli/main.js"
TRANSCRIPT_DIR="$ROOT/transcript"
SESSION="phase7-6-dogfood-$(date +%s)-$$"

mkdir -p "$TRANSCRIPT_DIR"
# Render a per-run manifest with the grounding-mcp path substituted so
# the smoke runs out-of-the-box on any checkout layout.
MANIFEST="$TRANSCRIPT_DIR/effective-manifest.yaml"
sed \
  -e "s|/home/lan/git/pandora/agent-grounding|$GROUNDING_DIR|g" \
  "$ROOT/harness.yaml" >"$MANIFEST"
exec > >(tee "$TRANSCRIPT_DIR/run.log") 2>&1

echo "=================================================="
echo "Phase 7 #6 dogfood — Risk Gate enforcement"
echo "=================================================="
echo "session       = $SESSION"
echo "manifest      = $MANIFEST"
echo "grounding dir = $GROUNDING_DIR"
echo "ledger db     = $HOME/.evidence-ledger/ledger.db"
echo
echo "NOTE: writes one ledger entry (risk-approved:$SESSION) scoped to"
echo "      sessionId=$SESSION. To clean up, drop rows where session ="
echo "      '$SESSION' from evidence_ledger in the sqlite db."
echo

# event <bash-command> — emit a synthetic Claude Code PreToolUse event.
event() {
  cat <<EOF
{
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": { "command": "$1" },
  "session_id": "$SESSION",
  "cwd": "$HARNESS_DIR"
}
EOF
}

# intercept <label> <bash-command> — pipe an event through the gate with
# DATABASE_URL set so production-signals resolves environment=production.
# Captures stdout/stderr under transcript/. Echoes the stdout.
intercept() {
  local label="$1" cmd="$2"
  local out="$TRANSCRIPT_DIR/$label.stdout" err="$TRANSCRIPT_DIR/$label.stderr"
  set +e
  event "$cmd" | DATABASE_URL="postgresql://prod-db.internal/app" \
    $HARNESS_BIN policy intercept --config "$MANIFEST" --verbose \
    >"$out" 2>"$err"
  set -e
  echo "--- $label: stdout ---"; cat "$out"
  echo "--- $label: stderr ---"; cat "$err"
  echo
}

fail() { echo "FAIL: $1"; exit 1; }

# ------------------------------------------------------------------
echo "=== STEP 1: deny outcome (smoke-deny, enforcement: block) ==="
intercept "01-deny" "RISKSMOKE_DENY echo blocked"
grep -q '"decision":"block"' "$TRANSCRIPT_DIR/01-deny.stdout" \
  || fail "expected decision=block for smoke-deny"
grep -q '"permissionDecision":"deny"' "$TRANSCRIPT_DIR/01-deny.stdout" \
  || fail "expected permissionDecision=deny for smoke-deny"
echo "PASS: deny — block envelope emitted"
echo

# ------------------------------------------------------------------
echo "=== STEP 2: warn outcome (smoke-warn, enforcement: warn) ==="
intercept "02-warn" "RISKSMOKE_WARN echo proceeds"
if [ -s "$TRANSCRIPT_DIR/02-warn.stdout" ]; then
  fail "expected empty stdout (no block) for smoke-warn"
fi
grep -q "smoke-warn: warn" "$TRANSCRIPT_DIR/02-warn.stderr" \
  || fail "expected a 'smoke-warn: warn' diagnostic on stderr"
echo "PASS: warn — proceeds, warn decision recorded"
echo

# ------------------------------------------------------------------
echo "=== STEP 3: require_approval outcome (smoke-approval) ==="
intercept "03-require-approval" "RISKSMOKE_APPROVAL echo gated"
grep -q '"decision":"block"' "$TRANSCRIPT_DIR/03-require-approval.stdout" \
  || fail "expected decision=block for smoke-approval (require_approval)"
echo "PASS: require_approval — blocked pending approval"
echo

# ------------------------------------------------------------------
echo "=== STEP 4: canonical kubectl-delete-namespace case (pre-approval) ==="
# `kubectl delete namespace prod` classifies high via dangerous-shell;
# in a production environment gate-kubectl returns require_approval.
# Checked BEFORE the approval below, while the gate is still closed.
intercept "04-kubectl-deny" "kubectl delete namespace prod"
grep -q '"decision":"block"' "$TRANSCRIPT_DIR/04-kubectl-deny.stdout" \
  || fail "expected kubectl delete namespace prod to be blocked"
echo "PASS: canonical case — kubectl delete namespace prod gated"
echo

# ------------------------------------------------------------------
echo "=== STEP 5: harness approve risk (operator grant) ==="
APPROVE_OUT="$TRANSCRIPT_DIR/04-approve.stdout"
set +e
$HARNESS_BIN approve risk --config "$MANIFEST" --session "$SESSION" \
  >"$APPROVE_OUT" 2>"$TRANSCRIPT_DIR/04-approve.stderr"
APPROVE_EXIT=$?
set -e
cat "$APPROVE_OUT"; echo
[ "$APPROVE_EXIT" -eq 0 ] || fail "harness approve risk exited $APPROVE_EXIT"
grep -q "wrote risk-approved:$SESSION" "$APPROVE_OUT" \
  || fail "approve risk did not report writing the ledger tag"
echo "PASS: approve risk — risk-approved:$SESSION recorded"
echo

# ------------------------------------------------------------------
echo "=== STEP 6: allow outcome (smoke-approval rerun, post-approval) ==="
intercept "06-allow" "RISKSMOKE_APPROVAL echo gated"
if [ -s "$TRANSCRIPT_DIR/06-allow.stdout" ]; then
  fail "expected empty stdout (allow) after approval"
fi
echo "PASS: allow — gate cleared once risk-approved is on record"
echo

# ------------------------------------------------------------------
echo "=== STEP 7: canonical case allows after approval ==="
# The risk-approved tag from STEP 5 satisfies gate-kubectl's requires
# (same session) — the ROADMAP exit-gate round-trip: kubectl delete
# namespace prod blocked (STEP 4), then allowed after the grant.
intercept "07-kubectl-allow" "kubectl delete namespace prod"
if [ -s "$TRANSCRIPT_DIR/07-kubectl-allow.stdout" ]; then
  fail "expected kubectl delete to allow after approval"
fi
echo "PASS: canonical case — kubectl delete namespace prod allowed post-approval"
echo

echo "=================================================="
echo "SMOKE COMPLETE — all four Risk Gate outcomes verified"
echo "session = $SESSION   transcripts at $TRANSCRIPT_DIR/"
echo "=================================================="
