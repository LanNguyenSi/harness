import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
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
