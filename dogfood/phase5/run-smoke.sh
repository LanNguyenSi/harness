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
HARNESS_BIN="node /home/lan/git/pandora/harness/dist/cli/main.js"
GROUNDING_MCP="node /home/lan/git/pandora/agent-grounding/packages/grounding-mcp/dist/server.js"
MANIFEST="$ROOT/harness.yaml"
TRANSCRIPT_DIR="$ROOT/transcript"
SESSION="phase5-dogfood-$(date +%s)-$$"

mkdir -p "$TRANSCRIPT_DIR"
exec > >(tee "$TRANSCRIPT_DIR/run.log") 2>&1

echo "=========================================="
echo "Phase 5 #1 dogfood — real Claude Code hook"
echo "=========================================="
echo "session = $SESSION"
echo "manifest = $MANIFEST"
echo "ledger db = ${EVIDENCE_LEDGER_DB:-$HOME/.evidence-ledger/ledger.db}"
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
# Step 5: audit shows both fires.
# ------------------------------------------------------------------
echo "=== STEP 4: harness audit --since 5m --session $SESSION ==="
AUDIT_OUT="$TRANSCRIPT_DIR/04-audit.stdout"
set +e
$HARNESS_BIN audit --config "$MANIFEST" --since 5m --session "$SESSION" \
  >"$AUDIT_OUT" 2>"$TRANSCRIPT_DIR/04-audit.stderr"
AUDIT_EXIT=$?
set -e
echo "exit = $AUDIT_EXIT"
cat "$AUDIT_OUT"
echo

# ------------------------------------------------------------------
# Step 6: explain --trace renders the live trace.
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

echo "=========================================="
echo "SMOKE COMPLETE — session = $SESSION"
echo "transcripts at $TRANSCRIPT_DIR/"
echo "=========================================="
