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
        members: ["harness", "git"],
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
        members: ["gh", "npm", "harness", "env"],
        description: "fixture reproducing 432db3d3: covers only 4 of the 8 gated head tokens",
      },
      {
        id: "GIT_TOKEN_RE_FIXTURE",
        module: "fixture",
        intent: "covers-gated-head-tokens",
        has: (token) => token === "git",
        members: ["git"],
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

  it("fix-round F1/F2 regression: a covers-gated-head-tokens registration whose declared `members` include a token that is NOT a live gated head token is flagged", () => {
    // F1 (reverse ENGINE->MANIFEST direction): the pre-migration guard
    // asserted every member of NON_GIT_HEAD_TOKENS must be a token some
    // shipped policy gates; the migration to checkRegisteredSets dropped
    // that direction (completeness-checking (b) only ever walks gated
    // tokens outward, never a set's own members inward). This fixture's
    // "COVERS_PLUS_UNGATED_MEMBER" registration declares an ungated member
    // ("docker") the same way a real NON_GIT_HEAD_TOKENS mutation would.
    //
    // F2 (mis-declared-intent laundering): reproduces the reviewer's exact
    // attack — the real dbc6d303 INERT_CONSUMER_HEADS shape (`new
    // Set(["ls", "cat", "harness"])`, an inert-consumer allowlist that
    // happens to contain the gated token "harness") registered under
    // "covers-gated-head-tokens" instead of its true
    // "must-not-contain-gated-head-token" intent, which made the
    // pre-fix-round guard 19/19 GREEN because check (a) (must-not-contain)
    // never inspects a "covers"-labelled registration and check (b)
    // (covers-completeness) does not penalise EXTRA coverage. Declaring
    // `members` here makes the laundering visible: "ls" and "cat" are not
    // gated head tokens, so the covers-purity check (c) flags them.
    const facts = fixtureFacts(["harness", "git"], { harness: "non-git-set", git: "git" });
    const registrations: readonly RegisteredHeadTokenSet[] = [
      {
        id: "COVERS_PLUS_UNGATED_MEMBER",
        module: "fixture: F1 reverse-direction shape",
        intent: "covers-gated-head-tokens",
        has: (token) => new Set(["harness", "docker"]).has(token),
        members: ["harness", "docker"],
        description: "fixture: a covers set that gained an ungated member (\"docker\"), the F1 shape",
      },
      {
        id: "INERT_CONSUMER_HEADS_LAUNDERED",
        module: "fixture: F2 mis-declared-intent shape (dbc6d303's real INERT_CONSUMER_HEADS contents)",
        intent: "covers-gated-head-tokens", // mis-declared: this is really a must-not-contain-gated-head-token set
        has: (token) => new Set(["ls", "cat", "harness"]).has(token),
        members: ["ls", "cat", "harness"],
        description: "fixture: an inert-consumer allowlist laundered under the covers intent to dodge the must-not-contain check",
      },
      {
        id: "GIT_COVERS_FIXTURE",
        module: "fixture",
        intent: "covers-gated-head-tokens",
        has: (token) => token === "git",
        members: ["git"],
        description: "fixture git coverage so only the covers-purity check is exercised, not covers-completeness",
      },
    ];

    const violations = checkRegisteredSets(facts, registrations, new Set());

    // Filtered to `check === "covers-purity"` (fix round 2) so the two NEW
    // checks added this round — (d) covers-redundancy and (e)
    // covers-predicate-purity, see `bash-match-registry.ts` — cannot
    // silently change what THIS assertion (isolating check (c) alone)
    // measures. Both new checks also fire on this exact fixture (see the
    // dedicated assertions below) — that is additional evidence, not a
    // substitute for this one.
    const purityViolations = violations.filter((v) => v.check === "covers-purity");
    const purityViolationTokensBySet = new Map<string, string[]>();
    for (const v of purityViolations) {
      const list = purityViolationTokensBySet.get(v.setId) ?? [];
      list.push(v.token);
      purityViolationTokensBySet.set(v.setId, list);
    }

    expect(purityViolationTokensBySet.get("COVERS_PLUS_UNGATED_MEMBER")).toEqual(["docker"]);
    expect(purityViolationTokensBySet.get("INERT_CONSUMER_HEADS_LAUNDERED")?.sort()).toEqual([
      "cat",
      "ls",
    ]);
    // "harness" IS a live gated head token, so it must NOT be flagged by
    // the purity check even though it sits inside the laundered set —
    // only its genuinely non-gated members ("ls", "cat") are the tell.
    expect(purityViolationTokensBySet.get("INERT_CONSUMER_HEADS_LAUNDERED")).not.toContain(
      "harness",
    );
    expect(purityViolationTokensBySet.get("GIT_COVERS_FIXTURE")).toBeUndefined();

    // Additional evidence (fix round 2): this same fixture ALSO trips the
    // two new checks, independently of covers-purity above.
    // covers-redundancy (d): "harness" is answered `true` by BOTH
    // COVERS_PLUS_UNGATED_MEMBER and INERT_CONSUMER_HEADS_LAUNDERED, so
    // both are flagged for it.
    const redundancyViolations = violations.filter((v) => v.check === "covers-redundancy");
    expect(redundancyViolations.map((v) => `${v.setId}:${v.token}`).sort()).toEqual([
      "COVERS_PLUS_UNGATED_MEMBER:harness",
      "INERT_CONSUMER_HEADS_LAUNDERED:harness",
    ]);
    // covers-predicate-purity (e): each set's has() answers true for a
    // token beyond what its (honestly declared) members alone would
    // predict as gated — the same tokens purity already caught by
    // declaration, now caught by probing the predicate directly.
    const predicatePurityViolations = violations.filter(
      (v) => v.check === "covers-predicate-purity",
    );
    expect(predicatePurityViolations.map((v) => `${v.setId}:${v.token}`).sort()).toEqual([
      "COVERS_PLUS_UNGATED_MEMBER:docker",
      "INERT_CONSUMER_HEADS_LAUNDERED:cat",
      "INERT_CONSUMER_HEADS_LAUNDERED:ls",
    ]);
  });

  it("fix-round-2 S2 regression: an intent-laundered single-member covers set (members: [\"harness\"]) is flagged by covers-redundancy even though its one declared member is honestly gated", () => {
    // Reproduces the reviewer's exact measurement: `new
    // Set(["harness"])`, registered as "covers-gated-head-tokens" with
    // `members: ["harness"]` declared HONESTLY (harness IS a live gated
    // head token, so check (c) covers-purity passes cleanly), still
    // passed the pre-S2 guard 22/22 because nothing checked whether
    // "harness" was ALREADY covered by the real set that exists to cover
    // it (NON_GIT_HEAD_TOKENS's analog here).
    const facts = fixtureFacts(["harness", "git"], { harness: "non-git-set", git: "git" });
    const registrations: readonly RegisteredHeadTokenSet[] = [
      {
        id: "NON_GIT_HEAD_TOKENS_FIXTURE",
        module: "fixture: simulates the real NON_GIT_HEAD_TOKENS covering harness",
        intent: "covers-gated-head-tokens",
        has: (token) => new Set(["harness"]).has(token),
        members: ["harness"],
        description: "fixture: the real, legitimate coverage of harness",
      },
      {
        id: "GIT_COVERS_FIXTURE",
        module: "fixture",
        intent: "covers-gated-head-tokens",
        has: (token) => token === "git",
        members: ["git"],
        description: "fixture git coverage",
      },
      {
        id: "LAUNDERED_SINGLE_MEMBER",
        module: "fixture: reviewer-measured laundering shape",
        intent: "covers-gated-head-tokens",
        has: (token) => new Set(["harness"]).has(token),
        members: ["harness"],
        description:
          "fixture: an intent-laundered set (new Set([\"harness\"])) registered as covers with its one member declared honestly",
      },
    ];

    const violations = checkRegisteredSets(facts, registrations, new Set());
    const redundancyViolations = violations.filter((v) => v.check === "covers-redundancy");
    expect(redundancyViolations.map((v) => `${v.setId}:${v.token}`).sort()).toEqual([
      "LAUNDERED_SINGLE_MEMBER:harness",
      "NON_GIT_HEAD_TOKENS_FIXTURE:harness",
    ]);
  });

  it("fix-round-2 S2 regression: an intent-laundered two-member covers set (members: [\"harness\", \"gh\"]) is flagged by covers-redundancy even though both declared members are honestly gated", () => {
    // Reproduces the reviewer's second measurement: `new Set(["harness",
    // "gh"])`, registered as covers with both members declared honestly
    // (both ARE live gated head tokens), also passed the pre-S2 guard
    // 22/22.
    const facts = fixtureFacts(["harness", "git", "gh"], {
      harness: "non-git-set",
      git: "git",
      gh: "non-git-set",
    });
    const registrations: readonly RegisteredHeadTokenSet[] = [
      {
        id: "NON_GIT_HEAD_TOKENS_FIXTURE",
        module: "fixture: simulates the real NON_GIT_HEAD_TOKENS covering harness and gh",
        intent: "covers-gated-head-tokens",
        has: (token) => new Set(["harness", "gh"]).has(token),
        members: ["harness", "gh"],
        description: "fixture: the real, legitimate coverage of harness and gh",
      },
      {
        id: "GIT_COVERS_FIXTURE",
        module: "fixture",
        intent: "covers-gated-head-tokens",
        has: (token) => token === "git",
        members: ["git"],
        description: "fixture git coverage",
      },
      {
        id: "LAUNDERED_TWO_MEMBER",
        module: "fixture: reviewer-measured laundering shape",
        intent: "covers-gated-head-tokens",
        has: (token) => new Set(["harness", "gh"]).has(token),
        members: ["harness", "gh"],
        description:
          "fixture: an intent-laundered set (new Set([\"harness\", \"gh\"])) registered as covers with both members declared honestly",
      },
    ];

    const violations = checkRegisteredSets(facts, registrations, new Set());
    const redundancyViolations = violations.filter((v) => v.check === "covers-redundancy");
    expect(redundancyViolations.map((v) => `${v.setId}:${v.token}`).sort()).toEqual([
      "LAUNDERED_TWO_MEMBER:gh",
      "LAUNDERED_TWO_MEMBER:harness",
      "NON_GIT_HEAD_TOKENS_FIXTURE:gh",
      "NON_GIT_HEAD_TOKENS_FIXTURE:harness",
    ]);
  });

  it("fix-round-2 S4/D-004 regression: a covers registration whose has() predicate accepts a token beyond its declared, honestly-gated members is flagged by covers-predicate-purity", () => {
    // Reproduces the GIT_TOKEN_RE shape measured by the orchestrator
    // (D-004): a predicate that answers `true` for more than its
    // declared `members` claim, with `members` itself fully honest and
    // clean (so check (c) alone would miss it entirely).
    const facts = fixtureFacts(["git"], { git: "git" });
    const registrations: readonly RegisteredHeadTokenSet[] = [
      {
        id: "WIDENED_PREDICATE_FIXTURE",
        module: "fixture: reproduces the GIT_TOKEN_RE-widened-to-docker shape (D-004)",
        intent: "covers-gated-head-tokens",
        has: (token) => token === "git" || token === "docker",
        members: ["git"],
        description:
          "fixture: predicate accepts \"docker\" though members only (honestly) declares \"git\"",
      },
    ];

    const violations = checkRegisteredSets(facts, registrations, new Set());
    const predicatePurityViolations = violations.filter(
      (v) => v.check === "covers-predicate-purity",
    );
    expect(predicatePurityViolations).toEqual([
      expect.objectContaining({ setId: "WIDENED_PREDICATE_FIXTURE", token: "docker" }),
    ]);
    // Check (c) covers-purity, in contrast, sees nothing wrong — the
    // declared `members` are clean — which is exactly why check (e) had
    // to be added as an INDEPENDENT check over the predicate itself.
    expect(violations.filter((v) => v.check === "covers-purity")).toEqual([]);
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
        members: ["gh", "npm"],
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
