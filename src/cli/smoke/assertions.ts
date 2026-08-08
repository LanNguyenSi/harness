// Phase 7 follow-up: `harness smoke` assertion engine.
//
// Operators pass any combination of --expect-hook / --expect-no-hook /
// --expect-exit / --expect-decision; this module turns each one into a
// pass/fail check against the parsed StreamSummary and returns a
// one-line diff per failure. The smoke CLI exits non-zero iff at least
// one failure is reported (EX_FAIL), so forensic stream + stderr files
// are always written before any assertion is evaluated.

import type { HookPair, StreamSummary } from "./stream-parser.js";

export type ExpectDecision = "allow" | "deny" | "warn";

export interface SmokeExpectations {
  /** Hook names or events that MUST have fired. */
  expectHooks?: string[];
  /** Hook names or events that MUST NOT have fired. */
  expectNoHooks?: string[];
  /** Terminal `result.is_error` is true iff this matches `expect-exit != 0`. */
  expectExit?: number;
  /** Last policy-intercept decision must match. */
  expectDecision?: ExpectDecision;
}

export interface AssertionFailure {
  kind: "expect-hook" | "expect-no-hook" | "expect-exit" | "expect-decision";
  expected: string;
  actual: string;
  detail: string;
}

/**
 * Match a user-supplied "hook" target against a stream hook entry by
 * name or by event. The Phase 5 transcripts emit `hook_name` and
 * `hook_event` independently (sometimes equal, sometimes not); the
 * task-defined --expect-hook value semantically refers to whichever
 * the operator finds in their generated settings.json. Matching either
 * field keeps the verb tolerant across Claude Code releases that may
 * swap which field carries the user-defined name.
 */
function hookMatches(pair: HookPair, target: string): boolean {
  return pair.hookName === target || pair.hookEvent === target;
}

function summariseHooks(hooks: HookPair[]): string {
  if (hooks.length === 0) return "(no hook events observed)";
  const labels = hooks.map((h) => {
    const id = h.hookName || h.hookEvent || "(unnamed)";
    const tag = h.response === null ? "[no response]" : h.outcome ?? "?";
    return `${id}:${tag}`;
  });
  return labels.join(", ");
}

/**
 * Classify the policy decision emitted by `harness policy intercept`.
 *
 * The intercept CLI contract (PR #81): on `deny`, stdout carries the
 * Claude Code 2.1+ envelope (`decision:"block"` AND
 * `hookSpecificOutput.permissionDecision:"deny"`). On `allow`, stdout
 * is empty. On `warn-degraded`, stdout is empty AND stderr carries the
 * Phase 5 #3 diagnostic line (`warn-degraded (ledger unreachable)`)
 * when HARNESS_POLICY_VERBOSE is on. `harness smoke` sets that env var
 * unconditionally when spawning claude, so the warn branch is
 * observable.
 *
 * Order of detection: deny first (any hook stdout containing the
 * envelope), then warn (any hook stderr containing the diagnostic),
 * then allow if at least one policy-shaped hook fired without a deny
 * stdout, else `null` (no policy hook in the stream, so the assertion
 * is N/A and must be reported as a miss).
 *
 * `deny-degraded` (task f1aea826) is classified as deny by this same
 * ordering: it emits the stdout block envelope, and the deny check runs
 * BEFORE the stderr `warn-degraded` substring check — that ordering is
 * load-bearing, since a deny-degraded event's stderr diagnostic line
 * does not contain the string "warn-degraded" anyway.
 */
export function classifyDecision(
  hooks: HookPair[],
): ExpectDecision | null {
  for (const h of hooks) {
    if (
      h.stdout.includes('"decision":"block"') &&
      h.stdout.includes('"permissionDecision":"deny"')
    ) {
      return "deny";
    }
  }
  for (const h of hooks) {
    if (h.stderr.includes("warn-degraded")) {
      return "warn";
    }
  }
  // Heuristic: any PreToolUse hook is potentially policy-driven. If
  // there are no PreToolUse hooks at all, decision is N/A.
  //
  // Known false-positive: a manifest can wire non-policy PreToolUse
  // hooks (audit/logging shims) alongside `harness policy intercept`.
  // If only the non-policy hook fired and no policy was evaluated at
  // all, this still classifies as `allow`. Operators chasing the
  // policy-bypass case should pair `--expect-decision deny` with a
  // prompt that is known to trigger the policy's tool matcher, so the
  // assertion fails loudly on a missing fire.
  const sawPreToolUse = hooks.some(
    (h) => h.hookEvent === "PreToolUse" || h.hookName === "PreToolUse",
  );
  return sawPreToolUse ? "allow" : null;
}

export function evaluateExpectations(
  summary: StreamSummary,
  expectations: SmokeExpectations,
): AssertionFailure[] {
  const failures: AssertionFailure[] = [];

  for (const target of expectations.expectHooks ?? []) {
    const seen = summary.hooks.some((h) => hookMatches(h, target));
    if (!seen) {
      failures.push({
        kind: "expect-hook",
        expected: `hook "${target}" fires at least once`,
        actual: summariseHooks(summary.hooks),
        detail:
          `--expect-hook="${target}" was not observed in the stream. ` +
          `Observed hooks: ${summariseHooks(summary.hooks)}`,
      });
    }
  }

  for (const target of expectations.expectNoHooks ?? []) {
    const seen = summary.hooks.some((h) => hookMatches(h, target));
    if (seen) {
      failures.push({
        kind: "expect-no-hook",
        expected: `hook "${target}" does NOT fire`,
        actual: `hook "${target}" fired ${summary.hooks.filter((h) => hookMatches(h, target)).length} time(s)`,
        detail:
          `--expect-no-hook="${target}" was observed in the stream. ` +
          `Full hook trace: ${summariseHooks(summary.hooks)}`,
      });
    }
  }

  if (expectations.expectExit !== undefined) {
    const want = expectations.expectExit;
    // `claude -p` does not emit a numeric exit code in the stream;
    // it emits `result.is_error: boolean`. We map:
    //   expectExit === 0  ⇒  is_error must be false
    //   expectExit !== 0  ⇒  is_error must be true
    // The exact numeric exit ladder is preserved in the spawn-side exit
    // code (returned from the runner), so callers who need the literal
    // number can inspect SmokeResult.claudeExitCode.
    const isError = summary.result?.is_error ?? null;
    const wantsError = want !== 0;
    if (isError === null) {
      failures.push({
        kind: "expect-exit",
        expected: `terminal result.is_error=${wantsError}`,
        actual: "(no terminal result event observed)",
        detail:
          `--expect-exit=${want} could not be evaluated: the stream ended ` +
          "without a terminal `result` event. claude likely crashed or was killed mid-run.",
      });
    } else if (isError !== wantsError) {
      failures.push({
        kind: "expect-exit",
        expected: `is_error=${wantsError} (--expect-exit=${want})`,
        actual: `is_error=${isError}`,
        detail:
          `--expect-exit=${want} expected is_error=${wantsError} but the terminal ` +
          `result event reports is_error=${isError}.`,
      });
    }
  }

  if (expectations.expectDecision !== undefined) {
    const observed = classifyDecision(summary.hooks);
    if (observed === null) {
      failures.push({
        kind: "expect-decision",
        expected: `policy decision = ${expectations.expectDecision}`,
        actual: "no PreToolUse hook fired",
        detail:
          `--expect-decision=${expectations.expectDecision} requires at least one ` +
          "PreToolUse hook in the stream; none observed.",
      });
    } else if (observed !== expectations.expectDecision) {
      failures.push({
        kind: "expect-decision",
        expected: `policy decision = ${expectations.expectDecision}`,
        actual: `policy decision = ${observed}`,
        detail:
          `--expect-decision=${expectations.expectDecision} but the last observable ` +
          `policy decision was ${observed}.`,
      });
    }
  }

  return failures;
}

export function formatFailures(failures: AssertionFailure[]): string {
  if (failures.length === 0) return "";
  const lines: string[] = [];
  lines.push(`harness smoke: ${failures.length} assertion(s) failed:`);
  for (const f of failures) {
    lines.push(`  - [${f.kind}] expected ${f.expected}; got ${f.actual}`);
  }
  return `${lines.join("\n")}\n`;
}
