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
// satisfy, against EVERY manifest-emitting surface that can ship one of
// these blocking hooks, not just FULL_TEMPLATE: FULL_TEMPLATE itself, the
// `harness init --interactive` Custom composer (src/cli/init/composer.ts),
// and the `team` profile template (src/cli/init/profiles.ts). Fix round 1
// (commit e409e73) raised FULL_TEMPLATE's own budgets but left the
// composer's HOOK_FOR_POLICY table and TEAM_TEMPLATE at their pre-fix
// 1000-2000ms budgets — the exact same fail-open gap, reachable via a
// different init surface. `solo` never ships a blocking `harness policy
// intercept` hook at all (no agent-tasks-coupled or Bash-triggered
// evidence policy in that profile), so it is checked as a negative
// control: the intended profile-independent floor is "raise it if you ship
// it", not "every profile must ship one".

import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { FULL_TEMPLATE } from "../../src/cli/init/templates.js";
import { SOLO_TEMPLATE, TEAM_TEMPLATE } from "../../src/cli/init/profiles.js";
import {
  composeCustom,
  COMPOSABLE_POLICIES,
  type CustomSelection,
} from "../../src/cli/init/composer.js";
import { parseManifest, type Hook, type Manifest } from "../../src/schema/index.js";
import { auditRetryTimeoutMs } from "../../src/cli/policy/intercept.js";
import { resolve as resolveBranchProtection } from "../../src/policy-packs/builtin/branch-protection.js";
import { resolve as resolvePostMergeGate } from "../../src/policy-packs/builtin/post-merge-gate.js";
import { resolve as resolveUnderstandingBeforeExecution } from "../../src/policy-packs/builtin/understanding-before-execution.js";
import { KNOWN_RUNTIMES } from "../../src/policy-packs/runtime.js";

function loadFullTemplateManifest(): Manifest {
  return parseManifest(parseYaml(FULL_TEMPLATE));
}

function loadTeamTemplateManifest(): Manifest {
  return parseManifest(parseYaml(TEAM_TEMPLATE));
}

function loadSoloTemplateManifest(): Manifest {
  return parseManifest(parseYaml(SOLO_TEMPLATE));
}

/** Every reference policy the Custom composer surfaces, all selected at once
 * so `composeCustom` emits every row of its internal HOOK_FOR_POLICY table
 * (deduped: two-reviewers-required shares require-review-evidence with
 * review-before-merge, so this yields 5 distinct hook names, not 6). */
function loadComposerManifest(): Manifest {
  const sel: CustomSelection = {
    packs: [],
    mcps: [],
    policies: COMPOSABLE_POLICIES.map((p) => p.key),
  };
  return parseManifest(parseYaml(composeCustom(sel).yaml));
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

const fullManifest = loadFullTemplateManifest();
const groundingMcp = fullManifest.tools.mcp.find((m) => m.name === "grounding-mcp");
const LEDGER_TIMEOUT_MS = groundingMcp?.health?.timeout_ms ?? 5000;
const REQUIRED_SECONDS = requiredMarginSeconds(LEDGER_TIMEOUT_MS);

/**
 * HARD FLOOR (task 7bf47554, fix round 2 of fix round 2): the formula-based
 * `REQUIRED_SECONDS` above (health.timeout_ms + 2x auditRetryTimeoutMs =
 * ~8s for the shipped 5000ms grounding-mcp health timeout) UNDERSTATES the
 * measured real-world worst case. `src/cli/init/templates.ts`'s budget-note
 * comment above `require-review-evidence` (and this task's CHANGELOG entry)
 * both pin the measured subprocess wall-time worst case at ~10.8-13.75s —
 * a live ledger query PLUS a fresh-session deny-degraded retry (initialize
 * + ledger_add) is slower in practice than the formula's idealised sum.
 * 15000ms (the value every surface in this file is pinned to) is the
 * actual shipped floor with real margin over that ~13.75s figure, not just
 * over the ~8s formula. Asserting the formula alone would let a partial
 * regression into [8000, 13000]ms — clearing REQUIRED_SECONDS but still
 * under the measured worst case — pass green; this constant closes that
 * gap. Tightening this number is exactly the fuller drift-guard task
 * d20a7e0c is tracking (a general schema-level minimum, not one hardcoded
 * here); until that lands, this is the enforced floor.
 */
const HARD_FLOOR_BUDGET_MS = 15000;

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

/**
 * The hard, measurement-derived floor (see HARD_FLOOR_BUDGET_MS above):
 * every blocking ledger-consulting `harness policy intercept` hook must
 * carry budget_ms >= 15000 outright, not merely clear the ~8s formula.
 */
function assertHookMeetsHardFloor(hook: Hook): void {
  expect(
    hook.budget_ms,
    `hook "${hook.name}" (budget_ms=${hook.budget_ms}) must be >= ` +
      `${HARD_FLOOR_BUDGET_MS}ms — the measured ~10.8-13.75s subprocess ` +
      `wall-time worst case (src/cli/init/templates.ts budget-note, task ` +
      `7bf47554) leaves too little margin below this floor even though it ` +
      `clears the looser health.timeout_ms-only formula.`,
  ).toBeGreaterThanOrEqual(HARD_FLOOR_BUDGET_MS);
}

function blockingInterceptHooks(manifest: Manifest): Hook[] {
  return manifest.hooks.filter(
    (h) => h.command.trim() === "harness policy intercept" && h.blocking === "hard",
  );
}

describe("blocking ledger-consulting hooks clear the ledger's worst-case round-trip (task 7bf47554)", () => {
  it("every blocking `harness policy intercept` hook in FULL_TEMPLATE clears the margin and the hard floor", () => {
    const interceptHooks = blockingInterceptHooks(fullManifest);
    // Sanity floor: fails loud if a future template refactor silently
    // drops all policy-intercept wiring instead of this test vacuously
    // passing over an empty array.
    expect(interceptHooks.length).toBeGreaterThanOrEqual(9);
    for (const hook of interceptHooks) {
      assertHookClearsMargin(hook);
      assertHookMeetsHardFloor(hook);
    }
  });

  it("every blocking `harness policy intercept` hook the Custom composer can emit clears the margin and the hard floor (task 7bf47554, fix round 2)", () => {
    const interceptHooks = blockingInterceptHooks(loadComposerManifest());
    // 5 distinct hooks: review-before-merge, preflight-before-investigation,
    // review-subagent-before-pr-create, preflight-before-push,
    // dogfood-before-release. two-reviewers-required dedupes onto
    // review-before-merge's row (same hook name), so selecting all 6
    // COMPOSABLE_POLICIES yields 5, not 6.
    expect(interceptHooks.length).toBe(5);
    for (const hook of interceptHooks) {
      assertHookClearsMargin(hook);
      assertHookMeetsHardFloor(hook);
    }
  });

  it("TEAM_TEMPLATE's blocking `harness policy intercept` hook clears the margin and the hard floor (task 7bf47554, fix round 2)", () => {
    const interceptHooks = blockingInterceptHooks(loadTeamTemplateManifest());
    expect(interceptHooks.length).toBe(1);
    for (const hook of interceptHooks) {
      assertHookClearsMargin(hook);
      assertHookMeetsHardFloor(hook);
    }
  });

  it("negative control: SOLO_TEMPLATE ships NO blocking `harness policy intercept` hook (nothing to raise; pins the profile-independent floor is 'raise it if shipped', not 'every profile ships one')", () => {
    const interceptHooks = blockingInterceptHooks(loadSoloTemplateManifest());
    expect(interceptHooks).toEqual([]);
  });

  it("branch-protection's blocking hook clears the margin and the hard floor (both runtimes)", () => {
    const pack = fullManifest.policy_packs.find((p) => p.name === "branch-protection");
    expect(pack).toBeDefined();
    if (!pack) return;
    for (const runtime of KNOWN_RUNTIMES) {
      const { contribution } = resolveBranchProtection(pack, runtime);
      const blocking = contribution.hooks.filter((h) => h.blocking === "hard");
      expect(blocking.length, `runtime ${runtime}`).toBe(1);
      for (const hook of blocking) {
        assertHookClearsMargin(hook);
        assertHookMeetsHardFloor(hook);
      }
    }
  });

  it("understanding-before-execution's blocking hook clears the margin and the hard floor (both runtimes)", () => {
    const pack = fullManifest.policy_packs.find(
      (p) => p.name === "understanding-before-execution",
    );
    expect(pack).toBeDefined();
    if (!pack) return;
    for (const runtime of KNOWN_RUNTIMES) {
      const { contribution } = resolveUnderstandingBeforeExecution(pack, runtime);
      const blocking = contribution.hooks.filter((h) => h.blocking === "hard");
      expect(blocking.length, `runtime ${runtime}`).toBe(1);
      for (const hook of blocking) {
        assertHookClearsMargin(hook);
        assertHookMeetsHardFloor(hook);
      }
    }
  });

  it("post-merge-gate's blocking hook clears the margin and the hard floor (shipped disabled by default; definition still pinned)", () => {
    const pack = fullManifest.policy_packs.find((p) => p.name === "post-merge-gate");
    expect(pack).toBeDefined();
    if (!pack) return;
    const { contribution } = resolvePostMergeGate(pack, "claude-code");
    const blocking = contribution.hooks.filter((h) => h.blocking === "hard");
    expect(blocking.length).toBe(1);
    for (const hook of blocking) {
      assertHookClearsMargin(hook);
      assertHookMeetsHardFloor(hook);
    }
  });

  // Mutation-probe controls (not normal regression pins): document that
  // these two assertions genuinely discriminate, at two different
  // regression depths.
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

  it("control: a hook at 10000ms budget clears the ~8s formula margin but still fails the 15000ms hard floor (the partial-regression band the hard floor exists to catch)", () => {
    const partialRegressionHook: Hook = {
      name: "control-only-partial",
      event: "PreToolUse",
      command: "harness policy intercept",
      blocking: "hard",
      budget_ms: 10000,
    };
    // Clears the looser formula...
    expect(outerTimeoutSeconds(partialRegressionHook.budget_ms)).toBeGreaterThanOrEqual(
      REQUIRED_SECONDS,
    );
    // ...but NOT the hard, measurement-derived floor.
    expect(partialRegressionHook.budget_ms).toBeLessThan(HARD_FLOOR_BUDGET_MS);
  });
});
