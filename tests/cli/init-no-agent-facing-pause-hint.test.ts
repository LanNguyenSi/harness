import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { FULL_TEMPLATE } from "../../src/cli/init/templates.js";
import { SOLO_TEMPLATE, TEAM_TEMPLATE } from "../../src/cli/init/profiles.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

// Regression guard for task 70781cf6: the agent-facing deny envelope of
// `gate-prod-destructive` used to name `harness pause --for <duration>`
// ("every gate silences") as a way to unblock a denied action — a full
// bypass recipe handed to the exact party the gate just blocked. `pause`
// is a session-wide kill switch and an operator verb; it has no business
// in a surface an agent reads.
//
// `ux.run` (src/schema/policies.ts) is specifically the agent-facing
// "what to do next" list — `renderAgentFacing` (src/runtime/intercept.ts)
// substitutes it straight into the PreToolUse deny JSON the agent reads.
// `ux.cannot` / `ux.required` are allowed to keep naming `harness pause`/
// `harness resume` (they describe what is already denied, e.g. on the
// deny-kill-switch-bypass / deny-pause-sentinel-forgery policies whose
// entire purpose IS pause/resume), and code comments are operator-only —
// neither surface is checked here, deliberately: only `ux.run`, across
// every shipped init template and the reference manifest, is agent-facing
// and therefore in scope.
//
// One legitimate, non-actionable exception is allow-listed: the "see also"
// link to docs/okf/pause-vs-gate-kill-switch.md, which the three
// kill-switch deny policies' own `run:` text points operators/readers at
// for the honest trust model. That is a doc citation, not a recommendation
// to run pause/resume, and its filename happens to contain the substring
// "pause".

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..", "..");
const REFERENCE_YAML = path.join(REPO_ROOT, "docs", "examples", "full-manifest.yaml");

const ALLOWED_DOC_LINK = "docs/okf/pause-vs-gate-kill-switch.md";
const KILL_SWITCH_WORD = /\b(pause|resume)\b/i;

function stripAllowedDocLink(text: string): string {
  return text.split(ALLOWED_DOC_LINK).join("");
}

function agentFacingRunLines(manifest: Manifest): Array<{ policy: string; line: string }> {
  const out: Array<{ policy: string; line: string }> = [];
  for (const policy of manifest.policies) {
    if (!policy.ux) continue;
    for (const line of policy.ux.run) {
      out.push({ policy: policy.name, line });
    }
  }
  return out;
}

const SOURCES: Array<{ name: string; load: () => Manifest }> = [
  { name: "FULL_TEMPLATE", load: () => parseManifest(parseYaml(FULL_TEMPLATE)) },
  { name: "SOLO_TEMPLATE", load: () => parseManifest(parseYaml(SOLO_TEMPLATE)) },
  { name: "TEAM_TEMPLATE", load: () => parseManifest(parseYaml(TEAM_TEMPLATE)) },
  {
    name: "docs/examples/full-manifest.yaml",
    load: () => parseManifest(parseYaml(fs.readFileSync(REFERENCE_YAML, "utf8"))),
  },
];

describe("no agent-facing ux.run line recommends the pause/resume kill switch (task 70781cf6)", () => {
  it.each(SOURCES)(
    "$name: no policy's ux.run line names pause or resume as a course of action",
    ({ load }) => {
      const manifest = load();
      const offenders = agentFacingRunLines(manifest).filter(({ line }) =>
        KILL_SWITCH_WORD.test(stripAllowedDocLink(line)),
      );
      expect(
        offenders,
        `agent-facing ux.run line(s) still recommend pause/resume: ${JSON.stringify(offenders)}`,
      ).toEqual([]);
    },
  );

  // AC1: the specific policy the task was measured against. Assert the
  // absence of the kill-switch hint directly (not just "does not equal the
  // old text" — a reworded bypass recipe would still be wrong), and pin
  // that the two legitimate agent options survive untouched.
  it("gate-prod-destructive's ux.run has no harness pause/resume hint and stays actionable", () => {
    const full = parseManifest(parseYaml(FULL_TEMPLATE));
    const policy = full.policies.find((p) => p.name === "gate-prod-destructive");
    expect(policy?.ux).toBeDefined();
    const run = policy!.ux!.run;
    for (const line of run) {
      expect(KILL_SWITCH_WORD.test(stripAllowedDocLink(line))).toBe(false);
    }
    expect(run).toHaveLength(2);
    expect(run[0]).toMatch(/non-destructive alternative/i);
    expect(run[1]).toMatch(/harness approve risk --force/);
  });
});
