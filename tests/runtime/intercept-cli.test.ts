import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { realLedgerClient, runInterceptCli } from "../../src/cli/policy/intercept.js";
import { FULL_TEMPLATE } from "../../src/cli/init/templates.js";
import type { LedgerClient } from "../../src/runtime/intercept.js";
import {
  parseManifest,
  type EnvironmentResolver,
  type McpServer,
  type Policy,
  type RiskClassifier,
} from "../../src/schema/index.js";
import { makeDecision } from "../_helpers/decision.js";
import { makeManifest } from "../_helpers/manifest.js";

// Read the real `bash_match` straight out of FULL_TEMPLATE instead of a
// hand-copied literal (F7 fix, review round 2026-07-27, run
// 2026-07-27-gate-target-repo-resolution): a literal here would keep
// passing against the OLD pattern after a future edit (open task
// `dbc6d303` tightens this exact regex), silently certifying stale
// behaviour. Mirrors the precedent in
// tests/cli/init-full-template-kill-switch-deny.test.ts's
// `policyBashMatch` helper.
function policyBashMatch(name: string): string {
  const parsed = parseManifest(parseYaml(FULL_TEMPLATE));
  const policy = parsed.policies.find((p) => p.name === name);
  if (!policy) throw new Error(`policy ${name} missing from FULL_TEMPLATE`);
  const pattern = policy.trigger.bash_match;
  if (!pattern) throw new Error(`policy ${name} declares no trigger.bash_match`);
  return pattern;
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

const captureStdout = captureStream;

const REVIEW_POLICY: Policy = {
  name: "review-before-merge",
  description: "block merges without review evidence",
  trigger: {
    event: "PreToolUse",
    match: "mcp__agent-tasks__pull_requests_merge",
    extract: { PR_NUMBER: "toolArgs.prNumber" },
  },
  requires: { ledger_tag: "review:${PR_NUMBER}" },
  hook: "h",
  enforcement: "block",
} as Policy;

const fakeManifest = (policies: Policy[]) => makeManifest({ policies });

describe("runInterceptCli", () => {
  it("writes deny JSON when a matching policy denies", async () => {
    const ledger: LedgerClient = {
      async query() {
        return { kind: "ok", entries: [] };
      },
      async record() {
        /* no-op */
      },
    };
    const { stream, output } = captureStdout();
    const result = await runInterceptCli({
      stdin: streamFrom(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "mcp__agent-tasks__pull_requests_merge",
          tool_input: { prNumber: 42 },
          session_id: "sess-1",
        }),
      ),
      stdout: stream,
      manifest: fakeManifest([REVIEW_POLICY]),
      ledger,
    });
    expect(result.blocked).toBe(true);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(output().trim());
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("review-before-merge");
    expect(parsed.hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: parsed.reason,
    });
  });

  it("stays silent on allow", async () => {
    const ledger: LedgerClient = {
      async query() {
        return {
          kind: "ok",
          entries: [
            {
              id: "1",
              content: "review:42:approved",
              createdAt: "2026-04-30T12:00:00.000Z",
            },
          ],
        };
      },
      async record() {
        /* no-op */
      },
    };
    const { stream, output } = captureStdout();
    const result = await runInterceptCli({
      stdin: streamFrom(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "mcp__agent-tasks__pull_requests_merge",
          tool_input: { prNumber: 42 },
          session_id: "sess-1",
        }),
      ),
      stdout: stream,
      manifest: fakeManifest([REVIEW_POLICY]),
      ledger,
    });
    expect(result.blocked).toBe(false);
    expect(output()).toBe("");
  });

  it("does not block when stdin is empty / non-JSON", async () => {
    const { stream, output } = captureStdout();
    const { stream: err } = captureStream();
    const result = await runInterceptCli({
      stdin: streamFrom(""),
      stdout: stream,
      stderr: err,
      manifest: fakeManifest([REVIEW_POLICY]),
    });
    expect(result.blocked).toBe(false);
    expect(output()).toBe("");
  });

  it("emits a stderr no-match hint when hook_event_name is missing", async () => {
    const { stream: out, output: outOutput } = captureStream();
    const { stream: err, output: errOutput } = captureStream();
    const result = await runInterceptCli({
      stdin: streamFrom(
        JSON.stringify({
          session_id: "sess-1",
          tool_name: "mcp__agent-tasks__pull_requests_merge",
          tool_input: { prNumber: 42 },
        }),
      ),
      stdout: out,
      stderr: err,
      manifest: fakeManifest([REVIEW_POLICY]),
    });
    expect(result.blocked).toBe(false);
    expect(result.decisions).toHaveLength(0);
    expect(outOutput()).toBe("");
    const errText = errOutput();
    expect(errText).toContain("harness policy intercept: no policy matched event");
    expect(errText).toContain("hook_event_name=(missing)");
    expect(errText).toContain('tool_name="mcp__agent-tasks__pull_requests_merge"');
    expect(errText).toContain("registered policy events: PreToolUse");
  });

  it("emits a stderr no-match hint when hook_event_name does not match any policy", async () => {
    const { stream: err, output: errOutput } = captureStream();
    const { stream: out } = captureStream();
    await runInterceptCli({
      stdin: streamFrom(
        JSON.stringify({
          session_id: "sess-1",
          hook_event_name: "Stop",
          tool_name: "anything",
        }),
      ),
      stdout: out,
      stderr: err,
      manifest: fakeManifest([REVIEW_POLICY]),
    });
    const errText = errOutput();
    expect(errText).toContain('hook_event_name="Stop"');
    expect(errText).toContain("registered policy events: PreToolUse");
  });

  it("does NOT emit a no-match hint when at least one policy matched", async () => {
    const ledger: LedgerClient = {
      async query() {
        return { kind: "ok", entries: [] };
      },
      async record() {
        /* no-op */
      },
    };
    const { stream: err, output: errOutput } = captureStream();
    const { stream: out } = captureStream();
    await runInterceptCli({
      stdin: streamFrom(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "mcp__agent-tasks__pull_requests_merge",
          tool_input: { prNumber: 42 },
          session_id: "sess-1",
        }),
      ),
      stdout: out,
      stderr: err,
      manifest: fakeManifest([REVIEW_POLICY]),
      ledger,
    });
    expect(errOutput()).not.toContain("no policy matched event");
  });

  it("does NOT emit a no-match hint when the manifest has zero policies", async () => {
    const { stream: err, output: errOutput } = captureStream();
    const { stream: out } = captureStream();
    await runInterceptCli({
      stdin: streamFrom(
        JSON.stringify({
          session_id: "sess-1",
          tool_name: "mcp__agent-tasks__pull_requests_merge",
        }),
      ),
      stdout: out,
      stderr: err,
      manifest: fakeManifest([]),
    });
    expect(errOutput()).toBe("");
  });
});

describe("runInterceptCli — Phase 5 #3: --verbose stderr diagnostics", () => {
  let savedEnv: string | undefined;
  beforeEach(() => {
    savedEnv = process.env.HARNESS_POLICY_VERBOSE;
    delete process.env.HARNESS_POLICY_VERBOSE;
  });
  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.HARNESS_POLICY_VERBOSE;
    } else {
      process.env.HARNESS_POLICY_VERBOSE = savedEnv;
    }
  });

  const denyEvent = JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "mcp__agent-tasks__pull_requests_merge",
    tool_input: { prNumber: 42 },
    session_id: "sess-1",
  });
  const denyLedger: LedgerClient = {
    async query() {
      return { kind: "ok", entries: [] };
    },
    async record() {
      /* no-op */
    },
  };
  const allowLedger: LedgerClient = {
    async query() {
      return {
        kind: "ok",
        entries: [
          { id: "1", content: "review:42:approved", createdAt: "2026-04-30T12:00:00.000Z" },
        ],
      };
    },
    async record() {
      /* no-op */
    },
  };
  const degradedLedger: LedgerClient = {
    async query() {
      return { kind: "degraded", reason: "grounding-mcp timeout after 5000ms" };
    },
    async record() {
      /* no-op */
    },
  };

  it("default (verbose off): stderr is empty even on deny", async () => {
    const { stream: out } = captureStream();
    const { stream: err, output: errOutput } = captureStream();
    await runInterceptCli({
      stdin: streamFrom(denyEvent),
      stdout: out,
      stderr: err,
      manifest: fakeManifest([REVIEW_POLICY]),
      ledger: denyLedger,
    });
    expect(errOutput()).toBe("");
  });

  it("--verbose on deny: stdout carries deny JSON, stderr carries diagnostic block", async () => {
    const { stream: out, output: outOutput } = captureStream();
    const { stream: err, output: errOutput } = captureStream();
    await runInterceptCli({
      stdin: streamFrom(denyEvent),
      stdout: out,
      stderr: err,
      manifest: fakeManifest([REVIEW_POLICY]),
      ledger: denyLedger,
      verbose: true,
    });
    const stdoutLine = outOutput().trim();
    const parsedDeny = JSON.parse(stdoutLine);
    expect(parsedDeny.decision).toBe("block");
    expect(parsedDeny.hookSpecificOutput?.permissionDecision).toBe("deny");
    const errText = errOutput();
    expect(errText).toContain("harness policy intercept: review-before-merge: deny");
    expect(errText).toContain("ledger_tag: review:42");
    expect(errText).toContain("matched: 0");
    expect(errText).toContain("reason: no matching ledger entry for tag `review:42`");
    expect(errText).toContain("PR_NUMBER=42");
  });

  it("--verbose on allow: stderr stays empty", async () => {
    const { stream: out } = captureStream();
    const { stream: err, output: errOutput } = captureStream();
    await runInterceptCli({
      stdin: streamFrom(denyEvent),
      stdout: out,
      stderr: err,
      manifest: fakeManifest([REVIEW_POLICY]),
      ledger: allowLedger,
      verbose: true,
    });
    expect(errOutput()).toBe("");
  });

  it("--verbose on warn-degraded: stderr names the ledger reason", async () => {
    const { stream: out, output: outOutput } = captureStream();
    const { stream: err, output: errOutput } = captureStream();
    await runInterceptCli({
      stdin: streamFrom(denyEvent),
      stdout: out,
      stderr: err,
      manifest: fakeManifest([REVIEW_POLICY]),
      ledger: degradedLedger,
      verbose: true,
    });
    expect(outOutput()).toBe("");
    const errText = errOutput();
    expect(errText).toContain("warn-degraded (ledger unreachable)");
    expect(errText).toContain("grounding-mcp timeout after 5000ms");
  });

  it("HARNESS_POLICY_VERBOSE=1 enables verbose without the flag", async () => {
    process.env.HARNESS_POLICY_VERBOSE = "1";
    const { stream: out } = captureStream();
    const { stream: err, output: errOutput } = captureStream();
    await runInterceptCli({
      stdin: streamFrom(denyEvent),
      stdout: out,
      stderr: err,
      manifest: fakeManifest([REVIEW_POLICY]),
      ledger: denyLedger,
    });
    expect(errOutput()).toContain("harness policy intercept: review-before-merge: deny");
  });

  it("HARNESS_POLICY_VERBOSE=0 stays silent (env disable)", async () => {
    process.env.HARNESS_POLICY_VERBOSE = "0";
    const { stream: out } = captureStream();
    const { stream: err, output: errOutput } = captureStream();
    await runInterceptCli({
      stdin: streamFrom(denyEvent),
      stdout: out,
      stderr: err,
      manifest: fakeManifest([REVIEW_POLICY]),
      ledger: denyLedger,
    });
    expect(errOutput()).toBe("");
  });

  it.each(["false", "FALSE", "no", "NO", "off", "Off", "0"])(
    "HARNESS_POLICY_VERBOSE=%s stays silent (env disable variants)",
    async (envValue) => {
      process.env.HARNESS_POLICY_VERBOSE = envValue;
      const { stream: out } = captureStream();
      const { stream: err, output: errOutput } = captureStream();
      await runInterceptCli({
        stdin: streamFrom(denyEvent),
        stdout: out,
        stderr: err,
        manifest: fakeManifest([REVIEW_POLICY]),
        ledger: denyLedger,
      });
      expect(errOutput()).toBe("");
    },
  );

  it("explicit verbose=false beats HARNESS_POLICY_VERBOSE=1", async () => {
    process.env.HARNESS_POLICY_VERBOSE = "1";
    const { stream: out } = captureStream();
    const { stream: err, output: errOutput } = captureStream();
    await runInterceptCli({
      stdin: streamFrom(denyEvent),
      stdout: out,
      stderr: err,
      manifest: fakeManifest([REVIEW_POLICY]),
      ledger: denyLedger,
      verbose: false,
    });
    expect(errOutput()).toBe("");
  });
});

describe("realLedgerClient — audit-write failure is surfaced, not swallowed", () => {
  // recordPolicyDecision reports failure via a `{ ok: false, reason }`
  // return value rather than throwing. The adapter previously discarded
  // it, so a persistently-failing recorder left `harness audit` /
  // `explain --trace` blind with zero signal. The adapter now writes a
  // one-line stderr diagnostic; stdout stays untouched.
  const badServer = {
    name: "grounding-mcp",
    command: ["/nonexistent-harness-test-binary-xyz"],
    enabled: true,
  } as unknown as McpServer;

  it("writes a stderr diagnostic when recordPolicyDecision returns !ok", async () => {
    const { stream: err, output: errOutput } = captureStream();
    const client = realLedgerClient(badServer, {
      stderr: err,
      ledgerTimeoutMs: 2000,
    });
    await client.record(
      makeDecision({ policyName: "preflight-before-investigation" }),
      "sess-err",
    );
    const text = errOutput();
    expect(text).toContain(
      "harness policy intercept: audit-write failed for preflight-before-investigation",
    );
    // A reason string is always appended — never a bare, contextless line.
    expect(text.trim().length).toBeGreaterThan(
      "harness policy intercept: audit-write failed for preflight-before-investigation:"
        .length,
    );
  });
});

describe("runInterceptCli — REPO / BRANCH builtins resolve from event.cwd", () => {
  let cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups) c();
    cleanups = [];
  });

  // A `block` policy whose tag references both per-repo builtins, so
  // the recorded decision's extractValues expose what the engine
  // resolved.
  const PREFLIGHT_POLICY: Policy = {
    name: "preflight-before-investigation",
    description: "gate git reads on a per-repo preflight tag",
    trigger: { event: "PreToolUse", match: "Bash" },
    requires: { ledger_tag: "preflight:${REPO}" },
    hook: "h",
    enforcement: "block",
  } as Policy;

  const PREFLIGHT_PUSH_POLICY: Policy = {
    name: "preflight-before-push",
    description: "gate pushes on a per-branch preflight tag",
    trigger: { event: "PreToolUse", match: "Bash", bash_match: "git\\s+push" },
    requires: { ledger_tag: "preflight:${BRANCH}" },
    hook: "h",
    enforcement: "block",
    ux: {
      cannot: "You cannot push branch ${BRANCH} yet.",
      required: ["a preflight for ${BRANCH} at the current HEAD"],
      run: ["harness preflight"],
    },
  } as Policy;

  const emptyLedger: LedgerClient = {
    async query() {
      return { kind: "ok", entries: [] };
    },
    async record() {
      /* no-op */
    },
  };

  function makeRepoFixture(name: string, branch: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-intercept-git-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = path.join(root, name);
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
    return repo;
  }

  async function decisionFor(cwd: string): Promise<Record<string, string>> {
    const { stream: out } = captureStream();
    const { stream: err } = captureStream();
    const result = await runInterceptCli({
      stdin: streamFrom(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "git status" },
          session_id: "sess-1",
          cwd,
        }),
      ),
      stdout: out,
      stderr: err,
      manifest: fakeManifest([PREFLIGHT_POLICY]),
      ledger: emptyLedger,
    });
    expect(result.decisions).toHaveLength(1);
    return result.decisions[0]!.extractValues;
  }

  it("derives REPO (work-tree basename) and BRANCH from the event cwd", async () => {
    const repo = makeRepoFixture("widget-service", "release/2.0");
    const extract = await decisionFor(repo);
    expect(extract.REPO).toBe("widget-service");
    expect(extract.BRANCH).toBe("release/2.0");
  });

  it("substitutes the resolved REPO into the policy's ledger_tag", async () => {
    const repo = makeRepoFixture("widget-service", "main");
    const { stream: out } = captureStream();
    const result = await runInterceptCli({
      stdin: streamFrom(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "git status" },
          session_id: "sess-1",
          cwd: repo,
        }),
      ),
      stdout: out,
      manifest: fakeManifest([PREFLIGHT_POLICY]),
      ledger: emptyLedger,
    });
    // No ledger entry → deny, and the reason names the *resolved* tag,
    // not the literal `preflight:` placeholder.
    expect(result.decisions[0]!.ledgerTag).toBe("preflight:widget-service");
  });

  it("leaves REPO / BRANCH empty when the cwd is not in a git work tree", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-intercept-nogit-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const extract = await decisionFor(root);
    expect(extract.REPO).toBe("");
    expect(extract.BRANCH).toBe("");
  });

  it("HARNESS_REPO / HARNESS_BRANCH env vars override the derived values", async () => {
    const savedRepo = process.env.HARNESS_REPO;
    const savedBranch = process.env.HARNESS_BRANCH;
    process.env.HARNESS_REPO = "override-repo";
    process.env.HARNESS_BRANCH = "override-branch";
    try {
      const repo = makeRepoFixture("derived-repo", "derived-branch");
      const extract = await decisionFor(repo);
      expect(extract.REPO).toBe("override-repo");
      expect(extract.BRANCH).toBe("override-branch");
    } finally {
      if (savedRepo === undefined) delete process.env.HARNESS_REPO;
      else process.env.HARNESS_REPO = savedRepo;
      if (savedBranch === undefined) delete process.env.HARNESS_BRANCH;
      else process.env.HARNESS_BRANCH = savedBranch;
    }
  });

  it("uses Codex exec_command raw_input.workdir when event.cwd is absent", async () => {
    const repo = makeRepoFixture("codex-repo", "feat/codex-workdir");
    const { stream: out } = captureStream();
    const result = await runInterceptCli({
      stdin: streamFrom(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "exec_command",
          raw_input: {
            cmd: "git push origin feat/codex-workdir",
            workdir: repo,
          },
          session_id: "sess-1",
        }),
      ),
      stdout: out,
      manifest: fakeManifest([PREFLIGHT_PUSH_POLICY]),
      ledger: emptyLedger,
    });

    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]!.extractValues.CWD).toBe(repo);
    expect(result.decisions[0]!.extractValues.REPO).toBe("codex-repo");
    expect(result.decisions[0]!.extractValues.BRANCH).toBe("feat/codex-workdir");
    expect(result.decisions[0]!.ledgerTag).toBe("preflight:feat/codex-workdir");
    expect(result.blocked).toBe(true);
  });

  it("uses Codex functions.exec_command tool_input.workdir when event.cwd is absent", async () => {
    const repo = makeRepoFixture("codex-functions", "fix/push-gate");
    const { stream: out } = captureStream();
    const result = await runInterceptCli({
      stdin: streamFrom(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "functions.exec_command",
          tool_input: {
            cmd: "git push origin fix/push-gate",
            workdir: repo,
          },
          session_id: "sess-1",
        }),
      ),
      stdout: out,
      manifest: fakeManifest([PREFLIGHT_PUSH_POLICY]),
      ledger: emptyLedger,
    });

    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]!.extractValues.CWD).toBe(repo);
    expect(result.decisions[0]!.extractValues.REPO).toBe("codex-functions");
    expect(result.decisions[0]!.extractValues.BRANCH).toBe("fix/push-gate");
    expect(result.decisions[0]!.ledgerTag).toBe("preflight:fix/push-gate");
    expect(result.blocked).toBe(true);
  });

  it("uses Codex shell raw_input.workdir when event.cwd is absent", async () => {
    const repo = makeRepoFixture("codex-shell", "fix/shell-workdir");
    const { stream: out } = captureStream();
    const result = await runInterceptCli({
      stdin: streamFrom(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "shell",
          raw_input: {
            cmd: "git push origin fix/shell-workdir",
            workdir: repo,
          },
          session_id: "sess-1",
        }),
      ),
      stdout: out,
      manifest: fakeManifest([PREFLIGHT_PUSH_POLICY]),
      ledger: emptyLedger,
    });

    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]!.extractValues.CWD).toBe(repo);
    expect(result.decisions[0]!.extractValues.REPO).toBe("codex-shell");
    expect(result.decisions[0]!.extractValues.BRANCH).toBe("fix/shell-workdir");
    expect(result.decisions[0]!.ledgerTag).toBe("preflight:fix/shell-workdir");
    expect(result.blocked).toBe(true);
  });

  it("uses Bash raw_input.workdir when a Codex adapter reports the shell alias as Bash", async () => {
    const repo = makeRepoFixture("codex-bash", "fix/bash-workdir");
    const { stream: out } = captureStream();
    const result = await runInterceptCli({
      stdin: streamFrom(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          raw_input: {
            cmd: "git push origin fix/bash-workdir",
            workdir: repo,
          },
          session_id: "sess-1",
        }),
      ),
      stdout: out,
      manifest: fakeManifest([PREFLIGHT_PUSH_POLICY]),
      ledger: emptyLedger,
    });

    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]!.extractValues.CWD).toBe(repo);
    expect(result.decisions[0]!.extractValues.REPO).toBe("codex-bash");
    expect(result.decisions[0]!.extractValues.BRANCH).toBe("fix/bash-workdir");
    expect(result.decisions[0]!.ledgerTag).toBe("preflight:fix/bash-workdir");
    expect(result.blocked).toBe(true);
  });

  it("falls back to Codex sandbox command cwd when the event omits cwd/workdir", async () => {
    const repo = makeRepoFixture("codex-proc-cwd", "fix/proc-cwd");
    const { stream: out } = captureStream();
    const result = await runInterceptCli({
      stdin: streamFrom(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "git push origin fix/proc-cwd" },
          session_id: "sess-1",
        }),
      ),
      stdout: out,
      manifest: fakeManifest([PREFLIGHT_PUSH_POLICY]),
      ledger: emptyLedger,
      codexCommandCwd: repo,
    });

    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]!.extractValues.CWD).toBe(repo);
    expect(result.decisions[0]!.extractValues.REPO).toBe("codex-proc-cwd");
    expect(result.decisions[0]!.extractValues.BRANCH).toBe("fix/proc-cwd");
    expect(result.decisions[0]!.ledgerTag).toBe("preflight:fix/proc-cwd");
  });

  it("keeps top-level event.cwd ahead of Codex per-call workdir", async () => {
    const sessionRepo = makeRepoFixture("session-repo", "main");
    const perCallRepo = makeRepoFixture("per-call-repo", "feat/ignored");
    const { stream: out } = captureStream();
    const result = await runInterceptCli({
      stdin: streamFrom(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "exec_command",
          raw_input: {
            cmd: "git push origin feat/ignored",
            workdir: perCallRepo,
          },
          session_id: "sess-1",
          cwd: sessionRepo,
        }),
      ),
      stdout: out,
      manifest: fakeManifest([PREFLIGHT_PUSH_POLICY]),
      ledger: emptyLedger,
    });

    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]!.extractValues.CWD).toBe(sessionRepo);
    expect(result.decisions[0]!.extractValues.REPO).toBe("session-repo");
    expect(result.decisions[0]!.extractValues.BRANCH).toBe("main");
    expect(result.decisions[0]!.ledgerTag).toBe("preflight:main");
  });

  // T-003 (run 2026-07-27-gate-target-repo-resolution): when a Bash
  // command explicitly names a target directory that resolves to a
  // real git work tree, ${REPO}/${BRANCH} must name THAT repository,
  // not the hook cwd's — this is the fix for the reproduced cross-repo
  // gap in 01-plan.md ("a preflight for `harness` authorised an
  // investigation of `agent-grounding`").
  describe("target-directory resolution overrides ${REPO} / ${BRANCH} (T-003)", () => {
    function ledgerWithFact(content: string): LedgerClient {
      return {
        async query() {
          return {
            kind: "ok",
            entries: [{ id: "fact-1", content, createdAt: new Date().toISOString() }],
          };
        },
        async record() {
          /* no-op */
        },
      };
    }

    async function runBashCommand(
      command: string,
      cwd: string,
      ledger: LedgerClient = emptyLedger,
    ) {
      const { stream: out } = captureStream();
      const { stream: err } = captureStream();
      const result = await runInterceptCli({
        stdin: streamFrom(
          JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command },
            session_id: "sess-1",
            cwd,
          }),
        ),
        stdout: out,
        stderr: err,
        manifest: fakeManifest([PREFLIGHT_POLICY]),
        ledger,
      });
      expect(result.decisions).toHaveLength(1);
      return result;
    }

    const SPELLINGS: Array<[string, (b: string) => string]> = [
      ["git -C <B> status", (b) => `git -C ${b} status`],
      ["env -C <B> git status", (b) => `env -C ${b} git status`],
      [
        "git --work-tree=<B> --git-dir=<B>/.git status",
        (b) => `git --work-tree=${b} --git-dir=${b}/.git status`,
      ],
      ["cd <B> && git status", (b) => `cd ${b} && git status`],
    ];

    it.each(SPELLINGS)(
      "%s resolves REPO/BRANCH to the named target, not cwd's repo",
      async (_label, buildCommand) => {
        const repoA = makeRepoFixture("target-a", "main");
        const repoB = makeRepoFixture("target-b", "feature/target");
        const result = await runBashCommand(buildCommand(repoB), repoA);
        expect(result.decisions[0]!.extractValues.REPO).toBe("target-b");
        expect(result.decisions[0]!.extractValues.BRANCH).toBe("feature/target");
      },
    );

    it("keeps ${CWD} as the hook cwd even when REPO/BRANCH come from a target dir", async () => {
      const repoA = makeRepoFixture("cwd-a", "main");
      const repoB = makeRepoFixture("cwd-b", "main");
      const result = await runBashCommand(`git -C ${repoB} status`, repoA);
      expect(result.decisions[0]!.extractValues.CWD).toBe(repoA);
      expect(result.decisions[0]!.extractValues.REPO).toBe("cwd-b");
    });

    it("REGRESSION: a preflight fact for repo A does not satisfy the gate for a command targeting repo B", async () => {
      const repoA = makeRepoFixture("cross-repo-a", "main");
      const repoB = makeRepoFixture("cross-repo-b", "main");
      const factForA = ledgerWithFact("preflight:cross-repo-a");

      // The empirical finding from 01-plan.md, turned into a regression
      // test: a fact recorded for A must not authorise a command that
      // explicitly targets B.
      const crossRepo = await runBashCommand(`git -C ${repoB} status`, repoA, factForA);
      expect(crossRepo.decisions[0]!.outcome).toBe("deny");
      expect(crossRepo.blocked).toBe(true);

      // The SAME fact DOES satisfy the gate for a command targeting A.
      const sameRepo = await runBashCommand(`git -C ${repoA} status`, repoA, factForA);
      expect(sameRepo.decisions[0]!.outcome).toBe("allow");
      expect(sameRepo.blocked).toBe(false);
    });

    it("falls back to the cwd-derived REPO/BRANCH when the target dir does not exist", async () => {
      const repoA = makeRepoFixture("fallback-nonexistent", "main");
      const bogus = path.join(path.dirname(repoA), "does-not-exist-xyz-12345");
      const result = await runBashCommand(`git -C ${bogus} status`, repoA);
      expect(result.decisions[0]!.extractValues.REPO).toBe("fallback-nonexistent");
      expect(result.decisions[0]!.extractValues.BRANCH).toBe("main");
    });

    it("falls back to the cwd-derived REPO/BRANCH when the target dir exists but is not a git repository", async () => {
      const repoA = makeRepoFixture("fallback-non-repo", "main");
      const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-intercept-plain-"));
      cleanups.push(() => fs.rmSync(plainDir, { recursive: true, force: true }));
      const result = await runBashCommand(`git -C ${plainDir} status`, repoA);
      expect(result.decisions[0]!.extractValues.REPO).toBe("fallback-non-repo");
      expect(result.decisions[0]!.extractValues.BRANCH).toBe("main");
    });

    it("falls back to the cwd-derived REPO/BRANCH when the command's target dir is unparseable", async () => {
      // An escaped-space path is one of command-normalize.ts's documented
      // blind spots: its tokeniser is not quote/escape-aware, so `-C`'s
      // argument is truncated at the literal space, yielding a garbled
      // ABSOLUTE targetDir ("/tmp/some\") that cannot exist on disk.
      // Absolute (not resolved against cwd) so this genuinely exercises
      // the "does not resolve to a work tree" guard rather than
      // coincidentally walking back up into repoA's own `.git`.
      const repoA = makeRepoFixture("fallback-unparseable", "main");
      const result = await runBashCommand(
        "git -C /tmp/harness-t003-unparseable\\ dir status",
        repoA,
      );
      expect(result.decisions[0]!.extractValues.REPO).toBe("fallback-unparseable");
      expect(result.decisions[0]!.extractValues.BRANCH).toBe("main");
    });

    // F2 fix (review round 2026-07-27): a command with MORE THAN ONE git
    // invocation must not resolve ${REPO}/${BRANCH} from just the FIRST
    // one when a LATER invocation runs bare (no explicit target of its
    // own) — that invocation actually runs against cwd, not the first
    // invocation's target. Measured regression: `git -C <agent-grounding>
    // log && git push` resolved REPO=agent-grounding for the PUSH too,
    // so `preflight-before-push`'s `preflight:${BRANCH}` tag was
    // satisfied by a preflight for an unrelated repo (a bare branch name
    // has no repo qualifier).
    it("F2: a bare invocation after an explicitly-targeted one keeps the cwd-derived REPO/BRANCH (ambiguous, not 'first wins')", async () => {
      const repoA = makeRepoFixture("f2-repo-a", "main");
      const repoB = makeRepoFixture("f2-repo-b", "feature/other");
      const result = await runBashCommand(`git -C ${repoB} log && git push`, repoA);
      expect(result.decisions[0]!.extractValues.REPO).toBe("f2-repo-a");
      expect(result.decisions[0]!.extractValues.BRANCH).toBe("main");
    });

    // F5 fix (review round 2026-07-27): a RELATIVE git-level target
    // resolves against the preceding `cd` / `env -C` context this module
    // saw, instead of always against the caller's own cwd.
    it("F5: cd <B> && git -C src status resolves against B, not the caller's cwd", async () => {
      const repoA = makeRepoFixture("f5-cd-a", "main");
      const repoB = makeRepoFixture("f5-cd-b", "feature/target");
      // `src` is never created on disk: `findGitEntry` walks UP from a
      // missing directory just as readily as from an existing one, and
      // that upward walk landing on repoB's OWN `.git` is exactly the
      // desired resolution (real `git -C <B>/src status` behaves the
      // same way).
      const result = await runBashCommand(`cd ${repoB} && git -C src status`, repoA);
      expect(result.decisions[0]!.extractValues.REPO).toBe("f5-cd-b");
      expect(result.decisions[0]!.extractValues.BRANCH).toBe("feature/target");
    });

    it("F5: env -C <B> git -C src status resolves against B, not the caller's cwd", async () => {
      const repoA = makeRepoFixture("f5-env-a", "main");
      const repoB = makeRepoFixture("f5-env-b", "feature/target");
      const result = await runBashCommand(`env -C ${repoB} git -C src status`, repoA);
      expect(result.decisions[0]!.extractValues.REPO).toBe("f5-env-b");
      expect(result.decisions[0]!.extractValues.BRANCH).toBe("feature/target");
    });

    it("F5: a ~-prefixed target is treated as unparseable, falling back to the cwd-derived REPO/BRANCH (no tilde expansion, no accidental upward walk)", async () => {
      const repoA = makeRepoFixture("f5-tilde-a", "main");
      const result = await runBashCommand(
        "git -C ~/git/pandora/agent-grounding status",
        repoA,
      );
      expect(result.decisions[0]!.extractValues.REPO).toBe("f5-tilde-a");
      expect(result.decisions[0]!.extractValues.BRANCH).toBe("main");
    });
  });
});

// F1 fix (CRITICAL, review round 2026-07-27): the Risk Gate's git context
// (feeding `environments.resolvers[].signals.branch_patterns`) must
// resolve from the hook's own cwd, NEVER from a command's TARGET repo
// (the `git -C` / `env -C` / `--work-tree` awareness that T-003 added for
// ${REPO}/${BRANCH}). Before this fix, `resolverGit` fell back to the
// SAME target-aware `gitContext` used for ${REPO}/${BRANCH}, so a
// `production` + `branch_patterns: [main]` resolver classified the
// environment from the COMMAND's target repo's branch instead of the cwd
// repo's — a command like `git -C <repo-on-feature/x> log && rm -rf
// /data` silently skipped the resolver (and every `when:`-gated policy
// keyed on it) because the resolver read feature/x's branch, not the cwd
// repo's `main`.
describe("runInterceptCli — Risk Gate git context stays cwd-derived even when a target-naming git invocation precedes the gated command (F1 regression, review round 2026-07-27)", () => {
  let cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups) c();
    cleanups = [];
  });

  function makeRepoFixture(name: string, branch: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-f1-git-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = path.join(root, name);
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
    return repo;
  }

  // Fires `production` off the CWD repo's branch, per
  // `environments.resolvers[].signals.branch_patterns` — the exact
  // resolver kind the finding measured.
  const PROD_BRANCH_RESOLVER: EnvironmentResolver = {
    name: "prod-branch",
    environment: "production",
    signals: { branch_patterns: ["main"] },
  };

  const RISK_POLICY: Policy = {
    name: "gate-prod-destructive",
    description: "block destructive actions classified as production",
    trigger: { event: "PreToolUse", match: "Bash" },
    when: { "environment.name": "production" },
    requires: { ledger_tag: "risk-approved:${SESSION_ID}" },
    hook: "h",
    enforcement: "block",
  } as Policy;

  const emptyLedger: LedgerClient = {
    async query() {
      return { kind: "ok", entries: [] };
    },
    async record() {
      /* no-op */
    },
  };

  async function runFor(command: string, cwd: string) {
    const { stream: out } = captureStream();
    const { stream: err } = captureStream();
    return runInterceptCli({
      stdin: streamFrom(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command },
          session_id: "sess-f1",
          cwd,
        }),
      ),
      stdout: out,
      stderr: err,
      manifest: makeManifest({ policies: [RISK_POLICY], resolvers: [PROD_BRANCH_RESOLVER] }),
      ledger: emptyLedger,
    });
  }

  it("fires for a bare command with cwd on the resolver's branch (baseline)", async () => {
    const repoA = makeRepoFixture("f1-repo-a", "main");
    const result = await runFor("echo hi", repoA);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.environment?.name).toBe("production");
    expect(result.blocked).toBe(true);
  });

  it("STILL fires when a target-naming git invocation on a DIFFERENT branch precedes the gated command (the regression)", async () => {
    const repoA = makeRepoFixture("f1-repo-a-2", "main");
    const repoB = makeRepoFixture("f1-repo-b-2", "feature/x");
    // Pre-fix, this resolved the Risk Gate's git context from repoB
    // (feature/x), so `branch_patterns: [main]` never matched and the
    // policy silently produced ZERO decisions — the exact silent-bypass
    // shape this whole run exists to close, reintroduced on the risk axis.
    const result = await runFor(`git -C ${repoB} log && echo hi`, repoA);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.environment?.name).toBe("production");
    expect(result.blocked).toBe(true);
  });
});

describe("runInterceptCli — Phase 7 #5: when: evaluation wiring", () => {
  const DESTROY_CLASSIFIER: RiskClassifier = {
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

  // Resolves `production` from a DATABASE_URL env-var signal — exercised
  // through the `env` seam so the test never touches the real process env.
  const PROD_RESOLVER: EnvironmentResolver = {
    name: "production-signals",
    environment: "production",
    signals: { env_var_patterns: [{ var: "DATABASE_URL", patterns: ["prod"] }] },
  };

  const RISK_POLICY: Policy = {
    name: "gate-prod-destructive",
    description: "require approval for destructive production actions",
    trigger: { event: "PreToolUse", match: "Bash" },
    when: { "environment.name": "production" },
    requires: { ledger_tag: "risk-approved:${SESSION_ID}" },
    hook: "h",
    enforcement: "require_approval",
  } as Policy;

  const riskManifest = () =>
    makeManifest({
      policies: [RISK_POLICY],
      classifiers: [DESTROY_CLASSIFIER],
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

  const destroyEvent = JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "terraform destroy" },
    session_id: "sess-1",
  });

  it("fires a when: policy when the resolved environment matches (env seam)", async () => {
    const { stream } = captureStdout();
    const result = await runInterceptCli({
      stdin: streamFrom(destroyEvent),
      stdout: stream,
      manifest: riskManifest(),
      ledger: emptyLedger,
      env: { DATABASE_URL: "postgres://prod-db/app" },
      kubeContext: "",
      kubeNamespace: "",
    });
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.outcome).toBe("require_approval");
    // Phase 7 #6: require_approval is authoritative — it blocks.
    expect(result.blocked).toBe(true);
  });

  it("does NOT fire the when: policy when the environment does not match", async () => {
    const { stream } = captureStdout();
    const result = await runInterceptCli({
      stdin: streamFrom(destroyEvent),
      stdout: stream,
      manifest: riskManifest(),
      ledger: emptyLedger,
      env: {},
      kubeContext: "",
      kubeNamespace: "",
    });
    expect(result.decisions).toHaveLength(0);
    expect(result.blocked).toBe(false);
  });
});

describe("runInterceptCli — task f1df7c2d: stage .pending-approval on require_approval block", () => {
  // The Risk Gate sister to the Understanding Gate's pending-approval
  // staging (hook-pre-tool-use.ts:520-526). Pre-fix, `harness policy
  // intercept` returned the block JSON for a `require_approval` decision
  // but never wrote the session id to <generatedDir>/.pending-approval,
  // so a subsequent arg-less `harness approve risk` failed to resolve
  // the session id — even though the gate that just fired knew it.
  // Post-fix, the marker is staged before the block JSON write so an
  // operator running `harness approve risk` in their `!`-shell picks it
  // up without `--session=<id>`.

  const DESTROY_CLASSIFIER: RiskClassifier = {
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
    signals: { env_var_patterns: [{ var: "DATABASE_URL", patterns: ["prod"] }] },
  };

  const RISK_POLICY: Policy = {
    name: "gate-prod-destructive",
    description: "require approval for destructive production actions",
    trigger: { event: "PreToolUse", match: "Bash" },
    when: { "environment.name": "production" },
    requires: { ledger_tag: "risk-approved:${SESSION_ID}" },
    hook: "h",
    enforcement: "require_approval",
  } as Policy;

  const emptyLedger: LedgerClient = {
    async query() {
      return { kind: "ok", entries: [] };
    },
    async record() {
      /* no-op */
    },
  };

  const destroyEvent = (sessionId: string) =>
    JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "terraform destroy" },
      session_id: sessionId,
    });

  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "intercept-staging-"));
  });
  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("stages .pending-approval with the event session_id on require_approval", async () => {
    const { stream } = captureStdout();
    const sessionId = "sess-staging-1";
    const result = await runInterceptCli({
      stdin: streamFrom(destroyEvent(sessionId)),
      stdout: stream,
      manifest: makeManifest({
        policies: [RISK_POLICY],
        classifiers: [DESTROY_CLASSIFIER],
        resolvers: [PROD_RESOLVER],
      }),
      ledger: emptyLedger,
      env: { DATABASE_URL: "postgres://prod-db/app" },
      kubeContext: "",
      kubeNamespace: "",
      generatedDir: tmpDir,
    });

    expect(result.blocked).toBe(true);
    expect(result.decisions[0]?.outcome).toBe("require_approval");
    const marker = path.join(tmpDir, ".pending-approval");
    expect(fs.existsSync(marker)).toBe(true);
    expect(fs.readFileSync(marker, "utf8").trim()).toBe(sessionId);
  });

  it("does not stage .pending-approval when no decision is require_approval", async () => {
    // A deny-only manifest (the Phase 4 review-policy fixture) blocks
    // but is not recoverable via `harness approve risk`, so the marker
    // would be a lie. Confirm we skip the write.
    const { stream } = captureStdout();
    const mergeEvent = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "mcp__agent-tasks__pull_requests_merge",
      tool_input: { prNumber: 42 },
      session_id: "sess-deny-1",
    });
    const result = await runInterceptCli({
      stdin: streamFrom(mergeEvent),
      stdout: stream,
      manifest: fakeManifest([REVIEW_POLICY]),
      ledger: emptyLedger,
      generatedDir: tmpDir,
    });

    expect(result.blocked).toBe(true);
    expect(result.decisions[0]?.outcome).toBe("deny");
    const marker = path.join(tmpDir, ".pending-approval");
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("does not stage when event has no session_id (test/probe path)", async () => {
    const { stream } = captureStdout();
    const eventWithoutSession = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "terraform destroy" },
    });
    const result = await runInterceptCli({
      stdin: streamFrom(eventWithoutSession),
      stdout: stream,
      manifest: makeManifest({
        policies: [RISK_POLICY],
        classifiers: [DESTROY_CLASSIFIER],
        resolvers: [PROD_RESOLVER],
      }),
      ledger: emptyLedger,
      env: { DATABASE_URL: "postgres://prod-db/app" },
      kubeContext: "",
      kubeNamespace: "",
      generatedDir: tmpDir,
    });

    expect(result.blocked).toBe(true);
    const marker = path.join(tmpDir, ".pending-approval");
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe("runInterceptCli — hookName self-identification", () => {
  // Codex spawns one process per [[hooks.*]] block and surfaces only a
  // generic "PreToolUse hook (failed)" string when a process is killed
  // for timing out. The Codex generator now injects `--hook <name>` into
  // the command literal so the failing process is identifiable via ps /
  // audit, AND so the intercept entrypoint can tag every stderr line it
  // emits with the same name. These tests pin the stderr-prefix contract
  // for the wire-format and for back-compat (no flag → un-tagged).

  it("tags the no-match hint with [hook=<name>] when hookName is set", async () => {
    const { stream: out } = captureStream();
    const { stream: err, output: errOutput } = captureStream();
    await runInterceptCli({
      stdin: streamFrom(
        JSON.stringify({
          session_id: "sess-1",
          tool_name: "mcp__agent-tasks__pull_requests_merge",
          tool_input: { prNumber: 42 },
        }),
      ),
      stdout: out,
      stderr: err,
      manifest: fakeManifest([REVIEW_POLICY]),
      hookName: "require-preflight-evidence",
    });
    expect(errOutput()).toContain(
      "harness policy intercept [hook=require-preflight-evidence]: no policy matched event",
    );
  });

  it("tags the verbose decision diagnostic with [hook=<name>]", async () => {
    const denyLedgerLocal: LedgerClient = {
      async query() {
        return { kind: "ok", entries: [] };
      },
      async record() {
        /* no-op */
      },
    };
    const { stream: out } = captureStream();
    const { stream: err, output: errOutput } = captureStream();
    await runInterceptCli({
      stdin: streamFrom(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "mcp__agent-tasks__pull_requests_merge",
          tool_input: { prNumber: 42 },
          session_id: "sess-1",
        }),
      ),
      stdout: out,
      stderr: err,
      manifest: fakeManifest([REVIEW_POLICY]),
      ledger: denyLedgerLocal,
      verbose: true,
      hookName: "require-review-evidence",
    });
    expect(errOutput()).toContain(
      "harness policy intercept [hook=require-review-evidence]: review-before-merge: deny",
    );
  });

  it("leaves stderr un-tagged when hookName is absent (back-compat)", async () => {
    const { stream: out } = captureStream();
    const { stream: err, output: errOutput } = captureStream();
    await runInterceptCli({
      stdin: streamFrom(
        JSON.stringify({
          session_id: "sess-1",
          tool_name: "mcp__agent-tasks__pull_requests_merge",
          tool_input: { prNumber: 42 },
        }),
      ),
      stdout: out,
      stderr: err,
      manifest: fakeManifest([REVIEW_POLICY]),
    });
    const errText = errOutput();
    expect(errText).toContain("harness policy intercept: no policy matched event");
    expect(errText).not.toContain("[hook=");
  });

  it("tags the malformed-event-JSON stderr with [hook=<name>]", async () => {
    const { stream: out } = captureStream();
    const { stream: err, output: errOutput } = captureStream();
    await runInterceptCli({
      stdin: streamFrom("{not json"),
      stdout: out,
      stderr: err,
      manifest: fakeManifest([REVIEW_POLICY]),
      hookName: "require-preflight-push-evidence",
    });
    expect(errOutput()).toContain(
      "harness policy intercept [hook=require-preflight-push-evidence]: malformed event JSON:",
    );
  });

  it("tags the manifest-load-failed stderr with [hook=<name>]", async () => {
    // No `manifest` opt + a bogus configPath forces the loader to throw,
    // exercising the catch branch in runInterceptCli.
    const { stream: out } = captureStream();
    const { stream: err, output: errOutput } = captureStream();
    await runInterceptCli({
      stdin: streamFrom(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          session_id: "sess-1",
        }),
      ),
      stdout: out,
      stderr: err,
      configPath: "/nonexistent/harness/manifest-xyz.yaml",
      hookName: "require-preflight-evidence",
    });
    expect(errOutput()).toContain(
      "harness policy intercept [hook=require-preflight-evidence]: manifest load failed:",
    );
  });

  it("tags the realLedgerClient audit-write failure with [hook=<name>]", async () => {
    // Mirror the existing audit-write coverage but pin the hook suffix.
    const badServer = {
      name: "grounding-mcp",
      command: ["/nonexistent-harness-test-binary-xyz"],
      enabled: true,
    } as unknown as McpServer;
    const { stream: err, output: errOutput } = captureStream();
    const client = realLedgerClient(badServer, {
      stderr: err,
      ledgerTimeoutMs: 2000,
      hookName: "require-review-evidence",
    });
    await client.record(
      makeDecision({ policyName: "review-before-merge" }),
      "sess-err",
    );
    expect(errOutput()).toContain(
      "harness policy intercept [hook=require-review-evidence]: audit-write failed for review-before-merge",
    );
  });
});

describe("runInterceptCli — normalised bash_match trigger matching (T-002, run 2026-07-27-gate-target-repo-resolution)", () => {
  // Read straight out of FULL_TEMPLATE (F7 fix — see the `policyBashMatch`
  // helper above) rather than a hand-copied literal. The PREFLIGHT_POLICY
  // fixture used elsewhere in this file carries NO bash_match, so the
  // trigger regex itself was untested through the real evaluation path
  // before this describe block.
  const REAL_BASH_MATCH = policyBashMatch("preflight-before-investigation");

  const REAL_PREFLIGHT_POLICY: Policy = {
    name: "preflight-before-investigation",
    description: "gate git reads on a per-repo preflight tag (real trigger regex)",
    trigger: { event: "PreToolUse", match: "Bash", bash_match: REAL_BASH_MATCH },
    requires: { ledger_tag: "preflight:${REPO}" },
    hook: "h",
    enforcement: "block",
  } as Policy;

  const emptyLedgerLocal: LedgerClient = {
    async query() {
      return { kind: "ok", entries: [] };
    },
    async record() {
      /* no-op */
    },
  };

  async function runFor(command: string) {
    const { stream: out } = captureStream();
    const { stream: err } = captureStream();
    return runInterceptCli({
      stdin: streamFrom(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command },
          session_id: "sess-1",
          cwd: "/tmp/harness-normalize-test-cwd",
        }),
      ),
      stdout: out,
      stderr: err,
      manifest: fakeManifest([REAL_PREFLIGHT_POLICY]),
      ledger: emptyLedgerLocal,
    });
  }

  describe("previously-allowed spellings now block", () => {
    const cases: Array<{ label: string; command: string }> = [
      { label: "env -C <repo>", command: "env -C /tmp/some-repo git status" },
      { label: "env (bare)", command: "env git status" },
      { label: "env VAR=value", command: "env FOO=bar git status" },
      { label: "nice", command: "nice git status" },
      { label: "git --no-pager", command: "git --no-pager status" },
      { label: "double space", command: "git  status" },
      {
        label: "git --git-dir=<x>/.git --work-tree=<x>",
        command: "git --git-dir=/tmp/some-repo/.git --work-tree=/tmp/some-repo status",
      },
      // F4 fix (HIGH, review round 2026-07-27): each of these was
      // measured as a live bypass against the shipped binary.
      { label: "sudo", command: "sudo git status" },
      { label: "doas", command: "doas git status" },
      { label: "time", command: "time git status" },
      { label: "timeout", command: "timeout 5 git status" },
      { label: "stdbuf glued mode flag", command: "stdbuf -o0 git status" },
      { label: "setsid", command: "setsid git status" },
      { label: "path-qualified git (basename match)", command: "/usr/bin/git status" },
    ];
    for (const c of cases) {
      it(`${c.label}: "${c.command}" is blocked with no ledger evidence`, async () => {
        const result = await runFor(c.command);
        expect(result.decisions).toHaveLength(1);
        expect(result.decisions[0]?.outcome).toBe("deny");
        expect(result.blocked).toBe(true);
      });
    }
  });

  // F4 fix: the DELIBERATELY-NOT-SUPPORTED spellings pinned through the
  // REAL evaluation path, so the ceiling is asserted end-to-end, not just
  // at the normaliser's unit level.
  describe("F4: still-unsupported spellings remain a bypass (documented ceiling)", () => {
    const cases: Array<{ label: string; command: string }> = [
      { label: "xargs (deliberately excluded)", command: "xargs git status" },
      { label: "quoted subcommand", command: 'git "status"' },
      { label: "backtick command substitution", command: "echo `env -C /tmp git status`" },
    ];
    for (const c of cases) {
      it(`${c.label}: "${c.command}" produces no decision (still bypasses)`, async () => {
        const result = await runFor(c.command);
        expect(result.decisions).toHaveLength(0);
        expect(result.blocked).toBe(false);
      });
    }
  });

  describe("superset: previously-blocked spellings still block", () => {
    const cases = [
      "git status",
      "cd /tmp/some-repo; git status",
      "cd /tmp/some-repo && git status",
      "git -C /tmp/some-repo status",
      "sh -c 'cd /tmp/some-repo && git status'",
    ];
    for (const command of cases) {
      it(`"${command}" is still blocked with no ledger evidence`, async () => {
        const result = await runFor(command);
        expect(result.decisions).toHaveLength(1);
        expect(result.decisions[0]?.outcome).toBe("deny");
        expect(result.blocked).toBe(true);
      });
    }
  });

  it("a non-git Bash command produces no decision (no-op, no false positive)", async () => {
    const result = await runFor("ls -la");
    expect(result.decisions).toHaveLength(0);
    expect(result.blocked).toBe(false);
  });

  it("a malformed bash_match fails safe to no-match and never throws", async () => {
    const malformedPolicy: Policy = {
      name: "malformed-bash-match",
      description: "deliberately unparseable regex",
      trigger: { event: "PreToolUse", match: "Bash", bash_match: "(" },
      requires: { ledger_tag: "preflight:${REPO}" },
      hook: "h",
      enforcement: "block",
    } as Policy;
    const { stream: out } = captureStream();
    const { stream: err } = captureStream();
    // If policyMatchesEvent's try/catch around `new RegExp` (or the added
    // normalised-path test) ever regressed, this call would throw/reject
    // instead of resolving — the `await` below is itself the "never
    // throws" assertion.
    const result = await runInterceptCli({
      stdin: streamFrom(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "git status" },
          session_id: "sess-1",
          cwd: "/tmp/harness-normalize-test-cwd",
        }),
      ),
      stdout: out,
      stderr: err,
      manifest: fakeManifest([malformedPolicy]),
      ledger: emptyLedgerLocal,
    });
    expect(result.decisions).toHaveLength(0);
    expect(result.blocked).toBe(false);
  });
});
