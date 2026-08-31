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
//
// UPDATE (task d20a7e0c): the `T + 2*auditRetryTimeoutMs` formula this file
// originally used to derive `REQUIRED_SECONDS` UNDERSTATED the real worst
// case (review 2026-08-08 measured ~10787ms wall time against the 5000ms
// default, against a naive-formula prediction of ~7500ms) — see
// `requiredHookBudgetMs`'s own doc comment in `src/cli/policy/intercept.ts`
// for the corrected `2*health.timeout_ms + 3*auditRetryTimeoutMs` derivation
// this file now sources `REQUIRED_SECONDS` from. That correction closes the
// gap `HARD_FLOOR_BUDGET_MS` below existed to backstop; the hard floor is
// kept anyway as an extra, still-real measured safety margin (15000ms > the
// corrected ~13750ms requirement at the shipped 5000ms ledger timeout), not
// because the formula is still wrong. This file also gained a sibling,
// GENERIC guard (`checkHookBudgetLedgerMargin`, `src/cli/validate/
// checks.ts`, exercised via `harness validate` / `harness doctor`) that
// checks the same invariant against an ARBITRARY manifest's OWN
// `health.timeout_ms` and OWN enabled `policy_packs[]`, instead of this
// file's fixed set of hand-imported template/pack surfaces — the trailing
// describe block below closes the loop by running it against the very
// manifests this file already builds.

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
import {
  isPolicyInterceptCommand,
  requiredHookBudgetMs,
} from "../../src/cli/policy/intercept.js";
import { checkHookBudgetLedgerMargin } from "../../src/cli/validate/checks.js";
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
 * it can write its decision, in outer (Claude Code / Codex) timeout
 * seconds. Delegates to `requiredHookBudgetMs` (src/cli/policy/
 * intercept.ts) — see that function's doc comment for the full
 * `2*health.timeout_ms + 3*auditRetryTimeoutMs` derivation (task d20a7e0c;
 * supersedes this file's original, understated `T + 2*auditRetryTimeoutMs`
 * formula).
 */
function requiredMarginSeconds(ledgerTimeoutMs: number): number {
  return Math.ceil(requiredHookBudgetMs(ledgerTimeoutMs) / 1000);
}

const fullManifest = loadFullTemplateManifest();
const groundingMcp = fullManifest.tools.mcp.find((m) => m.name === "grounding-mcp");
const LEDGER_TIMEOUT_MS = groundingMcp?.health?.timeout_ms ?? 5000;
const REQUIRED_SECONDS = requiredMarginSeconds(LEDGER_TIMEOUT_MS);

/**
 * HARD FLOOR (task 7bf47554, fix round 2 of fix round 2; formula corrected
 * by task d20a7e0c). `REQUIRED_SECONDS` above now derives from
 * `requiredHookBudgetMs`'s `2*health.timeout_ms + 3*auditRetryTimeoutMs`
 * formula (~13750ms / 14s for the shipped 5000ms grounding-mcp health
 * timeout) — a correction of this file's original, understated
 * `health.timeout_ms + 2*auditRetryTimeoutMs` (~8s) estimate, which review
 * 2026-08-08 measured against a REAL ~10787ms wall time. 15000ms (the value
 * every surface in this file is pinned to) still carries real margin above
 * even the CORRECTED ~13750ms figure, not just the original ~8s formula —
 * this constant keeps that extra, measured safety margin asserted
 * explicitly rather than relying on the formula's own margin alone.
 * Tightening or retiring this constant is a separate, deliberate decision
 * about the shipped template defaults themselves (out of scope for
 * d20a7e0c, which fixed the FORMULA and added the generic validate/doctor
 * guard below, not the shipped numbers — see task d20a7e0c's own scope
 * note: "Template-Default-Teil dieses Tasks ist ERLEDIGT").
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
  // isPolicyInterceptCommand (task d20a7e0c) rather than a verbatim
  // `h.command.trim() === "harness policy intercept"` compare: every
  // manifest this file loads is a harness-generated template/composer
  // surface, so the literal always matches either way — using the shared
  // classifier here keeps this file dogfooding the SAME matcher
  // `checkHookBudgetLedgerMargin` (validate/checks.ts) relies on for
  // operator-authored manifests, instead of a second, narrower copy.
  return manifest.hooks.filter(
    (h) => isPolicyInterceptCommand(h.command) && h.blocking === "hard",
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
    // 3 since task 2699b476: require-review-evidence plus the two
    // task-scoped merge-surface hooks (require-review-evidence-task-merge,
    // require-review-evidence-task-finish) the profile now also wires.
    expect(interceptHooks.length).toBe(3);
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

  it("control: a hook at 14000ms budget clears the (now corrected, ~13750ms) formula margin but still fails the 15000ms hard floor (the narrow partial-regression band the hard floor exists to catch)", () => {
    // Pre-d20a7e0c this control used 10000ms against the UNDERSTATED ~8s
    // formula; the corrected formula (2*5000 + 3*1250 = 13750ms, 14s) puts
    // 10000ms below the formula itself now, so it no longer demonstrates a
    // "clears the formula but not the hard floor" band. 14000ms sits in
    // that (now much narrower — [13750, 15000)ms) band instead.
    const partialRegressionHook: Hook = {
      name: "control-only-partial",
      event: "PreToolUse",
      command: "harness policy intercept",
      blocking: "hard",
      budget_ms: 14000,
    };
    // Clears the corrected formula...
    expect(outerTimeoutSeconds(partialRegressionHook.budget_ms)).toBeGreaterThanOrEqual(
      REQUIRED_SECONDS,
    );
    // ...but NOT the hard, measurement-derived floor.
    expect(partialRegressionHook.budget_ms).toBeLessThan(HARD_FLOOR_BUDGET_MS);
  });
});

// Generic guard (task d20a7e0c): checkHookBudgetLedgerMargin
// (src/cli/validate/checks.ts, wired into `harness validate` /
// `harness doctor`) checks the SAME invariant as this file's hand-imported,
// per-surface assertions above, but generically — it reads an arbitrary
// manifest's OWN `tools.mcp[grounding-mcp].health.timeout_ms` and iterates
// its OWN enabled `policy_packs[]` through the shared `resolveBuiltin`
// registry lookup, rather than this file's fixed list of specifically-
// imported template/pack modules. Running it against the very manifests
// built above closes the loop: the shipped defaults these hand-written
// assertions already pin also satisfy the durable, general-purpose guard
// an operator's OWN (differently-shaped) manifest gets checked against.
describe("checkHookBudgetLedgerMargin — the generic guard agrees with the per-surface pins above (task d20a7e0c)", () => {
  it("FULL_TEMPLATE reports zero hook-budget-margin diagnostics", () => {
    expect(checkHookBudgetLedgerMargin(fullManifest)).toEqual([]);
  });

  it("TEAM_TEMPLATE reports zero hook-budget-margin diagnostics", () => {
    expect(checkHookBudgetLedgerMargin(loadTeamTemplateManifest())).toEqual([]);
  });

  it("the Custom composer's full selection reports zero hook-budget-margin diagnostics", () => {
    expect(checkHookBudgetLedgerMargin(loadComposerManifest())).toEqual([]);
  });

  it("SOLO_TEMPLATE (no grounding-mcp ledger-consulting hooks) reports zero diagnostics", () => {
    expect(checkHookBudgetLedgerMargin(loadSoloTemplateManifest())).toEqual([]);
  });
});
