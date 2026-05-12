#!/usr/bin/env bash
# Phase 5 #1a, rewritten on top of `harness smoke` (task 78a23aed).
#
# The original 2026-05-03 recipe was a hand-rolled bash invocation of
# `claude -p ... --output-format stream-json --include-hook-events ...`
# whose output was greppy'd by hand for hook events and result.is_error.
# The `harness smoke` verb owns all of that: argv-building, env
# injection (HARNESS_POLICY_VERBOSE=1), stream capture, timeout
# escalation, assertion evaluation, forensic-file invariants.
#
# This script is the new canonical recipe. The synthetic-stdin smoke at
# `run-smoke.sh` still exists for the no-claude pipeline-only check.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
HARNESS_DIR="${HARNESS_DIR:-$(cd "$ROOT/../.." && pwd)}"
HARNESS_BIN="${HARNESS_BIN:-node $HARNESS_DIR/dist/cli/main.js}"

# Per-invocation transcript directory so repeat runs do not clobber.
STAMP=$(date +%Y-%m-%d-%H%M%S)
OUTPUT_DIR="${OUTPUT_DIR:-$ROOT/transcript-claude-p-$STAMP}"

# Render the manifest with HARNESS_DIR substituted (same trick as
# run-smoke.sh) so this works from any checkout layout, not just Lan's.
MANIFEST_SRC="$ROOT/harness.yaml"
MANIFEST_RENDERED="$OUTPUT_DIR/effective-manifest.yaml"
mkdir -p "$OUTPUT_DIR"
sed "s|/home/lan/git/pandora/harness|$HARNESS_DIR|g" "$MANIFEST_SRC" \
  >"$MANIFEST_RENDERED"

echo "================================================================"
echo "Phase 5 #1a (rewritten): harness smoke --prompt 'say hi'"
echo "================================================================"
echo "harness dir = $HARNESS_DIR"
echo "manifest    = $MANIFEST_RENDERED"
echo "output dir  = $OUTPUT_DIR"
echo

# `say hi` is the same prompt as the 2026-05-03 baseline. The
# manifest's only PreToolUse matcher targets
# mcp__agent-tasks__pull_requests_merge, which `say hi` does not
# trigger, so the policy-hook does not fire here and --expect-exit=0
# is the only universal assertion. Operators chasing the policy path
# should follow this with a merge-themed prompt and
# --expect-decision deny against an empty ledger.
$HARNESS_BIN smoke \
  --config "$MANIFEST_RENDERED" \
  --prompt "say hi" \
  --output-dir "$OUTPUT_DIR" \
  --expect-exit 0 \
  --timeout-ms 60000

echo
echo "================================================================"
echo "SMOKE COMPLETE: artefacts under $OUTPUT_DIR"
echo "================================================================"
