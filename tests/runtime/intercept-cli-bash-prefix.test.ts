// End-to-end integration test for the Bash-prefix resolver fix.
//
// Reproduces the two screenshot scenarios from the originating task:
//   1. `DATABASE_URL=postgres://prod-host/db terraform destroy` — inline
//      env smuggled a prod signal past the resolver until this fix.
//   2. `cd <repo-on-main> && terraform destroy` — cd-target's branch
//      was invisible to the resolver until this fix.
//
// Both events MUST land on `decision:"block"` now.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runInterceptCli } from "../../src/cli/policy/intercept.js";
import type { LedgerClient } from "../../src/runtime/intercept.js";
import type {
  EnvironmentResolver,
  Manifest,
  Policy,
  RiskClassifier,
} from "../../src/schema/index.js";
import { makeManifest } from "../_helpers/manifest.js";

function streamFrom(s: string): NodeJS.ReadableStream {
  return Readable.from([s]);
}

function captureStdout(): { stream: NodeJS.WritableStream; output: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString("utf8"));
      cb();
    },
  });
  return { stream, output: () => chunks.join("") };
}

const TERRAFORM_CLASSIFIER: RiskClassifier = {
  name: "dangerous-shell",
  tool: "Bash",
  patterns: [
    {
      pattern: "terraform\\s+destroy",
      categories: ["destructive", "infrastructure_change"],
      severity: "critical",
    },
  ],
};

const PROD_RESOLVER: EnvironmentResolver = {
  name: "production-signals",
  environment: "production",
  signals: {
    branch_patterns: ["main", "release/*"],
    env_var_patterns: [{ var: "DATABASE_URL", patterns: ["prod", "production"] }],
  },
};

const GATE_PROD: Policy = {
  name: "gate-prod-destructive",
  description: "deny critical-severity destructive shell actions against production",
  trigger: { event: "PreToolUse", match: "Bash" },
  when: {
    "risk.severity_at_least": "critical",
    "environment.name": "production",
  },
  requires: { ledger_tag: "risk-override:${SESSION_ID}" },
  hook: "risk-gate",
  enforcement: "block",
} as Policy;

const manifest: Manifest = makeManifest({
  policies: [GATE_PROD],
  classifiers: [TERRAFORM_CLASSIFIER],
  resolvers: [PROD_RESOLVER],
});

const emptyLedger: LedgerClient = {
  async query() {
    return { kind: "ok", entries: [] };
  },
  async record() {
    /* no-op */
  },
};

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function makeGitRepo(branch: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-bashpfx-"));
  fs.mkdirSync(path.join(root, ".git", "refs", "heads", path.dirname(branch)), {
    recursive: true,
  });
  fs.writeFileSync(path.join(root, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
  fs.writeFileSync(
    path.join(root, ".git", "refs", "heads", branch),
    "9fceb02d0ae598e95dc970b74767f19372d61af8\n",
  );
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

describe("runInterceptCli — Bash prefix parsing for Risk Gate resolver", () => {
  it("blocks `DATABASE_URL=postgres://prod-host... terraform destroy` (inline-env smuggled prod)", async () => {
    const nonProdRepo = makeGitRepo("feature/work");
    const { stream, output } = captureStdout();
    const result = await runInterceptCli({
      stdin: streamFrom(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: {
            command: "DATABASE_URL=postgres://prod-host.example.com/main terraform destroy",
          },
          session_id: "sess-1",
          cwd: nonProdRepo,
        }),
      ),
      stdout: stream,
      manifest,
      ledger: emptyLedger,
      env: {}, // clean env: only the inline-env should expose the prod signal
    });
    expect(result.blocked).toBe(true);
    const parsed = JSON.parse(output().trim());
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("gate-prod-destructive");
  });

  it("does NOT block when DATABASE_URL is absent (regression: clean state stays allow)", async () => {
    const nonProdRepo = makeGitRepo("feature/work");
    const { stream, output } = captureStdout();
    const result = await runInterceptCli({
      stdin: streamFrom(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "terraform destroy" },
          session_id: "sess-2",
          cwd: nonProdRepo,
        }),
      ),
      stdout: stream,
      manifest,
      ledger: emptyLedger,
      env: {},
    });
    expect(result.blocked).toBe(false);
    expect(output()).toBe("");
  });

  it("blocks `cd <repo-on-main> && terraform destroy` (cd-target branch is prod)", async () => {
    const nonProdRepo = makeGitRepo("feature/work");
    const prodRepo = makeGitRepo("main");
    const { stream, output } = captureStdout();
    const result = await runInterceptCli({
      stdin: streamFrom(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: `cd ${prodRepo} && terraform destroy` },
          session_id: "sess-3",
          cwd: nonProdRepo,
        }),
      ),
      stdout: stream,
      manifest,
      ledger: emptyLedger,
      env: {},
    });
    expect(result.blocked).toBe(true);
    const parsed = JSON.parse(output().trim());
    expect(parsed.decision).toBe("block");
  });

  it("falls back to hook cwd when the cd-target is not a git repo", async () => {
    // Hook's cwd is on `main` (prod), command tries to `cd` into a
    // non-existent path. The resolver MUST keep evaluating against the
    // hook cwd — silent fallback rather than the cd-target winning.
    const prodRepo = makeGitRepo("main");
    const { stream, output } = captureStdout();
    const result = await runInterceptCli({
      stdin: streamFrom(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: {
            command: "cd /nonexistent-risk-gate-test-path && terraform destroy",
          },
          session_id: "sess-4",
          cwd: prodRepo,
        }),
      ),
      stdout: stream,
      manifest,
      ledger: emptyLedger,
      env: {},
    });
    expect(result.blocked).toBe(true);
    const parsed = JSON.parse(output().trim());
    expect(parsed.decision).toBe("block");
  });

  it("inline-env wins over process.env for the resolver view", async () => {
    // Hook's env has DATABASE_URL pointing at staging; inline-env points
    // at prod. POSIX semantics: inline-env overrides; the gate fires.
    const nonProdRepo = makeGitRepo("feature/work");
    const { stream, output } = captureStdout();
    const result = await runInterceptCli({
      stdin: streamFrom(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: {
            command: "DATABASE_URL=postgres://prod/x terraform destroy",
          },
          session_id: "sess-5",
          cwd: nonProdRepo,
        }),
      ),
      stdout: stream,
      manifest,
      ledger: emptyLedger,
      env: { DATABASE_URL: "postgres://staging/x" },
    });
    expect(result.blocked).toBe(true);
    expect(JSON.parse(output().trim()).decision).toBe("block");
  });
});
