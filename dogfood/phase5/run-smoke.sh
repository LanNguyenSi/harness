#!/usr/bin/env bash
# Phase 5 #1 smoke driver — runs the killer-test from the founding incident:
#
#   1. Synthesise a Claude Code PreToolUse event for
#      `mcp__agent-tasks__pull_requests_merge` with prNumber=42.
#   2. Pipe it into the same `node ... policy intercept ...` command that
#      `harness apply` writes into settings.json. Verify deny JSON on stdout.
#   3. ledger_add review:42 against the real grounding-mcp + real
#      ~/.evidence-ledger/ledger.db, scoped to a unique sessionId so we
#      do not pollute other sessions.
#   4. Pipe the event in again. Verify silent allow (empty stdout).
#   5. `harness audit --since 5m --session ${SESSION}` shows both fires.
#   6. `harness explain review-before-merge --trace --session ${SESSION}`
#      renders the live trace.
#
# Output is captured under transcript/ for attachment to the agent-tasks
# task. Exits non-zero on any unexpected step so CI / a follow-up dogfood
# task can wrap it.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
# HARNESS_DIR / GROUNDING_DIR can be overridden so the smoke is portable across
# checkouts. Defaults match the canonical pandora layout.
HARNESS_DIR="${HARNESS_DIR:-$(cd "$ROOT/../.." && pwd)}"
GROUNDING_DIR="${GROUNDING_DIR:-$(cd "$HARNESS_DIR/../agent-grounding" && pwd)}"
HARNESS_BIN="node $HARNESS_DIR/dist/cli/main.js"
GROUNDING_MCP="node $GROUNDING_DIR/packages/grounding-mcp/dist/server.js"
TRANSCRIPT_DIR="$ROOT/transcript"
SESSION="phase5-dogfood-$(date +%s)-$$"

mkdir -p "$TRANSCRIPT_DIR"
# Render a per-run manifest with HARNESS_DIR / GROUNDING_DIR substituted.
# The canonical committed `harness.yaml` next to this script carries Lan's
# absolute paths for human reading + `harness apply` demos; the smoke uses
# this rendered copy so it runs out-of-the-box on any checkout layout.
MANIFEST="$TRANSCRIPT_DIR/effective-manifest.yaml"
sed \
  -e "s|/home/lan/git/pandora/harness|$HARNESS_DIR|g" \
  -e "s|/home/lan/git/pandora/agent-grounding|$GROUNDING_DIR|g" \
  "$ROOT/harness.yaml" >"$MANIFEST"
exec > >(tee "$TRANSCRIPT_DIR/run.log") 2>&1

echo "=========================================="
echo "Phase 5 #1 dogfood — real Claude Code hook"
echo "=========================================="
echo "session       = $SESSION"
echo "manifest      = $MANIFEST"
echo "harness dir   = $HARNESS_DIR"
echo "grounding dir = $GROUNDING_DIR"
echo "ledger db     = $HOME/.evidence-ledger/ledger.db (manifest-declared)"
echo
echo "NOTE: the smoke writes ledger entries scoped to sessionId=$SESSION."
echo "      To clean up after a run, drop rows where session = '$SESSION'"
echo "      from \`evidence_ledger\` in the sqlite db."
echo

# ------------------------------------------------------------------
# Step 1: synthesise the PreToolUse event Claude Code would send.
# Shape per Claude Code hooks docs (hook_event_name + tool_name +
# tool_input + session_id + cwd). prNumber 42 is intentional — the
# extract DSL is `toolArgs.prNumber`, so the substituted ledger_tag
# becomes `review:42`.
# ------------------------------------------------------------------
EVENT_JSON=$(cat <<EOF
{
  "hook_event_name": "PreToolUse",
  "tool_name": "mcp__agent-tasks__pull_requests_merge",
  "tool_input": {
    "prNumber": 42,
    "owner": "LanNguyenSi",
    "repo": "harness",
    "taskId": "phase5-smoke"
  },
  "session_id": "$SESSION",
  "cwd": "/home/lan/git/pandora/harness"
}
EOF
)
echo "--- event payload ---"
echo "$EVENT_JSON"
echo

# ------------------------------------------------------------------
# Step 2: deny on missing review evidence.
# ------------------------------------------------------------------
echo "=== STEP 1: first merge attempt (expect DENY) ==="
DENY_STDOUT="$TRANSCRIPT_DIR/01-deny.stdout"
DENY_STDERR="$TRANSCRIPT_DIR/01-deny.stderr"
set +e
echo "$EVENT_JSON" | $HARNESS_BIN policy intercept --config "$MANIFEST" \
  >"$DENY_STDOUT" 2>"$DENY_STDERR"
DENY_EXIT=$?
set -e
echo "exit = $DENY_EXIT"
echo "stdout:"
cat "$DENY_STDOUT"
echo "stderr:"
cat "$DENY_STDERR"
echo

if ! grep -q '"decision":"deny"' "$DENY_STDOUT"; then
  echo "FAIL: expected deny JSON on stdout"
  exit 1
fi
echo "PASS: deny JSON observed"
echo

# ------------------------------------------------------------------
# Step 3: record review:42 via grounding-mcp ledger_add.
# ------------------------------------------------------------------
echo "=== STEP 2: ledger_add review:42 ==="
LEDGER_OUT="$TRANSCRIPT_DIR/02-ledger-add.stdout"
{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"phase5-smoke","version":"0.1"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
  printf '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ledger_add","arguments":{"sessionId":"%s","type":"fact","content":"review:42 approved by phase5-smoke","source":"phase5-dogfood"}}}\n' "$SESSION"
  sleep 0.5
} | $GROUNDING_MCP > "$LEDGER_OUT" 2>>"$TRANSCRIPT_DIR/02-ledger-add.stderr" || true
echo "ledger_add raw responses:"
cat "$LEDGER_OUT"
echo

if ! grep -q '"id":2' "$LEDGER_OUT"; then
  echo "FAIL: ledger_add did not return a response with id=2"
  exit 1
fi
echo "PASS: ledger_add accepted"
echo

# ------------------------------------------------------------------
# Step 4: rerun, expect silent allow.
# ------------------------------------------------------------------
echo "=== STEP 3: second merge attempt (expect ALLOW / empty stdout) ==="
ALLOW_STDOUT="$TRANSCRIPT_DIR/03-allow.stdout"
ALLOW_STDERR="$TRANSCRIPT_DIR/03-allow.stderr"
set +e
echo "$EVENT_JSON" | $HARNESS_BIN policy intercept --config "$MANIFEST" \
  >"$ALLOW_STDOUT" 2>"$ALLOW_STDERR"
ALLOW_EXIT=$?
set -e
echo "exit = $ALLOW_EXIT"
echo "stdout (expect empty):"
cat "$ALLOW_STDOUT"
echo "stderr:"
cat "$ALLOW_STDERR"
echo

if [ -s "$ALLOW_STDOUT" ]; then
  echo "FAIL: expected empty stdout on allow, got content"
  exit 1
fi
echo "PASS: silent allow"
echo

# ------------------------------------------------------------------
# Step 4a: audit at --since 5m. Originally a Phase 5 #8 regression
# witness (pre-fix the TZ-shifted window silently filtered fresh
# entries on any non-UTC host). Now that #8 has shipped, this is a
# real acceptance gate: the window MUST contain both fires.
# ------------------------------------------------------------------
echo "=== STEP 4a: harness audit --since 5m --session $SESSION (acceptance, post-#8) ==="
AUDIT5_OUT="$TRANSCRIPT_DIR/04a-audit-5m.stdout"
set +e
$HARNESS_BIN audit --config "$MANIFEST" --since 5m --session "$SESSION" \
  >"$AUDIT5_OUT" 2>"$TRANSCRIPT_DIR/04a-audit-5m.stderr"
AUDIT5_EXIT=$?
set -e
echo "exit = $AUDIT5_EXIT"
cat "$AUDIT5_OUT"
echo
if [ "$AUDIT5_EXIT" -ne 0 ]; then
  echo "FAIL: harness audit --since 5m exited $AUDIT5_EXIT"
  exit 1
fi
DENY_5M=$(grep -c -E "review-before-merge[[:space:]]+deny" "$AUDIT5_OUT" || true)
ALLOW_5M=$(grep -c -E "review-before-merge[[:space:]]+allow" "$AUDIT5_OUT" || true)
if [ "$DENY_5M" -lt 1 ] || [ "$ALLOW_5M" -lt 1 ]; then
  echo "FAIL: 5m audit must show at least one deny ($DENY_5M) and one allow ($ALLOW_5M) row"
  echo "      (regression of Phase 5 #8 — TZ-shifted window filtering)"
  exit 1
fi
echo "PASS: 5m audit shows deny + allow rows"
echo

# ------------------------------------------------------------------
# Step 4b: audit at --since 24h. Wider acceptance gate kept as belt-and-
# braces against the narrow window: a regression that breaks 5m but
# leaves 24h working would still be caught here.
# ------------------------------------------------------------------
echo "=== STEP 4b: harness audit --since 24h --session $SESSION (acceptance) ==="
AUDIT24_OUT="$TRANSCRIPT_DIR/04b-audit-24h.stdout"
set +e
$HARNESS_BIN audit --config "$MANIFEST" --since 24h --session "$SESSION" \
  >"$AUDIT24_OUT" 2>"$TRANSCRIPT_DIR/04b-audit-24h.stderr"
AUDIT24_EXIT=$?
set -e
echo "exit = $AUDIT24_EXIT"
cat "$AUDIT24_OUT"
echo
if [ "$AUDIT24_EXIT" -ne 0 ]; then
  echo "FAIL: harness audit --since 24h exited $AUDIT24_EXIT"
  exit 1
fi
DENY_ROWS=$(grep -c -E "review-before-merge[[:space:]]+deny" "$AUDIT24_OUT" || true)
ALLOW_ROWS=$(grep -c -E "review-before-merge[[:space:]]+allow" "$AUDIT24_OUT" || true)
if [ "$DENY_ROWS" -lt 1 ] || [ "$ALLOW_ROWS" -lt 1 ]; then
  echo "FAIL: 24h audit must show at least one deny ($DENY_ROWS) and one allow ($ALLOW_ROWS) row"
  exit 1
fi
echo "PASS: 24h audit shows deny + allow rows"
echo

# ------------------------------------------------------------------
# Step 6: explain --trace renders the live trace. Phase 5 #9 means the
# returned decision is the *first* fire (deny) when both fires share an
# SQL second; the gate below asserts only that the trace renders against
# the live ledger and quotes the smoke session, NOT that the latest
# decision is the allow. Once #9 lands the assertion can tighten.
# ------------------------------------------------------------------
echo "=== STEP 5: harness explain review-before-merge --trace --session $SESSION ==="
EXPLAIN_OUT="$TRANSCRIPT_DIR/05-explain.stdout"
set +e
$HARNESS_BIN explain review-before-merge --config "$MANIFEST" --trace \
  --session "$SESSION" \
  >"$EXPLAIN_OUT" 2>"$TRANSCRIPT_DIR/05-explain.stderr"
EXPLAIN_EXIT=$?
set -e
echo "exit = $EXPLAIN_EXIT"
cat "$EXPLAIN_OUT"
echo
if [ "$EXPLAIN_EXIT" -ne 0 ]; then
  echo "FAIL: harness explain exited $EXPLAIN_EXIT"
  exit 1
fi
if ! grep -q "name: review-before-merge" "$EXPLAIN_OUT"; then
  echo "FAIL: explain output is missing the policy name field"
  exit 1
fi
if ! grep -q "ledgerTag: review:42" "$EXPLAIN_OUT"; then
  echo "FAIL: explain output is missing the substituted ledger tag"
  exit 1
fi
if ! grep -q "sessionId: $SESSION" "$EXPLAIN_OUT"; then
  echo "FAIL: explain output is missing the smoke session id (live-ledger proof)"
  exit 1
fi
echo "PASS: explain --trace renders the live trace for the smoke session"
echo

echo "=========================================="
echo "SMOKE COMPLETE — session = $SESSION"
echo "transcripts at $TRANSCRIPT_DIR/"
echo "=========================================="
