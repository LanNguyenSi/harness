// Registration point for every engine-side constant set that mirrors
// FULL_TEMPLATE's `bash_match` facts (task `074acf5d`, run
// `2026-07-28-manifest-facts-drift-guard`; redesigned by task `209e6dc4`).
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
// registry exists to close):
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
//     every such registered set's coverage.
//
// REDESIGN (task `209e6dc4`) — WHY: the ORIGINAL registration surface (fix
// rounds 1 and 2 of task `074acf5d`, both superseded by this redesign) let a
// registration hand the guard a freely-chosen `has: (token) => boolean`
// closure plus an independently hand-typed `members: readonly string[]`
// array — TWO self-descriptions of the SAME underlying constant, asserted
// by the registrant, never derived from it. Three adversarial review
// passes attacked that gap; two fix rounds narrowed the escape family by
// adding checks c/d/e over the self-descriptions (covers-purity,
// covers-redundancy, covers-predicate-purity) without closing it — every
// added check produced the next bypass. Review round 3 measured the
// residual: a `covers-gated-head-tokens` registration declaring
// `members: ["tee"]` (or any subset of the four `documented-uncovered`
// tokens `env`/`unset`/`tee`/`cp`) passed every one of the five checks with
// an entirely honest, live-coupled `has()` and `members` — because nothing
// in the old design distinguished "genuinely not gated" from "gated but
// consciously uncovered", and `members` could say anything a NEW closure
// also happened to agree with.
//
// HALT CRITERION (recorded before this redesign's first line, task
// `209e6dc4` brief, quoted verbatim): "Findet ein spaeterer Review eine
// weitere Registrierung, die akzeptiert wird und nicht sollte, wird NICHT
// nachgebessert (keine fuenfte/sechste Pruefung), sondern die Oberflaeche
// erneut vorgelegt. Drei Passes haben gezeigt: jede zusaetzliche Pruefung
// produziert die naechste Umgehung. Der Umbau muss die Formen STRUKTURELL
// unausdrueckbar machen, nicht einzeln fangen." This redesign follows that
// instruction literally: it does not add a sixth check on top of the old
// five. It removes the SURFACE the old checks were inspecting.
//
// THE STRUCTURAL FIX: `has()` as a freely-chosen closure, and `members` as
// an independently hand-typed array, are BOTH GONE. A registration now
// supplies a single `source: HeadTokenSource` — a discriminated union that
// holds the ACTUAL constant (`{ kind: "set"; set: NON_GIT_HEAD_TOKENS }` or
// `{ kind: "regex"; re: GIT_TOKEN_RE }`), imported and passed by reference,
// not re-described. `sourceHas` (below) derives membership testing FROM
// `source` — there is no code path left where a registration's declared
// coverage and its actual behaviour can diverge, because there is only one
// value now, not two. See the six-point closure list below for exactly
// which of the three passes' findings this makes unexpressible vs. which
// residual boundary (documented, not hidden) remains.
//
// SIX FORMS MEASURED OPEN BEFORE THIS REDESIGN (task `209e6dc4` brief,
// reconstructed from review round 3 since the run's own `.ai/runs/` docs
// are gitignored and not present in this checkout) AND THEIR DISPOSITION:
//
//   1. Documented-uncovered laundering WITHOUT dishonesty: a covers
//      registration whose declared members are all `documented-uncovered`
//      gated tokens (env/unset/tee/cp) passed all five checks with an
//      honest, live-coupled has()/members (the dbc6d303-CRITICAL shape,
//      concretely reproduced with `members: ["tee"]`).
//      CLOSED, structurally + a live probe: `checkRegisteredSets`'s (now
//      merged) covers-purity check probes the registration's actual
//      `source` — not a hand-typed members list, there isn't one any
//      more — against every live gated head token AND treats a
//      `documented-uncovered` token as ILLEGITIMATE to claim, exactly like
//      a token that is not gated at all. A registration cannot "declare"
//      its way around this: the probe reads the real Set/RegExp.
//      Pinned by the `["tee"]`-shaped regression test in
//      `tests/runtime/bash-match-registry.test.ts` (the exact form review
//      round 3 measured).
//   2. `has()` as an arbitrary closure with no coupling to the constant
//      `id`/`module` name (stale hand-copied predicate; `has: () => false`;
//      no predicate check at all on the must-not-contain arm).
//      STRUCTURALLY UNEXPRESSIBLE: there is no `has()` field any more.
//      `source` holds the constant directly; `sourceHas` is the ONLY way
//      membership is ever tested, for both intents.
//   3. `members` claiming coverage `has()` rejects (each walked in only one
//      direction), and `members: []`, which type-checked and passed.
//      STRUCTURALLY UNEXPRESSIBLE (the divergence half): there is no
//      `members` field to disagree with `source` — a registration has
//      exactly one thing to say about its coverage. CHECKED, not merely
//      unexpressible (the empty half): an empty/vacuous `source` (e.g.
//      `new Set([])`, or a regex matching none of the live vocabulary) is
//      still a value a registrant CAN write — `checkRegisteredSets`'s new
//      covers-empty check flags a covers registration whose `source`
//      matches none of the legitimately-coverable live gated head tokens.
//   4. Check (d) COVERS-REDUNDANCY (fix round 2) forbade ALL double
//      coverage, so it would also convict a legitimate future case (two
//      registered sets consciously, by design, both keying the same head
//      token) as if it were laundering.
//      RESOLVED: `CoversHeadTokenSet.intentionalOverlaps` is an explicit,
//      conscious per-token declaration. Covers-redundancy now only clears
//      a multiply-covered token when EVERY registered set currently
//      covering it lists that token in ITS OWN `intentionalOverlaps` — a
//      set that silently overlaps (the round-2 laundering shape: a new
//      set quietly re-covering a token an existing set already owns)
//      still trips the check, because it has declared nothing. Legitimate
//      double coverage requires touching BOTH registrations, not one.
//   5. `PLAUSIBLE_NON_GATED_HEAD_TOKENS` (the probe vocabulary check (e)
//      used) was itself an uncoupled hand-written constant — 5 of its 8
//      entries were exercised by no test at the time, and a token outside
//      BOTH vocabularies (e.g. `yarn`/`pnpm`) went unprobed.
//      PARTIALLY CLOSED (acceptance's declared "OR" branch — the vocabulary
//      cannot be DERIVED from the manifest, which only enumerates what IS
//      gated, never the negative space of what is not): every entry is now
//      individually pinned by a live regression test in
//      `tests/runtime/bash-match-head-token-drift.test.ts` asserting it is
//      NOT a live gated head token — a future policy gating one of these
//      words turns that test red, forcing a conscious update instead of a
//      silent drift. The residual boundary (a probe token entirely outside
//      both vocabularies stays unprobed) is named here AND at the constant.
//   6. A registration could name a `module`/`id` to which no exported
//      constant actually corresponds.
//      STRUCTURALLY UNEXPRESSIBLE, by the TypeScript compiler: `id` and
//      `module` are now purely descriptive strings (used only in failure
//      messages) — the CHECKED value is `source.set` / `source.re`, a
//      direct reference to the real imported binding. Writing
//      `source: { kind: "set", set: SOME_NAME_THAT_DOES_NOT_EXIST }`
//      is `TS2304: Cannot find name` — a compile error, before any test
//      runs. Manually verified (task `209e6dc4`): temporarily editing a
//      real registration's `source.set` reference to an undeclared
//      identifier fails `npm run typecheck` immediately; reverted right
//      after. `id`/`module` can still be a MISLEADING label for a real,
//      existing `source` (e.g. call `NON_GIT_HEAD_TOKENS`'s registration
//      `id: "TOTALLY_WRONG_NAME"` while `source.set` still correctly
//      references it) — that is a cosmetic residual, not a behavioural
//      one: every check still evaluates the REAL constant regardless of
//      the label.
//
// WHAT IS STILL A RESIDUAL, NAMED HONESTLY, NOT HIDDEN:
//   - The probe vocabulary (point 5) is finite; a token outside both
//     `facts.gatedHeadTokens` and `PLAUSIBLE_NON_GATED_HEAD_TOKENS` is not
//     probed by covers-purity. This is inherent to any predicate-based
//     check over an unbounded domain (a `RegExp`'s match set is not
//     enumerable) and is not something the source-based redesign changes;
//     it narrows the practical exposure (both arms are now checked with
//     the SAME probe set, no separate unguarded closure) without claiming
//     to enumerate "every string that is not gated".
//   - `id`/`module` remain free-text labels, decoupled from `source`'s
//     actual identity (point 6's cosmetic half, above).
//   - `intentionalOverlaps` is itself a hand-declared field. A registrant
//     COULD mark an overlap "intentional" when it is not. The bar this
//     redesign sets is that doing so requires editing BOTH covering
//     registrations (a two-registration diff, visible in review), not
//     silently adding one new registration next to an untouched existing
//     one — a materially higher bar than the round-2 escape, not a
//     mathematical impossibility.
//   - The must-not-contain arm has no purity check of its own (never did):
//     its whole point is that its content is unrelated to gated head
//     tokens, so there is nothing to compare its coverage against.
//
// AXIS SCOPE (carried forward, unchanged by this redesign): this registry
// models the HEAD-TOKEN axis only — which literal head token a
// `bash_match` anchors on. A shipped policy's `bash_match` can equally
// anchor on a VERB with no head-token significance of its own (`pause` in
// `deny-kill-switch-bypass`), checked today only by `HARNESS_READ_ONLY_SUBS`
// in `read-only-bash.ts`, a set this registry does not see and does not
// check. The VERB axis is explicitly OUT OF SCOPE here, unchanged from the
// prior design: the exact same defect shape (an engine-side allowlist
// silently absorbing a gated token) is unmodellable here today, one axis
// over. Do not assume verb coverage exists because head-token coverage
// does.
//
// WHY src/runtime/, NOT tests/: see `bash-match-facts.ts`'s module header —
// the same reasoning applies here.
//
// TODAY'S REAL REGISTRATIONS are both "covers" sets — `GIT_TOKEN_RE` and
// `NON_GIT_HEAD_TOKENS`, both from `command-normalize.ts`, the two sets
// the pre-migration guard already knew about, each now registered by
// handing this module the ACTUAL constant (`source: { kind: "regex", re:
// GIT_TOKEN_RE }` / `source: { kind: "set", set: NON_GIT_HEAD_TOKENS }`),
// not a re-description of it. No real "must-not-contain-gated-head-token"
// consumer exists in this tree today (run `dbc6d303`'s own module is
// explicit non-goal / future work) — the intent is fully implemented and
// covered by the fixture regression tests in
// `tests/runtime/bash-match-registry.test.ts` (reproducing the CRITICAL's
// exact shape) and by a live mutation probe against this file's own
// `REGISTERED_HEAD_TOKEN_SETS` array, not against a second production
// consumer: temporarily registering a fixture
// (`intent: "must-not-contain-gated-head-token"`,
// `source: { kind: "set", set: new Set(["harness"]) }`) reddens exactly
// "every registered engine-side set is clean against the live facts ..."
// and the defaults test in
// `tests/runtime/bash-match-head-token-drift.test.ts`, with the violation
// naming the fixture's own `setId` and the offending token — the probe was
// reverted immediately after.

import { GIT_TOKEN_RE, NON_GIT_HEAD_TOKENS } from "./command-normalize.js";
import { DOCUMENTED_UNCOVERED_HEAD_TOKENS, isHeadTokenGated } from "./bash-match-facts.js";
import type { BashMatchFacts } from "./bash-match-facts.js";

export type RegisteredSetIntent =
  | "covers-gated-head-tokens"
  | "must-not-contain-gated-head-token";

/**
 * The registration hands the guard the CONSTANT itself, discriminated by
 * shape (task `209e6dc4` redesign — see the module header). There is no
 * `has()` closure any more: `sourceHas` below is the ONLY way membership is
 * ever tested, so a registration cannot assert a predicate that diverges
 * from what the underlying `Set`/`RegExp` actually does, because there is
 * only one value, not a value plus a separate self-description of it.
 */
export type HeadTokenSource =
  | { readonly kind: "set"; readonly set: ReadonlySet<string> }
  | { readonly kind: "regex"; readonly re: RegExp };

/** Membership test derived FROM `source` — never independently supplied. */
export function sourceHas(source: HeadTokenSource, token: string): boolean {
  return source.kind === "set" ? source.set.has(token) : source.re.test(token);
}

interface RegisteredHeadTokenSetCommon {
  /**
   * Stable identifier, used in failure messages and by the unregistered-set
   * scan's cross-reference. Purely descriptive (task `209e6dc4`): the
   * checked value is `source`, a direct reference to the real constant, so
   * a wrong `id` here is a misleading LABEL, never a way to escape a
   * check — see the module header's point 6.
   */
  readonly id: string;
  /** File the set is actually declared in, for failure messages. Descriptive only, same caveat as `id`. */
  readonly module: string;
  /** The actual constant this registration mirrors — see `HeadTokenSource`. */
  readonly source: HeadTokenSource;
  readonly description: string;
}

/**
 * A "covers-gated-head-tokens" registration — the set exists so the engine
 * RECOGNISES these head tokens.
 */
export interface CoversHeadTokenSet extends RegisteredHeadTokenSetCommon {
  readonly intent: "covers-gated-head-tokens";
  /**
   * Token(s) this registration KNOWINGLY shares coverage of with another
   * registered "covers-gated-head-tokens" set — an explicit, conscious
   * declaration (task `209e6dc4` redesign, resolving the module header's
   * point 4), never an inference. `checkRegisteredSets`'s covers-redundancy
   * check only clears a token for which MORE THAN ONE covers-set answers
   * true when EVERY one of those covering sets lists that token here. A
   * set that silently overlaps without declaring so still trips the
   * check — legitimate double coverage requires editing both
   * registrations, not just adding one next to an untouched other.
   */
  readonly intentionalOverlaps?: ReadonlySet<string>;
}

/**
 * A "must-not-contain-gated-head-token" registration — the set exists for
 * some OTHER purpose and must never contain a token the manifest itself
 * gates (the dbc6d303 CRITICAL shape). No purity/redundancy semantics apply
 * to this arm — only `sourceHas` is ever asked anything (check (a)).
 */
export interface MustNotContainHeadTokenSet extends RegisteredHeadTokenSetCommon {
  readonly intent: "must-not-contain-gated-head-token";
}

/** Discriminated union on `intent`. */
export type RegisteredHeadTokenSet = CoversHeadTokenSet | MustNotContainHeadTokenSet;

export const REGISTERED_HEAD_TOKEN_SETS: readonly RegisteredHeadTokenSet[] = [
  {
    id: "GIT_TOKEN_RE",
    module: "src/runtime/command-normalize.ts",
    intent: "covers-gated-head-tokens",
    source: { kind: "regex", re: GIT_TOKEN_RE },
    description:
      "canonicalizeSegment's git-basename recognizer (matches `git`, and any `\\S*/git` path-qualified spelling, by basename)",
  },
  {
    id: "NON_GIT_HEAD_TOKENS",
    module: "src/runtime/command-normalize.ts",
    intent: "covers-gated-head-tokens",
    source: { kind: "set", set: NON_GIT_HEAD_TOKENS },
    description:
      "canonicalizeSegment's closed non-git head-token set (today: gh, npm, harness)",
  },
];

/**
 * Which check flagged this violation. `covers-purity` (task `209e6dc4`
 * redesign) merges what used to be three separate checks (covers-purity,
 * covers-predicate-purity, and the documented-uncovered laundering gap
 * that had no check at all) into one probe over the registration's real
 * `source` — see the module header's points 1 and 3.
 */
export type RegistrationCheck =
  | "must-not-contain"
  | "covers-completeness"
  | "covers-empty"
  | "covers-purity"
  | "covers-redundancy";

export interface RegistrationViolation {
  readonly setId: string;
  readonly intent: RegisteredSetIntent;
  readonly token: string;
  readonly check: RegistrationCheck;
  readonly reason: string;
}

/**
 * Fixed, deliberately small, PER-ENTRY-PINNED vocabulary of plausible
 * NON-gated head tokens (originally fix round 2 S4/D-004; each entry
 * individually pinned by a live regression test in
 * `tests/runtime/bash-match-head-token-drift.test.ts` as of task
 * `209e6dc4` — see the module header's point 5): commands a reasonable
 * engine-side set might plausibly mirror or accidentally absorb, but that
 * no shipped `bash_match` policy gates today. Combined with the live
 * `facts.gatedHeadTokens` (every token that IS gated, verified fresh — see
 * `bash-match-facts.ts`) this gives covers-purity a concrete probe domain
 * to test every registered "covers" source against, instead of trusting a
 * registration to honestly describe what it covers.
 *
 * RESIDUAL, named not hidden: this list cannot be exhaustively DERIVED from
 * the manifest — the manifest enumerates what IS gated, never the infinite
 * negative space of what is not. A token entirely outside both this list
 * and `facts.gatedHeadTokens` (e.g. `yarn`, `pnpm`) is not probed by
 * covers-purity. Widening this list narrows that residual; it cannot close
 * it completely for a `RegExp`-backed source, whose true match set is not
 * enumerable at all.
 */
export const PLAUSIBLE_NON_GATED_HEAD_TOKENS: readonly string[] = [
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
 * the real, shipped values but accept fixtures — see
 * `tests/runtime/bash-match-registry.test.ts`'s regression tests for the
 * historical incidents, which pass deliberately-broken fixtures to prove
 * this function catches their exact shape.
 */
export function checkRegisteredSets(
  facts: Pick<BashMatchFacts, "gatedHeadTokens" | "classify">,
  registrations: readonly RegisteredHeadTokenSet[] = REGISTERED_HEAD_TOKEN_SETS,
  documentedUncovered: ReadonlySet<string> = DOCUMENTED_UNCOVERED_HEAD_TOKENS,
): RegistrationViolation[] {
  const violations: RegistrationViolation[] = [];

  // (a) must-not-contain: no registered set with this intent may answer
  // `true` (via `sourceHas`, the ONLY membership test that exists now) for
  // ANY live gated head token — the dbc6d303 CRITICAL shape.
  for (const reg of registrations) {
    if (reg.intent !== "must-not-contain-gated-head-token") continue;
    for (const token of facts.gatedHeadTokens) {
      if (sourceHas(reg.source, token)) {
        violations.push({
          setId: reg.id,
          intent: reg.intent,
          token,
          check: "must-not-contain",
          reason: `"${reg.id}" (${reg.module} — ${reg.description}) declares intent "must-not-contain-gated-head-token" but its source contains "${token}", which IS gated by a shipped bash_match policy`,
        });
      }
    }
  }

  // Is `token` something a "covers" registration is LEGITIMATELY allowed to
  // claim: gated, AND not consciously carved out as documented-uncovered?
  // Point 1 of the module header's six forms lived exactly in the gap this
  // predicate closes — the old design treated "gated" as the only bar to
  // clear, so a covers set claiming ONLY documented-uncovered tokens
  // passed cleanly.
  const isLegitimatelyCoverable = (token: string): boolean =>
    isHeadTokenGated(facts, token) && !documentedUncovered.has(token);

  // (b) covers-completeness: every gated head token NOT consciously
  // documented as uncovered must be answered `true` by at least one
  // registered "covers" set's `source` — the 432db3d3 HIGH shape.
  for (const token of facts.gatedHeadTokens) {
    if (documentedUncovered.has(token)) continue;
    const covered = registrations.some(
      (reg) => reg.intent === "covers-gated-head-tokens" && sourceHas(reg.source, token),
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

  // (c) covers-empty (task `209e6dc4`, module header point 3, empty half):
  // a covers registration whose `source` matches NONE of the legitimately
  // coverable live gated head tokens contributes zero real coverage — the
  // structural echo of the old `members: []` escape, which type-checked
  // and passed silently because nothing walked an empty declaration back
  // to a finding. There is no `members` field to leave empty any more, but
  // an empty backing `Set`, or a regex that matches nothing in the known
  // vocabulary, is still a value a registrant can write; this check makes
  // that visible instead of silently accepted.
  for (const reg of registrations) {
    if (reg.intent !== "covers-gated-head-tokens") continue;
    const coversSomething = [...facts.gatedHeadTokens]
      .filter(isLegitimatelyCoverable)
      .some((token) => sourceHas(reg.source, token));
    if (!coversSomething) {
      violations.push({
        setId: reg.id,
        intent: reg.intent,
        token: "(none)",
        check: "covers-empty",
        reason: `"${reg.id}" (${reg.module} — ${reg.description}) declares intent "covers-gated-head-tokens" but its source matches NONE of the live, legitimately-coverable gated head tokens — an empty or vacuous registration`,
      });
    }
  }

  // (d) covers-purity (task `209e6dc4` redesign, merging the old checks
  // (c) covers-purity, (e) covers-predicate-purity, and closing the
  // previously-unchecked documented-uncovered laundering gap — module
  // header points 1 and 3): probe the registration's ACTUAL `source`
  // directly — never a hand-typed `members` list, there isn't one any
  // more — against every live gated head token PLUS
  // `PLAUSIBLE_NON_GATED_HEAD_TOKENS`. A covers registration must answer
  // `true` ONLY for tokens that are BOTH gated AND not consciously
  // documented-uncovered (i.e. `isLegitimatelyCoverable`). Because coverage
  // is read straight off `source` instead of a separate declared list,
  // "declaring coverage the predicate rejects" and "claiming a
  // documented-uncovered token honestly" collapse into the same probe:
  // there is nothing left to declare independently of what the constant
  // actually does.
  const probeVocabulary = new Set<string>([
    ...facts.gatedHeadTokens,
    ...PLAUSIBLE_NON_GATED_HEAD_TOKENS,
  ]);
  for (const reg of registrations) {
    if (reg.intent !== "covers-gated-head-tokens") continue;
    for (const token of probeVocabulary) {
      if (sourceHas(reg.source, token) && !isLegitimatelyCoverable(token)) {
        const reason = documentedUncovered.has(token)
          ? `"${reg.id}" (${reg.module} — ${reg.description}) declares intent "covers-gated-head-tokens" and its source answers true for "${token}", but "${token}" IS gated while also being consciously documented-uncovered — a covers set may not claim coverage of a token this codebase has deliberately marked as NOT covered by any engine-side set (the dbc6d303-shape laundering this check exists to close)`
          : `"${reg.id}" (${reg.module} — ${reg.description}) declares intent "covers-gated-head-tokens" and its source answers true for "${token}", but "${token}" is not a live gated head token at all — the source accepts more than it should, reproducing this registry's own defect class (an engine-side constant mirroring manifest content with no coupling) inside the guard itself`;
        violations.push({
          setId: reg.id,
          intent: reg.intent,
          token,
          check: "covers-purity",
          reason,
        });
      }
    }
  }

  // (e) covers-redundancy: a gated head token answered `true` by MORE THAN
  // ONE registered "covers-gated-head-tokens" set's `source` is a
  // violation UNLESS every one of those covering sets consciously declares
  // that token in its own `intentionalOverlaps` (task `209e6dc4`,
  // resolving module header point 4: a silent new registration re-covering
  // a token an existing set already owns still trips this — only a
  // declaration on BOTH sides clears it).
  const isCoversSet = (reg: RegisteredHeadTokenSet): reg is CoversHeadTokenSet =>
    reg.intent === "covers-gated-head-tokens";
  for (const token of facts.gatedHeadTokens) {
    const coveringSets = registrations
      .filter(isCoversSet)
      .filter((reg) => sourceHas(reg.source, token));
    if (coveringSets.length <= 1) continue;
    const allAcknowledged = coveringSets.every((reg) => reg.intentionalOverlaps?.has(token));
    if (allAcknowledged) continue;
    for (const reg of coveringSets) {
      const others = coveringSets.filter((r) => r.id !== reg.id).map((r) => r.id);
      violations.push({
        setId: reg.id,
        intent: reg.intent,
        token,
        check: "covers-redundancy",
        reason: `"${reg.id}" (${reg.module} — ${reg.description}) declares intent "covers-gated-head-tokens" and answers true for "${token}", but "${token}" is ALSO covered by ${others.length} other registered covers-set(s) (${others.join(", ")}) without every covering set declaring "${token}" in its own intentionalOverlaps — a gated head token must be covered by exactly one registered covers-set unless ALL covering sets consciously declare the overlap`,
      });
    }
  }

  return violations;
}
