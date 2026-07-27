import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { dryRun } from "../../src/cli/dry-run.js";
import { HarnessExitError } from "../../src/cli/exit-codes.js";

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
