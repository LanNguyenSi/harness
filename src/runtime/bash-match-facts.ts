// Live facts about FULL_TEMPLATE's shipped `bash_match` policies (task
// `074acf5d`, run `2026-07-28-manifest-facts-drift-guard`).
//
// WHY THIS MODULE EXISTS: two consecutive runs shipped/attempted a defect
// of the exact same CLASS, one day and one file apart.
//   - Run `432db3d3` (merged 2026-07-27), HIGH: `NON_GIT_HEAD_TOKENS`
//     (`command-normalize.ts`) covered 4 of the 8 head tokens a shipped
//     `bash_match` policy actually gates. Closed by
//     `tests/runtime/bash-match-head-token-drift.test.ts`, but scoped to
//     that one set in that one file.
//   - Run `dbc6d303` (halted 2026-07-28), CRITICAL: a NEW module's
//     `INERT_CONSUMER_HEADS` contained `harness` — itself the gated head
//     token of `deny-kill-switch-bypass`. The prior day's guard
//     structurally could not see it: it only ever compared ONE named set
//     (`NON_GIT_HEAD_TOKENS`) against the manifest, never a set someone
//     adds tomorrow.
// This module answers, ONE call, read live (never hand-copied): "which
// policies declare a `bash_match`, which head token(s) each anchors on,
// which verbs, and is token X gated by ANY of them?" — the question both
// incidents got wrong. `src/runtime/bash-match-registry.ts` builds the
// generalised, EVERY-registered-set guard on top of the facts this module
// produces.
//
// DESIGN: literal head-token extraction straight out of an arbitrary
// regex string is fragile (alternations, nested groups, nothing
// guarantees a token is even a bare word) — the same reasoning the
// migrated guard's own header carried. A CURATED classification map is
// used instead, but it is never trusted blind: `extractBashMatchFacts`
// verifies it against the LIVE policies passed in (call it with
// `parseManifest(parseYaml(FULL_TEMPLATE)).policies` to get the shipped
// ground truth) and THROWS descriptively the moment the curated map and
// the live manifest disagree — a policy added/removed/renamed, or a
// classified token no longer present in its policy's live pattern. A
// caller that gets a `BashMatchFacts` back without an exception is
// holding verified-fresh facts, not a stale copy.
//
// LAYERING: this module takes policies as a plain parameter and does not
// import `FULL_TEMPLATE` itself (that lives in `src/cli/init/templates.ts`,
// the `cli` layer — `.dependency-cruiser.cjs`'s `runtime-no-upward-imports`
// rule forbids `runtime/` importing `cli/`). The live wiring (parsing
// FULL_TEMPLATE and calling this module) happens in test code, which the
// boundary check does not scan.
//
// WHY src/runtime/, NOT tests/ (F8, fix round): this module and
// `bash-match-registry.ts` are a single shared source of truth that TWO
// independent test files (`bash-match-head-token-drift.test.ts`,
// `bash-match-registry.test.ts`) import symmetrically — a module peer
// test files both depend on belongs beside the engine code it inspects,
// not inside the test tree that merely happens to hold its only callers
// today.

import type { Policy } from "../schema/index.js";

/** How a classified head token relates to the engine's own coverage. */
export type HeadTokenClass = "git" | "non-git-set" | "documented-uncovered";

export interface HeadTokenFact {
  readonly token: string;
  readonly class: HeadTokenClass;
}

interface CuratedPolicyFact {
  readonly headTokens: readonly HeadTokenFact[];
  /**
   * Literal verbs the policy's `bash_match` anchors on, beyond the head
   * token itself (`merge` for `gh pr merge`, `push` for `git push`, ...).
   * Verified live the same way as head tokens (standalone-word presence
   * in the actual pattern). Left empty for a trigger too irregular
   * (headless/dual-mode alternatives) for a simple word-list to honestly
   * describe — see the two `deny-session-env-strip` /
   * `deny-pause-sentinel-forgery` entries below.
   */
  readonly verbs: readonly string[];
}

/**
 * The curated ground truth, verified fresh against FULL_TEMPLATE's live
 * policies by `extractBashMatchFacts` every time it runs — see the module
 * header. Keyed by policy name.
 *
 * "documented-uncovered" tokens (fix round 2, finding F1 on the migrated
 * guard — see `command-normalize.ts`'s "SHIPPED BUT NOT COVERED"
 * paragraph for why each is genuinely out of reach today, not merely
 * unimplemented): `env`, `unset`, `tee`, `cp`.
 */
const CURATED_BASH_MATCH_FACTS: Readonly<Record<string, CuratedPolicyFact>> = {
  "review-before-merge-bash": {
    headTokens: [{ token: "gh", class: "non-git-set" }],
    verbs: ["merge"],
  },
  "dogfood-before-release": {
    headTokens: [
      { token: "npm", class: "non-git-set" },
      { token: "git", class: "git" },
    ],
    verbs: ["publish", "tag"],
  },
  "preflight-before-investigation": {
    headTokens: [{ token: "git", class: "git" }],
    verbs: ["status", "log", "diff", "branch"],
  },
  "review-subagent-before-pr-create-bash": {
    headTokens: [{ token: "gh", class: "non-git-set" }],
    verbs: ["create"],
  },
  "preflight-before-push": {
    headTokens: [{ token: "git", class: "git" }],
    verbs: ["push"],
  },
  "deny-kill-switch-bypass": {
    headTokens: [{ token: "harness", class: "non-git-set" }],
    verbs: ["pause", "resume", "gate", "disable", "enable"],
  },
  "deny-session-env-strip": {
    headTokens: [
      { token: "env", class: "documented-uncovered" },
      { token: "unset", class: "documented-uncovered" },
    ],
    // Headless trigger alternatives (the bare `<SESSION_VAR>=` form) and
    // multiple independent alternations make a flat verb list misleading
    // rather than merely incomplete — left empty rather than overclaim.
    verbs: [],
  },
  "deny-pause-sentinel-forgery": {
    headTokens: [
      { token: "tee", class: "documented-uncovered" },
      { token: "cp", class: "documented-uncovered" },
    ],
    // No separate "verb" beyond the head tokens themselves here.
    verbs: [],
  },
};

/**
 * `documented-uncovered` head tokens are collected from the curated map
 * itself (single source of truth) rather than hand-copied a second time.
 */
function documentedUncoveredTokens(): ReadonlySet<string> {
  const out = new Set<string>();
  for (const fact of Object.values(CURATED_BASH_MATCH_FACTS)) {
    for (const h of fact.headTokens) {
      if (h.class === "documented-uncovered") out.add(h.token);
    }
  }
  return out;
}

/** Exposed for callers that need the full "genuinely not covered today" list (see `bash-match-registry.ts`). */
export const DOCUMENTED_UNCOVERED_HEAD_TOKENS: ReadonlySet<string> = documentedUncoveredTokens();

export interface PolicyBashMatchFact {
  readonly policyName: string;
  readonly pattern: string;
  readonly headTokens: readonly HeadTokenFact[];
  readonly verbs: readonly string[];
}

export interface BashMatchFacts {
  /** Every FULL_TEMPLATE policy name that declares a `bash_match` trigger, verified live. */
  readonly policyNames: readonly string[];
  /** Per-policy detail, in the same order as `policyNames`. */
  readonly policies: readonly PolicyBashMatchFact[];
  /** Every distinct head token gated by ANY `bash_match` policy, flattened. */
  readonly gatedHeadTokens: ReadonlySet<string>;
  /** The classification of a gated head token, or `undefined` if `token` is not gated by any shipped policy at all. */
  classify(token: string): HeadTokenClass | undefined;
}

/** Minimal shape this module needs from a policy — decoupled from the full zod-inferred `Policy` so fixtures can be built without constructing an entire manifest. */
export interface BashMatchPolicyLike {
  readonly name: string;
  readonly trigger: { readonly bash_match?: string | undefined };
}

/**
 * Compute verified-fresh `BashMatchFacts` from a LIVE list of parsed
 * policies. Call with `parseManifest(parseYaml(FULL_TEMPLATE)).policies`
 * to get the shipped ground truth (never hand-copy the patterns).
 *
 * Throws descriptively — the caller should let this propagate as a
 * failing test, not swallow it — when:
 *   1. The exact SET of policy names carrying a `bash_match` trigger in
 *      the live `policies` differs from the curated map's key set
 *      (a policy was added, removed, or renamed).
 *   2. A curated head token or verb is no longer present as a standalone
 *      word (`\bTOKEN\b`) in its policy's live pattern (renamed/removed
 *      within an otherwise still-existing policy).
 */
export function extractBashMatchFacts(
  policies: readonly (BashMatchPolicyLike | Policy)[],
): BashMatchFacts {
  const live = policies.filter(
    (p): p is BashMatchPolicyLike & { trigger: { bash_match: string } } =>
      p.trigger.bash_match !== undefined,
  );
  const actualNames = [...live.map((p) => p.name)].sort();
  const curatedNames = Object.keys(CURATED_BASH_MATCH_FACTS).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(curatedNames)) {
    throw new Error(
      `bash_match facts drift: the live policies declaring a bash_match trigger (${JSON.stringify(actualNames)}) no longer match CURATED_BASH_MATCH_FACTS's classified set (${JSON.stringify(curatedNames)}) in src/runtime/bash-match-facts.ts. A policy was added, removed, or renamed — update the curated map consciously.`,
    );
  }

  const byName = new Map(live.map((p) => [p.name, p]));
  const gatedHeadTokens = new Set<string>();
  const classification = new Map<string, HeadTokenClass>();
  const policyFacts: PolicyBashMatchFact[] = [];

  for (const policyName of curatedNames) {
    const curated = CURATED_BASH_MATCH_FACTS[policyName]!;
    const policy = byName.get(policyName)!;
    const pattern = policy.trigger.bash_match;

    for (const { token, class: cls } of curated.headTokens) {
      assertStandaloneWord(pattern, token, policyName);
      gatedHeadTokens.add(token);
      classification.set(token, cls);
    }
    for (const verb of curated.verbs) {
      assertStandaloneWord(pattern, verb, policyName);
    }

    policyFacts.push({
      policyName,
      pattern,
      headTokens: curated.headTokens,
      verbs: curated.verbs,
    });
  }

  return {
    policyNames: actualNames,
    policies: policyFacts,
    gatedHeadTokens,
    classify: (token) => classification.get(token),
  };
}

function assertStandaloneWord(pattern: string, word: string, policyName: string): void {
  const standaloneWordRe = new RegExp(`\\b${word}\\b`);
  if (!standaloneWordRe.test(pattern)) {
    throw new Error(
      `bash_match facts drift: policy "${policyName}"'s live bash_match pattern no longer contains the classified word "${word}" as a standalone word (pattern: ${pattern}). It was renamed or removed — update CURATED_BASH_MATCH_FACTS in src/runtime/bash-match-facts.ts.`,
    );
  }
}

/**
 * "Is `token` gated by ANY shipped `bash_match` policy?" — the one-call
 * question both incidents got wrong. Real caller (F8, fix round):
 * `bash-match-registry.ts`'s `checkRegisteredSets` covers-purity check,
 * which asks this once per declared `member` of every
 * "covers-gated-head-tokens" registration. Takes only the `gatedHeadTokens`
 * slice of `BashMatchFacts` (not the full shape) so a caller holding the
 * same narrowed `Pick` `checkRegisteredSets` accepts can call this directly
 * without widening its own parameter type.
 */
export function isHeadTokenGated(
  facts: Pick<BashMatchFacts, "gatedHeadTokens">,
  token: string,
): boolean {
  return facts.gatedHeadTokens.has(token);
}
