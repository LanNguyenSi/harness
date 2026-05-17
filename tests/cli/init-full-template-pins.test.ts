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
  it("git-preflight (agent-preflight) floors at 0.1.1 with `preflight --version` probe", () => {
    // Floor at agent-preflight 0.1.1: the release that distinguishes
    // "tool not installed" (e.g. an npm script invoking eslint that
    // is not in devDependencies) from real lint/test/typecheck
    // failures. Stale 0.1.0 installs silently emit false-positive
    // blockers that keep the preflight-before-* policies closed
    // forever. The version_command points at the source-of-truth
    // `preflight` binary, not at the `harness session-start preflight`
    // wrapper, so the floor checks the actual upstream release.
    const m = parseManifest(parseYaml(FULL_TEMPLATE));
    const gitPreflight = m.hooks.find((h) => h.name === "git-preflight");
    expect(gitPreflight, "FULL_TEMPLATE must declare a git-preflight SessionStart hook").toBeDefined();
    expect(gitPreflight?.event).toBe("SessionStart");
    expect(gitPreflight?.min_version).toBe("0.1.1");
    expect(gitPreflight?.version_command).toEqual(["preflight", "--version"]);
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
