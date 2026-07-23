import { describe, expect, it } from "vitest";
import {
  buildMergedTagContent,
  CURATED_MUTATION_BASH_RE,
  ESCAPE_GIT_BASH_RE,
  ESCAPE_HARNESS_BASH_RE,
  extractExitCode,
  extractPrNumber,
  GH_MERGE_SUCCESS_RE,
  GH_PR_MERGE_BASH_RE,
  isCuratedMutationCommand,
  isEscapeCommand,
  matchGhMergeSuccessText,
  MERGED_TAG_PREFIX,
  mergedTagMatchKey,
  PACK_NAME,
  resolveMergeConfirmation,
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

// ---------------------------------------------------------------------------
// Payload-reality follow-up (2026-07): Contract B. Live verification against
// a real Claude Code 2.1.218 install found the PostToolUse Bash payload
// carries no `tool_output` field at all, only `tool_response` — see
// tests/fixtures/post-merge-gate/real-posttooluse-payload-2.1.218.json for
// the verbatim capture. GH_MERGE_SUCCESS_RE / matchGhMergeSuccessText is the
// fallback confirmation path for that reality.
// ---------------------------------------------------------------------------

describe("GH_MERGE_SUCCESS_RE / matchGhMergeSuccessText (Contract B)", () => {
  // Real shape (verified against the installed gh v2.94.0,
  // pkg/cmd/pr/merge/merge.go:369-376): `infof("%s %s pull request
  // %s#%d (%s)", icon, action, ghrepo.FullName(baseRepo), pr.Number,
  // pr.Title)` — the repo fullname sits between "pull request" and the
  // PR number, GLUED to `#` with no space. This is the primary,
  // real-world-verified shape.
  it.each([
    ["Squashed and merged", "✓ Squashed and merged pull request LanNguyenSi/agent-memory#65 (Add feature)\n"],
    ["Rebased and merged", "✓ Rebased and merged pull request LanNguyenSi/agent-memory#65 (Add feature)\n"],
    ["Merged", "✓ Merged pull request LanNguyenSi/agent-memory#65 (Add feature)\n"],
  ])("matches gh's REAL %s success sentence (owner/repo#n) and captures the PR number", (_label, stdout) => {
    const m = GH_MERGE_SUCCESS_RE.exec(stdout);
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe("65");
  });

  // Doc-shape / future-gh-version tolerance (bare `#<n>`, no fullname) —
  // NOT gh's current actual wording, but accepted defensively by the
  // same `[^\s#]*` character class (matches zero characters just as
  // easily as it matches a fullname) at no extra matching-surface cost.
  it.each([
    ["Squashed and merged", "✓ Squashed and merged pull request #42 (Add feature)\n"],
    ["Rebased and merged", "✓ Rebased and merged pull request #42 (Add feature)\n"],
    ["Merged", "✓ Merged pull request #42 (Add feature)\n"],
  ])("also matches the doc-shape %s success sentence (bare #n, no fullname)", (_label, stdout) => {
    const m = GH_MERGE_SUCCESS_RE.exec(stdout);
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe("42");
  });

  it.each([
    // gh --auto pending text: REAL wording (same source file), verified
    // against the installed gh v2.94.0. Capitalized standalone "Pull
    // request", no past-tense action phrase immediately precedes it.
    "✓ Pull request owner/repo#65 will be automatically merged via squash when all requirements are met\n",
    // Already-merged warning: REAL wording, verified against the
    // installed gh v2.94.0 (a `warnf`, icon `!`). Word order is
    // reversed ("Pull request ... was already merged"), not "Merged
    // pull request #n".
    "! Pull request owner/repo#65 was already merged\n",
    // Legacy GraphQL-error-shaped negatives (kept as an additional,
    // broader negative-class check — not gh's exact current CLI
    // wording, but the same reversed-word-order class).
    "GraphQL: Pull request Foo/Bar#42 is already merged (mergePullRequest)\n",
    "X Pull request #42 is not mergeable: the merge commit could not be cleanly created.\n",
    "",
    "some unrelated stdout\n",
  ])("does not match negative/error text: %s", (text) => {
    expect(GH_MERGE_SUCCESS_RE.test(text)).toBe(false);
  });

  it("matchGhMergeSuccessText requires interrupted === false, exactly", () => {
    const success = "✓ Merged pull request owner/repo#42 (Add feature)\n";
    expect(matchGhMergeSuccessText({ stdout: success, stderr: "", interrupted: false })).toEqual({
      matched: true,
      pr: "42",
    });
    expect(
      matchGhMergeSuccessText({ stdout: success, stderr: "", interrupted: true }),
    ).toEqual({ matched: false });
    // Missing `interrupted` entirely — fail-safe, not treated as false.
    expect(matchGhMergeSuccessText({ stdout: success, stderr: "" })).toEqual({ matched: false });
  });

  // `infof` (gh's success-message helper) writes to STDERR, not stdout —
  // this is the REALISTIC channel for the success sentence; matched here
  // on stderr alone, with stdout empty (as a real `gh pr merge` Bash
  // result would look).
  it("matchGhMergeSuccessText matches gh's real success channel: stderr (infof), stdout empty", () => {
    expect(
      matchGhMergeSuccessText({
        stdout: "",
        stderr: "✓ Squashed and merged pull request owner/repo#7 (x)\n",
        interrupted: false,
      }),
    ).toEqual({ matched: true, pr: "7" });
  });

  it("matchGhMergeSuccessText also matches on stdout (defensive — the exact stream split is not load-bearing)", () => {
    expect(
      matchGhMergeSuccessText({
        stdout: "✓ Squashed and merged pull request owner/repo#7 (x)\n",
        stderr: "",
        interrupted: false,
      }),
    ).toEqual({ matched: true, pr: "7" });
  });

  it("matchGhMergeSuccessText returns matched:false on every non-confirming shape (never throws)", () => {
    expect(matchGhMergeSuccessText(undefined)).toEqual({ matched: false });
    expect(matchGhMergeSuccessText(null)).toEqual({ matched: false });
    expect(matchGhMergeSuccessText("a string")).toEqual({ matched: false });
    expect(matchGhMergeSuccessText({ interrupted: false })).toEqual({ matched: false });
    expect(
      matchGhMergeSuccessText({
        stdout: 123,
        stderr: null,
        interrupted: false,
      }),
    ).toEqual({ matched: false });
  });
});

describe("resolveMergeConfirmation (dual-contract decision table)", () => {
  const COMMAND = "gh pr merge";
  // Realistic shape: gh's success sentence goes through `infof` (stderr),
  // with the repo fullname glued to `#<n>` (gh v2.94.0 merge.go:369-376).
  const GH_SUCCESS_RESPONSE = {
    stdout: "",
    stderr: "✓ Merged pull request owner/repo#99 (Add feature)\n",
    interrupted: false,
  };

  it("Contract A: exit_code 0 confirms, PR resolved from the command only", () => {
    const r = resolveMergeConfirmation({ exit_code: 0 }, undefined, "gh pr merge 42");
    expect(r).toMatchObject({ confirmed: true, contract: "exit_code", pr: "42" });
  });

  it("Contract A: non-zero exit_code refuses WITHOUT consulting Contract B, even when tool_response would independently confirm", () => {
    const r = resolveMergeConfirmation({ exit_code: 1 }, GH_SUCCESS_RESPONSE, COMMAND);
    expect(r.confirmed).toBe(false);
    expect(r.contract).toBe("none");
    expect(r.reason).toMatch(/Contract B not consulted/);
  });

  it("Contract B: a matching gh success sentence in tool_response confirms when tool_output is absent", () => {
    const r = resolveMergeConfirmation(undefined, GH_SUCCESS_RESPONSE, COMMAND);
    expect(r).toMatchObject({ confirmed: true, contract: "gh_success_text", pr: "99" });
  });

  it("Contract B: PR number prefers the command, falls back to the success-sentence capture", () => {
    const r = resolveMergeConfirmation(undefined, GH_SUCCESS_RESPONSE, "gh pr merge 7");
    expect(r).toMatchObject({ confirmed: true, contract: "gh_success_text", pr: "7" });
  });

  it("Contract B: no match (interrupted, error text, empty output) refuses", () => {
    expect(
      resolveMergeConfirmation(
        undefined,
        { ...GH_SUCCESS_RESPONSE, interrupted: true },
        COMMAND,
      ).confirmed,
    ).toBe(false);
    expect(
      resolveMergeConfirmation(
        undefined,
        { stdout: "", stderr: "! Pull request owner/repo#42 was already merged\n", interrupted: false },
        COMMAND,
      ).confirmed,
    ).toBe(false);
    expect(
      resolveMergeConfirmation(undefined, { stdout: "", stderr: "", interrupted: false }, COMMAND)
        .confirmed,
    ).toBe(false);
  });

  it("neither contract present: refuses", () => {
    const r = resolveMergeConfirmation(undefined, undefined, COMMAND);
    expect(r.confirmed).toBe(false);
    expect(r.contract).toBe("none");
  });

  // Binding ordering decision (hypothetical "both present" shape,
  // coordinator follow-up): Contract A wins whenever it resolves to ANY
  // definite verdict. Pinned both directions.
  it("both contracts present and BOTH would confirm: Contract A wins (reports exit_code, not gh_success_text)", () => {
    const r = resolveMergeConfirmation({ exit_code: 0 }, GH_SUCCESS_RESPONSE, "gh pr merge 5");
    expect(r).toMatchObject({ confirmed: true, contract: "exit_code", pr: "5" });
  });

  it("both contracts present, Contract A fails: Contract A's failure wins over Contract B's would-be success", () => {
    const r = resolveMergeConfirmation({ exit_code: 1 }, GH_SUCCESS_RESPONSE, COMMAND);
    expect(r.confirmed).toBe(false);
    expect(r.contract).toBe("none");
  });
});
