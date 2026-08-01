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

  // Task 76671e5a: bash starts a new command after a single `&`, so
  // `A=x&gh pr merge` used to slip past this producer trigger entirely
  // (the boundary alternation only listed `&&`). Same fix `d834a065`
  // applied to every policy trigger. `&&` is subsumed by `&` (the second
  // `&` in `A=x&&gh pr merge` itself serves as the boundary), so the `&&`
  // cases are the regression pin proving nothing was dropped.
  it.each(["A=x&gh pr merge", "sleep 0 & gh pr merge", "A=x&gh pr merge 42"])(
    "matches the bare-`&`-separated form %s (task 76671e5a)",
    (cmd) => {
      expect(GH_PR_MERGE_BASH_RE.test(cmd)).toBe(true);
    },
  );
  it.each(["A=x&&gh pr merge", "echo x && gh pr merge"])(
    "still matches the `&&`-separated form %s (subsumed, not dropped)",
    (cmd) => {
      expect(GH_PR_MERGE_BASH_RE.test(cmd)).toBe(true);
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

  // Task 76671e5a: this is a DENY-scope matcher (broader = stricter, the
  // safe direction), so it gets the same bare-`&` boundary fix as
  // GH_PR_MERGE_BASH_RE above. `A=x&git push` used to slip past the
  // blocker entirely. `&&` cases pin subsumption (nothing dropped).
  it.each(["A=x&git push", "sleep 0 & git commit -am 'x'", "A=x&gh pr merge"])(
    "matches the bare-`&`-separated form %s (task 76671e5a)",
    (cmd) => {
      expect(isCuratedMutationCommand(cmd)).toBe(true);
    },
  );
  it.each(["A=x&&git push", "echo x && git push"])(
    "still matches the `&&`-separated form %s (subsumed, not dropped)",
    (cmd) => {
      expect(isCuratedMutationCommand(cmd)).toBe(true);
    },
  );

  // Known, ACCEPTED false-positive cost of the bare-`&` broadening (task
  // 76671e5a, F2) — nothing in this suite recorded this before. Extends the
  // existing in-quotes false-positive class (`&&` / `;` / `|`, task
  // `dbc6d303`) to a bare `&`: a gated verb mentioned as TEXT inside a
  // quoted string, after a literal `&`, now matches. Verified against the
  // live PATH (no `git` subprocess runs; bash only echoes/prints the quoted
  // text) that these are genuine over-blocks, not real invocations. The
  // predecessor change `d834a065` disclosed exactly this shape for `&&` in
  // CHANGELOG.md ("6 new ones, every new one of the shape gated verb
  // mentioned as text after a literal `&`"); this pins that the `&`-only
  // widening does not regress that standard, by naming the new cost rather
  // than hiding it. Direction is fail-closed (over-block, not under-block).
  it.each([
    'echo "a&git push"',
    "echo 'rollback plan: stop&git reset --hard'",
    "grep -F 'x&git commit' notes.md",
    'printf \'%s\\n\' "note: build&git push"',
  ])("accepted over-block: %s matches as curated mutation even though bash never runs the gated verb", (cmd) => {
    expect(isCuratedMutationCommand(cmd)).toBe(true);
  });

  // Disjointness (no-lockout) spot-check: none of the bare-`&`-broadened
  // deny matches also classify as an escape command — broadening the deny
  // side must never shrink the effective recovery path. Measured
  // exhaustively over a larger corpus outside the suite; this pins the
  // representative cases inline so a future edit that narrows the escape
  // verb list or widens the deny list into it trips a test.
  it.each(["A=x&git push", "sleep 0 & git commit -am 'x'", "A=x&gh pr merge"])(
    "the bare-`&` deny match %s is never also an escape command",
    (cmd) => {
      expect(isEscapeCommand(cmd)).toBe(false);
    },
  );

  // Accepted asymmetry (task 76671e5a, F6), pinned rather than left
  // implicit: the deny side now recognizes a bare `&` boundary;
  // ESCAPE_GIT_BASH_RE/ESCAPE_HARNESS_BASH_RE deliberately do not. Measured
  // consequence over a 5,880-command three-segment corpus: 480 commands of
  // exactly one shape, `<LEAD> & <RECOVERY> & <DENY>` (e.g. `sleep 0&git
  // switch master&git push`), become newly blocked, because the recovery
  // verb is reachable only via a bare `&` and so is invisible to the narrow
  // escape check. This is NOT a lockout: every such command also contains a
  // mutation verb bash really runs, and the plain recovery command the deny
  // message recommends (`git switch master` alone, no bare-`&` chaining) is
  // never blocked. A future sweep that widens the escape list to "fix" this
  // must make that decision consciously, not by drift.
  it("accepted asymmetry: a recovery verb reachable only via a bare `&` is not recognized as an escape, even though the chained command containing it is a curated mutation", () => {
    expect(isEscapeCommand("sleep 0 & git switch master")).toBe(false);
    expect(isCuratedMutationCommand("sleep 0&git switch master&git push")).toBe(true);
    // The plain recovery the deny message recommends is never blocked.
    expect(isCuratedMutationCommand("git switch master")).toBe(false);
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

  // Task 76671e5a, ALLOW-LIST PIN: unlike GH_PR_MERGE_BASH_RE and
  // CURATED_MUTATION_BASH_RE (deny/trigger matchers, broadened above), the
  // escape allowlist is checked FIRST and unconditionally — broadening its
  // boundary alphabet would let MORE commands skip the gate, the dangerous
  // direction. Both regexes must therefore carry EXACTLY the doubled `&&`
  // and no bare `&` alternative. A future sweep that widens them (the
  // one-line change every other matcher in this file just got) must turn
  // this red. Mutation-tested: temporarily adding `|&` to either source and
  // reverting reddened/re-greened this exact test.
  it("ESCAPE_GIT_BASH_RE / ESCAPE_HARNESS_BASH_RE carry the EXACT narrow boundary group, not just the old `&`-count / substring checks", () => {
    // A prior version of this pin counted `&` characters and checked for
    // the substring `&&|&|`. Disproven by mutation (task 76671e5a fix round
    // 1, finding F4): rewriting the boundary to `(?:^|\n|;|\||&&?|\()` is a
    // genuine widening — `&&?` matches a single bare `&`, so
    // `isEscapeCommand("A=x&git switch main")` flips from `false` to `true`,
    // reopening the exact bypass this allowlist must not have — while still
    // containing exactly two `&` characters and never the literal substring
    // `&&|&|`. Under that mutation only the BEHAVIORAL pin below caught it;
    // the character-count/substring pin stayed green. Assert the exact
    // narrow boundary group's source text instead, so `&&?`, `&{1,2}`,
    // `[&]`, or any other reshaping is rejected in one check rather than
    // enumerated one mutation at a time.
    const NARROW_BOUNDARY_GROUP = "(?:^|\\n|;|\\||&&|\\()";
    expect(ESCAPE_GIT_BASH_RE.source.startsWith(NARROW_BOUNDARY_GROUP)).toBe(true);
    expect(ESCAPE_HARNESS_BASH_RE.source.startsWith(NARROW_BOUNDARY_GROUP)).toBe(true);
  });

  it("ESCAPE_GIT_BASH_RE / ESCAPE_HARNESS_BASH_RE do NOT allow the bare-`&`-separated form of an escape verb (behavioral pin, mirrors the source-level pin above)", () => {
    expect(isEscapeCommand("A=x&git switch main")).toBe(false);
    expect(isEscapeCommand("sleep 0 & git switch main")).toBe(false);
    expect(isEscapeCommand("A=x&harness pause")).toBe(false);
    expect(isEscapeCommand("sleep 0 & harness pause")).toBe(false);
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
