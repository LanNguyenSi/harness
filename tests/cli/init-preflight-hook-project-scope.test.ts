// Scope guard for `session_start_preflight.setup` (task 30183330, review
// round 3).
//
// `docs/CLI.md`, `src/schema/session-start-preflight.ts` and the
// CHANGELOG all state that the key is HOST-WIDE, with no per-repo
// scoping, and the load-bearing half of that claim is what the GENERATED
// hook actually invokes: `harness session-start preflight` with no
// `--project`. `src/cli/loader.ts` resolves a project override layer only
// when `LoaderOptions.project` is set (pinned separately by
// tests/cli/loader-project-layer.test.ts), and `--project <name>` is the
// only source of that value, so as long as the shipped hook command
// carries no `--project` no project layer can narrow the key on the hook
// path. This test pins the hook side of that pair against the same
// rendered-template seam tests/cli/init-full-template-pins.test.ts uses,
// so an edit that adds a `--project` to the hook (which would silently
// turn a documented host-wide switch into a single hardcoded project
// name for every repository) fails here.

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
