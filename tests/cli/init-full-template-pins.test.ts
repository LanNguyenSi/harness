import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { SOLO_TEMPLATE, TEAM_TEMPLATE } from "../../src/cli/init/profiles.js";
import { composeCustom } from "../../src/cli/init/composer.js";
import { FULL_TEMPLATE } from "../../src/cli/init/templates.js";
import { parseManifest } from "../../src/schema/index.js";

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
      policies: ["dogfood-before-release", "review-before-merge"],
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

// Task d03af8f6, review round 3, MEDIUM C4: gate-dev-unsafe-deletion must
// be declared AFTER both gate-prod-destructive and
// gate-prod-destructive-approval, so the deny-first ordering documented
// at gate-prod-destructive's own comment ("Ordered deny-first so a
// critical action ... gets the hard-deny envelope") is not silently
// defeated by a future edit that moves the deletion gate earlier in the
// array — src/runtime/intercept.ts evaluates policies in array order and
// stops at the first that fires.
describe("FULL_TEMPLATE: gate-dev-unsafe-deletion is ordered after both production destructive gates", () => {
  it("gate-prod-destructive and gate-prod-destructive-approval both precede gate-dev-unsafe-deletion", () => {
    const parsed = parseManifest(parseYaml(FULL_TEMPLATE));
    const names = parsed.policies.map((p) => p.name);
    const prodDestructive = names.indexOf("gate-prod-destructive");
    const prodDestructiveApproval = names.indexOf("gate-prod-destructive-approval");
    const devUnsafeDeletion = names.indexOf("gate-dev-unsafe-deletion");
    expect(prodDestructive, "gate-prod-destructive missing from FULL_TEMPLATE").toBeGreaterThanOrEqual(0);
    expect(
      prodDestructiveApproval,
      "gate-prod-destructive-approval missing from FULL_TEMPLATE",
    ).toBeGreaterThanOrEqual(0);
    expect(devUnsafeDeletion, "gate-dev-unsafe-deletion missing from FULL_TEMPLATE").toBeGreaterThanOrEqual(0);
    expect(devUnsafeDeletion).toBeGreaterThan(prodDestructive);
    expect(devUnsafeDeletion).toBeGreaterThan(prodDestructiveApproval);
  });
});
