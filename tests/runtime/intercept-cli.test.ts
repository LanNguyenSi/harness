import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { realLedgerClient, runInterceptCli } from "../../src/cli/policy/intercept.js";
import { FULL_TEMPLATE } from "../../src/cli/init/templates.js";
import { normalizeCommandAmpAware } from "../../src/runtime/command-normalize.js";
import {
  policyMatchesEvent,
  type LedgerClient,
  type PolicyDecision,
  type ToolEvent,
} from "../../src/runtime/intercept.js";
import {
  parseManifest,
  type EnvironmentResolver,
  type McpServer,
  type Policy,
  type RiskClassifier,
} from "../../src/schema/index.js";
import { makeDecision } from "../_helpers/decision.js";
import { makeManifest } from "../_helpers/manifest.js";

// Fix round 1, findings F2+F3+F4: a call-through mock of
// `normalizeCommandAmpAware` used ONLY as a counting seam (never changes
// its behaviour — `actual.normalizeCommandAmpAware` still runs) so the
// "runs at most ONCE per event, not once per matching policy" contract of
// `runInterceptCli`'s real, production `ampNormalizedCommandThunk`
// (`src/cli/policy/intercept.ts`) can be asserted directly, instead of by
// the tautological "a memoising thunk of this shape memoises" test lower
// in this file. `vi.spyOn` cannot target this: Vitest's ESM module
// namespace objects are non-configurable, so `vi.spyOn(mod, "name")`
// throws "Module namespace is not configurable" for an own-source module
// exactly as it does for a third-party one — the call-through `vi.mock`
// below is this repo's established workaround (see
// tests/... project memory `reference_vitest_spyon_esm_named_export`).
// `InterceptCliOptions` has no injection seam for the amp normaliser
// itself, so this is the only way to count real production calls without
// restructuring the production code to add one.
vi.mock("../../src/runtime/command-normalize.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/runtime/command-normalize.js")>();
  return { ...actual, normalizeCommandAmpAware: vi.fn(actual.normalizeCommandAmpAware) };
});

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

  // Explicit regression pin for the split decided in run
  // 2026-07-27-gate-target-repo-resolution: a command naming a FOREIGN
  // target repository (`git -C <B>`) resolves ${REPO}/${BRANCH} from the
  // CWD's own repository, never the named target, so a future
  // reintroduction of a per-command target-directory resolution cannot
  // land unnoticed. A per-command resolution was built and reviewed on
  // this same run but removed before shipping (three consecutive review
  // rounds each found a different way it leaked into the wrong
  // evaluation) — see CHANGELOG.md and command-normalize.ts's module
  // header for the full account.
  // All four spellings the removed resolution understood are pinned, not
  // just `git -C`. A reviewer demonstrated that a reintroduction limited
  // to the leading-`cd` target — the spelling that looks safest, since a
  // `cd` genuinely persists for the rest of the command — leaves a
  // single-spelling pin entirely green.
  it.each([
    ["git -C", (b: string) => `git -C ${b} status`],
    ["env -C", (b: string) => `env -C ${b} git status`],
    ["--work-tree/--git-dir", (b: string) => `git --work-tree=${b} --git-dir=${b}/.git status`],
    ["leading cd", (b: string) => `cd ${b} && git status`],
  ])(
    "%s: a command naming a foreign target repo resolves ${REPO}/${BRANCH} to the cwd repo, not the named target",
    async (_spelling, build) => {
      const repoA = makeRepoFixture("split-cwd-repo", "main");
      const repoB = makeRepoFixture("split-foreign-target", "feature/other");
      const { stream: out } = captureStream();
      const result = await runInterceptCli({
        stdin: streamFrom(
          JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command: build(repoB) },
            session_id: "sess-1",
            cwd: repoA,
          }),
        ),
        stdout: out,
        manifest: fakeManifest([PREFLIGHT_POLICY]),
        ledger: emptyLedger,
      });
      expect(result.decisions).toHaveLength(1);
      expect(result.decisions[0]!.extractValues.REPO).toBe("split-cwd-repo");
      expect(result.decisions[0]!.extractValues.BRANCH).toBe("main");
      expect(result.decisions[0]!.extractValues.CWD).toBe(repoA);
    },
  );
});

// F1 fix (CRITICAL, review round 2026-07-27): the Risk Gate's git context
// (feeding `environments.resolvers[].signals.branch_patterns`) must
// resolve from the hook's own cwd, NEVER from a command's TARGET repo. A
// git-target-aware `${REPO}`/`${BRANCH}` was built and reviewed on this
// same run (a `git -C` / `env -C` / `--work-tree` awareness) but was
// removed before shipping — see `src/cli/policy/intercept.ts` and
// `CHANGELOG.md`; `${REPO}`/`${BRANCH}` are cwd-only again. During that
// run's development, `resolverGit` briefly fell back to the SAME
// target-aware git context ${REPO}/${BRANCH} used at the time, so a
// `production` + `branch_patterns: [main]` resolver classified the
// environment from the COMMAND's target repo's branch instead of the cwd
// repo's — a command like `git -C <repo-on-feature/x> log && rm -rf
// /data` silently skipped the resolver (and every `when:`-gated policy
// keyed on it) because the resolver read feature/x's branch, not the cwd
// repo's `main`. Fixed before that version ever shipped; this suite
// pins `resolverGit` staying cwd-only regardless of what the trigger
// normaliser's own (now-unwired) target-directory extraction finds.
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

// Task 98ad072f (run 2026-08-02-per-repo-gate-scoping-redesign), T-001:
// the three regressions measured against the FIRST (rejected) attempt at
// per-command target-repo resolution — see
// .ai/runs/2026-07-27-gate-target-repo-resolution/05-review-findings.md
// (critical row, first "high | security" row, and the Pass 2/3 rows) and
// D-016 in that run's 03-decisions.md. Written FIRST, BEFORE the redesign
// (T-002/T-003) exists, so the new per-policy attribution can be built
// against a red-first, then-green baseline instead of retrofitted.
//
// A command's git invocation(s) already carry a fully-tested target
// extraction (`command-normalize.ts`'s `targetDir`), but it is
// deliberately UNWIRED — see that module's STATUS header and the cwd-only
// comment on `cwdGitContext` in `src/cli/policy/intercept.ts`. These three
// tests pin that today's behaviour stays cwd-only regardless of what a
// command's OWN git invocation(s) name, so a reintroduction of ANY
// per-event global target — including the simplest possible one, wiring
// `targetDir` straight into `cwdGitContext` — cannot land unnoticed. The
// orchestrator's mutant at
// `.ai/runs/2026-08-02-per-repo-gate-scoping-redesign/mutants/global-target-dir.patch`
// does exactly that.
//
// Command-shape note: `command-normalize.ts`'s OWN `targetDir` already
// refuses to resolve (falls back to `null`) when a command mixes a
// PER-INVOCATION-targeted git call (`-C`/`--work-tree`/`--git-dir`/
// `env -C`) with an unrelated bare invocation across `&&`/`;` — see its
// module header's "every invocation agrees" rule — but NOT across `|`/
// `||`, which it treats as staying in the same effective directory (its
// own comment: "never a bare `|`, which stays in the SAME directory").
// That asymmetry is exactly the historical shape of this run's Pass 2/3
// findings ("closed for `&&`, still open for `|` and `||`"). Each test
// below is written to pin TODAY's cwd-only behaviour across all four
// separators regardless of that asymmetry; which sub-cases actually flip
// under the orchestrator's naive mutant is documented per test.
//
// Orchestrator decision D-010 (2026-08-02, T-003 fix round): (a) and (c)
// below are UNCHANGED. (b)'s command shape was rewritten from a
// leading-`cd` idiom to the literal `-C`-on-decoy form (see its own
// describe block for why) — the leading-`cd` shape is now covered as a
// DELIVERABLE (attribution correctly follows the `cd`), in the
// "leading-cd is now a deliverable" describe block further down this
// file, not as a regression pin here.
describe("runInterceptCli — 98ad072f mandatory regression pins (written FIRST against master 98ecb1b, per-repo gate-scoping redesign)", () => {
  let cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups) c();
    cleanups = [];
  });

  function makeRepoFixture(name: string, branch: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-98ad072f-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = path.join(root, name);
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
    return repo;
  }

  const emptyQuery: LedgerClient["query"] = async () => ({ kind: "ok", entries: [] });

  // (a) Risk Gate (F1-shaped): a `when: environment.name: production`
  // policy — the same shape as the shipped `gate-prod-destructive` /
  // `gate-prod-destructive-approval` templates — still fires although a
  // target-naming git read on a FOREIGN branch precedes the gated
  // command. Superset of the existing F1 pin above (which covers only
  // `&&`): `it.each` over all four separators.
  //
  // Measured (see this task's implementer report): under the
  // orchestrator's mutant, the `&&`/`;` sub-cases stay green (command-
  // normalize's own git-vs-non-git disagreement rule already nulls
  // `targetDir` for those two), but `|`/`||` flip red — `targetDir` leaks
  // through for those two separators today, exactly the historical Pass
  // 2/3 asymmetry noted above.
  describe("(a) Risk Gate: when: environment-production still fires despite a target-naming git read", () => {
    const PROD_BRANCH_RESOLVER: EnvironmentResolver = {
      name: "prod-branch",
      environment: "production",
      signals: { branch_patterns: ["main"] },
    };

    const GATE_PROD_DESTRUCTIVE: Policy = {
      name: "gate-prod-destructive",
      description: "block destructive actions classified as production",
      trigger: { event: "PreToolUse", match: "Bash" },
      when: { "environment.name": "production" },
      requires: { ledger_tag: "risk-override:${SESSION_ID}" },
      hook: "risk-gate",
      enforcement: "block",
    } as Policy;

    it.each(["&&", ";", "|", "||"])(
      "separator %s: fires (decision + audit row + block) with a foreign-branch git read ahead of the gated command",
      async (sep) => {
        const repoA = makeRepoFixture("prod-cwd-repo", "main");
        const repoB = makeRepoFixture("prod-decoy-repo", "feature/x");
        const recordCalls: PolicyDecision[] = [];
        const ledger: LedgerClient = {
          query: emptyQuery,
          async record(decision) {
            recordCalls.push(decision);
          },
        };
        const { stream: out, output: outText } = captureStream();
        const { stream: err } = captureStream();
        const result = await runInterceptCli({
          stdin: streamFrom(
            JSON.stringify({
              hook_event_name: "PreToolUse",
              tool_name: "Bash",
              tool_input: { command: `git -C ${repoB} log ${sep} echo hi` },
              session_id: "sess-98ad072f-a",
              cwd: repoA,
            }),
          ),
          stdout: out,
          stderr: err,
          manifest: makeManifest({
            policies: [GATE_PROD_DESTRUCTIVE],
            resolvers: [PROD_BRANCH_RESOLVER],
          }),
          ledger,
        });

        expect(result.decisions).toHaveLength(1);
        expect(result.decisions[0]?.environment?.name).toBe("production");
        expect(result.decisions[0]?.outcome).toBe("deny");
        expect(result.blocked).toBe(true);
        // Deny payload actually emitted on the hook's stdout contract.
        expect(outText()).toContain('"permissionDecision":"deny"');
        // Audit row actually written, not just an in-memory decision.
        expect(recordCalls).toHaveLength(1);
        expect(recordCalls[0]?.policyName).toBe("gate-prod-destructive");
        expect(recordCalls[0]?.environment?.name).toBe("production");
      },
    );
  });

  // (b) Push gate: a target-NAMING read (`-C <decoy>`, the literal 07-27
  // regression form) chained with a BARE `git push` in ONE command demands
  // the CWD repo's `${BRANCH}` tag, satisfied only via `currentHeadSha`
  // resolved from the CWD repo — never the read target's branch or HEAD.
  // The ledger entry below is deliberately STALE (outside the policy's
  // `within: 10m` window) and satisfiable ONLY through the `at_head`
  // bypass matching the CWD repo's sha, so an "allow" here is only
  // possible when BOTH `${BRANCH}` and `currentHeadSha` were resolved from
  // the cwd repo, not the decoy.
  //
  // This is the PROTECTED class: `-C` scopes only the ONE git invocation
  // it decorates (`command-normalize.ts`'s own "every invocation agrees"
  // rule already refuses to resolve a mixed explicit/bare chain like this
  // one), so `git push` genuinely runs at the real cwd, never the read
  // target — `${BRANCH}`/`currentHeadSha` staying cwd-derived here is
  // CORRECT bash semantics, not merely "unattributed".
  //
  // Orchestrator decision D-010 (2026-08-02): a LEADING-`cd` version of
  // this shape (`cd <B> && git log && git push`) previously lived here as
  // a "regression" pin, on the theory that an intervening `git log`
  // should stop `B` from reaching the push. REJECTED and moved to the
  // deliverable describe block below ("leading-cd is now a deliverable"):
  // a `cd` genuinely persists across the whole chain in real bash, so
  // `git push` after `cd <B> && git log` really does run inside B —
  // demanding B's tag there is the FIX this task delivers, not a
  // regression to guard against. `-C`, unlike `cd`, never persists past
  // its own invocation, which is exactly why THIS shape stays cwd-only.
  //
  // Measured against the NEW per-policy attribution design (not the old,
  // already-removed global-`targetDir` mutant, which never resolved this
  // specific mixed-invocation shape in the first place — see the comment
  // above): flips under
  // `.ai/runs/2026-08-02-per-repo-gate-scoping-redesign/mutants/first-invocation-wins.patch`,
  // which attributes EVERY matching policy to the first non-null segment
  // target in the event instead of only its OWN trigger-satisfying
  // segment(s) — under that mutant the `-C <decoy>` read's target reaches
  // the (unrelated) push policy too.
  describe("(b) push gate: a target-naming -C read + a bare push in one command stays cwd-derived (tag AND currentHeadSha)", () => {
    const CWD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const DECOY_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    function makeRepoFixtureWithSha(name: string, branch: string, sha: string): string {
      const repo = makeRepoFixture(name, branch);
      const refPath = path.join(repo, ".git", "refs", "heads", branch);
      fs.mkdirSync(path.dirname(refPath), { recursive: true });
      fs.writeFileSync(refPath, `${sha}\n`);
      return repo;
    }

    const PREFLIGHT_PUSH_POLICY: Policy = {
      name: "preflight-before-push",
      description: "gate pushes on a per-branch preflight tag (real trigger regex)",
      trigger: {
        event: "PreToolUse",
        match: "Bash",
        bash_match: policyBashMatch("preflight-before-push"),
      },
      requires: { ledger_tag: "preflight:${BRANCH}", within: "10m", at_head: true },
      hook: "require-preflight-push-evidence",
      enforcement: "block",
    } as Policy;

    it("demands preflight:<cwd branch>, satisfied only via the cwd repo's HEAD sha", async () => {
      const cwdRepo = makeRepoFixtureWithSha("push-cwd-repo", "cwd-branch", CWD_SHA);
      const decoyRepo = makeRepoFixtureWithSha("push-decoy-repo", "decoy-branch", DECOY_SHA);

      const staleHeadMatched = {
        id: "e1",
        content: `preflight:cwd-branch head:${CWD_SHA} — stale but head-pinned`,
        createdAt: new Date(Date.now() - 3600_000).toISOString(),
      };
      const recordCalls: PolicyDecision[] = [];
      const ledger: LedgerClient = {
        async query() {
          return { kind: "ok", entries: [staleHeadMatched] };
        },
        async record(decision) {
          recordCalls.push(decision);
        },
      };

      const { stream: out } = captureStream();
      const { stream: err } = captureStream();
      const result = await runInterceptCli({
        stdin: streamFrom(
          JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command: `git -C ${decoyRepo} log && git push` },
            session_id: "sess-98ad072f-b",
            cwd: cwdRepo,
          }),
        ),
        stdout: out,
        stderr: err,
        manifest: fakeManifest([PREFLIGHT_PUSH_POLICY]),
        ledger,
      });

      expect(result.decisions).toHaveLength(1);
      expect(result.decisions[0]!.ledgerTag).toBe("preflight:cwd-branch");
      expect(result.decisions[0]!.outcome).toBe("allow");
      expect(result.decisions[0]!.reason).toContain(CWD_SHA.slice(0, 7));
      expect(result.blocked).toBe(false);
      expect(recordCalls).toHaveLength(1);
      expect(recordCalls[0]?.ledgerTag).toBe("preflight:cwd-branch");
    });
  });

  // (c) Non-git gated verb: a targeted git read chained with the real
  // `review-before-merge-bash` trigger (`gh pr merge`) over each of the
  // four separators demands the CWD repo's `${BRANCH}` tag, never the
  // decoy's — the exact shape of the Pass 2/3 finding ("an explicit `-C`
  // target still leaking into a later non-git gated verb").
  //
  // Measured: `&&`/`;` stay green under the orchestrator's mutant
  // (command-normalize already nulls `targetDir` for a `-C`-targeted git
  // call mixed with an unrelated non-git command across those two
  // separators); `|`/`||` flip red (the documented "stays in the SAME
  // directory" pipe exemption lets `targetDir` leak through), reproducing
  // the historical asymmetry exactly.
  describe("(c) merge verb: targeted read chained via &&, ;, |, || demands the CWD repo's tag (it.each)", () => {
    const GH_MERGE_POLICY: Policy = {
      name: "review-before-merge-bash",
      description: "block gh pr merge without a ledger tag (real trigger regex)",
      trigger: {
        event: "PreToolUse",
        match: "Bash",
        bash_match: policyBashMatch("review-before-merge-bash"),
      },
      requires: { ledger_tag: "review:${BRANCH}" },
      hook: "h",
      enforcement: "block",
    } as Policy;

    it.each(["&&", ";", "|", "||"])(
      "separator %s: a foreign-branch git read chained with gh pr merge demands review:<cwd branch>, never the decoy's",
      async (sep) => {
        const cwdRepo = makeRepoFixture("merge-cwd-repo", "cwd-merge-branch");
        const decoyRepo = makeRepoFixture("merge-decoy-repo", "decoy-merge-branch");
        const { stream: out } = captureStream();
        const { stream: err } = captureStream();
        const result = await runInterceptCli({
          stdin: streamFrom(
            JSON.stringify({
              hook_event_name: "PreToolUse",
              tool_name: "Bash",
              tool_input: { command: `git -C ${decoyRepo} log ${sep} gh pr merge 1` },
              session_id: "sess-98ad072f-c",
              cwd: cwdRepo,
            }),
          ),
          stdout: out,
          stderr: err,
          manifest: fakeManifest([GH_MERGE_POLICY]),
          ledger: { query: emptyQuery, async record() {} },
        });

        expect(result.decisions).toHaveLength(1);
        expect(result.decisions[0]!.ledgerTag).toBe("review:cwd-merge-branch");
        expect(result.decisions[0]!.extractValues.BRANCH).toBe("cwd-merge-branch");
      },
    );
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

// T-001 (run 2026-07-28-nongit-trigger-wrappers, D-001): the head-token
// condition in `canonicalizeSegment` generalised from "literally `git`" to
// the closed set `git`, `gh`, `npm`, `harness` — every head token a shipped
// `bash_match` trigger actually gates. A one-word wrapper (`env`, `nice`,
// `command`, `env -C <dir>`) defeated the `gh`/`npm`/`harness` triggers
// exactly as it used to defeat `git`'s before the prior run's fix. Real
// regexes read straight out of FULL_TEMPLATE via `policyBashMatch` (see
// helper above), mirroring the git-focused T-002 describe block this one
// sits next to.
describe("runInterceptCli — non-git head-token wrapper bypass matching (T-001, run 2026-07-28-nongit-trigger-wrappers)", () => {
  const GH_MERGE_POLICY: Policy = {
    name: "review-before-merge-bash",
    description: "block gh pr merge without a ledger tag (real trigger regex)",
    trigger: { event: "PreToolUse", match: "Bash", bash_match: policyBashMatch("review-before-merge-bash") },
    requires: { ledger_tag: "review:${BRANCH}" },
    hook: "h",
    enforcement: "block",
  } as Policy;

  const GH_CREATE_POLICY: Policy = {
    name: "review-subagent-before-pr-create-bash",
    description: "block gh pr create without a ledger tag (real trigger regex)",
    trigger: {
      event: "PreToolUse",
      match: "Bash",
      bash_match: policyBashMatch("review-subagent-before-pr-create-bash"),
    },
    requires: { ledger_tag: "review-subagent:${BRANCH}" },
    hook: "h",
    enforcement: "block",
  } as Policy;

  const NPM_PUBLISH_POLICY: Policy = {
    name: "dogfood-before-release",
    description: "block npm publish without a recent dogfood ledger tag (real trigger regex)",
    trigger: { event: "PreToolUse", match: "Bash", bash_match: policyBashMatch("dogfood-before-release") },
    requires: { ledger_tag: "dogfood:${SESSION_ID}" },
    hook: "h",
    enforcement: "block",
  } as Policy;

  // deny-kill-switch-bypass is `operator_only: true` with NO `requires:` at
  // all in FULL_TEMPLATE (task 2cc73f55 — see
  // tests/cli/init-full-template-kill-switch-deny.test.ts). Read the REAL
  // policy object rather than a hand-rolled fixture so that shape — and its
  // no-ledger-query short-circuit — is exercised exactly as shipped, not
  // approximated.
  function realKillSwitchPolicy(): Policy {
    const parsed = parseManifest(parseYaml(FULL_TEMPLATE));
    const policy = parsed.policies.find((p) => p.name === "deny-kill-switch-bypass");
    if (!policy) throw new Error("deny-kill-switch-bypass missing from FULL_TEMPLATE");
    return policy;
  }

  const emptyLedgerLocal: LedgerClient = {
    async query() {
      return { kind: "ok", entries: [] };
    },
    async record() {
      /* no-op */
    },
  };

  async function runFor(policy: Policy, command: string) {
    const { stream: out } = captureStream();
    const { stream: err } = captureStream();
    return runInterceptCli({
      stdin: streamFrom(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command },
          session_id: "sess-nongit-1",
          cwd: "/tmp/harness-nongit-test-cwd",
        }),
      ),
      stdout: out,
      stderr: err,
      manifest: fakeManifest([policy]),
      ledger: emptyLedgerLocal,
    });
  }

  describe("gh pr merge: previously-allowed wrapped spellings now block", () => {
    const cases: Array<{ label: string; command: string }> = [
      { label: "env gh pr merge", command: "env gh pr merge 123" },
      { label: "env -C <dir> gh pr merge", command: "env -C /tmp/some-repo gh pr merge 123" },
      { label: "nice gh pr merge", command: "nice gh pr merge 123" },
      { label: "double space between gh and its subcommand", command: "gh  pr merge 123" },
      // Fix round 2, finding F2: an interior whitespace run further into
      // the multi-word verb phrase (between "pr" and "merge") used to
      // survive the head-to-next-token-only collapse.
      { label: "double space between pr and merge (F2)", command: "gh pr  merge 123" },
      { label: "tab between pr and merge (F2)", command: "gh pr\tmerge 123" },
    ];
    for (const c of cases) {
      it(`${c.label}: "${c.command}" is blocked with no ledger evidence`, async () => {
        const result = await runFor(GH_MERGE_POLICY, c.command);
        expect(result.decisions).toHaveLength(1);
        expect(result.decisions[0]?.outcome).toBe("deny");
        expect(result.blocked).toBe(true);
      });
    }
  });

  describe("gh pr create: previously-allowed wrapped spelling now blocks", () => {
    const cases: Array<{ label: string; command: string }> = [
      { label: "env gh pr create", command: "env gh pr create" },
      // Fix round 2, finding F2.
      { label: "double space between pr and create (F2)", command: "gh pr  create" },
    ];
    for (const c of cases) {
      it(`${c.label}: "${c.command}" is blocked with no ledger evidence`, async () => {
        const result = await runFor(GH_CREATE_POLICY, c.command);
        expect(result.decisions).toHaveLength(1);
        expect(result.decisions[0]?.outcome).toBe("deny");
        expect(result.blocked).toBe(true);
      });
    }
  });

  describe("npm publish: previously-allowed wrapped spellings now block", () => {
    const cases: Array<{ label: string; command: string }> = [
      { label: "env npm publish", command: "env npm publish" },
      { label: "nice npm publish", command: "nice npm publish" },
      // Fix round 2, findings F2/F7.
      { label: "double space between npm and publish (F2/F7)", command: "npm  publish" },
      { label: "tab between npm and publish (F2/F7)", command: "npm\tpublish" },
    ];
    for (const c of cases) {
      it(`${c.label}: "${c.command}" is blocked with no ledger evidence`, async () => {
        const result = await runFor(NPM_PUBLISH_POLICY, c.command);
        expect(result.decisions).toHaveLength(1);
        expect(result.decisions[0]?.outcome).toBe("deny");
        expect(result.blocked).toBe(true);
      });
    }
  });

  describe("harness pause (kill switch): previously-allowed wrapped spellings now block", () => {
    const cases: Array<{ label: string; command: string }> = [
      { label: "env harness pause", command: "env harness pause" },
      { label: "nice harness pause", command: "nice harness pause" },
      { label: "command harness pause", command: "command harness pause" },
      { label: "env -C <dir> harness pause", command: "env -C /tmp harness pause" },
    ];
    for (const c of cases) {
      it(`${c.label}: "${c.command}" is blocked (operator_only, no requires needed)`, async () => {
        const result = await runFor(realKillSwitchPolicy(), c.command);
        expect(result.decisions).toHaveLength(1);
        expect(result.decisions[0]?.outcome).toBe("deny");
        expect(result.blocked).toBe(true);
      });
    }
  });

  // Superset re-assertion: bare, previously-matching spellings for each of
  // these four policies must keep matching — additive raw-OR-normalised
  // construction, never raw-replaced-by-normalised.
  describe("superset: previously-blocked bare spellings still block", () => {
    it("gh pr merge (bare)", async () => {
      const result = await runFor(GH_MERGE_POLICY, "gh pr merge 123");
      expect(result.decisions).toHaveLength(1);
      expect(result.blocked).toBe(true);
    });
    it("gh pr create (bare)", async () => {
      const result = await runFor(GH_CREATE_POLICY, "gh pr create");
      expect(result.decisions).toHaveLength(1);
      expect(result.blocked).toBe(true);
    });
    it("npm publish (bare)", async () => {
      const result = await runFor(NPM_PUBLISH_POLICY, "npm publish");
      expect(result.decisions).toHaveLength(1);
      expect(result.blocked).toBe(true);
    });
    it("harness pause (bare)", async () => {
      const result = await runFor(realKillSwitchPolicy(), "harness pause");
      expect(result.decisions).toHaveLength(1);
      expect(result.blocked).toBe(true);
    });
  });

  // Negative controls: an unrelated Bash command, and a gh/npm/harness
  // near-miss, must produce no decision at all — the widening is additive,
  // never a false positive on innocent neighbours.
  describe("negative controls: no false positives", () => {
    it("an unrelated Bash command produces no decision", async () => {
      const result = await runFor(GH_MERGE_POLICY, "echo hello");
      expect(result.decisions).toHaveLength(0);
      expect(result.blocked).toBe(false);
    });
    it("gitk --all produces no decision against the harness kill-switch policy", async () => {
      const result = await runFor(realKillSwitchPolicy(), "gitk --all");
      expect(result.decisions).toHaveLength(0);
      expect(result.blocked).toBe(false);
    });
    it('a quoted-verb echo ("harness pause" as a string literal) produces no decision', async () => {
      const result = await runFor(realKillSwitchPolicy(), 'echo "not a real harness pause call"');
      expect(result.decisions).toHaveLength(0);
      expect(result.blocked).toBe(false);
    });
  });
});

// Fix round 2, finding F6: raw-first ordering pin. `policyMatchesEvent`
// tests every `bash_match` regex against the RAW command first and only
// falls back to the normalised form on a raw miss (raw-OR-normalised,
// never raw-replaced-by-normalised — command-normalize.ts module header).
// This particular command is the one shipped shape that actually proves
// the ordering matters: `env -u CLAUDE_SESSION_ID npm publish` matches
// `deny-session-env-strip` on the RAW string (the "-u <VAR>" text is
// right there), but this module's OWN normaliser treats the leading `env
// -u <VAR>` as a wrapper preceding the real `npm publish` invocation and
// PEELS IT AWAY when hunting for a recognised head token — so the
// NORMALISED form of this exact command no longer contains the `-u <VAR>`
// text `deny-session-env-strip`'s trigger needs (see the module header's
// "SHIPPED BUT NOT COVERED" paragraph, finding F1). If raw-OR-normalised
// ever collapsed to normalised-only, THIS test — and no other in this
// suite — would go red, because every other shipped bypass this run
// fixes is a case where raw already failed and normalised newly succeeds,
// never the reverse.
describe("runInterceptCli — fix round 2, finding F6: raw-first ordering (deny-session-env-strip still fires when normalisation erases its own evidence)", () => {
  function realDenySessionEnvStripPolicy(): Policy {
    const parsed = parseManifest(parseYaml(FULL_TEMPLATE));
    const policy = parsed.policies.find((p) => p.name === "deny-session-env-strip");
    if (!policy) throw new Error("deny-session-env-strip missing from FULL_TEMPLATE");
    return policy;
  }

  const emptyLedgerLocal: LedgerClient = {
    async query() {
      return { kind: "ok", entries: [] };
    },
    async record() {
      /* no-op */
    },
  };

  it('"env -u CLAUDE_SESSION_ID npm publish" still blocks via deny-session-env-strip (raw matches even though normalised does not)', async () => {
    const { stream: out } = captureStream();
    const { stream: err } = captureStream();
    const result = await runInterceptCli({
      stdin: streamFrom(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "env -u CLAUDE_SESSION_ID npm publish" },
          session_id: "sess-f6-1",
          cwd: "/tmp/harness-f6-test-cwd",
        }),
      ),
      stdout: out,
      stderr: err,
      manifest: fakeManifest([realDenySessionEnvStripPolicy()]),
      ledger: emptyLedgerLocal,
    });
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.outcome).toBe("deny");
    expect(result.blocked).toBe(true);
  });
});

// G4 fix (MEDIUM, review round 2, 2026-07-27): above
// `MAX_NORMALIZE_LENGTH`, `normalizeCommand` used to skip normalisation
// SILENTLY — no stderr line, no audit row, the skip was only visible by
// reading the source. End-to-end through the real `policy intercept`
// entrypoint (not just the normaliser unit), per the review brief.
describe("runInterceptCli — G4 fix: MAX_NORMALIZE_LENGTH skip is now observable on stderr", () => {
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
    const { stream: err, output: errOutput } = captureStream();
    const result = await runInterceptCli({
      stdin: streamFrom(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command },
          session_id: "sess-g4",
          cwd: "/tmp/harness-normalize-test-cwd",
        }),
      ),
      stdout: out,
      stderr: err,
      manifest: fakeManifest([REAL_PREFLIGHT_POLICY]),
      ledger: emptyLedgerLocal,
    });
    return { result, errOutput };
  }

  it("emits exactly one stderr line when the command exceeds MAX_NORMALIZE_LENGTH, and the RAW match still fires (D-003)", async () => {
    const oversized = "git status " + "x".repeat(100_000);
    expect(oversized.length).toBeGreaterThan(100_000);
    const { result, errOutput } = await runFor(oversized);
    // The raw command still matches ("git status" appears verbatim at
    // the start), so the trigger fires regardless of the skipped
    // ADDITIONAL normalised-form coverage — the skip only loses the
    // extra reach normalisation would have added, never the baseline.
    expect(result.decisions).toHaveLength(1);
    const stderrText = errOutput();
    const skipLines = stderrText
      .split("\n")
      .filter((line) => line.includes("normalised-form matching skipped"));
    expect(skipLines).toHaveLength(1);
    expect(stderrText).toContain("100000");
  });

  it("emits NO skip line at or under the bound", async () => {
    const atBound = "git status " + "x".repeat(100_000 - "git status ".length);
    expect(atBound.length).toBe(100_000);
    const { errOutput } = await runFor(atBound);
    expect(errOutput()).not.toContain("normalised-form matching skipped");
  });
});

// Task aabbad63: `policyMatchesEvent`'s third, ampersand-aware matching
// arm. Unlike the T-001/T-002 blocks above (which exercise the FULL
// `runInterceptCli` pipeline), these tests call `policyMatchesEvent`
// directly — the same seam `scripts/measure-command-normalize.mjs`'s
// `loadRealGates` uses — against the REAL trigger regex read straight out
// of FULL_TEMPLATE (never a hand-copied literal, same F7-fix rationale as
// the `policyBashMatch` helper above).
describe("policyMatchesEvent — ampersand-aware third normalisation arm (task aabbad63)", () => {
  const REAL_PREFLIGHT_MATCH = policyBashMatch("preflight-before-investigation");
  const REAL_PREFLIGHT_POLICY: Policy = {
    name: "preflight-before-investigation",
    description: "gate git reads on a per-repo preflight tag (real trigger regex)",
    trigger: { event: "PreToolUse", match: "Bash", bash_match: REAL_PREFLIGHT_MATCH },
    requires: { ledger_tag: "preflight:${REPO}" },
    hook: "h",
    enforcement: "block",
  } as Policy;

  function eventFor(command: string): ToolEvent {
    return {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command },
    };
  }

  describe("the two measured bare-& bypasses now match against the real trigger regex", () => {
    it('"A=x&env -C /tmp git status" (glued ampersand, no space before the wrapper) matches', () => {
      expect(
        policyMatchesEvent(REAL_PREFLIGHT_POLICY, eventFor("A=x&env -C /tmp git status")),
      ).toBe(true);
    });

    it('"echo hi & nice git status" (genuine bash background job) matches', () => {
      expect(
        policyMatchesEvent(REAL_PREFLIGHT_POLICY, eventFor("echo hi & nice git status")),
      ).toBe(true);
    });
  });

  describe("the quoted-value family still matches (via the EXISTING pass, unaffected by the third arm)", () => {
    const REAL_PUSH_MATCH = policyBashMatch("preflight-before-push");
    const REAL_PUSH_POLICY: Policy = {
      name: "preflight-before-push",
      description: "gate git push on a per-branch preflight tag (real trigger regex)",
      trigger: { event: "PreToolUse", match: "Bash", bash_match: REAL_PUSH_MATCH },
      requires: { ledger_tag: "preflight:${BRANCH}" },
      hook: "h",
      enforcement: "block",
    } as Policy;

    function realKillSwitchPolicy(): Policy {
      const parsed = parseManifest(parseYaml(FULL_TEMPLATE));
      const policy = parsed.policies.find((p) => p.name === "deny-kill-switch-bypass");
      if (!policy) throw new Error("deny-kill-switch-bypass missing from FULL_TEMPLATE");
      return policy;
    }

    it("env FOO='a&b' git push origin master still matches", () => {
      expect(
        policyMatchesEvent(REAL_PUSH_POLICY, eventFor("env FOO='a&b' git push origin master")),
      ).toBe(true);
    });

    it("nice FOO='x & y' harness pause still matches", () => {
      expect(
        policyMatchesEvent(realKillSwitchPolicy(), eventFor("nice FOO='x & y' harness pause")),
      ).toBe(true);
    });
  });

  describe("laziness: the third arm is consulted only after BOTH the raw and existing-normalised forms miss", () => {
    it("the amp thunk is NEVER called when the raw command already matches", () => {
      let calls = 0;
      const thunk = (): { normalized: string; truncated: boolean } => {
        calls += 1;
        throw new Error("must not be called: raw command already matched");
      };
      const matched = policyMatchesEvent(
        REAL_PREFLIGHT_POLICY,
        eventFor("git status"),
        undefined,
        thunk,
      );
      expect(matched).toBe(true);
      expect(calls).toBe(0);
    });

    it("the amp thunk is NEVER called when the raw form misses but the EXISTING normalised form matches", () => {
      let calls = 0;
      const thunk = (): { normalized: string; truncated: boolean } => {
        calls += 1;
        throw new Error("must not be called: the existing normalised pass already matched");
      };
      const matched = policyMatchesEvent(
        REAL_PREFLIGHT_POLICY,
        eventFor("env git status"), // raw misses, BOUNDARY_RE-normalised form matches
        undefined,
        thunk,
      );
      expect(matched).toBe(true);
      expect(calls).toBe(0);
    });

    it("the amp thunk IS called when both the raw and existing-normalised forms miss", () => {
      let calls = 0;
      const command = "A=x&env -C /tmp git status";
      const thunk = () => {
        calls += 1;
        return normalizeCommandAmpAware(command);
      };
      const matched = policyMatchesEvent(REAL_PREFLIGHT_POLICY, eventFor(command), undefined, thunk);
      expect(matched).toBe(true);
      expect(calls).toBe(1);
    });

    // `policyMatchesEvent` itself does not memoise — it just calls whatever
    // thunk it is handed. The "at most once PER EVENT, not once per policy"
    // property is a contract of the MEMOISING thunk `runInterceptCli`
    // constructs (`src/cli/policy/intercept.ts`'s `ampNormalizedCommandThunk`,
    // a `??=`-memoised closure over one `normalizeCommandAmpAware` call),
    // shared by reference across every policy in the manifest-wide loop.
    // This test proves that CONTRACT directly: a memoising thunk of that
    // exact shape, handed to `policyMatchesEvent` for TWO DIFFERENT
    // policies matching the SAME event, does the underlying work only once.
    it("a memoising thunk (the shape runInterceptCli builds) computes the amp pass only ONCE across two different policies for the same event", () => {
      let realCalls = 0;
      let cache: { normalized: string; truncated: boolean } | undefined;
      const command = "A=x&env -C /tmp git status";
      const thunk = (): { normalized: string; truncated: boolean } =>
        (cache ??= ((): { normalized: string; truncated: boolean } => {
          realCalls += 1;
          return normalizeCommandAmpAware(command);
        })());
      const event = eventFor(command);
      const policyA: Policy = { ...REAL_PREFLIGHT_POLICY, name: "policy-a" };
      const policyB: Policy = { ...REAL_PREFLIGHT_POLICY, name: "policy-b" };
      expect(policyMatchesEvent(policyA, event, undefined, thunk)).toBe(true);
      expect(policyMatchesEvent(policyB, event, undefined, thunk)).toBe(true);
      expect(realCalls).toBe(1);
      // NOTE (fix round 1, findings F2+F3): this test proves a memoising
      // thunk OF THIS SHAPE memoises — it builds its own `cache ??=`
      // closure and never touches `runInterceptCli` itself, so it caught
      // neither (1) replacing `runInterceptCli`'s real
      // `ampNormalizedCommandCache ??= normalizeCommandAmpAware(bashCommand)`
      // with a non-memoising call, nor (2) deleting the
      // `ampNormalizedCommandThunk` spread into `intercept()` entirely —
      // both mutations left the whole suite green including this test. The
      // describe block below drives real events through the real
      // `runInterceptCli` entrypoint and counts real
      // `normalizeCommandAmpAware` calls via a call-through `vi.mock`,
      // closing that gap; both mutations above were applied and reverted
      // to confirm they turn IT red (see the fix-round report).
    });
  });
});

// Fix round 1, findings F2+F3+F4: `runInterceptCli`'s real,
// production-built `ampNormalizedCommandThunk` (`src/cli/policy/intercept.ts`)
// must compute the ampersand-aware normalisation pass AT MOST ONCE PER
// EVENT, no matter how many `bash_match` policies in the manifest need it
// — that is the entire reason it is threaded as a memoising thunk rather
// than a precomputed value (see that file's own comment). The
// "policyMatchesEvent — ampersand-aware third normalisation arm" describe
// block above proves `policyMatchesEvent` calls WHATEVER thunk it is
// handed correctly, and proves a hand-built memoising closure memoises —
// but neither test drives an event through `runInterceptCli` itself, so
// neither one actually exercises the PRODUCTION thunk
// (`ampNormalizedCommandCache ??= normalizeCommandAmpAware(bashCommand)`)
// or the `ampNormalizedCommandThunk` spread that wires it into
// `intercept()`. These two tests do, using the module-level
// `vi.mock("../../src/runtime/command-normalize.js", ...)` call-through
// counting seam declared at the top of this file.
describe("runInterceptCli — the amp normalisation pass computes at most ONCE per event (fix round 1, F2+F3+F4)", () => {
  const REAL_PREFLIGHT_MATCH_F2 = policyBashMatch("preflight-before-investigation");
  const REAL_PUSH_MATCH_F4 = policyBashMatch("preflight-before-push");

  /** Two differently-named policies sharing one bash_match regex, so both reach the third arm for the same event. */
  function twinPolicies(bashMatch: string, ledgerTag: string): [Policy, Policy] {
    const base: Policy = {
      name: "policy-a",
      description: "real trigger regex, duplicated under two names",
      trigger: { event: "PreToolUse", match: "Bash", bash_match: bashMatch },
      requires: { ledger_tag: ledgerTag },
      hook: "h",
      enforcement: "block",
    } as Policy;
    return [base, { ...base, name: "policy-b" }];
  }

  const emptyLedgerAmpOnce: LedgerClient = {
    async query() {
      return { kind: "ok", entries: [] };
    },
    async record() {
      /* no-op */
    },
  };

  it("F2+F3: computes the amp pass exactly ONCE for a Bash event even when TWO policies both need it", async () => {
    const mockedAmpAware = vi.mocked(normalizeCommandAmpAware);
    mockedAmpAware.mockClear();
    const { stream: out } = captureStream();
    const { stream: err } = captureStream();
    // Both the raw form and the primary (BOUNDARY_RE) normalised form miss
    // this command; only the third, amp-aware arm matches (same measured
    // spelling used throughout this file's aabbad63 coverage).
    const command = "echo hi & nice git status";
    const result = await runInterceptCli({
      stdin: streamFrom(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command },
          session_id: "sess-f2f3",
          cwd: "/tmp/harness-f2f3-test-cwd",
        }),
      ),
      stdout: out,
      stderr: err,
      manifest: fakeManifest(twinPolicies(REAL_PREFLIGHT_MATCH_F2, "preflight:${REPO}")),
      ledger: emptyLedgerAmpOnce,
    });
    expect(result.decisions).toHaveLength(2);
    expect(result.decisions.every((d) => d.outcome === "deny")).toBe(true);
    expect(mockedAmpAware).toHaveBeenCalledTimes(1);
  });

  it("F4: computes the amp pass exactly ONCE for a Codex shell event whose command lives under raw_input.cmd", async () => {
    const mockedAmpAware = vi.mocked(normalizeCommandAmpAware);
    mockedAmpAware.mockClear();
    const { stream: out } = captureStream();
    const { stream: err } = captureStream();
    // `raw_input.cmd`, not `tool_input.command` — the exact shape the old
    // `event.tool_name === "Bash"` + `readBashCommand(event.tool_input)`
    // pair could never see, which is why this event used to reach
    // `policyMatchesEvent`'s per-policy fallback (both normalisers
    // recomputed once PER POLICY) instead of the precomputed/memoised path.
    const command = "echo hi & nice git push origin fix/codex-amp-once";
    const result = await runInterceptCli({
      stdin: streamFrom(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "shell",
          raw_input: { cmd: command },
          session_id: "sess-f4",
          cwd: "/tmp/harness-f4-test-cwd",
        }),
      ),
      stdout: out,
      stderr: err,
      manifest: fakeManifest(twinPolicies(REAL_PUSH_MATCH_F4, "preflight:${BRANCH}")),
      ledger: emptyLedgerAmpOnce,
    });
    expect(result.decisions).toHaveLength(2);
    expect(result.decisions.every((d) => d.outcome === "deny")).toBe(true);
    expect(mockedAmpAware).toHaveBeenCalledTimes(1);
  });
});

// Task 98ad072f, T-003 (run 2026-08-02-per-repo-gate-scoping-redesign):
// the per-policy attribution wiring that closes the cross-repo defect the
// T-001 pins above deliberately leave open (that block pins TODAY's
// cwd-only behaviour so a naive GLOBAL targetDir reintroduction cannot
// land unnoticed — see its own header comment). These tests exercise the
// actual fix: `${REPO}`/`${BRANCH}`/`currentHeadSha` resolve from the
// segment that satisfies a policy's OWN `bash_match` trigger, not always
// the event's cwd, per `01-plan.md` Proposed Approach items 2-4 and
// `src/runtime/intercept.ts`'s `attributeTriggerSegments` /
// `resolveAttributedContexts`.
describe("runInterceptCli — 98ad072f T-003 per-policy attribution (segment-level target resolution)", () => {
  let cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups) c();
    cleanups = [];
  });

  function makeRepoFixture(name: string, branch: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-98ad072f-t003-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = path.join(root, name);
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
    return repo;
  }

  const PREFLIGHT_INVESTIGATION_POLICY: Policy = {
    name: "preflight-before-investigation",
    description: "gate investigative git reads on a per-repo preflight tag (real trigger regex)",
    trigger: {
      event: "PreToolUse",
      match: "Bash",
      bash_match: policyBashMatch("preflight-before-investigation"),
    },
    requires: { ledger_tag: "preflight:${REPO}" },
    hook: "require-preflight-evidence",
    enforcement: "block",
  } as Policy;

  function ledgerWithEntries(contents: string[]): LedgerClient {
    const entries = contents.map((content, i) => ({
      id: `e${i}`,
      content,
      createdAt: new Date().toISOString(),
    }));
    return {
      async query() {
        return { kind: "ok", entries };
      },
      async record() {
        /* no-op */
      },
    };
  }

  // Deliverable pin (task acceptance criterion): only `preflight:<A>` on
  // record, cwd in A, a target-naming read on B → refused, the DEMANDED
  // tag is `preflight:<B>` — never `preflight:<A>` (which the shipped,
  // cwd-only engine would have accepted). Both required spellings
  // (`-C` absolute, and the `cd B && <read>` idiom) are covered.
  describe("deliverable pin: a target-naming read on B demands preflight:<B>, not preflight:<A>", () => {
    it.each([
      {
        label: "-C absolute",
        commandFor: (repoB: string) => `git -C ${repoB} status`,
      },
      {
        label: "cd B && <read>",
        commandFor: (repoB: string) => `cd ${repoB} && git status`,
      },
    ])("$label: denies against only preflight:<A>, demanding preflight:<B>", async ({ commandFor }) => {
      const repoA = makeRepoFixture("deliverable-repo-a", "main");
      const repoB = makeRepoFixture("deliverable-repo-b", "main");

      const denied = await runInterceptCli({
        stdin: streamFrom(
          JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command: commandFor(repoB) },
            session_id: "sess-98ad072f-deliverable",
            cwd: repoA,
          }),
        ),
        stdout: captureStream().stream,
        stderr: captureStream().stream,
        manifest: fakeManifest([PREFLIGHT_INVESTIGATION_POLICY]),
        ledger: ledgerWithEntries(["preflight:deliverable-repo-a — evidence for A only"]),
      });

      expect(denied.decisions).toHaveLength(1);
      expect(denied.decisions[0]!.ledgerTag).toBe("preflight:deliverable-repo-b");
      expect(denied.decisions[0]!.outcome).toBe("deny");
      expect(denied.blocked).toBe(true);

      // Positive control: with preflight:<B> on record instead, the SAME
      // command allows — proving the deny above was a real evidence gap
      // for B, not an unrelated failure.
      const allowed = await runInterceptCli({
        stdin: streamFrom(
          JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command: commandFor(repoB) },
            session_id: "sess-98ad072f-deliverable",
            cwd: repoA,
          }),
        ),
        stdout: captureStream().stream,
        stderr: captureStream().stream,
        manifest: fakeManifest([PREFLIGHT_INVESTIGATION_POLICY]),
        ledger: ledgerWithEntries(["preflight:deliverable-repo-b — evidence for B"]),
      });

      expect(allowed.decisions).toHaveLength(1);
      expect(allowed.decisions[0]!.ledgerTag).toBe("preflight:deliverable-repo-b");
      expect(allowed.decisions[0]!.outcome).toBe("allow");
      expect(allowed.blocked).toBe(false);
    });
  });

  // Unattributable-form pin (D-003): a policy whose `bash_match` matches
  // the WHOLE command only across a segment boundary — never a single
  // segment individually — falls back to cwd builtins, identical to
  // shipped, even though a foreign target (repoB) genuinely appears
  // earlier in the same chain. `attributeTriggerSegments` finds no
  // individually-matching segment, so `resolveAttributedContexts` never
  // resolves anything from repoB at all.
  it("unattributable form: a whole-string-only bash_match falls back to cwd builtins despite a foreign target in the chain", async () => {
    const repoA = makeRepoFixture("unattrib-repo-a", "main");
    const repoB = makeRepoFixture("unattrib-repo-b", "main");
    const WHOLE_STRING_ONLY_POLICY: Policy = {
      name: "whole-string-only-probe",
      description: "regex only satisfiable by spanning two segments, never one alone",
      trigger: { event: "PreToolUse", match: "Bash", bash_match: "status.*log" },
      requires: { ledger_tag: "preflight:${REPO}" },
      hook: "h",
      enforcement: "block",
    } as Policy;

    const result = await runInterceptCli({
      stdin: streamFrom(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: `cd ${repoB} && git status && git log` },
          session_id: "sess-98ad072f-unattrib",
          cwd: repoA,
        }),
      ),
      stdout: captureStream().stream,
      stderr: captureStream().stream,
      manifest: fakeManifest([WHOLE_STRING_ONLY_POLICY]),
      ledger: ledgerWithEntries(["preflight:unattrib-repo-a — evidence for A"]),
    });

    // Whole-command raw test DOES match (spans "status ... log" across
    // the chain) — this asserts the policy actually fired, not that it
    // was skipped for an unrelated reason.
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]!.ledgerTag).toBe("preflight:unattrib-repo-a");
    expect(result.decisions[0]!.extractValues.REPO).toBe("unattrib-repo-a");
    expect(result.decisions[0]!.outcome).toBe("allow");
    expect(result.blocked).toBe(false);
  });

  // Multi-target pin (D-004): a decoy read AND a cwd read chained in ONE
  // command each independently satisfy the SAME policy's trigger. With
  // only the cwd tag on record, the policy is evaluated once per distinct
  // target and the B-context's unsatisfied requirement blocks the whole
  // decision — the decision set names B (via its own ledgerTag/extractValues)
  // as the target that produced the still-unsatisfied demand. With BOTH
  // tags on record, every context is satisfied and the command allows.
  describe("multi-target pin (D-004): decoy read + cwd read in one chain, evaluated once per distinct target", () => {
    it("only the cwd tag on record: denies, naming B as the unsatisfied target", async () => {
      const repoA = makeRepoFixture("multi-repo-a", "main");
      const repoB = makeRepoFixture("multi-repo-b", "main");

      const result = await runInterceptCli({
        stdin: streamFrom(
          JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command: `git -C ${repoB} status && git status` },
            session_id: "sess-98ad072f-multi",
            cwd: repoA,
          }),
        ),
        stdout: captureStream().stream,
        stderr: captureStream().stream,
        manifest: fakeManifest([PREFLIGHT_INVESTIGATION_POLICY]),
        ledger: ledgerWithEntries(["preflight:multi-repo-a — evidence for A only"]),
      });

      // One decision per distinct attributed context (D-004): A and B.
      expect(result.decisions).toHaveLength(2);
      const tags = result.decisions.map((d) => d.ledgerTag).sort();
      expect(tags).toEqual(["preflight:multi-repo-a", "preflight:multi-repo-b"]);
      const bDecision = result.decisions.find((d) => d.ledgerTag === "preflight:multi-repo-b");
      expect(bDecision?.outcome).toBe("deny");
      expect(bDecision?.extractValues.REPO).toBe("multi-repo-b");
      // Any unsatisfied context blocks the whole event.
      expect(result.blocked).toBe(true);
    });

    it("both tags on record: allows (every distinct context is satisfied)", async () => {
      const repoA = makeRepoFixture("multi2-repo-a", "main");
      const repoB = makeRepoFixture("multi2-repo-b", "main");

      const result = await runInterceptCli({
        stdin: streamFrom(
          JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command: `git -C ${repoB} status && git status` },
            session_id: "sess-98ad072f-multi2",
            cwd: repoA,
          }),
        ),
        stdout: captureStream().stream,
        stderr: captureStream().stream,
        manifest: fakeManifest([PREFLIGHT_INVESTIGATION_POLICY]),
        ledger: ledgerWithEntries([
          "preflight:multi2-repo-a — evidence for A",
          "preflight:multi2-repo-b — evidence for B",
        ]),
      });

      expect(result.decisions).toHaveLength(2);
      expect(result.decisions.every((d) => d.outcome === "allow")).toBe(true);
      expect(result.blocked).toBe(false);
    });
  });

  // Positive controls: single-repo ship-flow spellings stay on the
  // single, cwd-only decision shape — no behaviour change for the
  // overwhelming majority of real usage.
  describe("positive controls: single-repo forms stay unchanged (one decision, cwd-derived)", () => {
    it.each([
      { label: "bare read", commandFor: () => "git status" },
      { label: "-C .", commandFor: () => "git -C . status" },
      { label: "-C <cwd absolute>", commandFor: (repoA: string) => `git -C ${repoA} status` },
    ])("$label", async ({ commandFor }) => {
      const repoA = makeRepoFixture("positive-repo-a", "main");
      const result = await runInterceptCli({
        stdin: streamFrom(
          JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command: commandFor(repoA) },
            session_id: "sess-98ad072f-positive",
            cwd: repoA,
          }),
        ),
        stdout: captureStream().stream,
        stderr: captureStream().stream,
        manifest: fakeManifest([PREFLIGHT_INVESTIGATION_POLICY]),
        ledger: ledgerWithEntries(["preflight:positive-repo-a — evidence for A"]),
      });

      expect(result.decisions).toHaveLength(1);
      expect(result.decisions[0]!.ledgerTag).toBe("preflight:positive-repo-a");
      expect(result.decisions[0]!.outcome).toBe("allow");
      expect(result.blocked).toBe(false);
    });
  });

  // Orchestrator decision D-010 (2026-08-02): a leading `cd <X> &&` GENUINELY
  // persists across the whole chain in real bash — attribution follows it
  // for EVERY gated verb in the chain, uniformly, including a verb (like
  // `push`) that names no target of its own. This is the DELIVERABLE, not
  // a regression: relative to the shipped, cwd-only binary (which would
  // have accepted the CWD repo's own tag for these exact commands — a
  // defect, since the verb genuinely runs against X, not cwd), the new
  // design is MORE RESTRICTIVE, demanding X's tag instead. Contrast with
  // describe block (b) above: a `-C <decoy>` read (which does NOT persist
  // past its own invocation) leaves a later bare push cwd-derived — that
  // shape stays protected; THIS shape (a real, persisting `cd`) does not.
  describe("leading-cd is now a deliverable: attribution follows a persisting cd for EVERY verb in the chain, including push", () => {
    it("cd <X> && <investigation read>: demands preflight:<X>, not preflight:<cwd> (restrictive vs. shipped)", async () => {
      const repoCwd = makeRepoFixture("leadingcd-read-cwd", "main");
      const repoX = makeRepoFixture("leadingcd-read-x", "main");

      const denied = await runInterceptCli({
        stdin: streamFrom(
          JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command: `cd ${repoX} && git status` },
            session_id: "sess-98ad072f-leadingcd-read",
            cwd: repoCwd,
          }),
        ),
        stdout: captureStream().stream,
        stderr: captureStream().stream,
        manifest: fakeManifest([PREFLIGHT_INVESTIGATION_POLICY]),
        // Only the CWD repo's own tag on record — the shipped, cwd-only
        // binary would have accepted this for the same command; the new
        // design correctly refuses.
        ledger: ledgerWithEntries(["preflight:leadingcd-read-cwd — evidence for cwd only"]),
      });

      expect(denied.decisions).toHaveLength(1);
      expect(denied.decisions[0]!.ledgerTag).toBe("preflight:leadingcd-read-x");
      expect(denied.decisions[0]!.outcome).toBe("deny");
      expect(denied.blocked).toBe(true);

      // Positive control: with X's own tag on record, the same command allows.
      const allowed = await runInterceptCli({
        stdin: streamFrom(
          JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command: `cd ${repoX} && git status` },
            session_id: "sess-98ad072f-leadingcd-read",
            cwd: repoCwd,
          }),
        ),
        stdout: captureStream().stream,
        stderr: captureStream().stream,
        manifest: fakeManifest([PREFLIGHT_INVESTIGATION_POLICY]),
        ledger: ledgerWithEntries(["preflight:leadingcd-read-x — evidence for X"]),
      });
      expect(allowed.decisions[0]!.outcome).toBe("allow");
      expect(allowed.blocked).toBe(false);
    });

    it("cd <X> && git push: demands preflight:<X's branch> via X's own HEAD sha, not the cwd repo's (restrictive vs. shipped)", async () => {
      const CWD_SHA = "cccccccccccccccccccccccccccccccccccccccc";
      const X_SHA = "dddddddddddddddddddddddddddddddddddddddd";

      function makeRepoFixtureWithSha(name: string, branch: string, sha: string): string {
        const repo = makeRepoFixture(name, branch);
        const refPath = path.join(repo, ".git", "refs", "heads", branch);
        fs.mkdirSync(path.dirname(refPath), { recursive: true });
        fs.writeFileSync(refPath, `${sha}\n`);
        return repo;
      }

      const PREFLIGHT_PUSH_POLICY: Policy = {
        name: "preflight-before-push",
        description: "gate pushes on a per-branch preflight tag (real trigger regex)",
        trigger: {
          event: "PreToolUse",
          match: "Bash",
          bash_match: policyBashMatch("preflight-before-push"),
        },
        requires: { ledger_tag: "preflight:${BRANCH}", within: "10m", at_head: true },
        hook: "require-preflight-push-evidence",
        enforcement: "block",
      } as Policy;

      const cwdRepo = makeRepoFixtureWithSha("leadingcd-push-cwd", "cwd-branch", CWD_SHA);
      const repoX = makeRepoFixtureWithSha("leadingcd-push-x", "x-branch", X_SHA);

      // Only the CWD repo's own head-pinned tag on record — what the
      // shipped, cwd-only binary would have accepted for this exact
      // command. The new design refuses: the push genuinely runs inside X.
      const cwdOnlyEntry = {
        id: "e1",
        content: `preflight:cwd-branch head:${CWD_SHA} — stale but head-pinned`,
        createdAt: new Date(Date.now() - 3600_000).toISOString(),
      };
      const denied = await runInterceptCli({
        stdin: streamFrom(
          JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command: `cd ${repoX} && git push` },
            session_id: "sess-98ad072f-leadingcd-push",
            cwd: cwdRepo,
          }),
        ),
        stdout: captureStream().stream,
        stderr: captureStream().stream,
        manifest: fakeManifest([PREFLIGHT_PUSH_POLICY]),
        ledger: {
          async query() {
            return { kind: "ok", entries: [cwdOnlyEntry] };
          },
          async record() {
            /* no-op */
          },
        },
      });

      expect(denied.decisions).toHaveLength(1);
      expect(denied.decisions[0]!.ledgerTag).toBe("preflight:x-branch");
      expect(denied.decisions[0]!.outcome).toBe("deny");
      expect(denied.blocked).toBe(true);

      // Positive control: X's own head-pinned tag on record → allow, the
      // matched sha in the reason is X's, not the cwd repo's.
      const xEntry = {
        id: "e2",
        content: `preflight:x-branch head:${X_SHA} — evidence for X`,
        createdAt: new Date(Date.now() - 3600_000).toISOString(),
      };
      const allowed = await runInterceptCli({
        stdin: streamFrom(
          JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command: `cd ${repoX} && git push` },
            session_id: "sess-98ad072f-leadingcd-push",
            cwd: cwdRepo,
          }),
        ),
        stdout: captureStream().stream,
        stderr: captureStream().stream,
        manifest: fakeManifest([PREFLIGHT_PUSH_POLICY]),
        ledger: {
          async query() {
            return { kind: "ok", entries: [xEntry] };
          },
          async record() {
            /* no-op */
          },
        },
      });

      expect(allowed.decisions).toHaveLength(1);
      expect(allowed.decisions[0]!.ledgerTag).toBe("preflight:x-branch");
      expect(allowed.decisions[0]!.outcome).toBe("allow");
      expect(allowed.decisions[0]!.reason).toContain(X_SHA.slice(0, 7));
      expect(allowed.blocked).toBe(false);
    });
  });
});
