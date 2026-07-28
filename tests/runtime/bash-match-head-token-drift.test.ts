import * as fs from "node:fs";
import * as os from "node:os";
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
// UNREGISTERED-SET SCAN — WHAT IT SEES AND WHAT IT MISSES (be honest, per
// this run's brief; broadened in the fix round, F3): a textual regex scan
// of every non-test `.ts` file under `src/runtime/` (RECURSIVELY, so a
// future `src/runtime/<subdir>/` is covered) for a TOP-LEVEL
// `export const NAME[: <any type annotation>] = new Set(<optional
// constructor generic>)([...])` literal containing AT LEAST ONE bare
// lowercase word element (no leading `-`, matching `read-only-bash.ts`'s
// own flag-vs-name distinction). Any match is a "candidate" that MUST have
// its name present in `REGISTERED_HEAD_TOKEN_SETS`.
//   SEES: a new exported `Set` literal of bare-word tokens anywhere under
//   `src/runtime/` (any depth), regardless of file — closing the exact
//   "new module" shape of run `dbc6d303` — AND, since the fix round,
//   regardless of three shapes a fixed-form regex plus `every()` missed:
//     (a) a MUTABLE type annotation (`export const X: Set<string> = ...`,
//         not only `ReadonlySet<string>`).
//     (b) a GENERIC on the constructor itself (`new Set<string>([...])`).
//     (c) a `// comment` line sharing an array element's slot — this
//         merges the comment into one element, which fails the bare-word
//         test; `some()` (not `every()`) only needs ONE genuine bare-word
//         element among the rest to flag the whole set, so a stray
//         comment can no longer sink an otherwise-detectable set.
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
//     - A set with NO bare-lowercase-word element at all (every element
//       uppercase, a flag, or a non-string literal) — `some()` still
//       needs at least one genuine candidate element to fire.
//     - (fix round 2, S3 decision D-003 — deliberately DEFERRED, not
//       fixed, as case enumeration; filed as follow-up rather than chased
//       one shape at a time):
//         - `new Set([...] as const)` — the trailing `as const` assertion
//           after the array literal is not accounted for by
//           `EXPORTED_SET_RE`.
//         - a `// comment` line BETWEEN `(` and `[` (e.g. `new Set(\n  //
//           why\n  [...])`) — distinct from the INSIDE-the-brackets
//           comment case, SEES (c) above, which a comment IS tolerated
//           for: the regex only tolerates whitespace between `(` and `[`,
//           not text, so a comment there breaks the match entirely rather
//           than merging into an element. A comment is tolerated ONLY
//           inside the brackets, sharing an element's slot — nowhere else.
//         - backtick-quoted (template-literal) elements — the unquoting
//           step only strips a leading/trailing `"` or `'`, never a
//           backtick.
//         - a union-literal type annotation on the constant itself.
//         - a trailing comma in the constructor call (`new Set([...], )`)
//           — the regex demands `]` immediately (modulo whitespace)
//           followed by `)`, with nothing in between.
//   This is a real, load-bearing but NARROW net, honestly under-claimed:
//   it catches both historical incidents and the shapes enumerated in SEES
//   above; it does not catch the shapes enumerated in MISSES above,
//   including the five just listed. See the fixture-tree tests below
//   (fix round 2, S5) for the mutation probes that prove each SEEN shape
//   fires, and the positive-control test (F4) for what it does and does
//   not guarantee on its own.
//
// FIX ROUND 2 (task `074acf5d`, second fix round, findings S3/S5/S6 — see
// `.ai/runs/2026-07-28-manifest-facts-drift-guard/03-decisions.md`):
//   (S3) NAME-ONLY cross-reference closed: round-1 checked only whether a
//     candidate's NAME appeared in `REGISTERED_HEAD_TOKEN_SETS`, so a set
//     reusing an already-registered id from a DIFFERENT file (e.g. a new
//     `src/runtime/other.ts` re-declaring `export const
//     NON_GIT_HEAD_TOKENS = new Set([...])`) passed silently — the id
//     matched, the file it actually lived in was never asked about. The
//     cross-reference is now over the PAIR: `${file}::${name}` against
//     `${module}::${id}`, both repo-root-relative.
//   (S5) `scanForHeadTokenShapedSets` / `collectRuntimeTsFiles` take an
//     INJECTABLE root directory (default `RUNTIME_DIR`), so the
//     fixture-tree tests below can point the scan at a disposable
//     `fs.mkdtempSync` tree instead of the real `src/runtime/`. Needed
//     because the F4 positive control only ever asserted on
//     `NON_GIT_HEAD_TOKENS` — the one real set that ALSO satisfies the
//     pre-fix-round-1 narrow regex — so it was invariant under every
//     widening it claims to protect (measured: reverting
//     `EXPORTED_SET_RE` to its pre-fix-round-1 form, reverting `some()`
//     back to `every()`, and disabling the recursive walk each left the
//     guard's own 22 tests green).
//   (S6) the stale run-directory pointer below is replaced with the
//     inlined probe result — `.ai/runs/` is gitignored and this module
//     ships into `dist`.
//
// SELF-EXCLUSION RECONSIDERED (F3, fix round): an earlier version of this
// scan excluded this guard's own two modules by filename, reasoning they
// "legitimately contain gated-head-token-shaped literals". Verified
// empirically: neither module declares anything shaped like `export const
// NAME = new Set([...])` — `CURATED_BASH_MATCH_FACTS` is a `Record`,
// `DOCUMENTED_UNCOVERED_HEAD_TOKENS` is computed (not a literal), and
// `REGISTERED_HEAD_TOKEN_SETS` is an array of objects, not a `Set`. A
// blanket exclusion defended against nothing today and would have hidden
// a real mirror added inside either module tomorrow — removed; both
// modules are now scanned like any other file under `src/runtime/`.

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..", "..");
const RUNTIME_DIR = path.join(REPO_ROOT, "src", "runtime");

const EXPORTED_SET_RE =
  /export const (\w+)\s*(?::\s*[\w.<>|\s]*)?=\s*new Set(?:<[^>]*>)?\(\s*\[([^\]]*)\]\s*\)/g;

const BARE_WORD_RE = /^[a-z][a-z0-9_-]*$/;

interface CandidateSet {
  /**
   * Repo-root-relative path (fix round 2, S3) — matches the format
   * `RegisteredHeadTokenSet.module` uses, so a candidate can be
   * cross-referenced against a registration by the PAIR (file, name), not
   * name alone.
   */
  file: string;
  name: string;
}

/**
 * Recursively collect every non-test `.ts` file under `dir` (F3, fix
 * round: a future `src/runtime/<subdir>/` must be covered, not just the
 * top level; fix round 2, S5: `dir` is now a parameter, defaulted to
 * `RUNTIME_DIR`, so a fixture tree can be walked the same way).
 */
function collectRuntimeTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectRuntimeTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Scan every `.ts` file under `rootDir` (recursively) for exported
 * bare-word-shaped `Set` literals — see the module header for exactly
 * what this sees and misses. `rootDir` defaults to the real
 * `src/runtime/` but is INJECTABLE (fix round 2, S5) so a disposable
 * `fs.mkdtempSync` fixture tree can be scanned instead, letting the
 * fixture-tree tests below assert on shapes the real tree does not
 * happen to contain today.
 */
function scanForHeadTokenShapedSets(rootDir: string = RUNTIME_DIR): CandidateSet[] {
  const found: CandidateSet[] = [];
  for (const full of collectRuntimeTsFiles(rootDir)) {
    const text = fs.readFileSync(full, "utf8");
    EXPORTED_SET_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = EXPORTED_SET_RE.exec(text)) !== null) {
      const name = m[1]!;
      const arrayBody = m[2] ?? "";
      const elements = arrayBody
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((s) => s.replace(/^["']|["']$/g, ""));
      if (elements.length === 0) continue;
      if (elements.some((e) => BARE_WORD_RE.test(e))) {
        // Repo-root-relative (fix round 2, S3) — NOT rootDir-relative —
        // so the (file, name) pair is directly comparable to a
        // registration's (module, id) pair regardless of which root the
        // scan actually walked (the real RUNTIME_DIR or a fixture tree).
        found.push({ file: path.relative(REPO_ROOT, full), name });
      }
    }
  }
  return found;
}

/**
 * Cross-reference scanned candidates against `REGISTERED_HEAD_TOKEN_SETS`
 * by the PAIR (fix round 2, S3) — `${file}::${name}` against
 * `${module}::${id}` — not by name alone. A candidate whose name matches a
 * registered id but whose file does NOT match that registration's module
 * is still unregistered: the id being taken elsewhere does not vouch for
 * THIS file's set.
 */
function unregisteredCandidates(candidates: readonly CandidateSet[]): CandidateSet[] {
  const registeredKeys = new Set(REGISTERED_HEAD_TOKEN_SETS.map((r) => `${r.module}::${r.id}`));
  return candidates.filter((c) => !registeredKeys.has(`${c.file}::${c.name}`));
}

/**
 * Build a disposable directory tree under the OS temp dir (fix round 2,
 * S5), write `files` (keyed by path relative to the tree's root, value is
 * file content) into it, run `fn` with the tree's root, then remove the
 * tree — regardless of whether `fn` throws.
 */
function withFixtureTree(files: Readonly<Record<string, string>>, fn: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bash-match-scan-fixture-"));
  try {
    for (const [relPath, content] of Object.entries(files)) {
      const full = path.join(root, relPath);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, "utf8");
    }
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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

  it("checkRegisteredSets(liveFacts()) — called with ONLY the live facts, relying on BOTH defaults — is clean on the shipped tree (F5 fix-round regression: the `documentedUncovered` parameter previously defaulted to an empty Set despite its docstring claiming the real shipped value, which raised 4 FALSE violations — tee, cp, env, unset — on this exact clean tree)", () => {
    expect(checkRegisteredSets(liveFacts())).toEqual([]);
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
    const unregistered = unregisteredCandidates(candidates);
    expect(
      unregistered,
      `found exported head-token-shaped set(s) not present in REGISTERED_HEAD_TOKEN_SETS (src/runtime/bash-match-registry.ts): ${JSON.stringify(unregistered)}`,
    ).toEqual([]);
  });

  it("fix-round-2 S3 regression: a set reusing an already-registered id (\"NON_GIT_HEAD_TOKENS\") in a DIFFERENT file is still reported unregistered — the cross-reference is over the (file, name) PAIR, not the name alone", () => {
    withFixtureTree(
      {
        "elsewhere.ts": 'export const NON_GIT_HEAD_TOKENS = new Set(["ls", "cat", "harness"]);\n',
      },
      (root) => {
        const candidates = scanForHeadTokenShapedSets(root);
        const unregistered = unregisteredCandidates(candidates);
        expect(unregistered).toHaveLength(1);
        expect(unregistered[0]).toMatchObject({ name: "NON_GIT_HEAD_TOKENS" });
        // The real NON_GIT_HEAD_TOKENS registration's module is
        // src/runtime/command-normalize.ts — this candidate must NOT be
        // mistaken for it just because the NAME matches.
        expect(unregistered[0]!.file).not.toBe("src/runtime/command-normalize.ts");
      },
    );
  });

  describe("fix-round-2 S5: scanForHeadTokenShapedSets on a disposable fixture tree — pins each SEEN shape independently of NON_GIT_HEAD_TOKENS, which (being the one real set that also satisfies the pre-fix-round-1 narrow regex) is invariant under every widening it claims to protect", () => {
    it("detects a MUTABLE `: Set<string>` type annotation (not only `ReadonlySet<string>`)", () => {
      withFixtureTree(
        { "mutable-annotation.ts": 'export const MUTABLE_HEADS: Set<string> = new Set(["ls", "cat"]);\n' },
        (root) => {
          expect(scanForHeadTokenShapedSets(root)).toContainEqual(
            expect.objectContaining({ name: "MUTABLE_HEADS" }),
          );
        },
      );
    });

    it("detects a GENERIC on the constructor itself (`new Set<string>([...])`)", () => {
      withFixtureTree(
        { "generic-constructor.ts": 'export const GENERIC_HEADS = new Set<string>(["ls", "cat"]);\n' },
        (root) => {
          expect(scanForHeadTokenShapedSets(root)).toContainEqual(
            expect.objectContaining({ name: "GENERIC_HEADS" }),
          );
        },
      );
    });

    it("detects a set with a `// comment` line sharing an array element's slot (some(), not every())", () => {
      withFixtureTree(
        {
          "commented-element.ts":
            'export const COMMENTED_HEADS = new Set([\n  "ls",\n  // "cat" removed pending review\n  "cp",\n]);\n',
        },
        (root) => {
          expect(scanForHeadTokenShapedSets(root)).toContainEqual(
            expect.objectContaining({ name: "COMMENTED_HEADS" }),
          );
        },
      );
    });

    it("detects a set in a file ONE DIRECTORY DOWN (the recursive walk)", () => {
      withFixtureTree(
        { "nested/dir/deep.ts": 'export const DEEP_HEADS = new Set(["ls", "cat"]);\n' },
        (root) => {
          expect(scanForHeadTokenShapedSets(root)).toContainEqual(
            expect.objectContaining({ name: "DEEP_HEADS" }),
          );
        },
      );
    });
  });

  it("scanForHeadTokenShapedSets DETECTS the known-good real case on the ACTUAL src/runtime/ tree (F4 fix-round-1 regression, title corrected fix round 2: this alone is NOT a general positive control — NON_GIT_HEAD_TOKENS is the one real set that also satisfies the pre-fix-round-1 narrow regex, `every()`, and a non-recursive walk, so it is invariant under every widening those fixes made; it only proves the scan is not a no-op against TODAY's shipped tree. The fix-round-2 fixture-tree tests above are what actually pin the mutable-annotation, generic-constructor, comment-tolerance, and recursive-walk shapes independently)", () => {
    expect(scanForHeadTokenShapedSets()).toContainEqual({
      file: "src/runtime/command-normalize.ts",
      name: "NON_GIT_HEAD_TOKENS",
    });
  });
});
