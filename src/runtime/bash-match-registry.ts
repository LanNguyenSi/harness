// Registration point for every engine-side constant set that mirrors
// FULL_TEMPLATE's `bash_match` facts (task `074acf5d`, run
// `2026-07-28-manifest-facts-drift-guard`).
//
// WHY A REGISTRY, NOT ONE HARD-CODED COMPARISON: the guard this replaces
// (`tests/runtime/bash-match-head-token-drift.test.ts`, pre-migration)
// checked exactly one named set (`NON_GIT_HEAD_TOKENS`) against the
// manifest. That guard could not see run `dbc6d303`'s `INERT_CONSUMER_HEADS`
// (a NEW module, CRITICAL: contained `harness`, the kill-switch's own
// gated head token) at all — it simply never looked at any set but the
// one it was told about. `REGISTERED_HEAD_TOKEN_SETS` below is the list
// every such set must join; `checkRegisteredSets` walks the WHOLE list
// against the live facts, so a set registered tomorrow is checked
// automatically, and (paired with the unregistered-set scan in
// `tests/runtime/bash-match-head-token-drift.test.ts`) a set that is
// NOT registered is itself a finding.
//
// TWO INTENTS (minimum required — see the two historical incidents this
// run exists to close):
//   - "covers-gated-head-tokens": the set exists so the engine recognises
//     these head tokens (`NON_GIT_HEAD_TOKENS`'s shape). Checked for
//     COMPLETENESS: every head token the manifest actually gates (barring
//     a consciously `documented-uncovered` token) must be covered by AT
//     LEAST ONE registered set with this intent — the run `432db3d3` HIGH
//     (a covers-set spanning only 4 of 8 gated tokens) as a standing
//     regression class.
//   - "must-not-contain-gated-head-token": the set exists for some OTHER
//     purpose entirely and must NEVER contain a token the manifest itself
//     gates — the run `dbc6d303` CRITICAL's shape (an "inert consumer"
//     allowlist that accidentally absorbed the kill-switch's own gated
//     head token). Checked by testing every LIVE gated head token against
//     every such registered set's `has()`.
//
// FIX ROUND 2 (task `074acf5d`, second fix round, findings S1/S2/S4 —
// see `.ai/runs/2026-07-28-manifest-facts-drift-guard/03-decisions.md`
// D-002/D-004): review round 2 MEASURED that the round-1 guard's central
// defence — a registration's self-declared `intent` — was still
// escapable two ways, and that the guard reproduced its own defect class
// inside itself. Three changes close what can be made STRUCTURALLY
// impossible (D-002/D-003 deliberately draws the line here, not at every
// enumerable escape — see the decisions file):
//   (S1) `RegisteredHeadTokenSet` is now a DISCRIMINATED UNION on `intent`:
//     the "covers-gated-head-tokens" arm's `members` is NON-OPTIONAL.
//     Omitting `members` on a covers registration — the round-1 escape,
//     "declare no members and check (c) below never runs" — is now a
//     COMPILE ERROR, not a test failure. The "must-not-contain" arm keeps
//     `members` optional (no purity semantics apply to it).
//   (S2) check (d), COVERS-REDUNDANCY, below: closes the escape where a
//     laundered set's declared `members` are all HONESTLY gated (so check
//     (c) is satisfied) but the set's true purpose is something else — its
//     gated members are, by construction, already covered by the real set
//     that exists to cover them.
//   (S4) check (e), COVERS-PREDICATE-PURITY, below: closes the escape
//     where a registration's `has()` PREDICATE accepts more than its
//     declared `members` claim (measured: widening `GIT_TOKEN_RE` to also
//     match "docker" while leaving `members: ["git"]` untouched left the
//     full suite green) — this guard reproducing, inside itself, the exact
//     "engine-side constant mirrors manifest content with no coupling"
//     defect class it exists to eliminate elsewhere.
// Each violation now carries a `check` field (see `RegistrationViolation`)
// naming exactly which of the five checks fired, so a fixture test can
// assert on ONE check's output without an unrelated check's finding on the
// same (setId, token) pair silently changing what the array contains.
//
// COVERS-PURITY (fix round, F1+F2): a THIRD check, over a "covers"
// registration's OWN declared `members` (see `RegisteredHeadTokenSet.members`
// below), closes two escapes with one rule — every declared member must
// itself be a live gated head token:
//   (F1) the REVERSE direction, ENGINE->MANIFEST: the pre-migration guard
//     asserted this (every member of `NON_GIT_HEAD_TOKENS` must be a token
//     some shipped policy gates) and the migration to this registry
//     silently dropped it — completeness-checking (b) only ever walks
//     `facts.gatedHeadTokens` outward to registered sets, never a
//     registered set's own members inward to the facts. An engine set
//     gaining an ungated member (e.g. "docker" added to
//     `NON_GIT_HEAD_TOKENS`) is real DEAD CODE at best and a sign the
//     manifest and the engine have silently diverged at worst; either way
//     it is a regression this registry exists to catch.
//   (F2) MIS-DECLARED INTENT: a `must-not-contain-gated-head-token` set
//     relabeled `covers-gated-head-tokens` to dodge check (a) — cheap,
//     because `intent` is self-declared and was, before this check,
//     cross-checked against nothing. A set that exists for any purpose
//     OTHER than recognising gated head tokens (an inert-consumer
//     allowlist, say) necessarily contains members that are not
//     themselves gated head tokens, so it fails THIS check the moment it
//     declares `members` — the decision rule is: pick the intent that
//     describes the set's PURPOSE; a set whose purpose is anything other
//     than recognising gated head tokens is
//     "must-not-contain-gated-head-token", never "covers-gated-head-tokens".
//
// AXIS SCOPE (F6, fix round): this registry models the HEAD-TOKEN axis
// only — which literal head token a `bash_match` anchors on. A shipped
// policy's `bash_match` can equally anchor on a VERB with no head-token
// significance of its own (`pause` in `deny-kill-switch-bypass`), checked
// today only by `HARNESS_READ_ONLY_SUBS` in `read-only-bash.ts`, a set this
// registry does not see and does not check. The VERB axis is explicitly
// OUT OF SCOPE for this run: the exact same defect shape (an engine-side
// allowlist silently absorbing a gated token) is unmodellable here today,
// one axis over. Do not assume verb coverage exists because head-token
// coverage does.
//
// WHY src/runtime/, NOT tests/ (F8, fix round): see `bash-match-facts.ts`'s
// module header — the same reasoning applies here.
//
// TODAY'S REAL REGISTRATIONS are both "covers" sets — `GIT_TOKEN_RE` and
// `NON_GIT_HEAD_TOKENS`, both from `command-normalize.ts`, the two sets
// the pre-migration guard already knew about. No real
// "must-not-contain-gated-head-token" consumer exists in this tree today
// (run `dbc6d303`'s own module is explicit non-goal / future work for
// THIS run) — the intent is fully implemented and covered by the fixture
// regression tests in `tests/runtime/bash-match-registry.test.ts`
// (reproducing the CRITICAL's exact shape) and by a live mutation probe
// against this file's own `REGISTERED_HEAD_TOKEN_SETS` array, not against
// a second production consumer: temporarily registering a fixture
// (`intent: "must-not-contain-gated-head-token"`, `has` containing
// "harness") reddens exactly "every registered engine-side set is clean
// against the live facts ..." and the F5 defaults test in
// `tests/runtime/bash-match-head-token-drift.test.ts`, with the violation
// naming the fixture's own `setId` and the offending token — the probe was
// reverted immediately after.
//
// `has()` rather than an enumerable `ReadonlySet<string>` uniformly for
// checks (a) and (b): the live gated-head-token vocabulary is small and
// fully known from `BashMatchFacts.gatedHeadTokens` (never more than ~8
// entries), so both checks only ever need to ask "does this registered set
// answer YES for token X", which a `RegExp.test` (`GIT_TOKEN_RE`) and a
// `Set.has` (`NON_GIT_HEAD_TOKENS`) can equally answer. Check (c)
// (COVERS-PURITY, above) is different in kind — it asks "does this
// registered set contain something the facts DON'T know about", which no
// predicate over the ~8 known tokens can answer; that is why `members` is
// a separate, enumerable field rather than folded into `has()` — NON-
// OPTIONAL on the "covers-gated-head-tokens" arm as of fix round 2 (S1;
// see `CoversHeadTokenSet`'s doc), optional on "must-not-contain", which
// this field's checks never apply to.

import { GIT_TOKEN_RE, NON_GIT_HEAD_TOKENS } from "./command-normalize.js";
import { DOCUMENTED_UNCOVERED_HEAD_TOKENS, isHeadTokenGated } from "./bash-match-facts.js";
import type { BashMatchFacts } from "./bash-match-facts.js";

export type RegisteredSetIntent =
  | "covers-gated-head-tokens"
  | "must-not-contain-gated-head-token";

interface RegisteredHeadTokenSetCommon {
  /** Stable identifier, used in failure messages and by the unregistered-set scan's cross-reference. */
  readonly id: string;
  /** File the set is actually declared in, for failure messages. */
  readonly module: string;
  /** Membership test — `Set.has` or `RegExp.test`, see the module header. */
  readonly has: (token: string) => boolean;
  readonly description: string;
}

/**
 * A "covers-gated-head-tokens" registration — the set exists so the engine
 * RECOGNISES these head tokens. `members` is NON-OPTIONAL (fix round 2,
 * S1): the round-1 shape had this field OPTIONAL, and
 * `checkRegisteredSets`'s covers-purity check (c) simply `continue`d past
 * any registration that omitted it — a new module registered as
 * "covers-gated-head-tokens" WITHOUT `members` measurably passed the full
 * suite (167 files / 3980 tests) even with a gated head token laundered
 * inside its `has()` predicate. Making `members` mandatory on this arm
 * turns that escape into a TYPE ERROR: a covers registration that omits
 * `members` now fails `tsc`, not merely a test. See `checkRegisteredSets`
 * checks (c), (d), (e) below for the three independent things `members`
 * (and `has()`) are cross-checked against.
 */
export interface CoversHeadTokenSet extends RegisteredHeadTokenSetCommon {
  readonly intent: "covers-gated-head-tokens";
  readonly members: readonly string[];
}

/**
 * A "must-not-contain-gated-head-token" registration — the set exists for
 * some OTHER purpose and must never contain a token the manifest itself
 * gates (the dbc6d303 CRITICAL shape). `members` is optional here: no
 * purity/redundancy/predicate-purity semantics apply to this arm — only
 * `has()` is ever asked anything (check (a)).
 */
export interface MustNotContainHeadTokenSet extends RegisteredHeadTokenSetCommon {
  readonly intent: "must-not-contain-gated-head-token";
  readonly members?: readonly string[];
}

/**
 * Discriminated union on `intent` (fix round 2, S1) — see
 * `CoversHeadTokenSet`'s doc for why the split exists.
 */
export type RegisteredHeadTokenSet = CoversHeadTokenSet | MustNotContainHeadTokenSet;

export const REGISTERED_HEAD_TOKEN_SETS: readonly RegisteredHeadTokenSet[] = [
  {
    id: "GIT_TOKEN_RE",
    module: "src/runtime/command-normalize.ts",
    intent: "covers-gated-head-tokens",
    has: (token) => GIT_TOKEN_RE.test(token),
    members: ["git"],
    description:
      "canonicalizeSegment's git-basename recognizer (matches `git`, and any `\\S*/git` path-qualified spelling, by basename)",
  },
  {
    id: "NON_GIT_HEAD_TOKENS",
    module: "src/runtime/command-normalize.ts",
    intent: "covers-gated-head-tokens",
    has: (token) => NON_GIT_HEAD_TOKENS.has(token),
    members: [...NON_GIT_HEAD_TOKENS],
    description:
      "canonicalizeSegment's closed non-git head-token set (today: gh, npm, harness)",
  },
];

/**
 * Which of the five independent checks flagged this violation (fix round
 * 2): a fixture test asserting on one check's behaviour must not be
 * silently polluted by another check's unrelated finding on the same
 * (setId, token) pair — see `tests/runtime/bash-match-registry.test.ts`.
 */
export type RegistrationCheck =
  | "must-not-contain"
  | "covers-completeness"
  | "covers-purity"
  | "covers-redundancy"
  | "covers-predicate-purity";

export interface RegistrationViolation {
  readonly setId: string;
  readonly intent: RegisteredSetIntent;
  readonly token: string;
  readonly check: RegistrationCheck;
  readonly reason: string;
}

/**
 * Fixed, deliberately small vocabulary of plausible NON-gated head tokens
 * (fix round 2, S4/D-004) — commands a reasonable engine-side set might
 * plausibly mirror or accidentally absorb, but that no shipped
 * `bash_match` policy gates today. Combined with the live
 * `facts.gatedHeadTokens` (every token that IS gated, verified fresh —
 * see `bash-match-facts.ts`) this gives check (e) below a concrete probe
 * domain to test every registered "covers" predicate against, instead of
 * trusting a registration's declared `members` to be an honest reflection
 * of what its `has()` actually accepts.
 */
const PLAUSIBLE_NON_GATED_HEAD_TOKENS: readonly string[] = [
  "docker",
  "kubectl",
  "ls",
  "cat",
  "node",
  "python",
  "make",
  "ssh",
];

/**
 * Check every registered set against the live facts. Returns an EMPTY
 * array when clean. `registrations` and `documentedUncovered` default to
 * the real, shipped values (F5 fix-round correction: the
 * `documentedUncovered` default previously silently fell back to an empty
 * set, which raised 4 FALSE violations — tee, cp, env, unset — when called
 * with only `facts`; pinned by
 * `tests/runtime/bash-match-head-token-drift.test.ts`'s
 * "checkRegisteredSets(liveFacts())" defaults test) but accept fixtures —
 * see `tests/runtime/bash-match-registry.test.ts`'s regression tests for
 * the historical incidents, which pass deliberately-broken fixtures to
 * prove this function catches their exact shape.
 */
export function checkRegisteredSets(
  facts: Pick<BashMatchFacts, "gatedHeadTokens" | "classify">,
  registrations: readonly RegisteredHeadTokenSet[] = REGISTERED_HEAD_TOKEN_SETS,
  documentedUncovered: ReadonlySet<string> = DOCUMENTED_UNCOVERED_HEAD_TOKENS,
): RegistrationViolation[] {
  const violations: RegistrationViolation[] = [];

  // (a) must-not-contain: no registered set with this intent may answer
  // `true` for ANY live gated head token — the dbc6d303 CRITICAL shape.
  for (const reg of registrations) {
    if (reg.intent !== "must-not-contain-gated-head-token") continue;
    for (const token of facts.gatedHeadTokens) {
      if (reg.has(token)) {
        violations.push({
          setId: reg.id,
          intent: reg.intent,
          token,
          check: "must-not-contain",
          reason: `"${reg.id}" (${reg.module} — ${reg.description}) declares intent "must-not-contain-gated-head-token" but contains "${token}", which IS gated by a shipped bash_match policy`,
        });
      }
    }
  }

  // (b) covers-completeness: every gated head token NOT consciously
  // documented as uncovered must be answered `true` by at least one
  // registered "covers" set — the 432db3d3 HIGH shape.
  for (const token of facts.gatedHeadTokens) {
    if (documentedUncovered.has(token)) continue;
    const covered = registrations.some(
      (reg) => reg.intent === "covers-gated-head-tokens" && reg.has(token),
    );
    if (!covered) {
      const cls = facts.classify(token);
      violations.push({
        setId: "(none)",
        intent: "covers-gated-head-tokens",
        token,
        check: "covers-completeness",
        reason: `gated head token "${token}" (class: ${cls ?? "unknown"}) is not covered by ANY registered "covers-gated-head-tokens" set, and is not in the documented-uncovered list either`,
      });
    }
  }

  // (c) covers-purity (fix round, F1+F2): every member a "covers" set
  // DECLARES (see RegisteredHeadTokenSet.members) must itself be a live
  // gated head token. Closes two escapes with one check: (1) the reverse
  // ENGINE->MANIFEST direction the pre-migration guard checked and the
  // migration dropped (a covers set gaining a member — e.g. "docker" —
  // that no shipped policy gates at all); (2) the mis-declared-intent
  // laundering escape, where a `must-not-contain-gated-head-token` set is
  // relabeled `covers-gated-head-tokens` to dodge check (a) — a set that
  // exists for any purpose OTHER than recognising gated head tokens
  // necessarily contains a member that fails this check. `members` is
  // non-optional on this arm as of fix round 2 (S1) — every registration
  // that reaches here has one to walk.
  for (const reg of registrations) {
    if (reg.intent !== "covers-gated-head-tokens") continue;
    for (const member of reg.members) {
      if (!isHeadTokenGated(facts, member)) {
        violations.push({
          setId: reg.id,
          intent: reg.intent,
          token: member,
          check: "covers-purity",
          reason: `"${reg.id}" (${reg.module} — ${reg.description}) declares intent "covers-gated-head-tokens" and lists "${member}" among its members, but "${member}" is not a live gated head token (no shipped bash_match policy gates it) — pick the intent that describes the set's PURPOSE: a set that exists for any purpose OTHER than recognising gated head tokens is "must-not-contain-gated-head-token", never "covers-gated-head-tokens"`,
        });
      }
    }
  }

  // (d) covers-redundancy (fix round 2, S2): a gated head token answered
  // `true` by MORE THAN ONE registered "covers-gated-head-tokens" set is a
  // violation. Closes the escape check (c) cannot: a laundered set (its
  // TRUE purpose is something other than recognising gated head tokens,
  // relabeled "covers-gated-head-tokens" to dodge check (a)) whose
  // declared `members` are HONESTLY all gated — e.g. `new
  // Set(["harness"])` or `new Set(["harness", "gh"])` — passes check (c)
  // cleanly (every declared member IS a live gated head token). But a
  // laundered set's gated members are, by construction, already covered
  // by the REAL set that exists to cover them ("harness" by
  // `NON_GIT_HEAD_TOKENS`) — so this check rejects the shape without
  // needing to know the set's true intent honestly: a gated head token
  // legitimately has exactly ONE registered "covers" set responsible for
  // it, and redundant coverage is the tell.
  for (const token of facts.gatedHeadTokens) {
    const coveringSets = registrations.filter(
      (reg) => reg.intent === "covers-gated-head-tokens" && reg.has(token),
    );
    if (coveringSets.length > 1) {
      for (const reg of coveringSets) {
        const others = coveringSets.filter((r) => r.id !== reg.id).map((r) => r.id);
        violations.push({
          setId: reg.id,
          intent: reg.intent,
          token,
          check: "covers-redundancy",
          reason: `"${reg.id}" (${reg.module} — ${reg.description}) declares intent "covers-gated-head-tokens" and answers true for "${token}", but "${token}" is ALSO covered by ${others.length} other registered covers-set(s) (${others.join(", ")}) — a gated head token must be covered by exactly one registered covers-set; redundant coverage is the signature of an intent-laundered set whose declared members happen to already be genuinely gated elsewhere`,
        });
      }
    }
  }

  // (e) covers-predicate-purity (fix round 2, S4/D-004): unlike check (c),
  // which only inspects a registration's DECLARED `members`, this probes
  // the registration's ACTUAL `has()` predicate directly against a fixed
  // vocabulary — every live gated head token plus
  // `PLAUSIBLE_NON_GATED_HEAD_TOKENS` — and demands `has(token)` answer
  // `true` ONLY for tokens that ARE live gated head tokens. Closes the
  // exact defect class this run exists to eliminate, reproduced INSIDE
  // this guard: a predicate-based registration (`GIT_TOKEN_RE.test`)
  // paired with a hand-written `members` list that check (c) verifies but
  // the predicate ITSELF is never re-checked against — measured (D-004):
  // widening `GIT_TOKEN_RE` to also match "docker" while leaving
  // `members: ["git"]` untouched left the full suite green before this
  // check existed.
  const probeVocabulary = new Set<string>([
    ...facts.gatedHeadTokens,
    ...PLAUSIBLE_NON_GATED_HEAD_TOKENS,
  ]);
  for (const reg of registrations) {
    if (reg.intent !== "covers-gated-head-tokens") continue;
    for (const token of probeVocabulary) {
      if (reg.has(token) && !isHeadTokenGated(facts, token)) {
        violations.push({
          setId: reg.id,
          intent: reg.intent,
          token,
          check: "covers-predicate-purity",
          reason: `"${reg.id}" (${reg.module} — ${reg.description}) declares intent "covers-gated-head-tokens" and its has() predicate answers true for "${token}", but "${token}" is not a live gated head token — the predicate accepts more than its declared members claim, reproducing this run's own defect class (an engine-side predicate mirroring manifest content with no coupling) inside the guard itself`,
        });
      }
    }
  }

  return violations;
}
