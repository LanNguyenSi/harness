import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { FULL_TEMPLATE } from "../../src/cli/init/templates.js";
import { GIT_TOKEN_RE, NON_GIT_HEAD_TOKENS } from "../../src/runtime/command-normalize.js";
import { parseManifest } from "../../src/schema/index.js";

// Fix round 2, finding F3: couples command-normalize.ts's covered
// head-token set (`GIT_TOKEN_RE`, `NON_GIT_HEAD_TOKENS` — both exported
// from that module for exactly this purpose) to what FULL_TEMPLATE's
// shipped `bash_match` policies actually key on TODAY, read fresh out of
// FULL_TEMPLATE (never hand-copied — same read-not-copy discipline as
// `policyBashMatch` in the sibling test files). A future `bash_match`
// policy with a NEW or CHANGED (renamed) head token must make this test
// FAIL LOUDLY, forcing a conscious re-classification instead of silent
// drift between "what the engine covers" and "what the manifest gates".
//
// Literal head-token extraction straight out of an arbitrary regex string
// is fragile (alternations, nested groups, nothing guarantees a token is
// even a bare word). Per the review brief, a CURATED classification map
// asserted against the actual regex strings is used instead. Two
// independent checks close two independent drift directions:
//   1. ADDED/REMOVED policy: the exact SET of policy names carrying a
//      `bash_match` trigger in FULL_TEMPLATE must equal the exact set of
//      names classified below — neither more nor fewer.
//   2. RENAMED/REMOVED token within a still-existing policy: for every
//      classified token, the ACTUAL bash_match string (read fresh, not
//      copied) must still contain that token as a standalone word
//      (`\bTOKEN\b`).
// NAMED RESIDUALS (not closed by this test, and not required by the review
// brief either):
//   a. A THIRD alternative silently added ALONGSIDE an existing,
//      still-correctly-spelled token (e.g. dogfood-before-release someday
//      also gating `yarn publish`) would not trip either check, since
//      nothing here verifies the token INVENTORY is exhaustive, only that
//      classified tokens are present and the policy-name set matches.
//      Closing that would need a real regex-AST head-token extractor,
//      which the review brief explicitly allows skipping in favour of this
//      curated-map approach.
//   b. DELETING a classified alternative whose token survives as a
//      SUBSTRING elsewhere in the same regex (e.g. dropping the standalone
//      `unset <VAR>` alternative while `--unset` remains) keeps the
//      `\bTOKEN\b` presence check green. Measured (verify pass): that
//      mutation is caught instead by the full-template parity and
//      kill-switch-deny suites (122 failures across 15 files), so the repo
//      is not blind to it — this guard just is not the net that catches it.
//   c. The engine-to-manifest direction is covered by the dedicated
//      assertion below (every NON_GIT_HEAD_TOKENS member must be
//      classified here), added after the verify pass measured that an
//      unshipped token quietly added to the set would otherwise stay
//      green. Headless trigger alternatives (deny-session-env-strip's bare
//      `<SESSION_VAR>=` form) have no head token and are therefore outside
//      this guard's model entirely; that ceiling is pinned in
//      command-normalize.test.ts instead.
type HeadTokenClass = "git" | "non-git-set" | "documented-uncovered";

interface HeadTokenExpectation {
  token: string;
  class: HeadTokenClass;
}

// "documented-uncovered" tokens (fix round 2, finding F1 — see the
// module header's "SHIPPED BUT NOT COVERED" paragraph in
// command-normalize.ts for why each is genuinely out of reach today, not
// merely unimplemented).
const DOCUMENTED_UNCOVERED_HEAD_TOKENS: ReadonlySet<string> = new Set([
  "env",
  "unset",
  "tee",
  "cp",
]);

const EXPECTED_BASH_MATCH_HEAD_TOKENS: Record<string, HeadTokenExpectation[]> = {
  "review-before-merge-bash": [{ token: "gh", class: "non-git-set" }],
  "dogfood-before-release": [
    { token: "npm", class: "non-git-set" },
    { token: "git", class: "git" },
  ],
  "preflight-before-investigation": [{ token: "git", class: "git" }],
  "review-subagent-before-pr-create-bash": [{ token: "gh", class: "non-git-set" }],
  "preflight-before-push": [{ token: "git", class: "git" }],
  "deny-kill-switch-bypass": [{ token: "harness", class: "non-git-set" }],
  "deny-session-env-strip": [
    { token: "env", class: "documented-uncovered" },
    { token: "unset", class: "documented-uncovered" },
  ],
  "deny-pause-sentinel-forgery": [
    { token: "tee", class: "documented-uncovered" },
    { token: "cp", class: "documented-uncovered" },
  ],
};

function parsedPolicies() {
  return parseManifest(parseYaml(FULL_TEMPLATE)).policies;
}

describe("bash_match head-token drift guard (fix round 2, finding F3)", () => {
  it("the exact set of FULL_TEMPLATE policies declaring a bash_match trigger matches the classified set — neither more nor fewer", () => {
    const actualNames = parsedPolicies()
      .filter((p) => p.trigger.bash_match !== undefined)
      .map((p) => p.name)
      .sort();
    const expectedNames = Object.keys(EXPECTED_BASH_MATCH_HEAD_TOKENS).sort();
    expect(actualNames).toEqual(expectedNames);
  });

  it("every NON_GIT_HEAD_TOKENS member is classified as non-git-set in the map — the engine cannot quietly normalise a head token no shipped policy gates (residual c)", () => {
    const classifiedNonGit = new Set(
      Object.values(EXPECTED_BASH_MATCH_HEAD_TOKENS)
        .flat()
        .filter((e) => e.class === "non-git-set")
        .map((e) => e.token),
    );
    for (const token of NON_GIT_HEAD_TOKENS) {
      expect(
        classifiedNonGit.has(token),
        `NON_GIT_HEAD_TOKENS contains "${token}", but no FULL_TEMPLATE bash_match policy is classified as gating it`,
      ).toBe(true);
    }
  });

  for (const [policyName, expectations] of Object.entries(EXPECTED_BASH_MATCH_HEAD_TOKENS)) {
    describe(policyName, () => {
      function realPattern(): string {
        const policy = parsedPolicies().find((p) => p.name === policyName);
        if (!policy) throw new Error(`policy ${policyName} missing from FULL_TEMPLATE`);
        const pattern = policy.trigger.bash_match;
        if (!pattern) throw new Error(`policy ${policyName} declares no trigger.bash_match`);
        return pattern;
      }

      for (const { token, class: cls } of expectations) {
        it(`head token "${token}" (classified: ${cls}) is still present as a standalone word in the real bash_match, and matches its classification`, () => {
          const pattern = realPattern();
          const standaloneWordRe = new RegExp(`\\b${token}\\b`);
          expect(
            standaloneWordRe.test(pattern),
            `expected "${token}" as a standalone word in ${policyName}'s bash_match: ${pattern}`,
          ).toBe(true);

          if (cls === "git") {
            expect(GIT_TOKEN_RE.test(token)).toBe(true);
            expect(NON_GIT_HEAD_TOKENS.has(token)).toBe(false);
          } else if (cls === "non-git-set") {
            expect(NON_GIT_HEAD_TOKENS.has(token)).toBe(true);
            expect(GIT_TOKEN_RE.test(token)).toBe(false);
          } else {
            // documented-uncovered: genuinely NOT covered by the engine
            // today. If this ever starts failing because the engine NOW
            // covers it (NON_GIT_HEAD_TOKENS grew to include it), that is
            // a real coverage improvement — move this token's
            // classification (and drop it from
            // DOCUMENTED_UNCOVERED_HEAD_TOKENS) consciously; do not just
            // delete the assertion.
            expect(DOCUMENTED_UNCOVERED_HEAD_TOKENS.has(token)).toBe(true);
            expect(NON_GIT_HEAD_TOKENS.has(token)).toBe(false);
            expect(GIT_TOKEN_RE.test(token)).toBe(false);
          }
        });
      }
    });
  }
});
