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
// a second production consumer. See this run's implementer report for the
// full probe log.
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
// a separate, OPTIONAL, enumerable field rather than folded into `has()`.

import { GIT_TOKEN_RE, NON_GIT_HEAD_TOKENS } from "./command-normalize.js";
import { DOCUMENTED_UNCOVERED_HEAD_TOKENS, isHeadTokenGated } from "./bash-match-facts.js";
import type { BashMatchFacts } from "./bash-match-facts.js";

export type RegisteredSetIntent =
  | "covers-gated-head-tokens"
  | "must-not-contain-gated-head-token";

export interface RegisteredHeadTokenSet {
  /** Stable identifier, used in failure messages and by the unregistered-set scan's cross-reference. */
  readonly id: string;
  /** File the set is actually declared in, for failure messages. */
  readonly module: string;
  readonly intent: RegisteredSetIntent;
  /** Membership test — `Set.has` or `RegExp.test`, see the module header. */
  readonly has: (token: string) => boolean;
  /**
   * Enumerable membership, OPTIONAL — see the module header's
   * "COVERS-PURITY" paragraph (fix round, F1+F2). Only meaningful for a
   * "covers-gated-head-tokens" registration: `checkRegisteredSets` walks
   * every declared member and demands each be a live gated head token.
   * Omitted (left `undefined`) skips the purity check for that
   * registration — used deliberately by fixtures/registrations that
   * isolate the OTHER checks, but every REAL "covers" registration going
   * forward should declare it, or it gets a free pass on this check.
   */
  readonly members?: readonly string[];
  readonly description: string;
}

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

export interface RegistrationViolation {
  readonly setId: string;
  readonly intent: RegisteredSetIntent;
  readonly token: string;
  readonly reason: string;
}

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
  // necessarily contains a member that fails this check. Registrations
  // that omit `members` are not checked here — see the field's doc.
  for (const reg of registrations) {
    if (reg.intent !== "covers-gated-head-tokens") continue;
    if (reg.members === undefined) continue;
    for (const member of reg.members) {
      if (!isHeadTokenGated(facts, member)) {
        violations.push({
          setId: reg.id,
          intent: reg.intent,
          token: member,
          reason: `"${reg.id}" (${reg.module} — ${reg.description}) declares intent "covers-gated-head-tokens" and lists "${member}" among its members, but "${member}" is not a live gated head token (no shipped bash_match policy gates it) — pick the intent that describes the set's PURPOSE: a set that exists for any purpose OTHER than recognising gated head tokens is "must-not-contain-gated-head-token", never "covers-gated-head-tokens"`,
        });
      }
    }
  }

  return violations;
}
