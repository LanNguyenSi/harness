// Task 7bf47554, fix round 2 (fail-open regression from the ms->seconds
// `hookTimeoutSeconds` unit fix, commit f2d2a29).
//
// Claude Code kills a PreToolUse hook subprocess once its settings.json
// `timeout` (seconds, generate-settings.ts's `hookTimeoutSeconds`) elapses,
// and a killed hook is treated as ALLOW for that tool call — even when the
// hook's own decision was already an internally-computed `deny` /
// `deny-degraded`, if that decision never reached stdout before the kill.
//
// Every blocking (`blocking: "hard"`) `harness policy intercept` hook, and
// every blocking hook in the branch-protection / understanding-before-
// execution / post-merge-gate builtin policy packs, performs at least one
// live grounding-mcp round-trip before it can write its stdout decision:
//   - a `requires:`-based policy queries the ledger for its verdict
//     (src/runtime/intercept.ts, `evaluateOnePolicy`, the
//     `options.ledger.query(...)` call).
//   - EVERY policy that reaches a verdict — including the intercept
//     engine's pure `operator_only` pattern-denies (deny-kill-switch-bash /
//     deny-session-env-strip-bash / deny-sentinel-write-bash), whose
//     verdict itself needs no ledger read — still has that verdict written
//     to the ledger via the UNCONDITIONAL `options.ledger.record(...)` call
//     in `intercept()`'s evaluation loop (src/runtime/intercept.ts,
//     ~L1362-1377) before `intercept()` returns and stdout is flushed. See
//     the budget-note comment above `require-review-evidence` in
//     src/cli/init/templates.ts for the full trace this test's invariant
//     is derived from.
//   - the three policy-pack blockers (`harness pack hook branch-protection`
//     / `harness pack hook pre-tool-use` / `harness pack hook codex-pre-
//     tool-use` / `harness pack hook post-merge-gate`) each run an
//     unconditional `queryLedgerByTag` / `checkLedger` probe on every
//     invocation, bounded by the same `health.timeout_ms`.
//
// This test pins the invariant the raised budgets (task 7bf47554) exist to
// satisfy: for every such hook shipped in FULL_TEMPLATE and the three
// builtin packs it wires, the Claude Code outer timeout
// (`ceil(budget_ms / 1000)`) must clear the worst-case ledger round-trip
// time — the query's own `health.timeout_ms` plus the deny-degraded
// audit-write retry's two calls (`auditRetryTimeoutMs`,
// src/cli/policy/intercept.ts) — with margin, so the hook can always
// finish (allow, deny, OR deny-degraded) before Claude Code would kill it.
//
// Deliberately a LIGHT version of the fuller drift-guard task d20a7e0c is
// tracking (not yet implemented): this test is scoped to the hooks and
// constants that exist today, but it is pinned against the REAL shipped
// FULL_TEMPLATE and the real policy-pack `resolve()` output — not a
// hardcoded hook-name list — so it goes red both when a budget regresses
// AND when a new blocking, `harness policy intercept`-routed hook is added
// to the template without a safe budget.

import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { FULL_TEMPLATE } from "../../src/cli/init/templates.js";
import { parseManifest, type Hook, type Manifest } from "../../src/schema/index.js";
import { auditRetryTimeoutMs } from "../../src/cli/policy/intercept.js";
import { resolve as resolveBranchProtection } from "../../src/policy-packs/builtin/branch-protection.js";
import { resolve as resolvePostMergeGate } from "../../src/policy-packs/builtin/post-merge-gate.js";
import { resolve as resolveUnderstandingBeforeExecution } from "../../src/policy-packs/builtin/understanding-before-execution.js";
import { KNOWN_RUNTIMES } from "../../src/policy-packs/runtime.js";

function loadFullTemplateManifest(): Manifest {
  return parseManifest(parseYaml(FULL_TEMPLATE));
}

/**
 * Claude Code's own outer-timeout formula (generate-settings.ts's
 * `hookTimeoutSeconds`), re-derived here rather than imported: this test
 * pins the OBSERVABLE outer timeout a budget_ms produces, independent of
 * that helper's own internals (including its per-command floor, which is
 * irrelevant once budget_ms is already >= the floor).
 */
function outerTimeoutSeconds(budgetMs: number): number {
  return Math.ceil(budgetMs / 1000);
}

/**
 * Worst-case ledger round-trip a blocking hook may have to complete before
 * it can write its decision: the query's own budget (`health.timeout_ms`)
 * plus a deny-degraded audit-write retry's two calls (initialize +
 * ledger_add), each bounded by `auditRetryTimeoutMs` — the same bound
 * `realLedgerClient`'s own doc comment states (src/cli/policy/intercept.ts,
 * the block above `auditRetryTimeoutMs`'s call sites).
 */
function requiredMarginSeconds(ledgerTimeoutMs: number): number {
  return Math.ceil((ledgerTimeoutMs + 2 * auditRetryTimeoutMs(ledgerTimeoutMs)) / 1000);
}

const manifest = loadFullTemplateManifest();
const groundingMcp = manifest.tools.mcp.find((m) => m.name === "grounding-mcp");
const LEDGER_TIMEOUT_MS = groundingMcp?.health?.timeout_ms ?? 5000;
const REQUIRED_SECONDS = requiredMarginSeconds(LEDGER_TIMEOUT_MS);

function assertHookClearsMargin(hook: Hook): void {
  const actual = outerTimeoutSeconds(hook.budget_ms);
  expect(
    actual,
    `hook "${hook.name}" (budget_ms=${hook.budget_ms}, outer timeout=${actual}s) ` +
      `must clear the worst-case ledger round-trip (${REQUIRED_SECONDS}s: ` +
      `health.timeout_ms=${LEDGER_TIMEOUT_MS}ms + deny-degraded audit retry), ` +
      `or a hung/slow ledger can get this blocking hook killed by Claude Code ` +
      `before its deny JSON reaches stdout — turning a fail-closed verdict into ` +
      `an unintended allow.`,
  ).toBeGreaterThanOrEqual(REQUIRED_SECONDS);
}

describe("blocking ledger-consulting hooks clear the ledger's worst-case round-trip (task 7bf47554)", () => {
  it("every blocking `harness policy intercept` hook in FULL_TEMPLATE clears the margin", () => {
    const interceptHooks = manifest.hooks.filter(
      (h) => h.command.trim() === "harness policy intercept" && h.blocking === "hard",
    );
    // Sanity floor: fails loud if a future template refactor silently
    // drops all policy-intercept wiring instead of this test vacuously
    // passing over an empty array.
    expect(interceptHooks.length).toBeGreaterThanOrEqual(9);
    for (const hook of interceptHooks) {
      assertHookClearsMargin(hook);
    }
  });

  it("branch-protection's blocking hook clears the margin (both runtimes)", () => {
    const pack = manifest.policy_packs.find((p) => p.name === "branch-protection");
    expect(pack).toBeDefined();
    if (!pack) return;
    for (const runtime of KNOWN_RUNTIMES) {
      const { contribution } = resolveBranchProtection(pack, runtime);
      const blocking = contribution.hooks.filter((h) => h.blocking === "hard");
      expect(blocking.length, `runtime ${runtime}`).toBe(1);
      for (const hook of blocking) assertHookClearsMargin(hook);
    }
  });

  it("understanding-before-execution's blocking hook clears the margin (both runtimes)", () => {
    const pack = manifest.policy_packs.find((p) => p.name === "understanding-before-execution");
    expect(pack).toBeDefined();
    if (!pack) return;
    for (const runtime of KNOWN_RUNTIMES) {
      const { contribution } = resolveUnderstandingBeforeExecution(pack, runtime);
      const blocking = contribution.hooks.filter((h) => h.blocking === "hard");
      expect(blocking.length, `runtime ${runtime}`).toBe(1);
      for (const hook of blocking) assertHookClearsMargin(hook);
    }
  });

  it("post-merge-gate's blocking hook clears the margin (shipped disabled by default; definition still pinned)", () => {
    const pack = manifest.policy_packs.find((p) => p.name === "post-merge-gate");
    expect(pack).toBeDefined();
    if (!pack) return;
    const { contribution } = resolvePostMergeGate(pack, "claude-code");
    const blocking = contribution.hooks.filter((h) => h.blocking === "hard");
    expect(blocking.length).toBe(1);
    for (const hook of blocking) assertHookClearsMargin(hook);
  });

  // Mutation-probe control (not a normal regression pin): documents that
  // this test genuinely discriminates. If a budget_ms regressed back to
  // the pre-fix ~1-2s floor, `assertHookClearsMargin` above must go red.
  it("control: a hook at the pre-fix 2000ms budget does NOT clear the margin", () => {
    const staleHook: Hook = {
      name: "control-only",
      event: "PreToolUse",
      command: "harness policy intercept",
      blocking: "hard",
      budget_ms: 2000,
    };
    expect(outerTimeoutSeconds(staleHook.budget_ms)).toBeLessThan(REQUIRED_SECONDS);
  });
});
