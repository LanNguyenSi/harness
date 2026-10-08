import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { dryRun } from "../../src/cli/dry-run.js";
import { HarnessExitError } from "../../src/cli/exit-codes.js";
import { loadManifest } from "../../src/cli/loader.js";
import { runInterceptCli } from "../../src/cli/policy/intercept.js";
import {
  MAX_ATTRIBUTED_CONTEXTS,
  OPAQUE_TARGET_REASON,
  policyMatchesEvent,
  type ToolEvent,
} from "../../src/runtime/intercept.js";
import type { Policy } from "../../src/schema/index.js";
import { addGitDirSkeleton } from "../_helpers/git-dir-fixture.js";
import { legacyPreflightInvestigation, legacyPreflightPush } from "../_helpers/legacy-preflight-policies.js";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..", "..");
const REFERENCE_MANIFEST = path.join(REPO_ROOT, "docs", "examples", "full-manifest.yaml");

// The reference manifest dropped the preflight-before-* policies in task
// f3f15290, but the dry-run engine tests below still exercise them as the
// canonical `${BRANCH}` / `${REPO}` branch-tag Bash fixtures (ledger-query
// resolution, quote-aware match parity). Build a local superset fixture: the
// live reference manifest plus the two legacy policies and the hooks they name,
// so those engine guards stay honest without re-shipping the policies.
const REFERENCE_MANIFEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "harness-dry-run-fixture-"));
afterAll(() => fs.rmSync(REFERENCE_MANIFEST_DIR, { recursive: true, force: true }));
const FULL_MANIFEST = (() => {
  const manifest = parseYaml(fs.readFileSync(REFERENCE_MANIFEST, "utf8")) as {
    hooks: Array<Record<string, unknown>>;
    policies: Array<Record<string, unknown>>;
  };
  const extra: Array<[Policy, string]> = [
    [legacyPreflightInvestigation(), "require-preflight-evidence"],
    [legacyPreflightPush(), "require-preflight-push-evidence"],
  ];
  for (const [policy, hookName] of extra) {
    manifest.policies.push(policy as unknown as Record<string, unknown>);
    manifest.hooks.push({
      name: hookName,
      event: "PreToolUse",
      match: "Bash",
      command: `~/.claude/hooks/${hookName}.sh`,
      blocking: "hard",
      budget_ms: 2000,
    });
  }
  const file = path.join(REFERENCE_MANIFEST_DIR, "full-manifest.yaml");
  fs.writeFileSync(file, stringifyYaml(manifest));
  return file;
})();

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
    addGitDirSkeleton(path.join(repo, ".git"));
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

describe("dry-run: an empty REPO / BRANCH never shows a blank ledger tag", () => {
  const tmpDir = (): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-dryrun-empty-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
  };
  const queryFor = (name: string, command: string, cwd: string): string | undefined => {
    const r = dryRun("look around", {
      configPath: FULL_MANIFEST,
      tool: "Bash",
      toolArgs: JSON.stringify({ command }),
      builtins: { CWD: cwd },
    });
    return r.report.matchingPolicies.find((p) => p.name === name)?.ledgerQuery;
  };

  it("a cwd outside every repo shows the no-repository hint instead of `preflight:`", () => {
    const query = queryFor("preflight-before-investigation", "git status", tmpDir());
    expect(query).toBeDefined();
    expect(query).not.toBe("preflight:");
    expect(query).toContain("no ledger query");
    expect(query).toContain("cd <repo>");
    expect(query).toContain("git -C <repo>");
  });

  it("a detached HEAD shows the git switch hint for a branch tag", () => {
    const repo = path.join(tmpDir(), "detached-repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git", "HEAD"), `${"c".repeat(40)}\n`);
    addGitDirSkeleton(path.join(repo, ".git"));
    const query = queryFor("preflight-before-push", "git push", repo);
    expect(query).toBeDefined();
    expect(query).not.toBe("preflight:");
    expect(query).toContain("git switch <branch>");
  });

  it("a git directory whose HEAD is unreadable shows the unreadable-file text, not the git switch hint", () => {
    const repo = path.join(tmpDir(), "refused-repo");
    // A `.git` directory with no HEAD: present, but it cannot be read.
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    const query = queryFor("preflight-before-push", "git push", repo);
    expect(query).toBeDefined();
    expect(query).toContain("no ledger query");
    expect(query).toContain("a git file there (HEAD) is present but is not a readable regular file");
    expect(query).not.toContain("HEAD is detached");
    expect(query).not.toContain("git switch <branch>");
  });

  it("a dangling `.git` symlink shows the unreadable-file text naming `.git`", () => {
    const repo = path.join(tmpDir(), "dangling-repo");
    fs.mkdirSync(repo, { recursive: true });
    fs.symlinkSync(path.join(repo, "no-such-gitdir"), path.join(repo, ".git"));
    const query = queryFor("preflight-before-push", "git push", repo);
    expect(query).toContain("a git file there (.git) is present but is not a readable regular file");
    expect(query).not.toContain("git switch <branch>");
  });

  it("an explicit BRANCH builtin overrides the refused-file text (the operator named the branch state)", () => {
    const repo = path.join(tmpDir(), "refused-repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    const r = dryRun("look around", {
      configPath: FULL_MANIFEST,
      tool: "Bash",
      toolArgs: JSON.stringify({ command: "git push" }),
      builtins: { CWD: repo, BRANCH: "" },
    });
    const query = r.report.matchingPolicies.find((p) => p.name === "preflight-before-push")?.ledgerQuery;
    expect(query).toContain("git switch <branch>");
    expect(query).not.toContain("a git file there");
  });

  it("an explicit empty REPO builtin is guarded too", () => {
    const r = dryRun("look around", {
      configPath: FULL_MANIFEST,
      tool: "Bash",
      toolArgs: JSON.stringify({ command: "git status" }),
      builtins: { REPO: "" },
    });
    const query = r.report.matchingPolicies.find(
      (p) => p.name === "preflight-before-investigation",
    )?.ledgerQuery;
    expect(query).toContain("cd <repo>");
  });

  it("unchanged: a policy without REPO/BRANCH in its tag still renders its tag outside a repo", () => {
    const r = dryRun("merge PR 42", {
      configPath: FULL_MANIFEST,
      tool: "mcp__agent-tasks__pull_requests_merge",
      toolArgs: JSON.stringify({ prNumber: 42 }),
      builtins: { CWD: tmpDir() },
    });
    expect(r.report.matchingPolicies.find((p) => p.name === "review-before-merge")?.ledgerQuery).toBe(
      "review:42",
    );
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
describe("dry-run: trigger.input_match (task 2699b476)", () => {
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

describe("dry-run: additive per-repo demands for a target-naming command", () => {
  function makeRepo(name: string, branch: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-dryrun-attr-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = path.join(root, name);
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
    addGitDirSkeleton(path.join(repo, ".git"));
    // A loose ref gives the repository a head sha, as a real checkout has.
    fs.mkdirSync(path.join(repo, ".git", "refs", "heads"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".git", "refs", "heads", branch),
      `${"a1b2c3d4e5".repeat(4)}\n`,
    );
    return repo;
  }

  function hit(command: string, cwd: string, policy: string) {
    const r = dryRun("look around", {
      configPath: FULL_MANIFEST,
      tool: "Bash",
      toolArgs: JSON.stringify({ command }),
      builtins: { CWD: cwd },
    });
    const found = r.report.matchingPolicies.find((p) => p.name === policy);
    expect(found, `${policy} should match ${command}`).toBeDefined();
    return found!;
  }

  it("predicts preflight:<A> and preflight:<B> for `git -C <B> log` run from A", () => {
    const a = makeRepo("repo-a", "main");
    const b = makeRepo("repo-b", "main");
    const h = hit(`git -C ${b} log`, a, "preflight-before-investigation");
    expect([...h.ledgerQueries].sort()).toEqual(["preflight:repo-a", "preflight:repo-b"]);
    // cwd value stays for --json consumers.
    expect(h.ledgerQuery).toBe("preflight:repo-a");
  });

  it("predicts both branch tags for `git -C <B> push` with B on another branch", () => {
    const a = makeRepo("repo-a", "main");
    const b = makeRepo("repo-b", "feature-x");
    const h = hit(`git -C ${b} push origin main`, a, "preflight-before-push");
    expect([...h.ledgerQueries].sort()).toEqual(["preflight:feature-x", "preflight:main"]);
  });

  it("collapses a subdirectory of the cwd repo into one demand", () => {
    const a = makeRepo("repo-a", "main");
    const sub = path.join(a, "subdir");
    fs.mkdirSync(sub);
    const h = hit(`git -C ${sub} status`, a, "preflight-before-investigation");
    expect(h.ledgerQueries).toEqual(["preflight:repo-a"]);
  });

  it("keeps a BRANCH override across attributed contexts", () => {
    const a = makeRepo("repo-a", "main");
    const b = makeRepo("repo-b", "feature-x");
    const r = dryRun("x", {
      configPath: FULL_MANIFEST,
      tool: "Bash",
      toolArgs: JSON.stringify({ command: `git -C ${b} push origin main` }),
      builtins: { CWD: a, BRANCH: "pinned" },
    });
    const h = r.report.matchingPolicies.find((p) => p.name === "preflight-before-push");
    expect(h?.ledgerQueries).toEqual(["preflight:pinned", "preflight:pinned"]);
  });

  it("gives three foreign repos four tags and four foreign repos the bounded text", () => {
    const a = makeRepo("repo-a", "main");
    const others = ["b", "c", "d", "e"].map((n) => makeRepo(`repo-${n}`, "main"));
    const cmd = (os: string[]) => os.map((o) => `git -C ${o} log`).join(" && ");
    const three = hit(cmd(others.slice(0, 3)), a, "preflight-before-investigation");
    expect(three.ledgerQueries).toHaveLength(4);
    expect(three.ledgerQueries.every((q) => /^preflight:repo-/.test(q))).toBe(true);
    const four = hit(cmd(others), a, "preflight-before-investigation");
    expect(four.ledgerQueries).toHaveLength(1);
    expect(four.ledgerQueries[0]).toContain("bounded");
  });

  it("keeps a single demand for a command naming no other repository", () => {
    const a = makeRepo("repo-a", "main");
    const h = hit("git status", a, "preflight-before-investigation");
    expect(h.ledgerQueries).toEqual(["preflight:repo-a"]);
  });

  it("reports the bounded ambiguity text instead of tags for five distinct foreign repos", () => {
    const a = makeRepo("repo-a", "main");
    const others = ["b", "c", "d", "e", "f"].map((n) => makeRepo(`repo-${n}`, "main"));
    const command = others.map((o) => `git -C ${o} log`).join(" && ");
    const h = hit(command, a, "preflight-before-investigation");
    expect(h.ledgerQueries).toHaveLength(1);
    expect(h.ledgerQueries[0]).toContain("bounded");
    expect(h.ledgerQueries[0]).toContain(`${MAX_ATTRIBUTED_CONTEXTS}-context bound`);
    expect(h.ledgerQueries[0]).not.toMatch(/preflight:repo-/);
  });

  it("reports one opaque-target text instead of a cwd tag for a backtick -C target (task cfb6b390)", () => {
    const a = makeRepo("repo-a", "main");
    const h = hit("git -C 'vendor/lib`x`y' log", a, "preflight-before-investigation");
    expect(h.ledgerQueries).toHaveLength(1);
    expect(h.ledgerQueries[0]).toContain("opaque target");
    expect(h.ledgerQueries[0]).not.toMatch(/preflight:repo-a/);
  });

  it("reports the runtime's opaque-target text for a directory that depends on an unresolved value (task e927e903)", () => {
    const a = makeRepo("repo-a", "main");
    for (const command of ['git -C "$(echo vendor)" log', "HOME=vendor; cd; git log"]) {
      const h = hit(command, a, "preflight-before-investigation");
      expect(h.ledgerQueries, command).toEqual([`(opaque target: ${OPAQUE_TARGET_REASON}; no context queried)`]);
    }
  });

  it("treats an explicit REPO override as an override in an attributed context", () => {
    const a = makeRepo("repo-a", "main");
    const b = makeRepo("repo-b", "main");
    const r = dryRun("x", {
      configPath: FULL_MANIFEST,
      tool: "Bash",
      toolArgs: JSON.stringify({ command: `git -C ${b} log` }),
      builtins: { CWD: a, REPO: "forced" },
    });
    const h = r.report.matchingPolicies.find((p) => p.name === "preflight-before-investigation");
    // Two contexts (cwd and B), both with REPO held at the override, exactly
    // as the runtime evaluates them: B's own repo name never replaces it.
    expect(h?.ledgerQueries).toEqual(["preflight:forced", "preflight:forced"]);
  });

  it("matches the demands `policy intercept` makes for the same command", async () => {
    const a = makeRepo("repo-a", "main");
    const b = makeRepo("repo-b", "feature-x");
    const { manifest } = loadManifest({ configPath: FULL_MANIFEST });
    const commands = [
      `git -C ${b} log`,
      `git -C ${b} push origin main`,
      `git -C ${path.join(a, ".")} status`,
    ];
    let foreignLogDecisions = 0;
    for (const command of commands) {
      const chunks: string[] = [];
      const sink = new Writable({
        write(chunk, _enc, cb) {
          chunks.push(chunk.toString("utf8"));
          cb();
        },
      });
      const runtime = await runInterceptCli({
        stdin: Readable.from([
          JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command },
            session_id: "dryrun-parity",
            cwd: a,
          }),
        ]),
        stdout: sink,
        stderr: sink,
        manifest,
        ledger: {
          async query() {
            return { kind: "ok", entries: [] };
          },
          async record() {
            /* no-op */
          },
        },
      });
      if (command === `git -C ${b} log`) {
        foreignLogDecisions = runtime.decisions.filter(
          (d) => d.policyName === "preflight-before-investigation",
        ).length;
      }
      for (const policy of ["preflight-before-investigation", "preflight-before-push"]) {
        const fromRuntime = runtime.decisions
          .filter((d) => d.policyName === policy)
          .map((d) => d.ledgerTag)
          .sort();
        const predicted = dryRun("x", {
          configPath: FULL_MANIFEST,
          tool: "Bash",
          toolArgs: JSON.stringify({ command }),
          builtins: { CWD: a },
        })
          .report.matchingPolicies.filter((p) => p.name === policy)
          .flatMap((p) => p.ledgerQueries)
          .sort();
        expect(predicted, `${policy} for ${command}`).toEqual(fromRuntime);
      }
    }
    // Negative control: the runtime itself made more than one investigation
    // decision for the foreign-repository command, so the equality above is
    // not met by cwd-only output.
    expect(foreignLogDecisions).toBeGreaterThan(1);
  });
});

describe("dry-run: the quote-aware shell model arm and attribution match policy intercept (task 7d4abf84)", () => {
  function makeWorld(): { outer: string; spaced: string; plain: string } {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "harness-dryrun-7d4abf84-")));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = (dir: string, branch: string): string => {
      fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
      fs.writeFileSync(path.join(dir, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
      addGitDirSkeleton(path.join(dir, ".git"));
      return dir;
    };
    const outer = repo(path.join(root, "outer"), "main");
    return {
      outer,
      spaced: repo(path.join(outer, "vendor", "lib sp"), "feature-sp"),
      plain: repo(path.join(outer, "vendor", "libplain"), "feature-plain"),
    };
  }

  async function runtimeTags(command: string, cwd: string, policy: string): Promise<string[]> {
    const { manifest } = loadManifest({ configPath: FULL_MANIFEST });
    const sink = new Writable({
      write(_chunk, _enc, cb) {
        cb();
      },
    });
    const runtime = await runInterceptCli({
      stdin: Readable.from([
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command },
          session_id: "dryrun-7d4abf84",
          cwd,
        }),
      ]),
      stdout: sink,
      stderr: sink,
      manifest,
      ledger: {
        async query() {
          return { kind: "ok", entries: [] };
        },
        async record() {
          /* no-op */
        },
      },
    });
    return runtime.decisions
      .filter((d) => d.policyName === policy)
      .map((d) => (d.reason.startsWith("ambiguous: this command names a repository directory") ? "(opaque)" : d.ledgerTag))
      .sort();
  }

  function predictedTags(command: string, cwd: string, policy: string): string[] {
    return dryRun("x", {
      configPath: FULL_MANIFEST,
      tool: "Bash",
      toolArgs: JSON.stringify({ command }),
      builtins: { CWD: cwd },
    })
      .report.matchingPolicies.filter((p) => p.name === policy)
      .flatMap((p) => p.ledgerQueries.map((q) => (q.startsWith("(opaque target:") ? "(opaque)" : q)))
      .sort();
  }

  it("predicts the match only the shell model arm makes, with the runtime's demands", async () => {
    const w = makeWorld();
    const cases: Array<[string, string, string[]]> = [
      ["git -C 'vendor/lib sp' log", "preflight-before-investigation", ["preflight:lib sp", "preflight:outer"]],
      ["git '-C' vendor/libplain push", "preflight-before-push", ["preflight:feature-plain", "preflight:main"]],
      ["cd vendor && git -C libplain log", "preflight-before-investigation", ["preflight:libplain", "preflight:outer"]],
      ["cd vendor/libpl* && git log", "preflight-before-investigation", ["(opaque)"]],
    ];
    for (const [command, policy, expected] of cases) {
      const fromRuntime = await runtimeTags(command, w.outer, policy);
      expect(fromRuntime, `runtime ${command}`).toEqual(expected);
      expect(predictedTags(command, w.outer, policy), `dry-run ${command}`).toEqual(fromRuntime);
    }
    // The first two match no policy without the shell model arm: the
    // runtime's own matcher agrees with dry-run on the match itself.
    const event: ToolEvent = {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "git -C 'vendor/lib sp' log" },
    };
    const { manifest } = loadManifest({ configPath: FULL_MANIFEST });
    const investigation = manifest.policies.find((p) => p.name === "preflight-before-investigation")!;
    expect(policyMatchesEvent(investigation, event)).toBe(true);
  });

  it("predicts the runtime's demands from a cwd outside every repository and from a repository nested in another", async () => {
    const w = makeWorld();
    const root = path.dirname(w.outer);
    const plain = path.join(root, "plain");
    fs.mkdirSync(plain);
    const child = path.join(w.outer, "wt", "child");
    fs.mkdirSync(path.join(child, ".git"), { recursive: true });
    fs.writeFileSync(path.join(child, ".git", "HEAD"), "ref: refs/heads/feature-child\n");
    addGitDirSkeleton(path.join(child, ".git"));
    fs.mkdirSync(path.join(child, "frontend"));
    // The blank cwd context renders differently in the two (a decision tag
    // vs a hint), both naming that no ledger query is made.
    const blank = (tags: string[]): string[] => tags.map((t) => (t.includes("no ledger query") ? "(blank cwd)" : t));
    const cases: Array<[string, string, string, string[]]> = [
      // The model reads env -C behind `&`; the segment view's blank cwd demand stays.
      [`A=x&env -C ${w.outer} git log`, plain, "preflight-before-investigation", ["(blank cwd)", "preflight:outer"]],
      [`cd ${w.outer}; git log`, plain, "preflight-before-investigation", ["preflight:outer"]],
      // Matched by the model's arm only: no segment-view cwd demand.
      [`git '-C' ${w.outer} log`, plain, "preflight-before-investigation", ["preflight:outer"]],
      // A cd into an existing directory cannot fail: `cd ..` returns to the child.
      ["cd frontend; npm test; cd ..; git status", child, "preflight-before-investigation", ["preflight:child"]],
      ["cd missing; npm test; cd ..; git status", child, "preflight-before-investigation", ["preflight:child", "preflight:outer"]],
    ];
    for (const [command, cwd, policy, expected] of cases) {
      const fromRuntime = blank(await runtimeTags(command, cwd, policy)).sort();
      expect(fromRuntime, `runtime ${command}`).toEqual(expected);
      expect(blank(predictedTags(command, cwd, policy)).sort(), `dry-run ${command}`).toEqual(fromRuntime);
    }
  });

  it("does not extend the shell model arm to a policy that is not evaluated per repository", async () => {
    const w = makeWorld();
    const command = "git '-C' vendor/libplain tag v1";
    const r = dryRun("x", {
      configPath: FULL_MANIFEST,
      tool: "Bash",
      toolArgs: JSON.stringify({ command }),
      builtins: { CWD: w.outer },
    });
    expect(r.report.matchingPolicies.map((p) => p.name)).not.toContain("dogfood-before-release");
    expect(await runtimeTags(command, w.outer, "dogfood-before-release")).toEqual([]);
    // Positive control: the policy exists and matches the unquoted spelling.
    expect(await runtimeTags("git -C vendor/libplain tag v1", w.outer, "dogfood-before-release")).toHaveLength(1);
  });
});
