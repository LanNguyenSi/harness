// 99f47307 Slice 1: runtime enforcement for `workflows:`.
//
// Intercept-level allow/deny coverage through the REAL `harness policy
// intercept` entrypoint (`runInterceptCli`, src/cli/policy/intercept.ts),
// loading a manifest from a temp-dir home override exactly the way both
// the Claude Code `settings.json` hook and the Codex `config.toml` hook
// invoke it (`runInterceptCli` calls `loadManifest` unless a manifest is
// injected; that call has no runtime branching, so the same derived
// policies apply on both runtimes, see the CHANGELOG entry for the
// pointer into docs/okf/codex-adapter-parity-gaps.md gap 8).
//
// AC1: a skipped spawn: required step (or, per the mutation probe below,
// no policy at all) does not block; a WIRED workflow with an empty ledger
// denies both the MCP merge tool and `gh pr merge`.
// AC2: a matching ledger fact (same content shape `harness record review`
// writes, src/cli/record/index.ts) allows both surfaces.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runInterceptCli } from "../../src/cli/policy/intercept.js";
import type { LedgerClient } from "../../src/runtime/intercept.js";
import type { LedgerQueryResult } from "../../src/policies/index.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function makeRepoFixture(name: string, branch: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-intercept-wf-gate-git-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, name);
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
  return repo;
}

function writeManifest(yaml: string): { homeDir: string; configPath: string } {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-intercept-wf-gate-"));
  cleanups.push(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const configPath = path.join(homeDir, "harness.yaml");
  fs.writeFileSync(configPath, yaml, "utf8");
  return { homeDir, configPath };
}

function streamFrom(s: string): NodeJS.ReadableStream {
  return Readable.from([s]);
}

function captureStream(): { stream: NodeJS.WritableStream; output: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString("utf8"));
      cb();
    },
  });
  return { stream, output: () => chunks.join("") };
}

function ledgerWith(result: LedgerQueryResult): LedgerClient {
  return {
    async query() {
      return result;
    },
    async record() {
      /* no-op */
    },
  };
}

const EMPTY_LEDGER = ledgerWith({ kind: "ok", entries: [] });

// Same content shape `harness record review --pr <n>` writes (src/cli/
// record/index.ts runRecordReview): ONE entry carries both the
// review:<pr-number> and review:<branch> tags, so a single recorded
// review satisfies both the MCP and the bash derived policy.
function reviewLedgerFor(pr: string, branch: string): LedgerClient {
  return ledgerWith({
    kind: "ok",
    entries: [
      {
        id: "1",
        content: `review:${pr} review:${branch}: looks good`,
        createdAt: "2026-08-27T12:00:00.000Z",
      },
    ],
  });
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

function workflowYaml(spawn: "required" | "skip"): string {
  return `review_templates:
  t1: "Review this PR for correctness."
workflows:
  - name: ship
    steps:
      - kind: branch
      - kind: review_subagent
        spawn: ${spawn}${spawn === "required" ? "\n        template: t1" : ""}
      - kind: merge
`;
}

const MCP_MERGE_EVENT = JSON.stringify({
  hook_event_name: "PreToolUse",
  tool_name: "mcp__agent-tasks__pull_requests_merge",
  tool_input: { prNumber: 42 },
  session_id: "sess-1",
});

function bashMergeEvent(cwd: string): string {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "gh pr merge" },
    session_id: "sess-1",
    cwd,
  });
}

describe("runInterceptCli: workflow-derived merge gate (99f47307 Slice 1, AC1/AC2)", () => {
  it("AC1 (MCP): denies pull_requests_merge with no ledger evidence, naming the missing tag", async () => {
    const { homeDir, configPath } = writeManifest(`version: 1\n${workflowYaml("required")}${WIRED_HOOKS_YAML}`);
    const { stream: out, output } = captureStream();
    const result = await runInterceptCli({
      stdin: streamFrom(MCP_MERGE_EVENT),
      stdout: out,
      homeDir,
      configPath,
      ledger: EMPTY_LEDGER,
    });
    expect(result.blocked).toBe(true);
    // The derived policy's `ux:` block replaces the raw engine reason with
    // agent-facing text (PolicyUxSchema, src/schema/policies.ts), so the
    // policy NAME is not in the rendered JSON; assert provenance via the
    // structured decision instead, and the missing tag via the ux text.
    expect(result.decisions[0]?.policyName).toBe("workflow:ship:review-before-merge");
    expect(result.decisions[0]?.ledgerTag).toBe("review:42");
    const parsed = JSON.parse(output().trim());
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("You cannot merge PR #42 yet.");
    expect(parsed.reason).toContain("a recorded review of PR #42");
  });

  it("AC1 (Bash): denies `gh pr merge` with no ledger evidence, naming the missing tag", async () => {
    const { homeDir, configPath } = writeManifest(`version: 1\n${workflowYaml("required")}${WIRED_HOOKS_YAML}`);
    const repo = makeRepoFixture("widget-service", "feat/x");
    const { stream: out, output } = captureStream();
    const result = await runInterceptCli({
      stdin: streamFrom(bashMergeEvent(repo)),
      stdout: out,
      homeDir,
      configPath,
      ledger: EMPTY_LEDGER,
    });
    expect(result.blocked).toBe(true);
    expect(result.decisions[0]?.policyName).toBe("workflow:ship:review-before-merge-bash");
    expect(result.decisions[0]?.ledgerTag).toBe("review:feat/x");
    const parsed = JSON.parse(output().trim());
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("You cannot merge the PR for branch feat/x via `gh pr merge` yet.");
    expect(parsed.reason).toContain("a recorded review of the PR for branch feat/x");
  });

  it("AC2 (MCP): allows pull_requests_merge once a matching review ledger fact exists", async () => {
    const { homeDir, configPath } = writeManifest(`version: 1\n${workflowYaml("required")}${WIRED_HOOKS_YAML}`);
    const { stream: out, output } = captureStream();
    const result = await runInterceptCli({
      stdin: streamFrom(MCP_MERGE_EVENT),
      stdout: out,
      homeDir,
      configPath,
      ledger: reviewLedgerFor("42", "feat/x"),
    });
    expect(result.blocked).toBe(false);
    expect(output()).toBe("");
  });

  it("AC2 (Bash): allows `gh pr merge` once a matching review ledger fact exists", async () => {
    const { homeDir, configPath } = writeManifest(`version: 1\n${workflowYaml("required")}${WIRED_HOOKS_YAML}`);
    const repo = makeRepoFixture("widget-service", "feat/x");
    const { stream: out, output } = captureStream();
    const result = await runInterceptCli({
      stdin: streamFrom(bashMergeEvent(repo)),
      stdout: out,
      homeDir,
      configPath,
      ledger: reviewLedgerFor("42", "feat/x"),
    });
    expect(result.blocked).toBe(false);
    expect(output()).toBe("");
  });

  it("mutation probe M1: spawn required -> skip flips the SAME deny-expecting scenario to allow", async () => {
    const { homeDir, configPath } = writeManifest(`version: 1\n${workflowYaml("skip")}${WIRED_HOOKS_YAML}`);
    const { stream: out, output } = captureStream();
    const result = await runInterceptCli({
      stdin: streamFrom(MCP_MERGE_EVENT),
      stdout: out,
      homeDir,
      configPath,
      ledger: EMPTY_LEDGER,
    });
    // No policy is derived at all for a spawn: skip workflow, so the same
    // event that AC1 (MCP) expects to deny now passes through unblocked
    // (nothing in this manifest's policies[] matches it).
    expect(result.blocked).toBe(false);
    expect(output()).toBe("");
  });
});
