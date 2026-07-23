import { describe, expect, it } from "vitest";
import {
  buildMergedTagContent,
  CURATED_MUTATION_BASH_RE,
  ESCAPE_GIT_BASH_RE,
  ESCAPE_HARNESS_BASH_RE,
  extractExitCode,
  extractPrNumber,
  GH_PR_MERGE_BASH_RE,
  isCuratedMutationCommand,
  isEscapeCommand,
  MERGED_TAG_PREFIX,
  mergedTagMatchKey,
  PACK_NAME,
} from "../../src/policy-packs/builtin/post-merge-gate-runtime.js";

describe("constants", () => {
  it("exposes the canonical pack name and tag prefix", () => {
    expect(PACK_NAME).toBe("post-merge-gate");
    expect(MERGED_TAG_PREFIX).toBe("post-merge-gate:merged");
  });
});

describe("mergedTagMatchKey / buildMergedTagContent", () => {
  it("builds the exact match-key substring", () => {
    expect(mergedTagMatchKey("harness", "feat/x", "a".repeat(40))).toBe(
      `post-merge-gate:merged:harness:feat/x:${"a".repeat(40)}`,
    );
  });

  it("content always contains the match key as a substring, plus pr + timestamp decoration", () => {
    const content = buildMergedTagContent({
      repo: "harness",
      branch: "feat/x",
      sha: "b".repeat(40),
      pr: "42",
      whenIso: "2026-07-23T00:00:00.000Z",
    });
    expect(content).toContain(mergedTagMatchKey("harness", "feat/x", "b".repeat(40)));
    expect(content).toContain("pr:42");
    expect(content).toContain("at:2026-07-23T00:00:00.000Z");
  });

  it("omits the pr: token when no PR number was extracted", () => {
    const content = buildMergedTagContent({
      repo: "harness",
      branch: "feat/x",
      sha: "c".repeat(40),
      pr: null,
      whenIso: "2026-07-23T00:00:00.000Z",
    });
    expect(content).not.toContain(" pr:");
    expect(content).toContain(mergedTagMatchKey("harness", "feat/x", "c".repeat(40)));
  });
});

describe("GH_PR_MERGE_BASH_RE (producer trigger)", () => {
  it.each([
    "gh pr merge",
    "gh pr merge 42",
    "gh pr merge --squash",
    "gh pr merge --squash --delete-branch",
    "cd repo && gh pr merge",
    "gh pr merge; echo done",
  ])("matches %s", (cmd) => {
    expect(GH_PR_MERGE_BASH_RE.test(cmd)).toBe(true);
  });

  it.each(["gh pr create", "gh pr view", "gh pr list", "git merge main"])(
    "does not match %s",
    (cmd) => {
      expect(GH_PR_MERGE_BASH_RE.test(cmd)).toBe(false);
    },
  );
});

// Self-lock table 1/2: the curated v1 deny-scope. Every command the
// decisions doc names must match; nothing else should.
describe("CURATED_MUTATION_BASH_RE / isCuratedMutationCommand", () => {
  it.each([
    "git commit -am 'x'",
    "git add -A",
    "git push",
    "git push origin feat/x",
    "git merge main",
    "git rebase main",
    "git cherry-pick abc123",
    "git revert HEAD",
    "git reset --hard HEAD~1",
    "git stash pop",
    "git stash apply",
    "gh pr create",
    "gh pr merge",
    "gh pr merge --squash",
    "git -C /some/repo commit -m x",
  ])("matches curated mutation %s", (cmd) => {
    expect(isCuratedMutationCommand(cmd)).toBe(true);
  });

  it.each([
    "git status",
    "git log",
    "git diff",
    "git branch",
    "git switch main",
    "git checkout main",
    "git pull",
    "git fetch",
    "git branch -d feat/x",
    "git stash list",
    "git stash show",
    "gh pr view",
    "gh pr list",
    "ls -la",
    "npm test",
  ])("does not match innocent neighbour %s", (cmd) => {
    expect(isCuratedMutationCommand(cmd)).toBe(false);
  });
});

// Self-lock table 2/2: the escape allowlist. Checked FIRST by the blocker
// (hook-post-merge-gate.ts), unconditionally. Must-allow includes the
// exact recovery commands the deny message recommends plus robustness
// variants (npx / absolute path / node_modules/.bin) for the harness verb,
// mirroring the deny-kill-switch-bash regex precedent in
// src/cli/init/templates.ts. Innocent neighbours (the curated mutation
// commands) must stay OUTSIDE the escape allowlist — an escape command
// must never also be classified as curated mutation, or the "escape wins"
// design would silently widen the deny-scope's exemptions.
describe("ESCAPE_GIT_BASH_RE / ESCAPE_HARNESS_BASH_RE / isEscapeCommand", () => {
  it.each([
    "git switch main",
    "git switch -c feat/y",
    "git checkout main",
    "git checkout -b feat/y",
    "git pull",
    "git pull --ff-only",
    "git fetch",
    "git fetch origin",
    "git branch -d feat/x",
    "git branch -D feat/x",
    "git stash list",
    "git stash show",
    "git -C /some/repo switch main",
    "harness session-start branch-check",
    "harness pause",
    "harness explain post-merge-gate",
    // Robustness variants (mirrors deny-kill-switch-bash's proven bypasses).
    "npx harness session-start branch-check",
    "/usr/local/bin/harness pause",
    "./node_modules/.bin/harness pause",
    "cd repo && git switch main",
    "echo x && harness pause",
  ])("escape allows %s", (cmd) => {
    expect(isEscapeCommand(cmd)).toBe(true);
  });

  it.each([
    "git commit -am 'x'",
    "git push",
    "git merge main",
    "gh pr merge",
    "gh pr create",
    "ls -la",
    "npm test",
  ])("does not treat curated mutation %s as an escape", (cmd) => {
    expect(isEscapeCommand(cmd)).toBe(false);
  });

  it("every escape command that also happens to look like a mutation still classifies as escape-first (design contract, not a regex property)", () => {
    // git branch -d is deliberately outside the curated mutation list
    // entirely (branch deletion isn't in the curated set), so there is no
    // actual overlap today — this test pins that invariant explicitly so
    // a future edit to either list trips it if it ever changes.
    expect(isCuratedMutationCommand("git branch -d feat/x")).toBe(false);
    expect(isEscapeCommand("git branch -d feat/x")).toBe(true);
  });
});

describe("extractExitCode", () => {
  it("reads a plain-number exit_code", () => {
    expect(extractExitCode({ exit_code: 0 })).toBe(0);
    expect(extractExitCode({ exit_code: 1 })).toBe(1);
  });

  it("returns null for every non-confirming shape", () => {
    expect(extractExitCode(undefined)).toBeNull();
    expect(extractExitCode(null)).toBeNull();
    expect(extractExitCode("0")).toBeNull();
    expect(extractExitCode({})).toBeNull();
    expect(extractExitCode({ exitCode: 0 })).toBeNull();
    expect(extractExitCode({ exit_code: "0" })).toBeNull();
    expect(extractExitCode({ exit_code: Number.NaN })).toBeNull();
    expect(extractExitCode({ stdout: "ok", stderr: "" })).toBeNull();
  });
});

describe("extractPrNumber", () => {
  it("extracts a trailing PR number", () => {
    expect(extractPrNumber("gh pr merge 42")).toBe("42");
    expect(extractPrNumber("gh pr merge --squash 42")).toBe("42");
  });

  it("returns null when no PR number is present", () => {
    expect(extractPrNumber("gh pr merge")).toBeNull();
    expect(extractPrNumber("gh pr merge --squash")).toBeNull();
  });
});
