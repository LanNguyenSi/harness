import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { FULL_TEMPLATE } from "../../src/cli/init/templates.js";
import { SOLO_TEMPLATE, TEAM_TEMPLATE } from "../../src/cli/init/profiles.js";
import { COMPOSABLE_PACKS, COMPOSABLE_POLICIES, composeCustom } from "../../src/cli/init/composer.js";
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
// COVERAGE (fix round 1, Finding 1): `ux.run` reaches the agent through
// THREE distinct rendering paths, all via the same `renderAgentFacing`
// engine, and the original guard only walked the first:
//   (a) `manifest.policies[].ux.run` — the reference/Risk-Gate policies.
//   (b) `manifest.policy_packs[].config.ux.run` — the built-in policy
//       packs (understanding-before-execution, branch-protection,
//       post-merge-gate) carry their own `ux` block under `config`,
//       structurally separate from `policies[]`.
//   (c) the Custom composer (`harness init --interactive`, composeCustom()
//       in src/cli/init/composer.ts) assembles its own `ux.run` text for
//       five reference policies and the two composable packs, entirely in
//       memory and independently of FULL_TEMPLATE/SOLO_TEMPLATE/
//       TEAM_TEMPLATE/full-manifest.yaml. tests/cli/init-templates-ux-parity.test.ts
//       already imports composeCustom for its own drift checks; this guard
//       follows the same pattern.
// agentFacingRunLines() below walks (a) and (b) for every SOURCES entry;
// the fifth SOURCES entry exercises the composer with every composable
// pack and policy selected, so (c) is covered too.
//
// One legitimate, non-actionable exception is allow-listed: the "see also"
// link to docs/okf/pause-vs-gate-kill-switch.md, which the three
// kill-switch deny policies' own `run:` text points operators/readers at
// for the honest trust model. That is a doc citation, not a recommendation
// to run pause/resume, and its filename happens to contain the substring
// "pause".
//
// LIMITATION (documented, not fixed here): this is a literal-vocabulary
// guard, not a semantic one. KILL_SWITCH_WORD also catches the sibling
// kill switches `harness gate disable` / `harness gate enable` (same
// silence-every-gate effect as pause/resume), but a paraphrase that avoids
// all of these literal words — e.g. "silence every gate" — is NOT caught.
// Finding 3 of task 70781cf6's fix round 1 reworded exactly such a line by
// hand, with reviewer sign-off; this guard cannot substitute for that
// review, only for the specific vocabulary it checks.

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..", "..");
const REFERENCE_YAML = path.join(REPO_ROOT, "docs", "examples", "full-manifest.yaml");

const ALLOWED_DOC_LINK = "docs/okf/pause-vs-gate-kill-switch.md";
const KILL_SWITCH_WORD = /\b(pause|resume)\b|\bgate\s+(?:disable|enable)\b/i;

function stripAllowedDocLink(text: string): string {
  return text.split(ALLOWED_DOC_LINK).join("");
}

// Finding 1(b): manifest.policy_packs[].config.ux.run. `config` is an
// untyped `Record<string, unknown>` in the schema (each pack owns its own
// config shape), so `ux`/`run` are read defensively rather than assumed.
function packUxRunLines(manifest: Manifest): Array<{ policy: string; line: string }> {
  const out: Array<{ policy: string; line: string }> = [];
  for (const pack of manifest.policy_packs) {
    const ux = pack.config.ux;
    if (!ux || typeof ux !== "object") continue;
    const run = (ux as { run?: unknown }).run;
    if (!Array.isArray(run)) continue;
    for (const line of run) {
      if (typeof line === "string") out.push({ policy: `pack:${pack.name}`, line });
    }
  }
  return out;
}

function agentFacingRunLines(manifest: Manifest): Array<{ policy: string; line: string }> {
  const out: Array<{ policy: string; line: string }> = [];
  for (const policy of manifest.policies) {
    if (!policy.ux) continue;
    for (const line of policy.ux.run) {
      out.push({ policy: policy.name, line });
    }
  }
  out.push(...packUxRunLines(manifest));
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
  {
    // Finding 1(c): the Custom composer builds its manifest in memory. Pick
    // every composable pack and policy so every ux.run line the composer
    // can emit is scanned in one pass, not just whatever a default
    // selection would happen to include.
    name: "composeCustom(all packs + policies)",
    load: () => {
      const composed = composeCustom({
        packs: COMPOSABLE_PACKS.map((p) => p.key),
        mcps: [],
        policies: COMPOSABLE_POLICIES.map((p) => p.key),
      });
      return parseManifest(parseYaml(composed.yaml));
    },
  },
];

describe("no agent-facing ux.run line recommends the pause/resume kill switch (task 70781cf6)", () => {
  it.each(SOURCES)(
    "$name: no policy's ux.run line names pause or resume as a course of action",
    ({ name, load }) => {
      const manifest = load();
      const lines = agentFacingRunLines(manifest);
      // Finding 2: an empty scan is not a passing scan — it means the
      // guard checked nothing. Before Finding 1's fix, SOLO_TEMPLATE had
      // zero top-level `policies:` entries, so this arm scanned zero lines
      // and could never have caught anything; it is only checked (via its
      // policy_packs[].config.ux.run) starting with this fix.
      expect(
        lines.length,
        `${name}: scanned zero ux.run lines — the guard verified nothing`,
      ).toBeGreaterThan(0);
      const offenders = lines.filter(({ line }) =>
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
