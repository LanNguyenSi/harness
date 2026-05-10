#!/usr/bin/env bash
# Phase 6 #6 dogfood — synthetic stdin smoke for the Codex adapter
# Understanding Gate (block + allow).
#
# What this exercises end-to-end:
#
#   1. `harness apply --runtime codex` against the local manifest.
#      Asserts that `harness.generated/codex/config.toml` is written
#      and `settings.json` is NOT (the runtime branches are mutually
#      exclusive in v1).
#   2. Synthesises a Codex PreToolUse event for `apply_patch` with a
#      fresh session id, pipes it into `harness pack hook
#      codex-pre-tool-use`. Asserts:
#        - exit code 2 (Codex's blocking convention)
#        - stderr contains "BLOCK"
#   3. Drops a persisted `.understanding-gate/reports/<file>.json`
#      with `approvalStatus: "approved"` for the same session id (the
#      synthetic equivalent of running `harness approve understanding`
#      against a session whose ledger source is degraded).
#   4. Pipes the same Codex PreToolUse event in again. Asserts:
#        - exit code 0
#        - stderr names `persisted-report` as the approval source.
#   5. Runs the codex-user-prompt-submit injector and asserts the
#      Understanding-Gate instruction template lands on stdout.
#
# No real Codex binary is required: the wire format on stdin is
# defined by harness (see
# docs/policy-packs/understanding-before-execution.md "Adapter notes /
# Codex"). Once a Codex CLI integration wraps its native event into
# this envelope, the same harness subcommands serve both surfaces.
#
# Exits non-zero on any unexpected step so CI / a follow-up dogfood
# task can wrap it.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
HARNESS_DIR="${HARNESS_DIR:-$(cd "$ROOT/../.." && pwd)}"
HARNESS_BIN="node $HARNESS_DIR/dist/cli/main.js"
TRANSCRIPT_DIR="$ROOT/transcript"
SESSION="phase6-6-dogfood-$(date +%s)-$$"

mkdir -p "$TRANSCRIPT_DIR"
LOG="$TRANSCRIPT_DIR/run.log"
exec > >(tee "$LOG") 2>&1

# Use a private CWD so the dogfood does not pollute the harness repo's
# .understanding-gate/ directory if one ever exists.
WORKDIR="$TRANSCRIPT_DIR/cwd-$SESSION"
mkdir -p "$WORKDIR"
REPORTS_DIR="$WORKDIR/.understanding-gate/reports"

echo "=========================================="
echo "Phase 6 #6 dogfood — Codex adapter smoke"
echo "=========================================="
echo "session     = $SESSION"
echo "workdir     = $WORKDIR"
echo "manifest    = $ROOT/harness.yaml"
echo "harness bin = $HARNESS_BIN"
echo

# ----------------------------------------------------------------------
# Step 1: harness apply --runtime codex
# ----------------------------------------------------------------------
echo "--- step 1: harness apply --runtime codex ---"
$HARNESS_BIN apply --config "$ROOT/harness.yaml" --runtime codex --quiet
GENERATED="$ROOT/harness.generated"
if [[ ! -f "$GENERATED/codex/config.toml" ]]; then
  echo "FAIL: codex config.toml was not written" >&2
  exit 1
fi
if [[ -f "$GENERATED/settings.json" ]]; then
  echo "FAIL: settings.json should not exist under --runtime codex" >&2
  exit 1
fi
echo "OK: codex config.toml written, settings.json absent"
echo

# ----------------------------------------------------------------------
# Step 2: PreToolUse event with no approval — expect block (exit 2)
# ----------------------------------------------------------------------
echo "--- step 2: PreToolUse without approval — expect block ---"
EVENT_JSON=$(cat <<EOF
{"session_id":"$SESSION","tool_name":"apply_patch","raw_input":{"path":"/tmp/x","patch":"..."}}
EOF
)
set +e
echo "$EVENT_JSON" | $HARNESS_BIN pack hook codex-pre-tool-use \
  --config "$ROOT/harness.yaml" \
  --reports-dir "$REPORTS_DIR" \
  >"$TRANSCRIPT_DIR/block-stdout.txt" \
  2>"$TRANSCRIPT_DIR/block-stderr.txt"
RC=$?
set -e
if [[ "$RC" -ne 2 ]]; then
  echo "FAIL: expected exit 2 (block), got $RC" >&2
  cat "$TRANSCRIPT_DIR/block-stderr.txt" >&2
  exit 1
fi
if ! grep -q "BLOCK" "$TRANSCRIPT_DIR/block-stderr.txt"; then
  echo "FAIL: stderr did not contain BLOCK" >&2
  cat "$TRANSCRIPT_DIR/block-stderr.txt" >&2
  exit 1
fi
echo "OK: block fired with exit 2 + BLOCK on stderr"
echo

# ----------------------------------------------------------------------
# Step 3: drop a persisted report with approvalStatus=approved
# ----------------------------------------------------------------------
echo "--- step 3: write approved persisted report ---"
mkdir -p "$REPORTS_DIR"
APPROVED_REPORT="$REPORTS_DIR/2026-05-10-${SESSION}.json"
cat >"$APPROVED_REPORT" <<EOF
{
  "sessionId": "$SESSION",
  "approvalStatus": "approved",
  "approvedAt": "2026-05-10T12:00:00Z",
  "approvedBy": "phase6-6-dogfood"
}
EOF
echo "OK: wrote $APPROVED_REPORT"
echo

# ----------------------------------------------------------------------
# Step 4: re-run PreToolUse — expect allow (exit 0)
# ----------------------------------------------------------------------
echo "--- step 4: PreToolUse after approval — expect allow ---"
set +e
echo "$EVENT_JSON" | $HARNESS_BIN pack hook codex-pre-tool-use \
  --config "$ROOT/harness.yaml" \
  --reports-dir "$REPORTS_DIR" \
  >"$TRANSCRIPT_DIR/allow-stdout.txt" \
  2>"$TRANSCRIPT_DIR/allow-stderr.txt"
RC=$?
set -e
if [[ "$RC" -ne 0 ]]; then
  echo "FAIL: expected exit 0 (allow), got $RC" >&2
  cat "$TRANSCRIPT_DIR/allow-stderr.txt" >&2
  exit 1
fi
if ! grep -q "persisted report" "$TRANSCRIPT_DIR/allow-stderr.txt"; then
  echo "FAIL: stderr did not name persisted-report as the approval source" >&2
  cat "$TRANSCRIPT_DIR/allow-stderr.txt" >&2
  exit 1
fi
echo "OK: allow path fired via persisted-report source"
echo

# ----------------------------------------------------------------------
# Step 5: UserPromptSubmit injector — instruction template on stdout
# ----------------------------------------------------------------------
echo "--- step 5: UserPromptSubmit injector ---"
set +e
echo '{"prompt":"refactor this module"}' | $HARNESS_BIN pack hook codex-user-prompt-submit \
  --config "$ROOT/harness.yaml" \
  >"$TRANSCRIPT_DIR/inject-stdout.txt" \
  2>"$TRANSCRIPT_DIR/inject-stderr.txt"
RC=$?
set -e
if [[ "$RC" -ne 0 ]]; then
  echo "FAIL: injector exited $RC" >&2
  cat "$TRANSCRIPT_DIR/inject-stderr.txt" >&2
  exit 1
fi
if ! grep -q "Understanding Gate" "$TRANSCRIPT_DIR/inject-stdout.txt"; then
  echo "FAIL: injector did not emit Understanding Gate template" >&2
  cat "$TRANSCRIPT_DIR/inject-stdout.txt" >&2
  exit 1
fi
if ! grep -q "apply_patch" "$TRANSCRIPT_DIR/inject-stdout.txt"; then
  echo "FAIL: injector did not name apply_patch in the gate text" >&2
  exit 1
fi
echo "OK: injector emitted instruction template"
echo

echo "=========================================="
echo "Phase 6 #6 dogfood: PASS"
echo "Transcript: $LOG"
echo "=========================================="
