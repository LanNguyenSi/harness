import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { SOLO_TEMPLATE, TEAM_TEMPLATE } from "../../src/cli/init/profiles.js";
import { composeCustom } from "../../src/cli/init/composer.js";
import { FULL_TEMPLATE } from "../../src/cli/init/templates.js";
import { parseManifest } from "../../src/schema/index.js";

// Module-scope helper (hoisted out of two describe blocks that each used
// to define their own copy — task fb80b5bb round 2): extracts the
// `approval_lifecycle.expire_on_bash_match` patterns from a rendered
// profile template as compiled RegExp objects, so tests exercise the
// ACTUAL shipped regexes rather than hand-copied literals.
function bashMatchers(templateSource: string): RegExp[] {
  const parsed = parseManifest(parseYaml(templateSource));
  const pack = parsed.policy_packs.find((p) => p.name === "understanding-before-execution");
  if (!pack) throw new Error("understanding-before-execution pack missing from template");
  const lifecycle = (pack.config as Record<string, unknown>)["approval_lifecycle"];
  const patterns = (lifecycle as Record<string, unknown>)["expire_on_bash_match"];
  if (!Array.isArray(patterns)) {
    throw new Error("expire_on_bash_match must be a string array in the template");
  }
  return patterns.map((p) => new RegExp(p as string));
}

// Drift guard for the npm-bin pins in FULL_TEMPLATE: any hook whose
// `command:` shells out to a tool shipped by a separate npm package
// MUST carry a `min_version` + `version_command` floor pointing at
// the source-of-truth binary. Without the floor, `harness doctor`
// cannot warn operators that their bin is stale. This is the same
// regression-guard shape used for the understanding-gate Claude hooks
// in tests/policy-packs/expand.test.ts:132-155.

describe("FULL_TEMPLATE: npm-bin hook pins", () => {
  it("git-preflight (agent-preflight) floors at 0.2.0 with `preflight --version` probe", () => {
    // Floor at agent-preflight 0.2.0: the release that makes secret
    // detection git-aware and diff-scoped. Pre-0.2.0 installs hard-fail
    // preflight on the normal correct state (a gitignored .env holding
    // real credentials), so the SessionStart producer never writes a
    // `preflight:` tag and the preflight-before-* policies stay closed
    // forever on any repo with a local .env. The version_command points
    // at the source-of-truth `preflight` binary, not at the `harness
    // session-start preflight` wrapper, so the floor checks the actual
    // upstream release.
    const m = parseManifest(parseYaml(FULL_TEMPLATE));
    const gitPreflight = m.hooks.find((h) => h.name === "git-preflight");
    expect(gitPreflight, "FULL_TEMPLATE must declare a git-preflight SessionStart hook").toBeDefined();
    expect(gitPreflight?.event).toBe("SessionStart");
    expect(gitPreflight?.min_version).toBe("0.2.0");
    expect(gitPreflight?.version_command).toEqual(["preflight", "--version"]);
  });
});

// AC2 regression guard (task 9f10267e, follow-up to PR #333): the
// runtime-reality hook ships in FULL_TEMPLATE as a COMMENTED discovery
// block, never as an active entry. An active `runtime-reality` hook
// without RUNTIME_REALITY_KEYWORD + an expectations file +
// RUNTIME_REALITY_PROBE_CMD degrades to a silent allow (a no-op that
// looks like protection). A future edit that uncomments the block would
// ship exactly that footgun; this guard turns such an edit red.
describe("FULL_TEMPLATE: runtime-reality stays commented (no active no-op hook)", () => {
  it("declares no active runtime-reality hook", () => {
    const m = parseManifest(parseYaml(FULL_TEMPLATE));
    expect(
      m.hooks.find((h) => h.name === "runtime-reality"),
      "FULL_TEMPLATE must keep runtime-reality commented out; an active entry without its RUNTIME_REALITY_* env degrades to silent-allow",
    ).toBeUndefined();
  });

  it("still carries the commented discovery block (not silently deleted)", () => {
    expect(FULL_TEMPLATE).toContain("runtime-reality drift gate (NOT enabled by default)");
  });
});

// Task d834a065. bash starts a new command after a single `&`, but the
// boundary alternation every policy trigger shares only listed `&&`, so
// `A=x&git push`, `A=x&gh pr merge`, `A=x&harness pause` (an
// operator_only deny) and even `sleep 0 & git status` reached their
// gated verb with no trigger match at all. Measured through the real
// prediction path against docs/examples/full-manifest.yaml, with the
// plain form of each policy as a per-policy positive control and a PATH
// shim proving the verb really executed (task 287fefaf).
//
// `&&` is subsumed by `&`: in `A=x&&git status` the SECOND `&` serves as
// the boundary, so the alternation is strictly more permissive than
// before. The `&&` cases below are the regression pin for that.
describe("profile templates: single `&` is a command boundary in every policy trigger", () => {
  function policyTriggers(templateSource: string): Array<{ name: string; re: RegExp }> {
    const parsed = parseManifest(parseYaml(templateSource));
    return parsed.policies
      .filter((p) => typeof p.trigger.bash_match === "string")
      .map((p) => ({ name: p.name, re: new RegExp(p.trigger.bash_match as string) }));
  }

  const TEMPLATES: Array<[string, string]> = [
    ["SOLO_TEMPLATE", SOLO_TEMPLATE],
    ["TEAM_TEMPLATE", TEAM_TEMPLATE],
    ["FULL_TEMPLATE", FULL_TEMPLATE],
  ];

  // Each entry: the plain form (positive control, must match today) and
  // the `&`-separated forms that used to slip through. A verb whose
  // plain form does not match in a given template simply is not gated
  // there, and the case is skipped rather than counted as a pass.
  const VERBS: Array<{ plain: string; amp: string[] }> = [
    { plain: "git status", amp: ["A=x&git status", "sleep 0 & git status"] },
    { plain: "git push", amp: ["A=x&git push"] },
    { plain: "gh pr merge", amp: ["A=x&gh pr merge"] },
    { plain: "gh pr create", amp: ["A=x&gh pr create"] },
    { plain: "npm publish", amp: ["A=x&npm publish"] },
    { plain: "harness pause", amp: ["A=x&harness pause", "sleep 0 & harness pause"] },
    // The two other operator_only denies. Without these the loop skipped
    // them (no plain verb matched their triggers) while the `asserted > 0`
    // guard was satisfied vacuously by the six above — measured: reverting
    // either family's alphabet left the whole suite green.
    {
      plain: "env -u CLAUDE_CODE_SESSION_ID sh",
      amp: ["A=x&env -u CLAUDE_CODE_SESSION_ID sh", "sleep 0 & env -u CLAUDE_CODE_SESSION_ID sh"],
    },
    { plain: "tee .harness-paused", amp: ["A=x&tee .harness-paused", "sleep 0 & cp a .harness-paused"] },
  ];

  // Only FULL ships bash_match policies today (solo/team gate through
  // MCP-match triggers alone). The assertions are data-driven off what a
  // template actually declares, so a bash_match policy added to solo or
  // team later is covered automatically instead of silently exempt; the
  // companion test below pins today's emptiness so that addition is
  // visible.
  it.each(TEMPLATES)("%s: every `&`-separated gated verb matches the trigger its plain form matches", (_, src) => {
    const triggers = policyTriggers(src);
    if (triggers.length === 0) return;
    let asserted = 0;
    for (const { plain, amp } of VERBS) {
      const gating = triggers.filter((t) => t.re.test(plain));
      if (gating.length === 0) continue; // not gated in this profile
      for (const cmd of amp) {
        for (const t of gating) {
          expect(t.re.test(cmd), `${t.name} must match ${JSON.stringify(cmd)}`).toBe(true);
          asserted += 1;
        }
      }
    }
    // Positive control for the assertion loop itself. `asserted > 0` is
    // not enough: with six of eight triggers covered it stayed green
    // while two operator_only denies were silently skipped. Require
    // EVERY declared trigger to have been exercised, so a policy added
    // to a template later cannot join the skipped set unnoticed.
    expect(asserted, "template declares bash_match triggers but none was exercised").toBeGreaterThan(0);
    const exercised = new Set(
      triggers.filter((t) => VERBS.some(({ plain }) => t.re.test(plain))).map((t) => t.name),
    );
    const skipped = triggers.filter((t) => !exercised.has(t.name)).map((t) => t.name);
    expect(skipped, `no VERBS entry exercises these triggers: ${skipped.join(", ")}`).toEqual([]);
  });

  it.each(TEMPLATES)("%s: `&&` keeps matching (subsumed, not dropped)", (_, src) => {
    const triggers = policyTriggers(src);
    if (triggers.length === 0) return;
    let asserted = 0;
    for (const { plain } of VERBS) {
      const gating = triggers.filter((t) => t.re.test(plain));
      for (const t of gating) {
        expect(t.re.test(`A=x&&${plain}`), `${t.name} must still match A=x&&${plain}`).toBe(true);
        expect(t.re.test(`echo x && ${plain}`), `${t.name} must still match echo x && ${plain}`).toBe(true);
        asserted += 1;
      }
    }
    expect(asserted).toBeGreaterThan(0);
  });

  it("only FULL_TEMPLATE declares bash_match policy triggers today", () => {
    expect(policyTriggers(SOLO_TEMPLATE)).toHaveLength(0);
    expect(policyTriggers(TEAM_TEMPLATE)).toHaveLength(0);
    expect(policyTriggers(FULL_TEMPLATE).length).toBeGreaterThan(0);
  });

  // The Custom profile is a fourth, independently-authored emitter that
  // the three template constants do not cover. It shipped the old
  // alphabet after the templates were fixed, so the same CRITICAL
  // bypass stayed live for every operator who picked Custom.
  it("composeCustom() output carries the same `&` boundary as the templates", () => {
    const composed = composeCustom({
      packs: [],
      mcps: [],
      policies: ["preflight-before-investigation", "preflight-before-push", "dogfood-before-release"],
    });
    const triggers = policyTriggers(composed.yaml);
    expect(triggers.length, "composed manifest declares no bash_match trigger to check").toBeGreaterThan(0);
    let asserted = 0;
    for (const { plain, amp } of VERBS) {
      for (const t of triggers.filter((x) => x.re.test(plain))) {
        for (const cmd of amp) {
          expect(t.re.test(cmd), `${t.name} must match ${JSON.stringify(cmd)}`).toBe(true);
          asserted += 1;
        }
      }
    }
    expect(asserted).toBeGreaterThan(0);
  });

  // One cheap guard over every emitter at once: no shipped bash_match
  // string may carry the old `&&`-only boundary alternative. This is
  // what would have caught composer.ts, the copy-paste policy example
  // and dogfood/harness.yaml in one go.
  it("no shipped bash_match string carries the old `&&|` boundary alternative", () => {
    const roots = [
      "src/cli/init/templates.ts",
      "src/cli/init/profiles.ts",
      "src/cli/init/composer.ts",
      "docs/examples/full-manifest.yaml",
      "docs/examples/full-manifest.expected.yaml",
      // Shipped copy-paste artefacts: the docs are the propagation
      // vector, so an operator following them must not be handed the
      // hole this task closed.
      "docs/examples/policies/02-clean-check-before-push.yaml",
      "docs/writing-custom-policies.md",
      "docs/ARCHITECTURE.md",
      // Task 76671e5a: this file was the documented gap. It is a
      // `harness validate` / `harness doctor` FIXTURE (see its own header),
      // deliberately declaring policies without grounding-mcp wired to
      // exercise the validate/doctor degraded-warn-mode warnings — `harness
      // apply --config dogfood/harness.yaml` deliberately REJECTS it
      // (measured: exits 1, "policies declared but grounding-mcp not
      // wired"), so it is never applied as a running manifest. Kept in
      // boundary-alphabet parity with the shipped templates anyway, so a
      // regression here would still mislead the validate/doctor warnings it
      // exists to exercise. Note this guard works by splitting on the
      // literal `bash_match` YAML token, which this file carries; it would
      // NOT see a plain exported regex constant with no such token (see
      // post-merge-gate-runtime.test.ts / solution-acceptance-runtime.test.ts
      // for those pins instead).
      "dogfood/harness.yaml",
    ];
    const offenders: string[] = [];
    for (const rel of roots) {
      // Scan the file as ONE string with newlines collapsed: a
      // prettier-wrapped value puts the pattern on a continuation line
      // that carries no `bash_match` token, and a per-line filter went
      // blind to 4 of the 6 composer patterns (measured: reverting one
      // of them left the whole suite green).
      const text = readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");
      const flat = text.replace(/\s*\n\s*/g, " ");
      for (const chunk of flat.split("bash_match").slice(1)) {
        const value = chunk.slice(0, 400);
        if (value.includes("&&|\\(") || value.includes("&&|\\\\(")) {
          offenders.push(`${rel}: ...${value.slice(0, 120)}`);
        }
      }
    }
    expect(offenders, `these still carry the pre-d834a065 boundary:\n${offenders.join("\n")}`).toEqual([]);
  });

  // Task 76671e5a, F7: the drift guard above only checks that the file
  // does NOT contain the old alternation substring — it never compiles the
  // pattern or runs a command through it, so a typo that broke the regex
  // entirely (e.g. an unbalanced group) would keep that guard green. This
  // pins the ACTUAL compiled dogfood-recency trigger against representative
  // spellings (including the bare-`&` one) and near-misses, so a broken
  // pattern reddens here even when it never contains the literal `&&|\(`
  // substring the guard above scans for.
  it("dogfood/harness.yaml's dogfood-recency trigger compiles and fires on representative spellings, not on near-misses", () => {
    const text = readFileSync(new URL("../../dogfood/harness.yaml", import.meta.url), "utf8");
    const parsed = parseManifest(parseYaml(text));
    const policy = parsed.policies.find((p) => p.name === "dogfood-recency");
    expect(policy, "dogfood/harness.yaml must declare a dogfood-recency policy").toBeDefined();
    expect(typeof policy?.trigger.bash_match).toBe("string");
    const re = new RegExp(policy?.trigger.bash_match as string);

    for (const cmd of [
      "npm publish",
      "git tag v1.0.0",
      "A=x&npm publish",
      "sleep 0 & npm publish",
      "A=x&git tag v2.0.0",
      "echo x && npm publish",
    ]) {
      expect(re.test(cmd), `must fire for ${JSON.stringify(cmd)}`).toBe(true);
    }
    for (const cmd of ["npm publisher", "git tagv1", "echo npm publish"]) {
      expect(re.test(cmd), `must NOT fire for ${JSON.stringify(cmd)}`).toBe(false);
    }
  });

  // Task fb80b5bb round 1 widened these patterns from `^`-anchored to
  // `\b`-scoped to close the fail-open forms measured against the old
  // shape. Round 2 measured that widening end-to-end against the real
  // PostToolUse hook and reverted it: it made
  // `harness approve understanding <<'RPT' ... RPT` self-revoking (a
  // report body that legitimately quotes a boundary command as part of
  // the plan expires its OWN freshly-written marker), plus 8 measured
  // everyday false positives and still 20 remaining fail-open forms. See
  // "expire_on_bash_match: start-anchored, with a documented fail-open
  // limitation" in docs/policy-packs/understanding-before-execution.md
  // for the full rationale. The `&`-boundary-alternation guard below is
  // UNRELATED to this anchoring decision and stays: it still protects
  // against the `&`-boundary family fixed in d834a065 (a different
  // concern, PreToolUse `bash_match` policy triggers) leaking into this
  // PostToolUse-boundary family's own patterns.
  it.each(TEMPLATES)("%s: expire_on_bash_match is a separate anchored family, untouched", (_, src) => {
    const parsed = parseManifest(parseYaml(src));
    const pack = parsed.policy_packs.find((p) => p.name === "understanding-before-execution");
    const lifecycle = (pack?.config as Record<string, unknown>)?.["approval_lifecycle"];
    const patterns = (lifecycle as Record<string, unknown>)?.["expire_on_bash_match"] as string[];
    expect(Array.isArray(patterns)).toBe(true);
    // Whole-value pin (round 2b): the per-pattern shape checks below
    // (anchored, `\b`-terminated, no `&`) stay green under a widening
    // (e.g. `(master|main)` -> `(master|main|develop)`), a narrowing, or
    // a reorder of the array — none of those change the shape. This
    // asserts the exact literals, so any of the three go red here. The
    // two literals are the ones documented in "expire_on_bash_match:
    // start-anchored, with a documented fail-open limitation" in
    // docs/policy-packs/understanding-before-execution.md; that section
    // and this assertion must not drift apart.
    expect(patterns).toEqual(["^gh pr (merge|close)\\b", "^git push origin (master|main)\\b"]);
    for (const p of patterns) {
      // Anchored, no boundary alternation: widening the trigger family
      // must never leak into ledger-expiry semantics.
      expect(p.startsWith("^"), `${p} must stay anchored`).toBe(true);
      // Trailing `\b` word boundary: without this check a start-anchored
      // pattern could still be silently narrowed (e.g. dropping the
      // close-word boundary) with nothing catching it. This assertion
      // was missing from the pre-fb80b5bb version of this test; the
      // round-2 mutation probe proved its absence would go undetected.
      expect(p.endsWith("\\b"), `${p} must end with a \\b word boundary`).toBe(true);
      expect(p.includes("&"), `${p} must not carry a boundary alternation`).toBe(false);
    }
  });

  // Task fb80b5bb round 2: pins the KNOWN, DOCUMENTED fail-open gap of
  // the `^`-anchored patterns against the actual shipped regexes (not
  // hand-copied literals), so the gap this task measured and chose not
  // to close stays visible instead of drifting silently further. See
  // "expire_on_bash_match: start-anchored, with a documented fail-open
  // limitation" in docs/policy-packs/understanding-before-execution.md
  // for the full list and the reasoning against widening — this
  // describe block and that doc section must not drift apart.
  describe("expire_on_bash_match: anchored-pattern behavior (task fb80b5bb, round 2)", () => {
    const matchesAny = (matchers: RegExp[], cmd: string): boolean => matchers.some((re) => re.test(cmd));

    it.each(TEMPLATES)("%s: the plain boundary commands still match", (_, src) => {
      const matchers = bashMatchers(src);
      for (const cmd of ["gh pr merge 42 --squash", "gh pr close 7", "git push origin main", "git push origin master"]) {
        expect(matchesAny(matchers, cmd), `expected a boundary regex to match ${JSON.stringify(cmd)} in ${_}`).toBe(
          true,
        );
      }
    });

    // Known miss: the anchor sits at command START, so a boundary
    // command behind a shell prefix or with a flag inserted between its
    // own words does not expire the marker.
    // `approval_lifecycle.max_age` is the named safety net for all of
    // these — documented as a limitation, not fixed, by this task.
    it.each(TEMPLATES)(
      "%s: known fail-open forms do NOT expire the marker (documented limitation, not fixed)",
      (_, src) => {
        const matchers = bashMatchers(src);
        for (const cmd of [
          "cd repo && gh pr merge 42", // leading `cd <dir> &&`
          "GH_TOKEN=x gh pr merge 42", // env-var assignment prefix
          "(gh pr merge 42)", // subshell parens
          "git -C repo push origin main", // flag inserted between `git` and `push`
          "git -c user.name=x push origin main", // flag inserted between `git` and `push`
          "git push --force origin main", // flag inserted between `push` and `origin`
          "git push -u origin main", // flag inserted between `push` and `origin`
          "git push origin HEAD:main", // refspec instead of a bare branch name
          "gh --repo owner/repo pr merge 42", // flag inserted between `gh` and `pr`
          "git  push  origin  main", // doubled whitespace between tokens
        ]) {
          expect(
            matchesAny(matchers, cmd),
            `expected NO boundary regex to match ${JSON.stringify(cmd)} in ${_} (documented fail-open form)`,
          ).toBe(false);
        }
      },
    );

    // Negative-FP pins: trivially true under `^`-anchoring today, but
    // pinned against a future de-anchoring attempt (the one round 2
    // reverted) so the self-revocation and everyday-FP regressions this
    // task measured cannot silently return unnoticed.
    it.each(TEMPLATES)(
      "%s: quoted/prose mentions of a boundary command do not falsely expire the marker",
      (_, src) => {
        const matchers = bashMatchers(src);
        const approveHeredoc = [
          "harness approve understanding <<'RPT'",
          "Plan: after review approves the PR, run `gh pr merge 42` and `git push origin main`.",
          "RPT",
        ].join("\n");
        for (const cmd of ['grep "gh pr merge" docs/', 'echo "gh pr merge 42"', 'echo "git push origin main"', approveHeredoc]) {
          expect(
            matchesAny(matchers, cmd),
            `expected NO boundary regex to match ${JSON.stringify(cmd)} in ${_} (would self-revoke or false-positive)`,
          ).toBe(false);
        }
      },
    );
  });
});

// Regression guard for the YAML-render round-trip of the new
// expire_on_bash_match defaults (task f54e0ecb). The unit tests in
// pack-hook-post-tool-use.test.ts use direct JS string literals which
// bypasses the YAML render step entirely; this test catches the
// off-by-one-backslash class of bug where the templates emit a regex
// that compiles to literal "\b" (backslash + b) instead of \b
// (word boundary). Trace: TS source → runtime string → YAML disk →
// yaml.parse → new RegExp → .test against a realistic Bash command.
describe("profile templates: expire_on_bash_match round-trips to functioning regex", () => {
  // Uses the module-scope `bashMatchers` helper defined near the top of
  // this file (hoisted from a duplicate local copy — task fb80b5bb
  // round 2).
  it.each([
    ["SOLO_TEMPLATE", SOLO_TEMPLATE],
    ["TEAM_TEMPLATE", TEAM_TEMPLATE],
    ["FULL_TEMPLATE", FULL_TEMPLATE],
  ])("%s: ^gh pr (merge|close) regex matches realistic gh-cli invocations", (_, src) => {
    const matchers = bashMatchers(src);
    const ghMerge = matchers.find((re) => re.test("gh pr merge 42 --squash"));
    expect(ghMerge, `expected one regex to match "gh pr merge 42 --squash" in ${_}`).toBeDefined();
    const ghClose = matchers.find((re) => re.test("gh pr close 7"));
    expect(ghClose, `expected one regex to match "gh pr close 7" in ${_}`).toBeDefined();
    // Negative: must NOT vacuously match unrelated commands.
    expect(matchers.some((re) => re.test("git status"))).toBe(false);
  });

  it.each([
    ["SOLO_TEMPLATE", SOLO_TEMPLATE],
    ["TEAM_TEMPLATE", TEAM_TEMPLATE],
    ["FULL_TEMPLATE", FULL_TEMPLATE],
  ])("%s: ^git push origin (master|main) regex matches realistic push invocations", (_, src) => {
    const matchers = bashMatchers(src);
    expect(matchers.some((re) => re.test("git push origin master"))).toBe(true);
    expect(matchers.some((re) => re.test("git push origin main"))).toBe(true);
    // Negative: feature-branch pushes must not expire the marker.
    expect(matchers.some((re) => re.test("git push origin feat/foo"))).toBe(false);
  });
});

// Task 19356be7 drift pin, generated-manifest half. `harness init` writes
// FULL_TEMPLATE into the operator's own harness.yaml, and
// docs/examples/full-manifest.yaml is the shipped copy-paste reference —
// both carried a post-merge-gate comment claiming the escape allowlist is
// "checked first, unconditionally" long after the blocker stopped working
// that way. An operator reading either file would conclude that chaining a
// recovery verb still exempts a mutation.
describe("post-merge-gate comment: escape-first precedence is not taught anywhere operators read", () => {
  const SURFACES: Array<[string, () => string]> = [
    ["FULL_TEMPLATE", () => FULL_TEMPLATE],
    [
      "docs/examples/full-manifest.yaml",
      () => readFileSync(new URL("../../docs/examples/full-manifest.yaml", import.meta.url), "utf8"),
    ],
  ];

  // The `--help` text is the fifth operator-visible surface and was the one
  // the round-1 sweep left unpinned: reverting it to the escape-first
  // wording left the ENTIRE suite green (mutation-confirmed). It is not a
  // YAML comment block, so it gets its own shape rather than joining
  // SURFACES above.
  it("harness pack hook post-merge-gate --help no longer claims the escape list is checked first", () => {
    const text = readFileSync(new URL("../../src/cli/index.ts", import.meta.url), "utf8");
    const start = text.indexOf('.command("post-merge-gate")');
    expect(start, "post-merge-gate command not found").toBeGreaterThanOrEqual(0);
    const block = text
      .slice(start, text.indexOf(".option(", start))
      .replace(/\s*\+\s*\n\s*"/g, "")
      .replace(/\s+/g, " ");
    expect(block).not.toMatch(/checked first, unconditionally/i);
    expect(block).not.toMatch(/escape allowlist/i);
    expect(block).toMatch(/does NOT exempt the mutation/);
  });

  it.each(SURFACES)("%s no longer claims the escape list is checked first", (_label, read) => {
    const text = read();
    // Only assert on the post-merge-gate comment block, so an unrelated
    // pack's wording can never satisfy or break this pin.
    const start = text.indexOf("# post-merge-gate (");
    expect(start, "post-merge-gate comment block not found").toBeGreaterThanOrEqual(0);
    const raw = text.slice(start, text.indexOf("- name: post-merge-gate", start));
    // FLATTEN before matching. These are wrapped YAML comments, so any
    // phrase can straddle a `\n  # ` continuation — a per-line or raw
    // match silently goes blind exactly when the wording is longest (the
    // same trap the boundary-alphabet guard above documents).
    const block = raw.replace(/\s*\n\s*#\s?/g, " ").replace(/\s+/g, " ");
    expect(block).not.toMatch(/checked first, unconditionally/i);
    expect(block).not.toMatch(/escape allowlist/i);
    // Positive half: the block must state the new precedence, so deleting
    // the whole comment cannot pass this test by vacuity.
    expect(block).toMatch(/does NOT exempt the mutation/);
  });
});
