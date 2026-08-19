import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { SOLO_TEMPLATE, TEAM_TEMPLATE } from "../../src/cli/init/profiles.js";
import { composeCustom } from "../../src/cli/init/composer.js";
import { FULL_TEMPLATE } from "../../src/cli/init/templates.js";
import { parseManifest } from "../../src/schema/index.js";

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

  // Task fb80b5bb (Batch 19) intentionally revised the anchoring
  // decision this test used to pin: `expire_on_bash_match` patterns
  // moved from `^`-anchored to `\b`-scoped so a boundary command behind
  // `cd <dir> &&`, an env-var prefix, a subshell `(...)`, or (push
  // pattern only) `git -C <dir>` still expires the marker (see
  // docs/policy-packs/understanding-before-execution.md,
  // "expire_on_bash_match prefix tolerance"). The `&`-boundary-
  // alternation guard below is UNRELATED to that change and stays: it
  // still protects against the `&`-boundary-family fixed in d834a065
  // (a completely different concern, PreToolUse `bash_match` policy
  // triggers) accidentally leaking into this PostToolUse-boundary
  // family's own patterns.
  it.each(TEMPLATES)("%s: expire_on_bash_match patterns are unanchored (task fb80b5bb) and still carry no `&`-boundary alternation", (_, src) => {
    const parsed = parseManifest(parseYaml(src));
    const pack = parsed.policy_packs.find((p) => p.name === "understanding-before-execution");
    const lifecycle = (pack?.config as Record<string, unknown>)?.["approval_lifecycle"];
    const patterns = (lifecycle as Record<string, unknown>)?.["expire_on_bash_match"] as string[];
    expect(Array.isArray(patterns)).toBe(true);
    for (const p of patterns) {
      // No `^` anchor: the whole point of fb80b5bb is that these match
      // anywhere a boundary verb sits, not only at command start.
      expect(p.startsWith("^"), `${p} must NOT be start-anchored (task fb80b5bb widened it)`).toBe(false);
      // Still `\b`-scoped, not a bare substring match, so an unrelated
      // word merely containing "gh" or "git" cannot match.
      expect(p.startsWith("\\b"), `${p} must open with a \\b word boundary`).toBe(true);
      // Unrelated concern (d834a065's `&`-boundary-alternation family)
      // must not leak into this family's own patterns.
      expect(p.includes("&"), `${p} must not carry a boundary alternation`).toBe(false);
    }
  });

  // AC pin (task fb80b5bb): the ACTUAL shipped regexes — not hand-copied
  // literals — against realistic prefixed/compound boundary commands.
  // Reproduces the exact fail-open miss the task fixed
  // (`cd repo && gh pr merge 42`, `git -C repo push origin main`,
  // `GH_TOKEN=x gh pr merge 42`, `(gh pr merge 42)`), each of which used
  // to slip past the old `^`-anchored patterns and leave a stale
  // approval marker alive past the real merge/push. A future regex edit
  // that silently narrows or widens the boundary reddens here.
  describe("expire_on_bash_match: compound/prefixed boundary commands (task fb80b5bb)", () => {
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
    const matchesAny = (matchers: RegExp[], cmd: string): boolean => matchers.some((re) => re.test(cmd));

    it.each(TEMPLATES)("%s: prefixed/compound forms of a real boundary command still expire the marker", (_, src) => {
      const matchers = bashMatchers(src);
      for (const cmd of [
        "gh pr merge 42 --squash",
        "cd repo && gh pr merge 42",
        "GH_TOKEN=x gh pr merge 42",
        "(gh pr merge 42)",
        "cd repo && gh pr close 7",
        "git push origin main",
        "git push origin master",
        "cd repo && git push origin main",
        "git -C repo push origin main",
        "GIT_AUTHOR_NAME=x git -C repo push origin main",
        "(git -C repo push origin main)",
      ]) {
        expect(matchesAny(matchers, cmd), `expected a boundary regex to match ${JSON.stringify(cmd)} in ${_}`).toBe(
          true,
        );
      }
    });

    it.each(TEMPLATES)("%s: unrelated or non-boundary commands do not falsely expire the marker", (_, src) => {
      const matchers = bashMatchers(src);
      for (const cmd of [
        "git status",
        "gh pr view 42",
        "gh pr list",
        "gh issue close 42",
        "git pull origin main",
        "git push origin feature/foo",
        "git -C repo status",
        "npm publish",
      ]) {
        expect(matchesAny(matchers, cmd), `expected no boundary regex to match ${JSON.stringify(cmd)} in ${_}`).toBe(
          false,
        );
      }
    });

    // Documents the accepted trade-off named in the task's own
    // acceptance criteria: an unanchored `\b`-scoped pattern also fires
    // inside quoted text. This is the deliberately chosen failure
    // direction (an extra, unnecessary re-approval) rather than the
    // fail-open miss the task closes (a marker that survives a real
    // merge/push). Pinned so a future "fix" that tries to exclude
    // quoted occurrences (which would require real shell-quote parsing,
    // out of scope here — see the task's stop-signal note) doesn't
    // silently change this behaviour unnoticed.
    it.each(TEMPLATES)(
      "%s: accepted false positive by design — the pattern also fires inside quoted/echoed text",
      (_, src) => {
        const matchers = bashMatchers(src);
        expect(
          matchesAny(matchers, 'echo "gh pr merge 42"'),
          "expected the gh boundary regex to ALSO match inside quoted text (documented trade-off)",
        ).toBe(true);
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
  function bashMatchers(templateSource: string): RegExp[] {
    const parsed = parseManifest(parseYaml(templateSource));
    const pack = parsed.policy_packs.find(
      (p) => p.name === "understanding-before-execution",
    );
    if (!pack) throw new Error("understanding-before-execution pack missing from template");
    const lifecycle = (pack.config as Record<string, unknown>)["approval_lifecycle"];
    const patterns = (lifecycle as Record<string, unknown>)["expire_on_bash_match"];
    if (!Array.isArray(patterns)) {
      throw new Error("expire_on_bash_match must be a string array in the template");
    }
    return patterns.map((p) => new RegExp(p as string));
  }

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
