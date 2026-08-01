import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { SOLO_TEMPLATE, TEAM_TEMPLATE } from "../../src/cli/init/profiles.js";
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

// Regression guard for the YAML-render round-trip of the new
// expire_on_bash_match defaults (task f54e0ecb). The unit tests in
// pack-hook-post-tool-use.test.ts use direct JS string literals which
// bypasses the YAML render step entirely; this test catches the
// off-by-one-backslash class of bug where the templates emit a regex
// that compiles to literal "\b" (backslash + b) instead of \b
// (word boundary). Trace: TS source → runtime string → YAML disk →
// yaml.parse → new RegExp → .test against a realistic Bash command.
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
    // Positive control for the assertion loop itself: a template that
    // declares triggers but exercises none would otherwise pass
    // vacuously.
    expect(asserted, "template declares bash_match triggers but none was exercised").toBeGreaterThan(0);
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

  it.each(TEMPLATES)("%s: expire_on_bash_match is a separate anchored family, untouched", (_, src) => {
    const parsed = parseManifest(parseYaml(src));
    const pack = parsed.policy_packs.find((p) => p.name === "understanding-before-execution");
    const lifecycle = (pack?.config as Record<string, unknown>)?.["approval_lifecycle"];
    const patterns = (lifecycle as Record<string, unknown>)?.["expire_on_bash_match"] as string[];
    expect(Array.isArray(patterns)).toBe(true);
    for (const p of patterns) {
      // Anchored, no boundary alternation: widening the trigger family
      // must never leak into ledger-expiry semantics.
      expect(p.startsWith("^"), `${p} must stay anchored`).toBe(true);
      expect(p.includes("|&"), `${p} must not carry a boundary alternation`).toBe(false);
    }
  });
});

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
