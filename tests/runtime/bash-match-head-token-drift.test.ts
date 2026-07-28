import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { FULL_TEMPLATE } from "../../src/cli/init/templates.js";
import { parseManifest } from "../../src/schema/index.js";
import {
  DOCUMENTED_UNCOVERED_HEAD_TOKENS,
  extractBashMatchFacts,
  type BashMatchFacts,
} from "../../src/runtime/bash-match-facts.js";
import {
  REGISTERED_HEAD_TOKEN_SETS,
  checkRegisteredSets,
} from "../../src/runtime/bash-match-registry.js";

// MIGRATED (task `074acf5d`, run `2026-07-28-manifest-facts-drift-guard`)
// onto `src/runtime/bash-match-facts.ts` (the live facts) and
// `src/runtime/bash-match-registry.ts` (the registered-set guard). This
// file used to carry its own local curated classification map and its own
// two hand-written drift assertions, checking exactly one named engine
// set (`NON_GIT_HEAD_TOKENS`) against FULL_TEMPLATE. That guard could not
// see run `dbc6d303`'s CRITICAL (a brand NEW module's `INERT_CONSUMER_HEADS`
// containing `harness`, the kill-switch's own gated head token) — it
// never looked at any set but the one it was told about. The
// classification map and the two checks now live in the modules above so
// EVERY registered set is checked, not one; this file's remaining job is
// (1) proving today's SHIPPED state is clean against the live manifest,
// and (2) the load-bearing addition: scanning for an engine-side set that
// exists but was never registered at all.
//
// NAMED RESIDUALS carried forward from the pre-migration guard (curated-
// map limits, not closed by this run either — see
// `src/runtime/bash-match-facts.ts`'s module header for why a regex-AST
// head-token extractor is deliberately not attempted):
//   a. A THIRD alternative silently added ALONGSIDE an existing,
//      still-correctly-spelled token (e.g. dogfood-before-release someday
//      also gating `yarn publish`) would not trip `extractBashMatchFacts`,
//      since nothing verifies the token INVENTORY of a pattern is
//      exhaustive, only that classified tokens/verbs are present.
//   b. Deleting a classified alternative whose token survives as a
//      SUBSTRING elsewhere in the same regex keeps the `\bTOKEN\b`
//      presence check green. The repo is not blind to it (measured
//      previously: the full-template parity and kill-switch-deny suites
//      catch it), just not via this guard.
//   c. CLOSED by this run, generalised: `checkRegisteredSets`'s covers-
//      completeness check now runs against EVERY registered
//      "covers-gated-head-tokens" set, not only `NON_GIT_HEAD_TOKENS` —
//      see `src/runtime/bash-match-registry.ts`.
//
// UNREGISTERED-SET SCAN — WHAT IT SEES AND WHAT IT MISSES (be honest,
// per this run's brief): a textual regex scan of `src/runtime/*.ts`
// (excluding this guard's own two modules) for a TOP-LEVEL
// `export const NAME[: ReadonlySet<string>] = new Set([...])` literal
// whose every element is a bare lowercase word (no leading `-`, matching
// `read-only-bash.ts`'s own flag-vs-name distinction). Any match is a
// "candidate" that MUST have its name present in
// `REGISTERED_HEAD_TOKEN_SETS`.
//   SEES: a new exported `Set`/`ReadonlySet<string>` literal of bare-word
//   tokens anywhere in `src/runtime/*.ts`, regardless of which file —
//   closing the exact "new module" shape of run `dbc6d303`.
//   MISSES (by construction, not oversight):
//     - Anything outside `src/runtime/` (e.g. `src/policy-packs/`,
//       `src/cli/`) — scoped to the layer where both real registrations
//       live today.
//     - A non-`Set` shaped mirror: a plain array, an object-of-booleans
//       map, or a regex alternation (`GIT_TOKEN_RE`'s own shape) — those
//       are registered BY HAND, not discovered.
//     - A set built any way other than a literal `new Set([...])` at the
//       declaration site (computed, spread from another module, built in
//       a function body, or re-exported under an alias).
//     - A module-private (`const`, not `export const`) set — nothing
//       outside the module could reference it for registration anyway,
//       and no other module could consume it as a mirror of manifest
//       content.
//     - Elements that are not bare lowercase words (a set mixing flags
//       and head tokens, or using a different casing/quoting
//       convention).
//   This is a real, load-bearing but NARROW net — see this run's
//   implementer report for the mutation probe that proves it fires.

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..", "..");
const RUNTIME_DIR = path.join(REPO_ROOT, "src", "runtime");

/** This guard's own modules: legitimately contain gated-head-token-shaped literals (the curated map, the registrations array) without being an independent mirror that needs registering. */
const SELF_EXCLUDED_FILES: ReadonlySet<string> = new Set([
  "bash-match-facts.ts",
  "bash-match-registry.ts",
]);

const EXPORTED_SET_RE =
  /export const (\w+)\s*:\s*ReadonlySet<string>\s*=\s*new Set\(\s*\[([^\]]*)\]\s*\)|export const (\w+)\s*=\s*new Set\(\s*\[([^\]]*)\]\s*\)/g;

const BARE_WORD_RE = /^[a-z][a-z0-9_-]*$/;

interface CandidateSet {
  file: string;
  name: string;
}

/** Scan `src/runtime/*.ts` for exported bare-word-shaped `Set`/`ReadonlySet<string>` literals — see the module header for exactly what this sees and misses. */
function scanForHeadTokenShapedSets(): CandidateSet[] {
  const found: CandidateSet[] = [];
  const files = fs
    .readdirSync(RUNTIME_DIR)
    .filter(
      (f) =>
        f.endsWith(".ts") &&
        !f.endsWith(".test.ts") &&
        !SELF_EXCLUDED_FILES.has(f),
    );
  for (const file of files) {
    const text = fs.readFileSync(path.join(RUNTIME_DIR, file), "utf8");
    EXPORTED_SET_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = EXPORTED_SET_RE.exec(text)) !== null) {
      const name = m[1] ?? m[3];
      const arrayBody = m[2] ?? m[4] ?? "";
      const elements = arrayBody
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((s) => s.replace(/^["']|["']$/g, ""));
      if (elements.length === 0) continue;
      if (elements.every((e) => BARE_WORD_RE.test(e))) {
        found.push({ file, name: name! });
      }
    }
  }
  return found;
}

function liveFacts(): BashMatchFacts {
  return extractBashMatchFacts(parseManifest(parseYaml(FULL_TEMPLATE)).policies);
}

describe("bash_match facts drift guard (migrated onto src/runtime/bash-match-facts.ts + bash-match-registry.ts, task 074acf5d)", () => {
  it("extractBashMatchFacts computes verified-fresh facts from the live FULL_TEMPLATE without drift (closes: added/removed/renamed bash_match policy, or a renamed/removed classified head token/verb within one)", () => {
    expect(() => liveFacts()).not.toThrow();
  });

  it("every registered engine-side set is clean against the live facts — no covers-completeness gap (432db3d3 HIGH shape) and no must-not-contain violation (dbc6d303 CRITICAL shape), checked for EVERY registered set, not one", () => {
    const violations = checkRegisteredSets(
      liveFacts(),
      REGISTERED_HEAD_TOKEN_SETS,
      DOCUMENTED_UNCOVERED_HEAD_TOKENS,
    );
    expect(violations).toEqual([]);
  });

  describe("per-policy head-token facts (diagnostic detail preserved from the pre-migration guard)", () => {
    const facts = liveFacts();
    for (const policyFact of facts.policies) {
      describe(policyFact.policyName, () => {
        for (const { token, class: cls } of policyFact.headTokens) {
          it(`head token "${token}" (classified: ${cls}) is a standalone word in the live pattern, and its classification agrees with the registered sets`, () => {
            expect(
              new RegExp(`\\b${token}\\b`).test(policyFact.pattern),
              `expected "${token}" as a standalone word in ${policyFact.policyName}'s bash_match: ${policyFact.pattern}`,
            ).toBe(true);

            const gitSet = REGISTERED_HEAD_TOKEN_SETS.find((r) => r.id === "GIT_TOKEN_RE")!;
            const nonGitSet = REGISTERED_HEAD_TOKEN_SETS.find(
              (r) => r.id === "NON_GIT_HEAD_TOKENS",
            )!;

            if (cls === "git") {
              expect(gitSet.has(token)).toBe(true);
              expect(nonGitSet.has(token)).toBe(false);
            } else if (cls === "non-git-set") {
              expect(nonGitSet.has(token)).toBe(true);
              expect(gitSet.has(token)).toBe(false);
            } else {
              // documented-uncovered: genuinely NOT covered by any
              // registered set today. If this ever starts failing
              // because a registered set NOW covers it, that is a real
              // coverage improvement — move the classification (and drop
              // it from DOCUMENTED_UNCOVERED_HEAD_TOKENS in
              // bash-match-facts.ts) consciously; do not just delete the
              // assertion.
              expect(DOCUMENTED_UNCOVERED_HEAD_TOKENS.has(token)).toBe(true);
              expect(nonGitSet.has(token)).toBe(false);
              expect(gitSet.has(token)).toBe(false);
            }
          });
        }
      });
    }
  });

  it("every exported bare-word-shaped Set/ReadonlySet<string> in src/runtime/*.ts is registered in REGISTERED_HEAD_TOKEN_SETS — the load-bearing clause: a NEW engine-side set that mirrors manifest content but is never registered must make this guard red (run dbc6d303's exact shape: a new module's set)", () => {
    const candidates = scanForHeadTokenShapedSets();
    const registeredIds = new Set(REGISTERED_HEAD_TOKEN_SETS.map((r) => r.id));
    const unregistered = candidates.filter((c) => !registeredIds.has(c.name));
    expect(
      unregistered,
      `found exported head-token-shaped set(s) not present in REGISTERED_HEAD_TOKEN_SETS (src/runtime/bash-match-registry.ts): ${JSON.stringify(unregistered)}`,
    ).toEqual([]);
  });
});
