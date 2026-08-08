import { describe, expect, it } from "vitest";
import {
  checkRegisteredSets,
  type CoversHeadTokenSet,
  type RegisteredHeadTokenSet,
} from "../../src/runtime/bash-match-registry.js";
import type { BashMatchFacts, HeadTokenClass } from "../../src/runtime/bash-match-facts.js";

// Fixture regression tests for the historical incidents and the three
// adversarial review passes this registry exists to close, written against
// the SOURCE-based registration surface (task `209e6dc4` redesign — a
// registration hands the guard the actual constant, never a hand-typed
// `has()`/`members` self-description; see `bash-match-registry.ts`'s module
// header for the full six-point closure list). These prove the CHECK LOGIC
// itself catches each shape, independent of today's real registrations —
// the live-FULL_TEMPLATE-driven guard in
// `tests/runtime/bash-match-head-token-drift.test.ts` proves today's
// SHIPPED state is clean using the same function.

function fixtureFacts(
  gatedHeadTokens: readonly string[],
  classify: Readonly<Record<string, HeadTokenClass>>,
): Pick<BashMatchFacts, "gatedHeadTokens" | "classify"> {
  return {
    gatedHeadTokens: new Set(gatedHeadTokens),
    classify: (token) => classify[token],
  };
}

/** Shorthand for a "covers" fixture backed by a literal Set — the common shape below. */
function coversSetFixture(
  id: string,
  members: readonly string[],
  extra: Partial<Pick<CoversHeadTokenSet, "intentionalOverlaps">> = {},
): CoversHeadTokenSet {
  return {
    id,
    module: "fixture",
    intent: "covers-gated-head-tokens",
    source: { kind: "set", set: new Set(members) },
    description: `fixture: ${id}`,
    ...extra,
  };
}

describe("checkRegisteredSets — historical incident regressions", () => {
  it("dbc6d303 CRITICAL regression: a must-not-contain-gated-head-token set whose source contains a gated head token is flagged", () => {
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
        source: { kind: "set", set: new Set(["ls", "cat", "harness"]) },
        description:
          "fixture reproducing dbc6d303: an inert-consumer allowlist that accidentally included the kill-switch's own gated head token",
      },
      // A clean covers registration so the covers-completeness check
      // (part (b)) does not also fire in this fixture and muddy the
      // assertion below — this test is isolating part (a).
      coversSetFixture("COVERS_FIXTURE", ["harness", "git"]),
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
      coversSetFixture("NON_GIT_HEAD_TOKENS_FIXTURE_4_OF_8", ["gh", "npm", "harness", "env"]),
      coversSetFixture("GIT_TOKEN_RE_FIXTURE", ["git"]),
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

  it("task 209e6dc4 point 1 regression: the EXACT measured shape — a covers registration whose source is `new Set([\"tee\"])`, a single documented-uncovered gated head token — is flagged, even though it is entirely honest and live-coupled", () => {
    // Reproduces review round 3's exact measurement (the shape the
    // pre-redesign registry, task 074acf5d, could not see at all): a
    // `covers-gated-head-tokens` registration declaring only
    // `documented-uncovered` members passed every one of the five old
    // checks with an honest, live-coupled has()/members. Under the
    // source-based redesign there is no separate `members` to declare
    // honestly — the probe reads `source` directly and still catches it,
    // because a documented-uncovered token is now explicitly ILLEGITIMATE
    // for a covers set to claim, not merely "gated".
    const facts = fixtureFacts(["tee", "cp", "env", "unset", "git"], {
      tee: "documented-uncovered",
      cp: "documented-uncovered",
      env: "documented-uncovered",
      unset: "documented-uncovered",
      git: "git",
    });
    const documentedUncovered = new Set(["tee", "cp", "env", "unset"]);
    const registrations: readonly RegisteredHeadTokenSet[] = [
      coversSetFixture("TEE_LAUNDERED_FIXTURE", ["tee"]),
      coversSetFixture("GIT_COVERS_FIXTURE", ["git"]),
    ];

    const violations = checkRegisteredSets(facts, registrations, documentedUncovered);

    const purityViolations = violations.filter(
      (v) => v.check === "covers-purity" && v.setId === "TEE_LAUNDERED_FIXTURE",
    );
    expect(purityViolations).toEqual([
      expect.objectContaining({ setId: "TEE_LAUNDERED_FIXTURE", token: "tee" }),
    ]);
    expect(purityViolations[0]!.reason).toMatch(/documented-uncovered/);

    // The laundered set also covers nothing LEGITIMATE, so it trips
    // covers-empty too — additional evidence, not a substitute.
    expect(violations).toContainEqual(
      expect.objectContaining({ setId: "TEE_LAUNDERED_FIXTURE", check: "covers-empty" }),
    );
    // The clean git registration must not be touched by either check.
    expect(
      violations.filter(
        (v) => v.setId === "GIT_COVERS_FIXTURE" && (v.check === "covers-purity" || v.check === "covers-empty"),
      ),
    ).toEqual([]);
  });

  it("task 209e6dc4 point 3 (empty half) regression: a covers registration whose source is an empty Set is flagged by covers-empty — the structural echo of the old `members: []` escape, which type-checked and passed silently", () => {
    const facts = fixtureFacts(["git", "gh"], { git: "git", gh: "non-git-set" });
    const registrations: readonly RegisteredHeadTokenSet[] = [
      coversSetFixture("EMPTY_FIXTURE", []),
      coversSetFixture("GIT_COVERS_FIXTURE", ["git"]),
      coversSetFixture("GH_COVERS_FIXTURE", ["gh"]),
    ];

    const violations = checkRegisteredSets(facts, registrations, new Set());
    const emptyViolations = violations.filter((v) => v.check === "covers-empty");
    expect(emptyViolations).toEqual([
      expect.objectContaining({ setId: "EMPTY_FIXTURE", token: "(none)" }),
    ]);
  });

  it("fix-round F1/F2 shape, reproduced against source: a covers-gated-head-tokens registration whose source contains a token that is NOT a live gated head token, and a mis-declared-intent laundered set, are both flagged by covers-purity", () => {
    // F1 (reverse ENGINE->MANIFEST direction): a covers set gaining a
    // member the manifest does not gate at all (e.g. "docker") is real
    // dead code / drift.
    //
    // F2 (mis-declared-intent laundering): reproduces the reviewer's exact
    // attack — the real dbc6d303 INERT_CONSUMER_HEADS shape (`new
    // Set(["ls", "cat", "harness"])`, an inert-consumer allowlist that
    // happens to contain the gated token "harness") registered under
    // "covers-gated-head-tokens" instead of its true
    // "must-not-contain-gated-head-token" intent. Under the source-based
    // redesign this is caught the same way F1 is — by probing `source`
    // directly, there being no separate `members` declaration to inspect
    // instead.
    const facts = fixtureFacts(["harness", "git"], { harness: "non-git-set", git: "git" });
    const registrations: readonly RegisteredHeadTokenSet[] = [
      coversSetFixture("COVERS_PLUS_UNGATED_MEMBER", ["harness", "docker"]),
      coversSetFixture("INERT_CONSUMER_HEADS_LAUNDERED", ["ls", "cat", "harness"]),
      coversSetFixture("GIT_COVERS_FIXTURE", ["git"]),
    ];

    const violations = checkRegisteredSets(facts, registrations, new Set());

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

    // Additional evidence: this same fixture ALSO trips covers-redundancy,
    // independently of covers-purity above — "harness" is answered `true`
    // by BOTH COVERS_PLUS_UNGATED_MEMBER and
    // INERT_CONSUMER_HEADS_LAUNDERED, neither of which declares the
    // overlap via intentionalOverlaps.
    const redundancyViolations = violations.filter((v) => v.check === "covers-redundancy");
    expect(redundancyViolations.map((v) => `${v.setId}:${v.token}`).sort()).toEqual([
      "COVERS_PLUS_UNGATED_MEMBER:harness",
      "INERT_CONSUMER_HEADS_LAUNDERED:harness",
    ]);
  });

  it("fix-round-2 S2 shape, reproduced against source: an intent-laundered single-member covers set (source: new Set([\"harness\"])) is flagged by covers-redundancy even though its one member is honestly gated, because neither set declares the overlap", () => {
    // Reproduces the reviewer's exact measurement: `new
    // Set(["harness"])`, registered as "covers-gated-head-tokens", passed
    // the pre-S2 guard because nothing checked whether "harness" was
    // ALREADY covered by the real set that exists to cover it
    // (NON_GIT_HEAD_TOKENS's analog here). Neither registration declares
    // `intentionalOverlaps`, so the overlap remains a laundering signal —
    // see the next test for the same shape with a CONSCIOUS declaration.
    const facts = fixtureFacts(["harness", "git"], { harness: "non-git-set", git: "git" });
    const registrations: readonly RegisteredHeadTokenSet[] = [
      coversSetFixture("NON_GIT_HEAD_TOKENS_FIXTURE", ["harness"]),
      coversSetFixture("GIT_COVERS_FIXTURE", ["git"]),
      coversSetFixture("LAUNDERED_SINGLE_MEMBER", ["harness"]),
    ];

    const violations = checkRegisteredSets(facts, registrations, new Set());
    const redundancyViolations = violations.filter((v) => v.check === "covers-redundancy");
    expect(redundancyViolations.map((v) => `${v.setId}:${v.token}`).sort()).toEqual([
      "LAUNDERED_SINGLE_MEMBER:harness",
      "NON_GIT_HEAD_TOKENS_FIXTURE:harness",
    ]);
  });

  it("task 209e6dc4 point 4 resolution: the SAME overlap as the previous test produces ZERO covers-redundancy violations once BOTH covering sets consciously declare it via intentionalOverlaps — legitimate double coverage now has a valid expression", () => {
    const facts = fixtureFacts(["harness", "git"], { harness: "non-git-set", git: "git" });
    const registrations: readonly RegisteredHeadTokenSet[] = [
      coversSetFixture("NON_GIT_HEAD_TOKENS_FIXTURE", ["harness"], {
        intentionalOverlaps: new Set(["harness"]),
      }),
      coversSetFixture("GIT_COVERS_FIXTURE", ["git"]),
      coversSetFixture("DELIBERATE_SECOND_COVERAGE", ["harness"], {
        intentionalOverlaps: new Set(["harness"]),
      }),
    ];

    const violations = checkRegisteredSets(facts, registrations, new Set());
    expect(violations.filter((v) => v.check === "covers-redundancy")).toEqual([]);
  });

  it("task 209e6dc4 point 4, one-sided declaration: if only ONE of the two overlapping sets declares intentionalOverlaps, the laundering signal survives — a set cannot silently free-ride on the other set's declaration", () => {
    const facts = fixtureFacts(["harness", "git"], { harness: "non-git-set", git: "git" });
    const registrations: readonly RegisteredHeadTokenSet[] = [
      coversSetFixture("NON_GIT_HEAD_TOKENS_FIXTURE", ["harness"], {
        intentionalOverlaps: new Set(["harness"]),
      }),
      coversSetFixture("GIT_COVERS_FIXTURE", ["git"]),
      // This set does NOT declare intentionalOverlaps for "harness" —
      // the round-2 laundering shape: a new set silently re-covers a
      // token an existing set already owns.
      coversSetFixture("SILENT_SECOND_COVERAGE", ["harness"]),
    ];

    const violations = checkRegisteredSets(facts, registrations, new Set());
    const redundancyViolations = violations.filter((v) => v.check === "covers-redundancy");
    expect(redundancyViolations.map((v) => `${v.setId}:${v.token}`).sort()).toEqual([
      "NON_GIT_HEAD_TOKENS_FIXTURE:harness",
      "SILENT_SECOND_COVERAGE:harness",
    ]);
  });

  it("fix-round-2 S2 two-member shape, reproduced against source: an intent-laundered two-member covers set (source: new Set([\"harness\", \"gh\"])) is flagged by covers-redundancy on both tokens", () => {
    const facts = fixtureFacts(["harness", "git", "gh"], {
      harness: "non-git-set",
      git: "git",
      gh: "non-git-set",
    });
    const registrations: readonly RegisteredHeadTokenSet[] = [
      coversSetFixture("NON_GIT_HEAD_TOKENS_FIXTURE", ["harness", "gh"]),
      coversSetFixture("GIT_COVERS_FIXTURE", ["git"]),
      coversSetFixture("LAUNDERED_TWO_MEMBER", ["harness", "gh"]),
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

  it("fix-round-2 S4/D-004 shape, reproduced against source: a covers registration backed by a REGEX whose match set is wider than the live gated head tokens it should cover is flagged by covers-purity", () => {
    // Reproduces the GIT_TOKEN_RE shape measured by the orchestrator
    // (D-004): a predicate that answers `true` for more than it should.
    // Under the redesign there is no separate `members` declaration for
    // check (c) to trust instead — covers-purity probes the regex
    // directly, so a widened regex is caught the same way a widened Set
    // would be.
    const facts = fixtureFacts(["git"], { git: "git" });
    const registrations: readonly RegisteredHeadTokenSet[] = [
      {
        id: "WIDENED_PREDICATE_FIXTURE",
        module: "fixture: reproduces the GIT_TOKEN_RE-widened-to-docker shape (D-004)",
        intent: "covers-gated-head-tokens",
        source: { kind: "regex", re: /^(?:git|docker)$/ },
        description: "fixture: regex matches \"docker\" though only \"git\" is a live gated head token",
      },
    ];

    const violations = checkRegisteredSets(facts, registrations, new Set());
    const purityViolations = violations.filter((v) => v.check === "covers-purity");
    expect(purityViolations).toEqual([
      expect.objectContaining({ setId: "WIDENED_PREDICATE_FIXTURE", token: "docker" }),
    ]);
  });

  it("a clean fixture (every gated token either covered or documented-uncovered, no must-not-contain violations, no empty/laundered covers sets) produces zero violations", () => {
    const facts = fixtureFacts(["gh", "npm", "env"], {
      gh: "non-git-set",
      npm: "non-git-set",
      env: "documented-uncovered",
    });
    const registrations: readonly RegisteredHeadTokenSet[] = [
      coversSetFixture("COVERS_FIXTURE", ["gh", "npm"]),
      {
        id: "MUST_NOT_CONTAIN_FIXTURE",
        module: "fixture",
        intent: "must-not-contain-gated-head-token",
        source: { kind: "set", set: new Set(["ls", "cat"]) },
        description: "fixture",
      },
    ];

    const violations = checkRegisteredSets(facts, registrations, new Set(["env"]));
    expect(violations).toEqual([]);
  });
});
