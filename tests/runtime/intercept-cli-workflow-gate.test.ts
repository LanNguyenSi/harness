// 99f47307 Slice 1: runtime enforcement for `workflows:`.
//
// Intercept-level allow/deny coverage through the REAL `harness policy
// intercept` entrypoint (`runInterceptCli`, src/cli/policy/intercept.ts),
// loading a manifest from a temp-dir home override exactly the way both
// the Claude Code `settings.json` hook and the Codex `config.toml` hook
// invoke it (`runInterceptCli` calls `loadManifest` unless a manifest is
// injected; that call has no runtime branching, so the same derived
// policies apply on both runtimes, see the CHANGELOG entry for the
// pointer into docs/okf/codex-adapter-parity-gaps.md gap 8).
//
// AC1: a skipped spawn: required step (or, per the mutation probe below,
// no policy at all) does not block; a WIRED workflow with an empty ledger
// denies both the MCP merge tool and `gh pr merge`.
// AC2: a matching ledger fact (same content shape `harness record review`
// writes, src/cli/record/index.ts) allows both surfaces.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runInterceptCli } from "../../src/cli/policy/intercept.js";
import type { LedgerClient } from "../../src/runtime/intercept.js";
import type { LedgerQueryResult } from "../../src/policies/index.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function makeRepoFixture(name: string, branch: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-intercept-wf-gate-git-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, name);
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
  return repo;
}

function writeManifest(yaml: string): { homeDir: string; configPath: string } {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-intercept-wf-gate-"));
  cleanups.push(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const configPath = path.join(homeDir, "harness.yaml");
  fs.writeFileSync(configPath, yaml, "utf8");
  return { homeDir, configPath };
}

function streamFrom(s: string): NodeJS.ReadableStream {
  return Readable.from([s]);
}

function captureStream(): { stream: NodeJS.WritableStream; output: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString("utf8"));
      cb();
    },
  });
  return { stream, output: () => chunks.join("") };
}

function ledgerWith(result: LedgerQueryResult): LedgerClient {
  return {
    async query() {
      return result;
    },
    async record() {
      /* no-op */
    },
  };
}

const EMPTY_LEDGER = ledgerWith({ kind: "ok", entries: [] });

// Same content shape `harness record review --pr <n>` writes (src/cli/
// record/index.ts runRecordReview): ONE entry carries both the
// review:<pr-number> and review:<branch> tags, so a single recorded
// review satisfies both the MCP and the bash derived policy.
function reviewLedgerFor(pr: string, branch: string): LedgerClient {
  return ledgerWith({
    kind: "ok",
    entries: [
      {
        id: "1",
        content: `review:${pr} review:${branch}: looks good`,
        createdAt: "2026-08-27T12:00:00.000Z",
      },
    ],
  });
}

const WIRED_HOOKS_YAML = `hooks:
  - name: require-review-evidence
    event: PreToolUse
    match: "mcp__agent-tasks__pull_requests_merge"
    command: harness policy intercept
    blocking: hard
    budget_ms: 15000
  - name: require-review-evidence-bash
    event: PreToolUse
    match: "Bash"
    bash_match: '(^|\\n|;|\\||&|\\()\\s*(\\w+=\\S+\\s+)*gh pr merge\\b'
    command: harness policy intercept
    blocking: hard
    budget_ms: 15000
`;

// The two task-scoped merge-surface hooks (task 2699b476). Kept SEPARATE
// from WIRED_HOOKS_YAML on purpose: a manifest that declares only the
// original pair must still derive exactly the original pair, so the
// pre-2699b476 scenarios above keep exercising that shape.
const TASK_VERB_HOOKS_YAML = `  - name: require-review-evidence-task-merge
    event: PreToolUse
    match: "mcp__agent-tasks__task_merge"
    command: harness policy intercept
    blocking: hard
    budget_ms: 15000
  - name: require-review-evidence-task-finish
    event: PreToolUse
    match: "mcp__agent-tasks__task_finish"
    command: harness policy intercept
    blocking: hard
    budget_ms: 15000
`;

const TASK_ID = "2699b476-1111-4222-8333-444455556666";

const TASK_MERGE_EVENT = JSON.stringify({
  hook_event_name: "PreToolUse",
  tool_name: "mcp__agent-tasks__task_merge",
  tool_input: { taskId: TASK_ID },
  session_id: "sess-1",
});

function taskFinishEvent(toolInput: Record<string, unknown>): string {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "mcp__agent-tasks__task_finish",
    tool_input: toolInput,
    session_id: "sess-1",
  });
}

// Same content shape `harness record review --pr <n> --task <id>` writes
// (src/cli/record/index.ts runRecordReview): ONE entry carrying the PR,
// branch and task tags together.
function taskReviewLedger(taskId: string): LedgerClient {
  return ledgerWith({
    kind: "ok",
    entries: [
      {
        id: "1",
        content: `review:42 review:feat/x review:${taskId}: looks good`,
        createdAt: "2026-08-31T12:00:00.000Z",
      },
    ],
  });
}

function workflowYaml(spawn: "required" | "skip"): string {
  return `review_templates:
  t1: "Review this PR for correctness."
workflows:
  - name: ship
    steps:
      - kind: branch
      - kind: review_subagent
        spawn: ${spawn}${spawn === "required" ? "\n        template: t1" : ""}
      - kind: merge
`;
}

const MCP_MERGE_EVENT = JSON.stringify({
  hook_event_name: "PreToolUse",
  tool_name: "mcp__agent-tasks__pull_requests_merge",
  tool_input: { prNumber: 42 },
  session_id: "sess-1",
});

function bashMergeEvent(cwd: string): string {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "gh pr merge" },
    session_id: "sess-1",
    cwd,
  });
}

describe("runInterceptCli: workflow-derived merge gate (99f47307 Slice 1, AC1/AC2)", () => {
  it("AC1 (MCP): denies pull_requests_merge with no ledger evidence, naming the missing tag", async () => {
    const { homeDir, configPath } = writeManifest(`version: 1\n${workflowYaml("required")}${WIRED_HOOKS_YAML}`);
    const { stream: out, output } = captureStream();
    const result = await runInterceptCli({
      stdin: streamFrom(MCP_MERGE_EVENT),
      stdout: out,
      homeDir,
      configPath,
      ledger: EMPTY_LEDGER,
    });
    expect(result.blocked).toBe(true);
    // The derived policy's `ux:` block replaces the raw engine reason with
    // agent-facing text (PolicyUxSchema, src/schema/policies.ts), so the
    // policy NAME is not in the rendered JSON; assert provenance via the
    // structured decision instead, and the missing tag via the ux text.
    expect(result.decisions[0]?.policyName).toBe("workflow:ship:review-before-merge");
    expect(result.decisions[0]?.ledgerTag).toBe("review:42");
    const parsed = JSON.parse(output().trim());
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("You cannot merge PR #42 yet.");
    expect(parsed.reason).toContain("a recorded review of PR #42");
  });

  it("AC1 (Bash): denies `gh pr merge` with no ledger evidence, naming the missing tag", async () => {
    const { homeDir, configPath } = writeManifest(`version: 1\n${workflowYaml("required")}${WIRED_HOOKS_YAML}`);
    const repo = makeRepoFixture("widget-service", "feat/x");
    const { stream: out, output } = captureStream();
    const result = await runInterceptCli({
      stdin: streamFrom(bashMergeEvent(repo)),
      stdout: out,
      homeDir,
      configPath,
      ledger: EMPTY_LEDGER,
    });
    expect(result.blocked).toBe(true);
    expect(result.decisions[0]?.policyName).toBe("workflow:ship:review-before-merge-bash");
    expect(result.decisions[0]?.ledgerTag).toBe("review:feat/x");
    const parsed = JSON.parse(output().trim());
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("You cannot merge the PR for branch feat/x via `gh pr merge` yet.");
    expect(parsed.reason).toContain("a recorded review of the PR for branch feat/x");
  });

  it("AC2 (MCP): allows pull_requests_merge once a matching review ledger fact exists", async () => {
    const { homeDir, configPath } = writeManifest(`version: 1\n${workflowYaml("required")}${WIRED_HOOKS_YAML}`);
    const { stream: out, output } = captureStream();
    const result = await runInterceptCli({
      stdin: streamFrom(MCP_MERGE_EVENT),
      stdout: out,
      homeDir,
      configPath,
      ledger: reviewLedgerFor("42", "feat/x"),
    });
    expect(result.blocked).toBe(false);
    expect(output()).toBe("");
  });

  it("AC2 (Bash): allows `gh pr merge` once a matching review ledger fact exists", async () => {
    const { homeDir, configPath } = writeManifest(`version: 1\n${workflowYaml("required")}${WIRED_HOOKS_YAML}`);
    const repo = makeRepoFixture("widget-service", "feat/x");
    const { stream: out, output } = captureStream();
    const result = await runInterceptCli({
      stdin: streamFrom(bashMergeEvent(repo)),
      stdout: out,
      homeDir,
      configPath,
      ledger: reviewLedgerFor("42", "feat/x"),
    });
    expect(result.blocked).toBe(false);
    expect(output()).toBe("");
  });

  it("mutation probe M1: spawn required -> skip flips the SAME deny-expecting scenario to allow", async () => {
    const { homeDir, configPath } = writeManifest(`version: 1\n${workflowYaml("skip")}${WIRED_HOOKS_YAML}`);
    const { stream: out, output } = captureStream();
    const result = await runInterceptCli({
      stdin: streamFrom(MCP_MERGE_EVENT),
      stdout: out,
      homeDir,
      configPath,
      ledger: EMPTY_LEDGER,
    });
    // No policy is derived at all for a spawn: skip workflow, so the same
    // event that AC1 (MCP) expects to deny now passes through unblocked
    // (nothing in this manifest's policies[] matches it).
    expect(result.blocked).toBe(false);
    expect(output()).toBe("");
  });

  // F1 (review round 2): a hand-authored `enforcement: warn` policy on
  // the IDENTICAL trigger surface + ledger_tag as the derived MCP gate
  // must not suppress it — round-1 code deduped purely on trigger-
  // surface-key, so this exact manifest shape used to silently drop the
  // block gate (an agent could merge with only a "warn" recorded, never
  // an actual deny). This is the M1 mutation probe this round's review
  // brief names: reverting `isAtLeastAsStrongAsDerivedGate`'s filter back
  // to a bare `triggerSurfaceKey` seed turns this test red (`blocked`
  // flips from `true` to `false`).
  it("F1 mutation probe M1: a WEAKER hand policy on the same surface does not suppress the deny", async () => {
    const weakOverlapPolicy = `policies:
  - name: two-reviewers-required
    description: Warn-level companion sharing review-before-merge's exact surface + tag.
    trigger:
      event: PreToolUse
      match: "mcp__agent-tasks__pull_requests_merge"
      extract:
        PR_NUMBER: "toolArgs.prNumber"
    requires:
      ledger_tag: "review:\${PR_NUMBER}"
      count:
        min: 2
    hook: require-review-evidence
    enforcement: warn
`;
    const { homeDir, configPath } = writeManifest(
      `version: 1\n${workflowYaml("required")}${weakOverlapPolicy}${WIRED_HOOKS_YAML}`,
    );
    const { stream: out, output } = captureStream();
    const result = await runInterceptCli({
      stdin: streamFrom(MCP_MERGE_EVENT),
      stdout: out,
      homeDir,
      configPath,
      ledger: EMPTY_LEDGER,
    });
    expect(result.blocked).toBe(true);
    // Both policies match the same trigger surface — `two-reviewers-required`
    // (warn, no evidence yet) and the derived block gate — so assert on
    // the DENYING decision specifically rather than array index/order.
    const denying = result.decisions.find((d) => d.outcome === "deny");
    expect(denying?.policyName).toBe("workflow:ship:review-before-merge");
    const parsed = JSON.parse(output().trim());
    expect(parsed.decision).toBe("block");
  });

  // Review round 3 follow-up (F3, 99f47307 Slice 1): the case
  // `checkWorkflowDerivedNameCollision` (src/cli/validate/checks.ts)
  // errors on at the config level (a hand-authored `enforcement: warn`
  // policy on the SAME surface AND the SAME NAME as the derived gate)
  // exercised end to end through the real runtime: both policies are
  // enforced (name collision is a validate-time authoring error, not a
  // runtime dedupe), so the derived block gate still fires even though
  // its name resolves to the hand-authored policy in every by-name
  // reader. `result.blocked` is `runInterceptCli`'s surface for
  // `blockJson !== null` (src/cli/policy/intercept.ts).
  it("F3: a same-NAME, same-surface warn hand policy still leaves the derived block gate enforced (blockJson != null)", async () => {
    const collidingWarnPolicy = `policies:
  - name: workflow:ship:review-before-merge
    description: Same name AND same surface as the derived gate, but weaker.
    trigger:
      event: PreToolUse
      match: "mcp__agent-tasks__pull_requests_merge"
      extract:
        PR_NUMBER: "toolArgs.prNumber"
    requires:
      ledger_tag: "review:\${PR_NUMBER}"
    hook: require-review-evidence
    enforcement: warn
`;
    const { homeDir, configPath } = writeManifest(
      `version: 1\n${workflowYaml("required")}${collidingWarnPolicy}${WIRED_HOOKS_YAML}`,
    );
    const { stream: out, output } = captureStream();
    const result = await runInterceptCli({
      stdin: streamFrom(MCP_MERGE_EVENT),
      stdout: out,
      homeDir,
      configPath,
      ledger: EMPTY_LEDGER,
    });
    expect(result.blocked).toBe(true);
    const denying = result.decisions.find((d) => d.outcome === "deny");
    expect(denying).toBeDefined();
    expect(denying?.policyName).toBe("workflow:ship:review-before-merge");
    const parsed = JSON.parse(output().trim());
    expect(parsed.decision).toBe("block");
  });
});

// Task 2699b476: the two task-scoped agent-tasks merge surfaces, driven
// through the same real `runInterceptCli` entrypoint as the pair above.
// Closes the residual the 99f47307 Slice 1 CHANGELOG entry named twice
// ("`mcp__agent-tasks__task_merge` and `mcp__agent-tasks__task_finish`
// (`autoMerge`) still pass the gate uncovered").
describe("runInterceptCli: task-scoped merge gates (task 2699b476)", () => {
  function wiredManifest(): { homeDir: string; configPath: string } {
    return writeManifest(
      `version: 1\n${workflowYaml("required")}${WIRED_HOOKS_YAML}${TASK_VERB_HOOKS_YAML}`,
    );
  }

  it("AC1 (task_merge): denies with no ledger evidence, naming review:<task-id>", async () => {
    const { homeDir, configPath } = wiredManifest();
    const { stream: out, output } = captureStream();
    const result = await runInterceptCli({
      stdin: streamFrom(TASK_MERGE_EVENT),
      stdout: out,
      homeDir,
      configPath,
      ledger: EMPTY_LEDGER,
    });
    expect(result.blocked).toBe(true);
    expect(result.decisions[0]?.policyName).toBe("workflow:ship:review-before-task-merge");
    expect(result.decisions[0]?.ledgerTag).toBe(`review:${TASK_ID}`);
    const parsed = JSON.parse(output().trim());
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain(`You cannot merge the PR for task ${TASK_ID} yet.`);
  });

  it("AC2 (task_merge): allows once a matching review ledger fact exists", async () => {
    const { homeDir, configPath } = wiredManifest();
    const { stream: out, output } = captureStream();
    const result = await runInterceptCli({
      stdin: streamFrom(TASK_MERGE_EVENT),
      stdout: out,
      homeDir,
      configPath,
      ledger: taskReviewLedger(TASK_ID),
    });
    expect(result.blocked).toBe(false);
    expect(output()).toBe("");
  });

  it("AC1 (task_finish autoMerge: true): denies with no ledger evidence", async () => {
    const { homeDir, configPath } = wiredManifest();
    const { stream: out, output } = captureStream();
    const result = await runInterceptCli({
      stdin: streamFrom(taskFinishEvent({ taskId: TASK_ID, autoMerge: true })),
      stdout: out,
      homeDir,
      configPath,
      ledger: EMPTY_LEDGER,
    });
    expect(result.blocked).toBe(true);
    expect(result.decisions[0]?.policyName).toBe(
      "workflow:ship:review-before-task-finish-automerge",
    );
    expect(result.decisions[0]?.ledgerTag).toBe(`review:${TASK_ID}`);
    const parsed = JSON.parse(output().trim());
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain(`You cannot finish task ${TASK_ID} with autoMerge yet.`);
  });

  it("AC2 (task_finish autoMerge: true): allows once a matching review ledger fact exists", async () => {
    const { homeDir, configPath } = wiredManifest();
    const { stream: out, output } = captureStream();
    const result = await runInterceptCli({
      stdin: streamFrom(taskFinishEvent({ taskId: TASK_ID, autoMerge: true })),
      stdout: out,
      homeDir,
      configPath,
      ledger: taskReviewLedger(TASK_ID),
    });
    expect(result.blocked).toBe(false);
    expect(output()).toBe("");
  });

  // The discriminating case for `trigger.input_match` (mutation probe (a)
  // in this task's brief): a plain `task_finish` merges nothing, so it must
  // pass with NO policy matching it at all. Making the input_match
  // evaluation unconditionally true turns exactly these two assertions red.
  it("task_finish WITHOUT autoMerge is not intercepted at all (no policy matched)", async () => {
    const { homeDir, configPath } = wiredManifest();
    const { stream: out, output } = captureStream();
    const result = await runInterceptCli({
      stdin: streamFrom(taskFinishEvent({ taskId: TASK_ID, result: "done" })),
      stdout: out,
      homeDir,
      configPath,
      ledger: EMPTY_LEDGER,
    });
    expect(result.blocked).toBe(false);
    expect(result.decisions).toEqual([]);
    expect(output()).toBe("");
  });

  it("task_finish with autoMerge: false is not intercepted either (strict equality, not truthiness)", async () => {
    const { homeDir, configPath } = wiredManifest();
    const { stream: out } = captureStream();
    const result = await runInterceptCli({
      stdin: streamFrom(taskFinishEvent({ taskId: TASK_ID, autoMerge: false })),
      stdout: out,
      homeDir,
      configPath,
      ledger: EMPTY_LEDGER,
    });
    expect(result.blocked).toBe(false);
    expect(result.decisions).toEqual([]);
  });

  it('task_finish with autoMerge: "true" (string) is not intercepted (same JSON type required)', async () => {
    const { homeDir, configPath } = wiredManifest();
    const { stream: out } = captureStream();
    const result = await runInterceptCli({
      stdin: streamFrom(taskFinishEvent({ taskId: TASK_ID, autoMerge: "true" })),
      stdout: out,
      homeDir,
      configPath,
      ledger: EMPTY_LEDGER,
    });
    expect(result.blocked).toBe(false);
    expect(result.decisions).toEqual([]);
  });

  // Fail posture (brief item 5): an unresolvable `${TASK_ID}` must NOT
  // degrade to allow. `preserve_enforcement` (the default) maps a block
  // policy whose requires cannot be evaluated to `deny-degraded`.
  it("task_merge with no taskId in tool_input denies (deny-degraded), never allows", async () => {
    const { homeDir, configPath } = wiredManifest();
    const { stream: out, output } = captureStream();
    const result = await runInterceptCli({
      stdin: streamFrom(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "mcp__agent-tasks__task_merge",
          tool_input: {},
          session_id: "sess-1",
        }),
      ),
      stdout: out,
      homeDir,
      configPath,
      ledger: EMPTY_LEDGER,
    });
    expect(result.blocked).toBe(true);
    const decision = result.decisions.find(
      (d) => d.policyName === "workflow:ship:review-before-task-merge",
    );
    expect(decision?.outcome).toBe("deny-degraded");
    expect(JSON.parse(output().trim()).decision).toBe("block");
  });

  // No double intercept: a manifest carrying BOTH the hand-authored
  // template policies and a qualifying workflow must evaluate exactly ONE
  // policy per call (the derivation dedupes against the equivalent
  // hand-authored one).
  it("a hand-authored copy of the shipped task_finish gate dedupes the derived one (no double intercept)", async () => {
    const handAuthored = `policies:
  - name: review-before-task-finish-automerge
    description: 'Block agent-tasks task_finish with autoMerge: true unless a ledger entry tagged review:<task-id> exists for this session.'
    trigger:
      event: PreToolUse
      match: "mcp__agent-tasks__task_finish"
      input_match:
        toolArgs.autoMerge: true
      extract:
        TASK_ID: "toolArgs.taskId"
    requires:
      ledger_tag: "review:\${TASK_ID}"
    hook: require-review-evidence-task-finish
    enforcement: block
`;
    const { homeDir, configPath } = writeManifest(
      `version: 1\n${workflowYaml("required")}${handAuthored}${WIRED_HOOKS_YAML}${TASK_VERB_HOOKS_YAML}`,
    );
    const { stream: out } = captureStream();
    const result = await runInterceptCli({
      stdin: streamFrom(taskFinishEvent({ taskId: TASK_ID, autoMerge: true })),
      stdout: out,
      homeDir,
      configPath,
      ledger: EMPTY_LEDGER,
    });
    expect(result.blocked).toBe(true);
    const matching = result.decisions.filter((d) => d.ledgerTag === `review:${TASK_ID}`);
    expect(matching).toHaveLength(1);
    expect(matching[0]?.policyName).toBe("review-before-task-finish-automerge");
  });

  // Backwards compatibility: a manifest that predates the two task-verb
  // hooks derives exactly the pair it always did, and the task-scoped
  // surfaces stay uncovered rather than getting an INERT derived gate
  // (see REVIEW_EVIDENCE_HOOK_TASK_MERGE's doc in workflow-policies.ts).
  it("without the task-verb hooks declared, task_merge is not intercepted and the old pair is unchanged", async () => {
    const { homeDir, configPath } = writeManifest(
      `version: 1\n${workflowYaml("required")}${WIRED_HOOKS_YAML}`,
    );
    const { stream: taskOut } = captureStream();
    const taskResult = await runInterceptCli({
      stdin: streamFrom(TASK_MERGE_EVENT),
      stdout: taskOut,
      homeDir,
      configPath,
      ledger: EMPTY_LEDGER,
    });
    expect(taskResult.blocked).toBe(false);
    expect(taskResult.decisions).toEqual([]);

    const { stream: prOut } = captureStream();
    const prResult = await runInterceptCli({
      stdin: streamFrom(MCP_MERGE_EVENT),
      stdout: prOut,
      homeDir,
      configPath,
      ledger: EMPTY_LEDGER,
    });
    expect(prResult.blocked).toBe(true);
    expect(prResult.decisions[0]?.policyName).toBe("workflow:ship:review-before-merge");
  });
});
