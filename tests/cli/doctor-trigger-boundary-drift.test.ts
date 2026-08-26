// Trigger-boundary drift (task 037cfb7c, follow-up to adf037c1):
// checkTemplatePolicyDrift only catches a shipped policy that is
// entirely MISSING or downgraded; it never inspected a bash_match
// trigger that IS present under a shipped name but whose leading
// boundary-alternation group (^|\n|;|\||&|\( since v0.43.0, task
// d834a065) is missing an alternative the template has, or has no
// boundary group at all. See checkTriggerBoundaryDrift in
// src/cli/validate/checks.ts for the check itself and CHANGELOG.md's
// [Unreleased] entry for task 037cfb7c for the measured incident this
// closes (a sleep 0 & gh pr merge 1 bypass on an unmigrated manifest).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { doctor } from "../../src/cli/doctor/index.js";
import { format } from "../../src/cli/doctor/format.js";
import { getTemplate, shippedBashMatchBoundaries } from "../../src/cli/init/templates.js";
import { checkTriggerBoundaryDrift } from "../../src/cli/validate/checks.js";
import { parseManifest } from "../../src/schema/index.js";
import { parse as parseYaml } from "yaml";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function makeFixture(files: Record<string, string>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-doctor-boundary-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(home, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, "utf8");
  }
  return home;
}

// Silences the (unrelated) operator_only template-policy-drift check
// (task adf037c1) so each test's errorCount/format assertions are about
// trigger-boundary drift alone, not swamped by the three missing
// kill-switch policies these minimal fixtures don't carry.
const SILENCE_OPERATOR_ONLY_DRIFT = `doctor:
  ignore_template_drift:
    - deny-kill-switch-bypass
    - deny-session-env-strip
    - deny-pause-sentinel-forgery
`;

// A hook + policy pair named after a real FULL_TEMPLATE entry
// (require-review-evidence-bash / review-before-merge-bash). `boundary`
// substitutes the single separator token the old `&&`-vs-`&` incident
// hinges on, inside the fixed skeleton `(^|\n|;|\||<boundary>|\()`.
function manifestWithBoundary(boundary: string, extraHooks = ""): string {
  return `version: 1
${SILENCE_OPERATOR_ONLY_DRIFT}hooks:
  - name: require-review-evidence-bash
    event: PreToolUse
    match: "Bash"
    bash_match: '(^|\\n|;|\\||${boundary}|\\()\\s*(\\w+=\\S+\\s+)*gh pr merge\\b'
    command: harness policy intercept
    blocking: hard
${extraHooks}policies:
  - name: review-before-merge-bash
    description: test
    trigger:
      event: PreToolUse
      match: "Bash"
      bash_match: '(^|\\n|;|\\||${boundary}|\\()\\s*(\\w+=\\S+\\s+)*gh pr merge\\b'
    requires:
      ledger_tag: "review:x"
    hook: require-review-evidence-bash
    enforcement: block
`;
}

// A hook + policy pair (same shipped names) whose FULL boundary-group
// content is caller-supplied verbatim, for the set-comparison tests
// (reordering, supersets, missing alternatives) that a single-token
// substitution can't express.
function manifestWithFullBoundary(hookBoundaryContent: string, policyBoundaryContent: string): string {
  return `version: 1
${SILENCE_OPERATOR_ONLY_DRIFT}hooks:
  - name: require-review-evidence-bash
    event: PreToolUse
    match: "Bash"
    bash_match: '(${hookBoundaryContent})\\s*(\\w+=\\S+\\s+)*gh pr merge\\b'
    command: harness policy intercept
    blocking: hard
policies:
  - name: review-before-merge-bash
    description: test
    trigger:
      event: PreToolUse
      match: "Bash"
      bash_match: '(${policyBoundaryContent})\\s*(\\w+=\\S+\\s+)*gh pr merge\\b'
    requires:
      ledger_tag: "review:x"
    hook: require-review-evidence-bash
    enforcement: block
`;
}

// A hook + policy pair whose bash_match has NO leading parenthesized
// boundary group at all (the item-3 case: present, shipped by name, but
// unparseable as a boundary alternation).
function manifestWithNoBoundaryGroup(): string {
  return `version: 1
${SILENCE_OPERATOR_ONLY_DRIFT}hooks:
  - name: require-review-evidence-bash
    event: PreToolUse
    match: "Bash"
    bash_match: '\\s*gh pr merge\\b'
    command: harness policy intercept
    blocking: hard
policies:
  - name: review-before-merge-bash
    description: test
    trigger:
      event: PreToolUse
      match: "Bash"
      bash_match: '\\s*gh pr merge\\b'
    requires:
      ledger_tag: "review:x"
    hook: require-review-evidence-bash
    enforcement: block
`;
}

describe("doctor - trigger-boundary drift (task 037cfb7c)", () => {
  // AC1: a manifest whose bash_match triggers carry the &&-only boundary
  // reports one finding per affected hook AND one per affected policy,
  // each naming the entry, its actual boundary, the template boundary,
  // the specific missing alternative, and a rehydration path; every
  // finding is an error (see the severity-assertion test below), so
  // errorCount picks them both up.
  it("reports drift for both the hook-level and policy-level bash_match trigger, naming actual + template boundary, the missing alternative, and the rehydration path", async () => {
    const home = makeFixture({ "harness.yaml": manifestWithBoundary("&&") });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      shallow: true,
    });
    expect(report.triggerBoundaryDrift.errors).toHaveLength(2);
    const hookMsg = report.triggerBoundaryDrift.errors.find((m) =>
      m.includes("require-review-evidence-bash"),
    );
    const policyMsg = report.triggerBoundaryDrift.errors.find((m) =>
      m.includes("review-before-merge-bash"),
    );
    expect(hookMsg).toBeDefined();
    expect(policyMsg).toBeDefined();
    for (const m of [hookMsg, policyMsg]) {
      // Actual boundary (&&-only, no bare &) and template boundary both named.
      expect(m).toContain("(^|\\n|;|\\||&&|\\()");
      expect(m).toContain("(^|\\n|;|\\||&|\\()");
      // The specific missing alternative is named, not just "differs".
      expect(m).toContain('"&"');
      expect(m).toContain("missing");
      // Corrected rehydration path (review round 2): a throwaway --config
      // path, not --template full --force against the live manifest.
      expect(m).toContain("harness init --template full --config");
      expect(m).not.toContain("scratch dir");
      expect(m).toContain("doctor.ignore_template_drift");
    }
    const text = format(report);
    expect(text).toContain("Trigger boundary drift (shipped bash_match triggers)");
    expect(text).toContain("✗");
  });

  // AC2 (negative control 1): a manifest generated by
  // `harness init --template full` carries the shipped boundary already,
  // so it reports no drift.
  it("reports no drift on a manifest from harness init --template full", async () => {
    const home = makeFixture({ "harness.yaml": getTemplate("full") });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      shallow: true,
    });
    expect(report.triggerBoundaryDrift.errors).toHaveLength(0);
    expect(format(report)).not.toContain("Trigger boundary drift");
  });

  // Fixed-point pin (review round 2, item 6): the previous negative
  // control is tautological on its own (the fixture and the expectation
  // both derive from FULL_TEMPLATE, so it would pass even if
  // shippedBashMatchBoundaries() were broken in a way that also broke
  // getTemplate("full")'s parse the same way). Pin the actual shape of
  // the shipped set independently: 16 entries (8 hooks + 8 policies as
  // of this task), every one carrying the identical literal boundary
  // FULL_TEMPLATE ships since v0.43.0.
  it("shippedBashMatchBoundaries() is exactly 16 entries, all with the shipped boundary", () => {
    const entries = shippedBashMatchBoundaries();
    expect(entries).toHaveLength(16);
    expect(entries.filter((e) => e.level === "hook")).toHaveLength(8);
    expect(entries.filter((e) => e.level === "policy")).toHaveLength(8);
    for (const e of entries) {
      expect(e.boundary).toBe("^|\\n|;|\\||&|\\(");
    }
    // Cross-check against a direct FULL_TEMPLATE parse, independent of
    // shippedBashMatchBoundaries()'s own extraction, so this test does
    // not just restate the function under test.
    const manifest = parseManifest(parseYaml(getTemplate("full")));
    const directHookCount = manifest.hooks.filter((h) => h.bash_match !== undefined).length;
    const directPolicyCount = manifest.policies.filter(
      (p) => p.trigger.bash_match !== undefined,
    ).length;
    expect(directHookCount).toBe(8);
    expect(directPolicyCount).toBe(8);
  });

  // AC2 (negative control 2): an entry whose name does not exist in the
  // template is out of scope for this check, even carrying an &&-only
  // boundary produces no finding.
  it("reports no drift for a bash_match entry not named in the template", async () => {
    const home = makeFixture({
      "harness.yaml": manifestWithBoundary(
        "&",
        `  - name: my-custom-bash-gate
    event: PreToolUse
    match: "Bash"
    bash_match: '(^|\\n|;|\\||&&|\\()\\s*(\\w+=\\S+\\s+)*custom-cmd\\b'
    command: harness policy intercept
    blocking: hard
`,
      ),
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      shallow: true,
    });
    expect(report.triggerBoundaryDrift.errors).toHaveLength(0);
  });

  // AC3: doctor.ignore_template_drift silences only the message, not
  // enforcement. Review round 2 (item 7): the original assertion
  // re-read the YAML the test itself had just written, which is
  // tautological (it would pass even if doctor silently rewrote the
  // file, as long as it kept that one substring). Assert instead, non
  // tautologically, that the manifest file on disk is byte-identical
  // before and after the doctor() call: doctor is read-only regardless
  // of the opt-out.
  it("respects doctor.ignore_template_drift as a deliberate opt-out that silences only the message, and doctor never rewrites the manifest", async () => {
    const manifest = manifestWithBoundary("&&").replace(
      "    - deny-pause-sentinel-forgery\n",
      "    - deny-pause-sentinel-forgery\n    - require-review-evidence-bash\n    - review-before-merge-bash\n",
    );
    const home = makeFixture({ "harness.yaml": manifest });
    const configPath = path.join(home, "harness.yaml");
    const before = fs.readFileSync(configPath, "utf8");
    const report = await doctor({ configPath, homeOverride: home, shallow: true });
    const after = fs.readFileSync(configPath, "utf8");
    expect(after).toBe(before);
    expect(report.triggerBoundaryDrift.errors).toHaveLength(0);
    expect(report.errorCount).toBe(0);
  });

  // AC4 mutation probe: fixing one trigger's boundary to `&` in the test
  // manifest makes its finding disappear; reverting to `&&` brings it
  // back. Exercised against the hook-level entry (the policy-level
  // entry is left on `&&` throughout, so it stays a live control that
  // the fix/revert cycle does not touch).
  it("mutation probe: correcting one trigger's boundary makes its finding disappear, and reverting brings it back", async () => {
    const buildManifest = (hookBoundary: string): string => `version: 1
${SILENCE_OPERATOR_ONLY_DRIFT}hooks:
  - name: require-review-evidence-bash
    event: PreToolUse
    match: "Bash"
    bash_match: '(^|\\n|;|\\||${hookBoundary}|\\()\\s*(\\w+=\\S+\\s+)*gh pr merge\\b'
    command: harness policy intercept
    blocking: hard
policies:
  - name: review-before-merge-bash
    description: test
    trigger:
      event: PreToolUse
      match: "Bash"
      bash_match: '(^|\\n|;|\\||&&|\\()\\s*(\\w+=\\S+\\s+)*gh pr merge\\b'
    requires:
      ledger_tag: "review:x"
    hook: require-review-evidence-bash
    enforcement: block
`;

    // Baseline: both stale (&&).
    const home = makeFixture({ "harness.yaml": buildManifest("&&") });
    const configPath = path.join(home, "harness.yaml");
    const baseline = await doctor({ configPath, homeOverride: home, shallow: true });
    expect(baseline.triggerBoundaryDrift.errors).toHaveLength(2);
    expect(baseline.triggerBoundaryDrift.errors.some((m) => m.includes("require-review-evidence-bash"))).toBe(
      true,
    );

    // Mutant fix: hook boundary corrected to `&`, policy left at `&&`.
    fs.writeFileSync(configPath, buildManifest("&"), "utf8");
    const fixed = await doctor({ configPath, homeOverride: home, shallow: true });
    expect(fixed.triggerBoundaryDrift.errors).toHaveLength(1);
    expect(fixed.triggerBoundaryDrift.errors.some((m) => m.includes("require-review-evidence-bash"))).toBe(
      false,
    );
    expect(fixed.triggerBoundaryDrift.errors.some((m) => m.includes("review-before-merge-bash"))).toBe(
      true,
    );

    // Restored: back to `&&`, the finding reappears.
    fs.writeFileSync(configPath, buildManifest("&&"), "utf8");
    const restored = await doctor({ configPath, homeOverride: home, shallow: true });
    expect(restored.triggerBoundaryDrift.errors).toHaveLength(2);
    expect(
      restored.triggerBoundaryDrift.errors.some((m) => m.includes("require-review-evidence-bash")),
    ).toBe(true);
  });

  // A stale/typo'd ignore_template_drift entry that matches neither an
  // operator_only policy name nor a shipped bash_match trigger name is
  // still surfaced as a warning by checkTemplatePolicyDrift's shared
  // stale-opt-out check (task 037cfb7c extended its "known names" set so
  // a VALID trigger-boundary opt-out is not itself misreported as stale).
  it("does not misreport a valid trigger-boundary opt-out as a stale ignore_template_drift entry", async () => {
    const manifest = manifestWithBoundary("&&").replace(
      "    - deny-pause-sentinel-forgery\n",
      "    - deny-pause-sentinel-forgery\n    - require-review-evidence-bash\n    - review-before-merge-bash\n",
    );
    const home = makeFixture({ "harness.yaml": manifest });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      shallow: true,
    });
    expect(report.templateDrift.warnings).toHaveLength(0);
  });

  // Review round 2, item 4: severity is a load-bearing field on the
  // diagnostics, not just decoration (buildTriggerBoundaryDrift now
  // partitions by severity, mirroring buildTemplateDrift). Assert it
  // directly against checkTriggerBoundaryDrift's own output: flipping
  // this to "warning" (or any other severity) makes this assertion fail
  // even though every other test in this file stays green, since none
  // of them inspect severity directly.
  it("every diagnostic checkTriggerBoundaryDrift emits has severity error", () => {
    const manifest = parseManifest(
      parseYaml(manifestWithBoundary("&&")),
    );
    const diags = checkTriggerBoundaryDrift(manifest);
    expect(diags.length).toBeGreaterThan(0);
    for (const d of diags) {
      expect(d.severity).toBe("error");
    }
  });

  // Review round 2, item 2: set-based comparison, not exact-string.
  describe("set-based boundary comparison (review round 2)", () => {
    // Same alternatives, different order: not a finding.
    it("reports no drift when the installed boundary reorders the same alternatives", async () => {
      const reordered = "\\(|&|\\||;|\\n|^"; // same 6 alternatives as the template, reversed
      const home = makeFixture({
        "harness.yaml": manifestWithFullBoundary(reordered, reordered),
      });
      const report = await doctor({
        configPath: path.join(home, "harness.yaml"),
        homeOverride: home,
        shallow: true,
      });
      expect(report.triggerBoundaryDrift.errors).toHaveLength(0);
    });

    // A strict superset (every template alternative present, plus an
    // extra one): not a finding, since a superset only widens what the
    // trigger matches.
    it("reports no drift when the installed boundary is a superset of the template's", async () => {
      const superset = "^|\\n|;|\\||&|\\(|\\r"; // template's set plus \r
      const home = makeFixture({
        "harness.yaml": manifestWithFullBoundary(superset, superset),
      });
      const report = await doctor({
        configPath: path.join(home, "harness.yaml"),
        homeOverride: home,
        shallow: true,
      });
      expect(report.triggerBoundaryDrift.errors).toHaveLength(0);
    });

    // A single missing alternative (here: bare `&`, the historical
    // incident) is reported, naming exactly that alternative.
    it("reports drift naming the specific missing alternative when one is absent", async () => {
      const missingAmpersand = "^|\\n|;|\\||\\("; // template's set minus &
      const home = makeFixture({
        "harness.yaml": manifestWithFullBoundary(missingAmpersand, missingAmpersand),
      });
      const report = await doctor({
        configPath: path.join(home, "harness.yaml"),
        homeOverride: home,
        shallow: true,
      });
      expect(report.triggerBoundaryDrift.errors).toHaveLength(2);
      for (const m of report.triggerBoundaryDrift.errors) {
        expect(m).toContain("missing");
        expect(m).toContain('"&"');
        // Only the missing alternative is named, not the untouched ones.
        expect(m).not.toContain('"^"');
      }
    });
  });

  // Review round 2, item 3: an installed bash_match under a shipped name
  // with no recognizable leading boundary group at all used to fall
  // through the old `continue` silently (0 findings). It is now its own
  // finding, distinct wording from the missing-alternative case.
  it("reports its own finding when a shipped-named bash_match has no recognizable boundary group at all", async () => {
    const home = makeFixture({ "harness.yaml": manifestWithNoBoundaryGroup() });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      shallow: true,
    });
    expect(report.triggerBoundaryDrift.errors).toHaveLength(2);
    for (const m of report.triggerBoundaryDrift.errors) {
      expect(m).toContain("no recognizable");
      expect(m).toContain("boundary");
    }
  });
});
