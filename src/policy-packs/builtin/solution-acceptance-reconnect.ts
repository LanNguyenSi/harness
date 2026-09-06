// Reconnect-vs-retry facts for the `solution-acceptance` pack (task
// 5c9cad05), owned as DATA in exactly one place so the two rendered
// surfaces cannot drift apart the way they did across review rounds 1-2:
//
//   1. `buildInstructions` (solution-acceptance.ts) renders the operator
//      audit copy's "Reconnecting vs. retrying" section from
//      `renderReconnectInstructionsSection`.
//   2. `blockJson` (../../cli/pack/hook-solution-acceptance.ts) renders the
//      agent-facing deny paragraph from `renderReconnectDenyParagraph`,
//      shown only when `gate.verdict === null` (no readable verdict
//      marker: covers three readings, see `RECONNECT_THREE_READINGS_LABELS`
//      below).
//
// Both renderers are built from the SAME fact constants below (not just
// the same values restated in prose twice), and
// `tests/policy-packs/solution-acceptance-reconnect.test.ts` asserts each
// fact constant appears verbatim in both rendered surfaces, so a future
// edit that updates one surface but not the other fails that test instead
// of shipping a silent drift.
//
// Scope: this module documents grounding-mcp's ATTEMPT lifecycle
// (`solution_evaluate_status` / `solution_evaluate_result`, `attemptId`,
// `pollAfterMs`, retention), which the pack's producer floor (>= 0.3.2)
// does not itself guarantee (that lifecycle shipped in grounding-mcp
// 0.11.0), so every rendering below is explicitly qualified with
// `RECONNECT_VERSION_QUALIFIER` rather than stated as if it held
// unconditionally under the pack's own (older) producer floor.
//
// grounding-mcp's README also documents an attempt-lock anchor
// (`<verdict dir>/<id>.attempt-lock`, beside the
// `<id>.attempt-lock.lock` directory `proper-lockfile` manages, from
// which the producer itself derives its own `running-unconfirmed`
// status) that would let the deny text rule out two of the three
// readings below and narrow to just the in-flight case. This module
// does NOT read it: doing so is a second cross-repo coupling to the
// producer's lock-file layout, with its own stale-lock semantics to
// absorb, out of scope for a text-surface change (a follow-up narrows
// this by reading that anchor). Every rendering below states this as a
// scope decision, not as "the hook has no signal at all".

/** The grounding-mcp version this reconnect lifecycle was verified against. */
export const RECONNECT_PRODUCER_FLOOR = "grounding-mcp >= 0.11.0";

/** Rendered qualifier prefix both surfaces open the guidance with. */
export const RECONNECT_VERSION_QUALIFIER = `With ${RECONNECT_PRODUCER_FLOOR}:`;

export const RECONNECT_STATUS_TOOL = "mcp__grounding-mcp__solution_evaluate_status";
export const RECONNECT_RESULT_TOOL = "mcp__grounding-mcp__solution_evaluate_result";

export const RECONNECT_POLL_MS_ADVERTISED = "5000ms";
export const RECONNECT_RETENTION = "24h";
export const RECONNECT_RETENTION_FLOOR = "100x pollAfterMs";

/**
 * The three readings `gate.verdict === null` covers, deliberately left
 * unresolved by this text surface: this module does not read the
 * documented attempt-lock anchor (scope decision, see the module header
 * above and the follow-up it names), so it cannot rule any of the three
 * out from here.
 */
export const RECONNECT_THREE_READINGS_LABELS = [
  "solution_evaluate was never called for this id",
  "a call for it is still running in the background",
  "a marker exists but could not be read or parsed",
] as const;

/** Fact 1: reconnect by attempt id, not by starting a fresh call. */
export const RECONNECT_FACT_RECONNECT_BY_ID =
  `poll \`${RECONNECT_STATUS_TOOL}\` / \`${RECONNECT_RESULT_TOOL}\` for the SAME id, passing ` +
  `the attemptId you were given (or omitting it to resolve the latest attempt, the recovery ` +
  `path when your own call timed out before it ever returned one)`;

/**
 * Fact 2: never retry while the lock is held; a second call JOINS, it does
 * not refuse. Both renderers use this fact as a fresh sentence (after a
 * period), so it is capitalized.
 */
export const RECONNECT_FACT_JOIN_NOT_RETRY =
  `A second solution_evaluate call for an id whose attempt is still live just joins that ` +
  `attempt and returns its attemptId, never starting a second preflight run; only ` +
  `forceNewAttempt is refused while that attempt's lock holds`;

/**
 * Fact 3: poll interval and retention bounds, from the released
 * grounding-mcp version. Both renderers use this fact as a fresh sentence
 * (after a period), so it is capitalized.
 */
export const RECONNECT_FACT_POLL_AND_RETENTION =
  `Wait at least the returned pollAfterMs (advertised as ${RECONNECT_POLL_MS_ADVERTISED}) ` +
  `between polls; attempt records are retained ${RECONNECT_RETENTION} by default (always at ` +
  `least ${RECONNECT_RETENTION_FLOOR}), and a pruned terminal attempt reads "expired"`;

/** The three readings, as one clause, with the task id interpolated. */
function threeReadingsClause(taskId: string): string {
  const [neverCalled, stillRunning, unreadable] = RECONNECT_THREE_READINGS_LABELS;
  return (
    `${neverCalled.replace("this id", `"${taskId}"`)}, ${stillRunning}, or ${unreadable}`
  );
}

/**
 * Compact paragraph appended to the completion-gate's deny reason
 * (`blockJson` in hook-solution-acceptance.ts) when `gate.verdict ===
 * null`. Renders the SAME fact constants as
 * `renderReconnectInstructionsSection` below.
 */
export function renderReconnectDenyParagraph(taskId: string): string {
  return (
    `\n` +
    `Reconnecting vs. retrying. ${RECONNECT_VERSION_QUALIFIER} this same "no readable ` +
    `verdict marker" message fires whether ${threeReadingsClause(taskId)} (the verdict marker ` +
    `only appears once an attempt finishes, and is validated on read; this hook does not read ` +
    `the documented attempt-lock anchor, so it cannot rule any of these three apart from ` +
    `here). If you already called solution_evaluate for this id, do not call it again: ` +
    `${RECONNECT_FACT_RECONNECT_BY_ID}. ${RECONNECT_FACT_JOIN_NOT_RETRY}. ` +
    `${RECONNECT_FACT_POLL_AND_RETENTION}.\n`
  );
}

/**
 * "Reconnecting vs. retrying" section body rendered into the pack's
 * `instructions.md` operator audit copy (`buildInstructions` in
 * solution-acceptance.ts). Renders the SAME fact constants as
 * `renderReconnectDenyParagraph` above; a large repo can outlive a single
 * `solution_evaluate` call, so this section documents reconnecting to an
 * in-flight attempt rather than treating a timeout as a stall to retry.
 */
export function renderReconnectInstructionsSection(): string {
  return `## Reconnecting vs. retrying (${RECONNECT_PRODUCER_FLOOR})

${RECONNECT_VERSION_QUALIFIER} a large repo can outlive the call: \`solution_evaluate\` may
hand back \`{status: "running", attemptId, id, pollAfterMs}\` instead of a verdict, or your
own call may time out with nothing at all. Either way the \`preflight\` run keeps going in
the background; ${RECONNECT_FACT_RECONNECT_BY_ID}.

Never re-call \`solution_evaluate\` as a stall workaround: ${RECONNECT_FACT_JOIN_NOT_RETRY}.
A prior attempt's reported status (\`completed\`,
\`failed\`, \`unknown\`, or \`expired\`) is informational, not the gate: \`unknown\`/
\`expired\` never license a new attempt by themselves while another process still holds the
id's lock. A genuinely new attempt becomes possible only once the previous one is terminal and
the id's lock is free again, at which point an ordinary \`solution_evaluate\` call starts
one.

${RECONNECT_FACT_POLL_AND_RETENTION}. \`running-unconfirmed\` still means keep
polling, not stall or escalate: it resolves by itself, into \`running\`
or once the lock is reclaimed as stale. Never escalate to a human before
the poll hint has elapsed.
`;
}
