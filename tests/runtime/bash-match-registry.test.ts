import { describe, expect, it } from "vitest";
import {
  checkRegisteredSets,
  type RegisteredHeadTokenSet,
} from "../../src/runtime/bash-match-registry.js";
import type { BashMatchFacts, HeadTokenClass } from "../../src/runtime/bash-match-facts.js";

// Fixture regression tests for the two historical incidents this run
// exists to close, written BEFORE `tests/runtime/bash-match-head-token-drift.test.ts`
// was migrated onto `checkRegisteredSets` (task `074acf5d`). These prove
// the CHECK LOGIC itself catches each incident's exact shape, independent
// of today's real registrations — the live-FULL_TEMPLATE-driven guard in
// the migrated test proves today's SHIPPED state is clean using the same
// function.

function fixtureFacts(
  gatedHeadTokens: readonly string[],
  classify: Readonly<Record<string, HeadTokenClass>>,
): Pick<BashMatchFacts, "gatedHeadTokens" | "classify"> {
  return {
    gatedHeadTokens: new Set(gatedHeadTokens),
    classify: (token) => classify[token],
  };
}

describe("checkRegisteredSets — historical incident regressions", () => {
  it("dbc6d303 CRITICAL regression: a must-not-contain-gated-head-token set that contains a gated head token is flagged", () => {
    // Reproduces run dbc6d303's shape: a new module's INERT_CONSUMER_HEADS
    // (an "inert consumer" allowlist for some OTHER purpose) contained
    // `harness`, itself the gated head token of deny-kill-switch-bypass —
    // a real hardening regression (harness 'pause' went from shipped
    // binary DENY to branch ALLOW).
    const facts = fixtureFacts(["harness", "git"], { harness: "non-git-set", git: "git" });
    const registrations: readonly RegisteredHeadTokenSet[] = [
      {
        id: "INERT_CONSUMER_HEADS_FIXTURE",
        module: "fixture: reproduces dbc6d303",
        intent: "must-not-contain-gated-head-token",
        has: (token) => new Set(["ls", "cat", "harness"]).has(token),
        description:
          "fixture reproducing dbc6d303: an inert-consumer allowlist that accidentally included the kill-switch's own gated head token",
      },
      // A clean covers registration so the covers-completeness check
      // (part (b)) does not also fire in this fixture and muddy the
      // assertion below — this test is isolating part (a).
      {
        id: "COVERS_FIXTURE",
        module: "fixture",
        intent: "covers-gated-head-tokens",
        has: (token) => new Set(["harness", "git"]).has(token),
        description: "fixture covering both tokens so only the must-not-contain check is exercised",
      },
    ];

    const violations = checkRegisteredSets(facts, registrations, new Set());

    const mustNotContainViolations = violations.filter(
      (v) => v.intent === "must-not-contain-gated-head-token",
    );
    expect(mustNotContainViolations).toHaveLength(1);
    expect(mustNotContainViolations[0]).toMatchObject({
      setId: "INERT_CONSUMER_HEADS_FIXTURE",
      token: "harness",
    });
  });

  it("432db3d3 HIGH regression: a covers-gated-head-tokens set spanning only 4 of 8 gated head tokens leaves the rest unclassified/uncovered", () => {
    // Reproduces run 432db3d3's shape: NON_GIT_HEAD_TOKENS covered 4 head
    // tokens while FULL_TEMPLATE actually gated 8.
    const eightTokens = ["gh", "npm", "harness", "git", "env", "unset", "tee", "cp"];
    const facts = fixtureFacts(
      eightTokens,
      Object.fromEntries(
        eightTokens.map((t) => [t, t === "git" ? "git" : "non-git-set"] as const),
      ),
    );
    const registrations: readonly RegisteredHeadTokenSet[] = [
      {
        id: "NON_GIT_HEAD_TOKENS_FIXTURE_4_OF_8",
        module: "fixture: reproduces 432db3d3",
        intent: "covers-gated-head-tokens",
        has: (token) => new Set(["gh", "npm", "harness", "env"]).has(token),
        description: "fixture reproducing 432db3d3: covers only 4 of the 8 gated head tokens",
      },
      {
        id: "GIT_TOKEN_RE_FIXTURE",
        module: "fixture",
        intent: "covers-gated-head-tokens",
        has: (token) => token === "git",
        description: "fixture git coverage",
      },
    ];

    // No documented-uncovered tokens in this fixture — deliberately, so
    // the remaining 3 (unset, tee, cp) surface as genuine coverage gaps,
    // matching the HIGH's own finding that nothing declared the gap
    // consciously at the time.
    const violations = checkRegisteredSets(facts, registrations, new Set());

    const uncovered = violations
      .filter((v) => v.intent === "covers-gated-head-tokens" && v.setId === "(none)")
      .map((v) => v.token)
      .sort();
    expect(uncovered).toEqual(["cp", "tee", "unset"]);
  });

  it("a clean fixture (every gated token either covered or documented-uncovered, no must-not-contain violations) produces zero violations", () => {
    const facts = fixtureFacts(["gh", "npm", "env"], {
      gh: "non-git-set",
      npm: "non-git-set",
      env: "documented-uncovered",
    });
    const registrations: readonly RegisteredHeadTokenSet[] = [
      {
        id: "COVERS_FIXTURE",
        module: "fixture",
        intent: "covers-gated-head-tokens",
        has: (token) => new Set(["gh", "npm"]).has(token),
        description: "fixture",
      },
      {
        id: "MUST_NOT_CONTAIN_FIXTURE",
        module: "fixture",
        intent: "must-not-contain-gated-head-token",
        has: (token) => new Set(["ls", "cat"]).has(token),
        description: "fixture",
      },
    ];

    const violations = checkRegisteredSets(facts, registrations, new Set(["env"]));
    expect(violations).toEqual([]);
  });
});
