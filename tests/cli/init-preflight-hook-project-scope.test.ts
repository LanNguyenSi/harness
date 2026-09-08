// Scope guard for `session_start_preflight.setup` (task 30183330, review
// round 3; task `c88461c1` builds per-repo scoping on top of this
// contract, see below).
//
// The GENERATED SessionStart hook is one static command string, written
// once by `harness init` and then invoked unchanged on every session,
// in every repository that shares the same `~/.harness/harness.yaml`.
// A single hardcoded `--project <name>` baked into that string could
// therefore only ever name ONE project, the same one for every
// repository the hook runs in, which is worse than no scoping at all;
// see the entry these two facts justify (`resolvePaths`, `src/cli/
// loader.ts`, resolves a project override layer only when
// `LoaderOptions.project` is set, pinned separately by
// tests/cli/loader-project-layer.test.ts, and `--project <name>` is the
// only source of that value). So the hook stays `--project`-free, and
// per-repo scoping instead comes from the PRODUCER itself
// (`harness session-start preflight`, `src/cli/session-start/index.ts`)
// deriving a project name from its own cwd at runtime (task `c88461c1`,
// pinned by tests/cli/session-start/preflight.test.ts's "per-repo
// scoping via cwd-derived project name" describe block) and feeding it
// through this SAME `LoaderOptions.project` seam. This test pins the
// hook side of that pair against the same rendered-template seam
// tests/cli/init-full-template-pins.test.ts uses, so an edit that adds
// a literal `--project` to the hook (which would silently turn the
// per-repo cwd-derived scoping into a single hardcoded project name for
// every repository) fails here.

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { FULL_TEMPLATE, getTemplate, type TemplateName } from "../../src/cli/init/templates.js";
import { parseManifest } from "../../src/schema/index.js";

const TEMPLATE_NAMES: TemplateName[] = ["minimal", "full", "solo", "team"];

describe("generated git-preflight hook: no --project (task 30183330)", () => {
  it("FULL_TEMPLATE's git-preflight SessionStart hook invokes the producer with no --project", () => {
    const manifest = parseManifest(parseYaml(FULL_TEMPLATE));
    const hook = manifest.hooks.find((h) => h.name === "git-preflight");
    expect(hook, "FULL_TEMPLATE must declare a git-preflight SessionStart hook").toBeDefined();
    expect(hook?.event).toBe("SessionStart");
    expect(hook?.command).toBe("harness session-start preflight");
    expect(hook?.command).not.toContain("--project");
  });

  it("no shipped template's preflight producer hook carries a --project flag", () => {
    // Belt and braces across every template `harness init` can write, so
    // a future profile that starts shipping its own git-preflight hook is
    // covered by the same rule rather than silently exempt.
    const offenders: string[] = [];
    for (const name of TEMPLATE_NAMES) {
      const manifest = parseManifest(parseYaml(getTemplate(name)));
      for (const hook of manifest.hooks) {
        if (!hook.command.includes("session-start preflight")) continue;
        if (hook.command.includes("--project")) offenders.push(`${name}:${hook.name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
