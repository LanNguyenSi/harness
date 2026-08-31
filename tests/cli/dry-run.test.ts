import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { dryRun } from "../../src/cli/dry-run.js";
import { HarnessExitError } from "../../src/cli/exit-codes.js";
import { loadManifest } from "../../src/cli/loader.js";
import { policyMatchesEvent, type ToolEvent } from "../../src/runtime/intercept.js";
import type { Policy } from "../../src/schema/index.js";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..", "..");
const FULL_MANIFEST = path.join(REPO_ROOT, "docs", "examples", "full-manifest.yaml");

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

describe("dry-run — without --tool", () => {
  it("lists prompt-event hooks but flags PreToolUse policies as 'could match'", () => {
    const r = dryRun("merge PR 42", { configPath: FULL_MANIFEST });
    const report = r.report;
    expect(report.prompt).toBe("merge PR 42");
    expect(report.tool).toBeNull();
    // PreToolUse policies in the example manifest are deferred to the
    // "could match" bucket because no --tool is supplied.
    const couldNames = report.couldMatchPolicies.map((p) => p.name);
    expect(couldNames).toContain("review-before-merge");
    expect(report.matchingPolicies.find((p) => p.name === "review-before-merge")).toBeUndefined();
  });
});

describe("dry-run — with --tool", () => {
  it("matches review-before-merge against mcp__agent-tasks__pull_requests_merge with prNumber=42", () => {
    const r = dryRun("merge PR 42", {
      configPath: FULL_MANIFEST,
      tool: "mcp__agent-tasks__pull_requests_merge",
      toolArgs: JSON.stringify({ prNumber: 42 }),
    });
    const matched = r.report.matchingPolicies.map((p) => p.name);
    expect(matched).toContain("review-before-merge");
    const review = r.report.matchingPolicies.find((p) => p.name === "review-before-merge");
    expect(review?.ledgerQuery).toBe("review:42");
    expect(review?.enforcement).toBe("block");
  });

  it("emits a parseable JSON projection under --json", () => {
    const r = dryRun("merge PR 42", {
      configPath: FULL_MANIFEST,
      tool: "mcp__agent-tasks__pull_requests_merge",
      toolArgs: JSON.stringify({ prNumber: 42 }),
      json: true,
    });
    const parsed = JSON.parse(r.output);
    expect(parsed.prompt).toBe("merge PR 42");
    expect(parsed.tool).toBe("mcp__agent-tasks__pull_requests_merge");
    expect(Array.isArray(parsed.matchingPolicies)).toBe(true);
    expect(parsed.matchingPolicies.find((p: { name: string }) => p.name === "review-before-merge")).toBeDefined();
  });

  it("flags policies whose trigger.match excludes the chosen tool", () => {
    const r = dryRun("merge PR 42", {
      configPath: FULL_MANIFEST,
      tool: "Bash",
      toolArgs: JSON.stringify({ command: "ls" }),
    });
    const reviewCould = r.report.couldMatchPolicies.find(
      (p) => p.name === "review-before-merge",
    );
    expect(reviewCould?.reason).toMatch(/does not contain trigger\.match/);
  });

  it("matches a bash_match policy when the command fits", () => {
    const r = dryRun("ship it", {
      configPath: FULL_MANIFEST,
      tool: "Bash",
      toolArgs: JSON.stringify({ command: "npm publish" }),
    });
    const matched = r.report.matchingPolicies.map((p) => p.name);
    expect(matched).toContain("dogfood-before-release");
  });

  it("rejects malformed --tool-args with EX_USAGE", () => {
    let caught: unknown;
    try {
      dryRun("x", {
        configPath: FULL_MANIFEST,
        tool: "Bash",
        toolArgs: "{not json",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    const err = caught as HarnessExitError;
    expect(err.exitCode).toBe(64);
    expect(err.message).toMatch(/--tool-args/);
  });
});

describe("dry-run — bash_match trigger matching is raw-OR-normalised (F8 fix, review round 2026-07-27)", () => {
  // Before this fix, `policyMatchesTool` tested only the RAW command, so
  // dry-run predicted `preflight-before-investigation` as NOT matching a
  // wrapped git invocation while `harness policy intercept` (via
  // `policyMatchesEvent`) actually blocks it — dry-run's own comment and
  // docs/okf/debug-verb-selection.md both assert parity between the two.
  it("matches a wrapper-peeled git invocation the same way the runtime does", () => {
    const r = dryRun("look around", {
      configPath: FULL_MANIFEST,
      tool: "Bash",
      toolArgs: JSON.stringify({ command: "env -C /tmp git status" }),
    });
    const matched = r.report.matchingPolicies.map((p) => p.name);
    expect(matched).toContain("preflight-before-investigation");
  });

  it("still matches the raw (unwrapped) spelling — superset, not a replacement", () => {
    const r = dryRun("look around", {
      configPath: FULL_MANIFEST,
      tool: "Bash",
      toolArgs: JSON.stringify({ command: "git status" }),
    });
    const matched = r.report.matchingPolicies.map((p) => p.name);
    expect(matched).toContain("preflight-before-investigation");
  });

  it("a non-git command is still reported as not matching (no false positive)", () => {
    const r = dryRun("look around", {
      configPath: FULL_MANIFEST,
      tool: "Bash",
      toolArgs: JSON.stringify({ command: "ls -la" }),
    });
    const matched = r.report.matchingPolicies.map((p) => p.name);
    expect(matched).not.toContain("preflight-before-investigation");
  });
});

// Task aabbad63: dry-run's bash_match check gained a third,
// ampersand-aware arm (`normalizeCommandAmpAware`) alongside the raw and
// existing-normalised ones, so `harness dry-run` keeps predicting exactly
// what `harness policy intercept` (via `policyMatchesEvent`) actually
// does for the bare-`&` bypass family — the same parity rationale as the
// "raw-OR-normalised" describe block above (F8 fix), just for the newly
// added arm.
describe("dry-run — bash_match trigger matching gains the amp-aware third arm (task aabbad63)", () => {
  it('matches "A=x&env -C /tmp git status" (glued ampersand) the same way the runtime does', () => {
    const r = dryRun("look around", {
      configPath: FULL_MANIFEST,
      tool: "Bash",
      toolArgs: JSON.stringify({ command: "A=x&env -C /tmp git status" }),
    });
    const matched = r.report.matchingPolicies.map((p) => p.name);
    expect(matched).toContain("preflight-before-investigation");
  });

  it('matches "echo hi & nice git status" (genuine background job) the same way the runtime does', () => {
    const r = dryRun("look around", {
      configPath: FULL_MANIFEST,
      tool: "Bash",
      toolArgs: JSON.stringify({ command: "echo hi & nice git status" }),
    });
    const matched = r.report.matchingPolicies.map((p) => p.name);
    expect(matched).toContain("preflight-before-investigation");
  });

  it("still predicts a match via the EXISTING pass alone for the quoted-value family (unaffected by the new arm)", () => {
    const r = dryRun("look around", {
      configPath: FULL_MANIFEST,
      tool: "Bash",
      toolArgs: JSON.stringify({ command: "env FOO='a&b' git status" }),
    });
    const matched = r.report.matchingPolicies.map((p) => p.name);
    expect(matched).toContain("preflight-before-investigation");
  });
});

describe("dry-run — REPO builtin resolves from cwd", () => {
  it("substitutes the cwd-derived repo name into a preflight policy's ledgerQuery", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-dryrun-git-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = path.join(root, "sample-repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    const r = dryRun("look around", {
      configPath: FULL_MANIFEST,
      tool: "Bash",
      toolArgs: JSON.stringify({ command: "git status" }),
      builtins: { CWD: repo },
    });
    const preflight = r.report.matchingPolicies.find(
      (p) => p.name === "preflight-before-investigation",
    );
    // Before the fix this was the literal `preflight:` (empty REPO).
    expect(preflight?.ledgerQuery).toBe("preflight:sample-repo");
  });
});

describe("dry-run — memory routing", () => {
  it("surfaces the configured memory directories with their scopes", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-dryrun-mem-"));
    cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
    fs.writeFileSync(
      path.join(home, "harness.yaml"),
      `version: 1
hooks: []
policies: []
memory:
  directories:
    - path: ~/notes
      scope: user
    - path: \${PROJECT}/memory
      scope: project
`,
      "utf8",
    );
    const r = dryRun("anything", {
      homeDir: home,
      configPath: path.join(home, "harness.yaml"),
      discriminator: { hostname: "h", platform: "linux", procVersionPath: "/nonexistent" },
    });
    expect(r.report.memoryDirectories).toEqual([
      { path: "~/notes", scope: "user" },
      { path: "${PROJECT}/memory", scope: "project" },
    ]);
  });
});

// Task f561e44c: dry-run's bash_match check gains a fourth, quote-aware
// arm (`normalizeCommandQuoteAware`), mirroring `policyMatchesEvent`'s own
// fourth arm (task cf3dff51) exactly, the same parity rationale as the
// "raw-OR-normalised" (F8) and "amp-aware third arm" (aabbad63) describe
// blocks above. Before this fix, dry-run predicted NOT-MATCHED for the
// quoted-shell-boundary family (`VAR='a; b' git push origin master`) while
// `harness policy intercept` actually blocks it via the quote-aware pass —
// the same debug-verb/runtime contradiction those two prior fixes closed
// for their own families, reintroduced here for this one.
describe("dry-run — bash_match trigger matching gains the quote-aware fourth arm (task f561e44c)", () => {
  // The 12 cf3dff51 target spellings: each of the 5 shell-boundary
  // characters BOUNDARY_RE itself recognises (`;`, `|`, `&&`, `(`, and a
  // literal newline in both its spaced and unspaced forms — 6 spellings in
  // total) sitting INSIDE a quoted assignment value, crossed with the two
  // gated verbs cf3dff51 measured against at the real hook entry point
  // (`git push`, the operator-only kill switch `harness pause`).
  const BOUNDARY_FORMS = [
    { label: "semicolon", quoted: "a; b" },
    { label: "pipe", quoted: "a| b" },
    { label: "double-ampersand", quoted: "a&& b" },
    { label: "open-paren", quoted: "a( b" },
    { label: "literal newline (spaced)", quoted: "a\n b" },
    { label: "literal newline (no extra space)", quoted: "a\nb" },
  ] as const;

  const TARGETS: Array<{ label: string; command: string; policyName: string }> = [];
  for (const f of BOUNDARY_FORMS) {
    TARGETS.push({
      label: `${f.label}, git push`,
      command: `VAR='${f.quoted}' git push origin master`,
      policyName: "preflight-before-push",
    });
    TARGETS.push({
      label: `${f.label}, kill switch`,
      command: `VAR='${f.quoted}' harness pause`,
      policyName: "deny-kill-switch-bypass",
    });
  }

  it("enumerates exactly the 12 cf3dff51 target spellings", () => {
    expect(TARGETS.length).toBe(12);
  });

  for (const t of TARGETS) {
    it(`predicts a match for ${t.label}: ${JSON.stringify(t.command)}, the same way policy intercept does`, () => {
      const r = dryRun("look around", {
        configPath: FULL_MANIFEST,
        tool: "Bash",
        toolArgs: JSON.stringify({ command: t.command }),
      });
      const matched = r.report.matchingPolicies.map((p) => p.name);
      expect(matched).toContain(t.policyName);
    });
  }

  it("still predicts a match via the raw arm alone without an internal whitespace split (unaffected by the new arm)", () => {
    const r = dryRun("look around", {
      configPath: FULL_MANIFEST,
      tool: "Bash",
      toolArgs: JSON.stringify({ command: "VAR='a;b' git push origin master" }),
    });
    const matched = r.report.matchingPolicies.map((p) => p.name);
    expect(matched).toContain("preflight-before-push");
  });
});

// Direct parity fixture (acceptance criterion 2): dry-run's prediction and
// the real `policyMatchesEvent` matcher (`src/runtime/intercept.ts`) must
// AGREE, entry for entry, for the SAME 12 forms against the SAME manifest
// policies — not merely each independently asserted `true` (the describe
// block above), which could still silently diverge from the runtime if a
// future edit changed one matcher's arm order/logic without the other's.
describe("dry-run vs policyMatchesEvent — quote-aware fourth arm parity fixture (task f561e44c)", () => {
  const { manifest } = loadManifest({ configPath: FULL_MANIFEST });
  const pushPolicy = manifest.policies.find((p) => p.name === "preflight-before-push");
  const killSwitchPolicy = manifest.policies.find((p) => p.name === "deny-kill-switch-bypass");
  if (!pushPolicy || !killSwitchPolicy) {
    throw new Error(
      "docs/examples/full-manifest.yaml is missing preflight-before-push or deny-kill-switch-bypass",
    );
  }

  const quotedForms = ["a; b", "a| b", "a&& b", "a( b", "a\n b", "a\nb"];
  const cases: Array<{ command: string; policy: Policy }> = [
    ...quotedForms.map((q) => ({ command: `VAR='${q}' git push origin master`, policy: pushPolicy })),
    ...quotedForms.map((q) => ({ command: `VAR='${q}' harness pause`, policy: killSwitchPolicy })),
  ];

  it("agrees with policyMatchesEvent for all 12 target forms (equal verdict, not just both independently true)", () => {
    expect(cases.length).toBe(12);
    for (const c of cases) {
      const event: ToolEvent = {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: c.command },
      };
      const runtimeVerdict = policyMatchesEvent(c.policy, event);
      const r = dryRun("look around", {
        configPath: FULL_MANIFEST,
        tool: "Bash",
        toolArgs: JSON.stringify({ command: c.command }),
      });
      const dryRunVerdict = r.report.matchingPolicies.some((p) => p.name === c.policy.name);
      expect(runtimeVerdict, `policyMatchesEvent should match: ${c.command}`).toBe(true);
      expect(dryRunVerdict, `dry-run should agree with policyMatchesEvent: ${c.command}`).toBe(
        runtimeVerdict,
      );
    }
  });
});

// Task 2699b476: `trigger.input_match`. Same parity contract the
// bash_match fixture above pins (docs/okf/debug-verb-selection.md): what
// `harness policy dry-run` predicts is what `policy intercept` decides,
// verdict for verdict, not two independently-asserted booleans.
describe("dry-run — trigger.input_match (task 2699b476)", () => {
  const TASK_ID = "2699b476-1111-4222-8333-444455556666";
  const GATE = "review-before-task-finish-automerge";

  it("predicts the gate for task_finish with autoMerge: true, and resolves review:<task-id>", () => {
    const r = dryRun("finish and merge", {
      configPath: FULL_MANIFEST,
      tool: "mcp__agent-tasks__task_finish",
      toolArgs: JSON.stringify({ taskId: TASK_ID, autoMerge: true }),
    });
    const hit = r.report.matchingPolicies.find((p) => p.name === GATE);
    expect(hit).toBeDefined();
    expect(hit?.ledgerQuery).toBe(`review:${TASK_ID}`);
    expect(hit?.enforcement).toBe("block");
  });

  it("predicts NO match for a plain task_finish, naming input_match as the reason", () => {
    const r = dryRun("finish", {
      configPath: FULL_MANIFEST,
      tool: "mcp__agent-tasks__task_finish",
      toolArgs: JSON.stringify({ taskId: TASK_ID, result: "done" }),
    });
    expect(r.report.matchingPolicies.map((p) => p.name)).not.toContain(GATE);
    const missed = r.report.couldMatchPolicies.find((p) => p.name === GATE);
    expect(missed?.reason).toMatch(/trigger\.input_match needs toolArgs\.autoMerge/);
  });

  it("predicts NO match for autoMerge: false, naming the actual value", () => {
    const r = dryRun("finish", {
      configPath: FULL_MANIFEST,
      tool: "mcp__agent-tasks__task_finish",
      toolArgs: JSON.stringify({ taskId: TASK_ID, autoMerge: false }),
    });
    expect(r.report.matchingPolicies.map((p) => p.name)).not.toContain(GATE);
    const missed = r.report.couldMatchPolicies.find((p) => p.name === GATE);
    expect(missed?.reason).toBe("trigger.input_match toolArgs.autoMerge is false, not true");
  });

  it("predicts the task_merge gate, which carries no input_match at all", () => {
    const r = dryRun("merge the task", {
      configPath: FULL_MANIFEST,
      tool: "mcp__agent-tasks__task_merge",
      toolArgs: JSON.stringify({ taskId: TASK_ID }),
    });
    const hit = r.report.matchingPolicies.find((p) => p.name === "review-before-task-merge");
    expect(hit?.ledgerQuery).toBe(`review:${TASK_ID}`);
  });

  // The discriminating fixture (mutation probe (c) in this task's brief):
  // dropping the input_match arm from `policyMatchesTool` makes dry-run
  // predict a match for every one of the three non-autoMerge payloads
  // while `policyMatchesEvent` still says no, and this equality goes red.
  it("agrees with policyMatchesEvent for every autoMerge payload shape", () => {
    const { manifest } = loadManifest({ configPath: FULL_MANIFEST });
    const policy = manifest.policies.find((p) => p.name === GATE);
    if (!policy) throw new Error(`docs/examples/full-manifest.yaml is missing ${GATE}`);

    const payloads: Array<Record<string, unknown>> = [
      { taskId: TASK_ID, autoMerge: true },
      { taskId: TASK_ID, autoMerge: false },
      { taskId: TASK_ID, autoMerge: "true" },
      { taskId: TASK_ID, autoMerge: 1 },
      { taskId: TASK_ID, autoMerge: null },
      { taskId: TASK_ID, result: "done" },
      { taskId: TASK_ID },
    ];
    const runtimeVerdicts: boolean[] = [];
    for (const toolInput of payloads) {
      const event: ToolEvent = {
        hook_event_name: "PreToolUse",
        tool_name: "mcp__agent-tasks__task_finish",
        tool_input: toolInput,
      };
      const runtimeVerdict = policyMatchesEvent(policy, event);
      runtimeVerdicts.push(runtimeVerdict);
      const r = dryRun("finish", {
        configPath: FULL_MANIFEST,
        tool: "mcp__agent-tasks__task_finish",
        toolArgs: JSON.stringify(toolInput),
      });
      const dryRunVerdict = r.report.matchingPolicies.some((p) => p.name === GATE);
      expect(
        dryRunVerdict,
        `dry-run must agree with policyMatchesEvent for ${JSON.stringify(toolInput)}`,
      ).toBe(runtimeVerdict);
    }
    // Negative control: the payload list is not uniformly true or false,
    // so the equality above is discriminating rather than trivially met.
    expect(runtimeVerdicts).toEqual([true, false, false, false, false, false, false]);
  });
});
