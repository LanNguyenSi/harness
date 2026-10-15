import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { SOLO_TEMPLATE, TEAM_TEMPLATE } from "../../src/cli/init/profiles.js";
import { COMPOSABLE_MCPS, COMPOSABLE_PACKS, composeCustom } from "../../src/cli/init/composer.js";
import { FULL_TEMPLATE } from "../../src/cli/init/templates.js";
import { parseManifest } from "../../src/schema/index.js";

// AC2 regression guard (task 9f10267e, follow-up to PR #333): the
// runtime-reality hook must never ship as an active entry. An active
// `runtime-reality` hook without RUNTIME_REALITY_KEYWORD + an expectations
// file + RUNTIME_REALITY_PROBE_CMD degrades to a silent allow (a no-op that
// looks like protection). FULL_TEMPLATE ships no hooks at all now (task
// bcdcde36); this guard turns an edit that adds the hook red.
describe("FULL_TEMPLATE: no active runtime-reality hook", () => {
  it("declares no active runtime-reality hook", () => {
    const m = parseManifest(parseYaml(FULL_TEMPLATE));
    expect(
      m.hooks.find((h) => h.name === "runtime-reality"),
      "FULL_TEMPLATE must not carry runtime-reality; an active entry without its RUNTIME_REALITY_* env degrades to silent-allow",
    ).toBeUndefined();
  });
});

// Task d834a065 pinned the `&` command boundary in every policy trigger the
// templates and the composer emitted. The policy engine is gone and the
// install surfaces ship no policies and no bash_match triggers any more
// (task bcdcde36), so the surface is pinned empty instead.
describe("install surfaces ship no policies, hooks or bash_match triggers", () => {
  const TEMPLATES: Array<[string, string]> = [
    ["SOLO_TEMPLATE", SOLO_TEMPLATE],
    ["TEAM_TEMPLATE", TEAM_TEMPLATE],
    ["FULL_TEMPLATE", FULL_TEMPLATE],
  ];

  it.each(TEMPLATES)("%s: parses with no policies, no hooks and no policy-intercept text", (_, src) => {
    const parsed = parseManifest(parseYaml(src));
    expect(parsed.policies).toEqual([]);
    expect(parsed.hooks).toEqual([]);
    expect(src).not.toContain("harness policy intercept");
    expect(src).not.toContain("bash_match");
  });

  it("composeCustom() with every pack and MCP emits no policies, hooks or bash_match", () => {
    const composed = composeCustom({
      packs: COMPOSABLE_PACKS.map((o) => o.key),
      mcps: COMPOSABLE_MCPS.map((o) => o.key),
    });
    const parsed = parseManifest(parseYaml(composed.yaml));
    expect(parsed.policies).toEqual([]);
    expect(parsed.hooks).toEqual([]);
    expect(composed.yaml).not.toContain("harness policy intercept");
    expect(composed.yaml).not.toContain("bash_match");
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
      // NOT see a plain exported regex constant with no such token.
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
});
