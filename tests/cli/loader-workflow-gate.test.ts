// 99f47307 Slice 1: `loadManifest` appends the derived workflow merge-gate
// policies (src/runtime/workflow-policies.ts) right after parse, so every
// `loadManifest` caller (the CLI `policy intercept` entrypoint, `list`,
// `explain[-policy]`, `doctor`) sees them with no `harness apply`
// round-trip. This file proves that wiring from a real on-disk manifest,
// end to end: no explicit `policies:` block is declared anywhere in the
// fixture, only `workflows:` + `hooks:`.
//
// Intercept-level allow/deny coverage through the real `harness policy
// intercept` entrypoint (`runInterceptCli`) lives in
// tests/runtime/intercept-cli-workflow-gate.test.ts.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadManifest } from "../../src/cli/loader.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function writeManifest(yaml: string): { homeDir: string; configPath: string } {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-loader-wf-gate-"));
  cleanups.push(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const configPath = path.join(homeDir, "harness.yaml");
  fs.writeFileSync(configPath, yaml, "utf8");
  return { homeDir, configPath };
}

const WIRED_HOOKS_YAML = `hooks:
  - name: require-review-evidence
    event: PreToolUse
    match: "mcp__agent-tasks__pull_requests_merge"
    command: harness policy intercept
    blocking: hard
    budget_ms: 15000
  - name: require-review-evidence-bash
    event: PreToolUse
    match: "Bash"
    bash_match: '(^|\\n|;|\\||&|\\()\\s*(\\w+=\\S+\\s+)*gh pr merge\\b'
    command: harness policy intercept
    blocking: hard
    budget_ms: 15000
`;

const WORKFLOW_YAML = `review_templates:
  t1: "Review this PR for correctness."
workflows:
  - name: ship
    steps:
      - kind: branch
      - kind: review_subagent
        spawn: required
        template: t1
      - kind: merge
`;

describe("loadManifest: workflow gate derivation (99f47307 Slice 1)", () => {
  it("appends the derived review-before-merge pair to manifest.policies when the evidence hooks are wired", () => {
    const { homeDir, configPath } = writeManifest(
      `version: 1\n${WORKFLOW_YAML}${WIRED_HOOKS_YAML}`,
    );
    const { manifest } = loadManifest({ homeDir, configPath });
    expect(manifest.policies.map((p) => p.name).sort()).toEqual([
      "workflow:ship:review-before-merge",
      "workflow:ship:review-before-merge-bash",
    ]);
  });

  it("does NOT append derived policies when the evidence hooks are absent (fail direction: no silent allow policy)", () => {
    const { homeDir, configPath } = writeManifest(`version: 1\n${WORKFLOW_YAML}hooks: []\n`);
    const { manifest } = loadManifest({ homeDir, configPath });
    expect(manifest.policies).toEqual([]);
  });

  it("does NOT append derived policies when no workflow declares spawn: required", () => {
    const yaml = `version: 1\nreview_templates: {}\nworkflows:\n  - name: ship\n    steps:\n      - kind: branch\n      - kind: review_subagent\n        spawn: optional\n      - kind: merge\n${WIRED_HOOKS_YAML}`;
    const { homeDir, configPath } = writeManifest(yaml);
    const { manifest } = loadManifest({ homeDir, configPath });
    expect(manifest.policies).toEqual([]);
  });

  it("preserves any hand-authored policies alongside the derived ones", () => {
    const handAuthored = `policies:
  - name: hand-authored
    description: unrelated hand-authored policy
    trigger:
      event: PreToolUse
      match: "Bash"
      bash_match: '(^|\\n|;|\\||&|\\()\\s*npm publish\\b'
    requires:
      ledger_tag: "dogfood:\${SESSION_ID}"
    hook: require-dogfood-evidence
    enforcement: block
`;
    const extraHook = `  - name: require-dogfood-evidence
    event: PreToolUse
    match: "Bash"
    bash_match: '(^|\\n|;|\\||&|\\()\\s*npm publish\\b'
    command: harness policy intercept
    blocking: hard
    budget_ms: 15000
`;
    const { homeDir, configPath } = writeManifest(
      `version: 1\n${WORKFLOW_YAML}${handAuthored}${WIRED_HOOKS_YAML}${extraHook}`,
    );
    const { manifest } = loadManifest({ homeDir, configPath });
    expect(manifest.policies.map((p) => p.name).sort()).toEqual([
      "hand-authored",
      "workflow:ship:review-before-merge",
      "workflow:ship:review-before-merge-bash",
    ]);
  });
});
