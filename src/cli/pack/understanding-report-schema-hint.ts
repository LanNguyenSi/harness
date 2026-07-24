// Single source of truth (within harness) for the Understanding-Report
// schema hint that the PreToolUse gate emits when blocking a tool call.
//
// The canonical parser lives in `@lannguyensi/understanding-gate`
// (its `core/parser.js` SECTIONS array). Harness inlines the section
// names here so the gate's block message tells the agent exactly what
// to produce — without this, a freeform prose report parses to "Missing
// required sections" and the audit trail is silently empty even though
// the gate-approval marker still gets written.
//
// Drift risk: if the standalone parser adds, renames, or reorders
// sections, this constant goes out of sync. Mitigation:
//   1. Keep the comment + linked file path at the top, so a reviewer
//      who touches the standalone parser notices the harness mirror.
//   2. The standalone Stop hook still logs the actual reject-list to
//      `.understanding-gate/parse-errors/`, so a stale harness hint
//      gracefully degrades to "your report has the wrong sections —
//      here is what the parser wanted" rather than silent failure.

export const UNDERSTANDING_REPORT_REQUIRED_SECTIONS = [
  "Current Understanding (paragraph)",
  "Intended Outcome (paragraph)",
  "Derived Todos (list)",
  "Acceptance Criteria (list)",
  "Assumptions (list)",
  "Open Questions (list)",
  "Out Of Scope (list)",
  "Risks (list)",
  "Verification Plan (list)",
  // Section 10 (agent-grounding 0.4.0): state what was searched for an
  // existing solution and what was found, with an explicit
  // adopt-or-build judgment. Required by the Stop-capture parser in
  // grill_me / full mode; relaxed in fast_confirm. See harness task
  // 798d7173 / agent-grounding PR #85.
  "Prior Art (list)",
] as const;

/**
 * Render a compact, agent-readable hint listing the canonical sections
 * the `@lannguyensi/understanding-gate` parser expects. Suitable for
 * inlining in a `permissionDecisionReason` string (claude-code) or a
 * stderr diagnostic (codex).
 *
 * Format chosen for legibility in both a JSON-stringified block envelope
 * and a plain stderr write: single newline-separated lines, "- " bullets,
 * no surrounding code-fence (Claude Code wraps the reason in its own
 * formatter, and stderr is read as-is by the operator).
 */
export function renderReportSchemaHint(): string {
  // Note on the intro wording: the previous iteration included an "e.g."
  // alias example ("Current Understanding" or "My Current Understanding")
  // that suggested those two were the canonical pair. The parser
  // actually accepts more aliases (e.g. `derivedTodos` ⇄ "todos", "derived
  // todos / specs"; `verificationPlan` ⇄ "verification"), and listing
  // one pair implied exhaustiveness. The bullets below show the canonical
  // names; the parser's alias-tolerance is a quiet bonus, not something
  // the agent needs to choose between.
  const intro =
    "Report format (parsed by `@lannguyensi/understanding-gate`): markdown with these ten sections, any heading level (#, ##, ###), names case-insensitive. Sections marked (list) need markdown list items ('- ' or '1.') in the body — a prose paragraph under a (list) heading is rejected the same as a missing section. Missing any section produces a parse-error under `.understanding-gate/parse-errors/` and the audit trail is empty even though the gate-approval marker still gets written.";
  const bullets = UNDERSTANDING_REPORT_REQUIRED_SECTIONS.map((s) => `  - ${s}`).join("\n");
  // Submission recipe (task 61fd36db): the Stop-hook producer fires only
  // at END of turn — after `harness approve understanding` already ran —
  // so attaching the report to the approve command itself is the one
  // path that reliably persists it. The gate's escape matcher accepts
  // exactly this heredoc shape (see approve-escape.ts).
  const submit =
    "To persist the report for audit, attach it to the approval command as a quoted heredoc " +
    "(the only extra shape the gate allows — no other pipes, chaining, or redirection):\n" +
    "  harness approve understanding <<'UNDERSTANDING_REPORT'\n" +
    "  ## Understanding Report\n" +
    "  ...your report...\n" +
    "  UNDERSTANDING_REPORT";
  return `${intro}\n${bullets}\n${submit}`;
}
