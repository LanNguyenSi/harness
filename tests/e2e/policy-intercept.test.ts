// End-to-end regression net for the `harness policy intercept` PreToolUse
// hook. Pre-existing unit tests in `tests/runtime/intercept-cli.test.ts`
// inject a synthetic `LedgerClient`, which means the manifest -> grounding-mcp
// spawn boundary is uncovered. Both v0.8.0 silent-enforcement bugs were
// caught live in dogfood (PR #81 wrong block-envelope shape, PR #82 silent
// no-op on incomplete stdin) precisely because that boundary had no
// regression net.
//
// This file fills the gap: each test writes a manifest YAML to a temp dir,
// spawns a fake `grounding-mcp` script referenced from the manifest, and
// drives `runInterceptCli` end-to-end through `loadManifest` +
// `realLedgerClient`. Coverage:
//
//   - deny envelope shape on empty ledger (the PR #81 contract)
//   - silent allow on a seeded matching ledger entry
//   - deny envelope shape on a wrong-tag ledger entry
//   - stderr no-match hint on missing hook_event_name (the PR #82 contract)
//   - warn-degraded fallback when the fake grounding-mcp exits non-zero
//
// The grounding-mcp pointer in the manifest is the only moving piece; the
// fake script is a small Node program that records every `tools/call`
// invocation to a temp file so future tests can extend this with negative
// "agent-tasks MCP was never invoked" assertions once `claude -p` lands
// (task 78a23aed, the `harness smoke` verb).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInterceptCli } from "../../src/cli/policy/intercept.js";

let cleanups: Array<() => void> = [];
let savedVerboseEnv: string | undefined;

beforeEach(() => {
  // Strip HARNESS_POLICY_VERBOSE so `expect(stderr).toBe("")` assertions
  // hold deterministically. Mirrors the sibling unit suite at
  // `tests/runtime/intercept-cli.test.ts`.
  savedVerboseEnv = process.env.HARNESS_POLICY_VERBOSE;
  delete process.env.HARNESS_POLICY_VERBOSE;
});

afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
  if (savedVerboseEnv === undefined) {
    delete process.env.HARNESS_POLICY_VERBOSE;
  } else {
    process.env.HARNESS_POLICY_VERBOSE = savedVerboseEnv;
  }
});

function makeTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
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

interface FakeGroundingMcpOptions {
  /** Entries returned in the `facts` bucket of `ledger_summary`. */
  entries?: Array<{ id: number; content: string; createdAt: string }>;
  /**
   * Path to a file the fake will append a JSON line to on every
   * `tools/call` invocation. Useful for asserting invocation counts.
   */
  invocationLog?: string;
}

/**
 * Writes a minimal Node script that speaks the MCP stdio JSON-RPC
 * dialect harness's ledger-client expects. Returns the absolute path to
 * the script (executable, cleaned up in afterEach).
 */
function makeFakeGroundingMcp(opts: FakeGroundingMcpOptions = {}): string {
  const dir = makeTmpDir("harness-fake-mcp-");
  const file = path.join(dir, "fake-grounding-mcp.js");
  const facts = opts.entries ?? [];
  const invocationLog = opts.invocationLog ?? "";
  const script = `#!/usr/bin/env node
const fs = require("fs");
const FACTS = ${JSON.stringify(facts)};
const INVOCATION_LOG = ${JSON.stringify(invocationLog)};

let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  let nl = buf.indexOf("\\n");
  while (nl !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) { nl = buf.indexOf("\\n"); continue; }
    let msg;
    try { msg = JSON.parse(line); } catch { nl = buf.indexOf("\\n"); continue; }
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05" } }) + "\\n");
    } else if (msg.method === "tools/list") {
      // Forward-compat: queryLedgerByTag only calls tools/list when a
      // sinceIso/contentPrefix filter is requested. Responding with an
      // empty tools array keeps the fake honest if a future caller flips
      // that on, instead of hanging on the 5s detect-timeout.
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } }) + "\\n");
    } else if (msg.method === "tools/call" && msg.params) {
      const toolName = msg.params.name;
      if (INVOCATION_LOG) {
        fs.appendFileSync(INVOCATION_LOG, JSON.stringify({ tool: toolName, args: msg.params.arguments, ts: Date.now() }) + "\\n");
      }
      if (toolName === "ledger_summary") {
        const payload = {
          sessionId: msg.params.arguments && msg.params.arguments.sessionId,
          counts: { facts: FACTS.length, hypotheses: 0, rejected: 0, unknowns: 0 },
          entries: { facts: FACTS, hypotheses: [], rejected: [], unknowns: [] },
        };
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } }) + "\\n");
      } else if (toolName === "ledger_add") {
        // Acknowledge so recordPolicyDecision doesn't time out. The decision
        // record itself is not under test here; we just need the round-trip
        // to complete.
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: '{"ok":true}' }] } }) + "\\n");
      } else {
        // Unknown tools/call name: reply with a JSON-RPC error rather than
        // hanging. The caller's "ledger_summary error: ..." degraded path
        // is preferable to a silent 5s timeout if a future revision adds
        // a new verb we haven't mocked.
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown tool: " + toolName } }) + "\\n");
      }
    }
    nl = buf.indexOf("\\n");
  }
});
`;
  fs.writeFileSync(file, script, "utf8");
  fs.chmodSync(file, 0o755);
  return file;
}

interface WriteManifestOptions {
  groundingMcpCommand: string[];
  /** Optional extra timeout for the ledger health probe (ms). */
  groundingTimeoutMs?: number;
}

function writeManifest(opts: WriteManifestOptions): string {
  const dir = makeTmpDir("harness-e2e-manifest-");
  const manifestPath = path.join(dir, "harness.yaml");
  const cmdYaml = opts.groundingMcpCommand
    .map((s) => JSON.stringify(s))
    .join(", ");
  const timeout = opts.groundingTimeoutMs ?? 5000;
  // Keep this manifest minimal but schema-valid. `policy intercept` only
  // touches `tools.mcp[name=grounding-mcp]`, `policies`, and `hooks` (for
  // the policy's `hook:` cross-reference). Everything else is filler.
  const yaml = `version: 1

grounding:
  session:
    auto_start: false
    id_format: "e2e-{rand:8}"
  evidence_ledger:
    path: ~/.evidence-ledger/ledger.db
    retention_days: 30

tools:
  mcp:
    - name: grounding-mcp
      command: [${cmdYaml}]
      health:
        verb: ledger_summary
        timeout_ms: ${timeout}
      enabled: true

  cli: []

  skills:
    enabled: []
    required: []
    source_dirs: []

  builtin:
    known: [Read, Edit, Write, Bash]

memory:
  directories: []
  retention:
    staleness_days: 180
    broken_refs: warn
  scopes:
    default: project
    allowed: [project]

hooks:
  - name: policy-intercept-pretooluse
    event: PreToolUse
    match: "mcp__agent-tasks__pull_requests_merge"
    command: /bin/true
    blocking: hard
    budget_ms: 10000

policies:
  - name: review-before-merge
    description: Block PR merges unless a ledger entry tagged review:<pr-number> exists for the active session.
    trigger:
      event: PreToolUse
      match: "mcp__agent-tasks__pull_requests_merge"
      extract:
        PR_NUMBER: "toolArgs.prNumber"
    requires:
      ledger_tag: "review:\${PR_NUMBER}"
    hook: policy-intercept-pretooluse
    enforcement: block
`;
  fs.writeFileSync(manifestPath, yaml, "utf8");
  return manifestPath;
}

const PR_MERGE_EVENT = {
  hook_event_name: "PreToolUse",
  tool_name: "mcp__agent-tasks__pull_requests_merge",
  tool_input: { prNumber: 42, owner: "LanNguyenSi", repo: "harness" },
  session_id: "e2e-sess-1",
  cwd: "/tmp/harness-e2e",
};

describe("policy intercept: manifest-driven E2E flow", () => {
  it("emits the PR #81 deny envelope when the fake ledger is empty", async () => {
    const mcp = makeFakeGroundingMcp({ entries: [] });
    const manifestPath = writeManifest({ groundingMcpCommand: ["node", mcp] });
    const { stream: stdout, output: stdoutOut } = captureStream();
    const { stream: stderr, output: stderrOut } = captureStream();

    const result = await runInterceptCli({
      stdin: streamFrom(JSON.stringify(PR_MERGE_EVENT)),
      stdout,
      stderr,
      configPath: manifestPath,
    });

    expect(result.blocked).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.decisions).toHaveLength(1);
    expect(stderrOut()).toBe("");
    const parsed = JSON.parse(stdoutOut().trim());
    // PR #81: top-level `decision:"block"` AND
    // `hookSpecificOutput.permissionDecision:"deny"` for PreToolUse, both
    // shapes are required by Claude Code 2.1+ for the hook to actually
    // block. Wrong-shape regression manifests as silent enforcement.
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("review-before-merge");
    expect(parsed.hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: parsed.reason,
    });
  });

  it("stays silent on stdout when the fake ledger contains a matching review:42 entry", async () => {
    const mcp = makeFakeGroundingMcp({
      entries: [
        {
          id: 1,
          content: "review:42 approved by reviewer",
          createdAt: "2026-05-12T08:00:00.000Z",
        },
      ],
    });
    const manifestPath = writeManifest({ groundingMcpCommand: ["node", mcp] });
    const { stream: stdout, output: stdoutOut } = captureStream();
    const { stream: stderr, output: stderrOut } = captureStream();

    const result = await runInterceptCli({
      stdin: streamFrom(JSON.stringify(PR_MERGE_EVENT)),
      stdout,
      stderr,
      configPath: manifestPath,
    });

    expect(result.blocked).toBe(false);
    expect(stdoutOut()).toBe("");
    // No-match hint must NOT fire because the policy DID match, it just allowed.
    expect(stderrOut()).not.toContain("no policy matched event");
  });

  it("emits the deny envelope when the ledger holds the wrong tag (review:99)", async () => {
    const mcp = makeFakeGroundingMcp({
      entries: [
        {
          id: 1,
          content: "review:99 approved (irrelevant pr)",
          createdAt: "2026-05-12T08:00:00.000Z",
        },
      ],
    });
    const manifestPath = writeManifest({ groundingMcpCommand: ["node", mcp] });
    const { stream: stdout, output: stdoutOut } = captureStream();
    const { stream: stderr } = captureStream();

    const result = await runInterceptCli({
      stdin: streamFrom(JSON.stringify(PR_MERGE_EVENT)),
      stdout,
      stderr,
      configPath: manifestPath,
    });

    expect(result.blocked).toBe(true);
    const parsed = JSON.parse(stdoutOut().trim());
    expect(parsed.decision).toBe("block");
    expect(parsed.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("queries ledger_summary exactly once with the active session id", async () => {
    const logDir = makeTmpDir("harness-mcp-log-");
    const invocationLog = path.join(logDir, "calls.jsonl");
    const mcp = makeFakeGroundingMcp({ entries: [], invocationLog });
    const manifestPath = writeManifest({ groundingMcpCommand: ["node", mcp] });

    const { stream: stdout } = captureStream();
    const { stream: stderr } = captureStream();
    await runInterceptCli({
      stdin: streamFrom(JSON.stringify(PR_MERGE_EVENT)),
      stdout,
      stderr,
      configPath: manifestPath,
    });

    const calls = fs
      .readFileSync(invocationLog, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const summaries = calls.filter((c) => c.tool === "ledger_summary");
    expect(summaries).toHaveLength(1);
    // The policy's `requires.ledger_tag` substitution should reach the
    // ledger client and the active session id should land server-side.
    expect(summaries[0].args.sessionId).toBe("e2e-sess-1");
    // The deny path also exercises recordPolicyDecision, which spawns the
    // ledger again and calls ledger_add. Asserting it fired covers the
    // second half of the manifest-to-real-spawn coverage gap.
    const adds = calls.filter((c) => c.tool === "ledger_add");
    expect(adds.length).toBeGreaterThanOrEqual(1);
    expect(adds[0].args.sessionId).toBe("e2e-sess-1");
  });

  it("emits the PR #82 stderr no-match hint when hook_event_name is missing", async () => {
    const mcp = makeFakeGroundingMcp({ entries: [] });
    const manifestPath = writeManifest({ groundingMcpCommand: ["node", mcp] });
    const { stream: stdout, output: stdoutOut } = captureStream();
    const { stream: stderr, output: stderrOut } = captureStream();

    const stripped = {
      tool_name: "mcp__agent-tasks__pull_requests_merge",
      tool_input: { prNumber: 42 },
      session_id: "e2e-sess-2",
    };
    const result = await runInterceptCli({
      stdin: streamFrom(JSON.stringify(stripped)),
      stdout,
      stderr,
      configPath: manifestPath,
    });

    expect(result.blocked).toBe(false);
    expect(stdoutOut()).toBe("");
    const errText = stderrOut();
    expect(errText).toContain("harness policy intercept: no policy matched event");
    expect(errText).toContain("hook_event_name=(missing)");
    expect(errText).toContain('tool_name="mcp__agent-tasks__pull_requests_merge"');
    expect(errText).toContain("registered policy events: PreToolUse");
  });

  it("falls back to warn-degraded when the configured grounding-mcp exits non-zero", async () => {
    // Reuse the broken-mcp shape from dogfood/broken-mcp.sh: a script that
    // immediately writes to stderr and exits 1. The runtime contract says
    // an unreachable ledger degrades to warn-equivalent, not block.
    const dir = makeTmpDir("harness-broken-mcp-");
    const brokenScript = path.join(dir, "broken-grounding-mcp.sh");
    fs.writeFileSync(
      brokenScript,
      "#!/bin/sh\necho 'broken-mcp: simulated startup failure' >&2\nexit 1\n",
      "utf8",
    );
    fs.chmodSync(brokenScript, 0o755);

    const manifestPath = writeManifest({ groundingMcpCommand: [brokenScript] });
    const { stream: stdout, output: stdoutOut } = captureStream();
    const { stream: stderr } = captureStream();

    const result = await runInterceptCli({
      stdin: streamFrom(JSON.stringify(PR_MERGE_EVENT)),
      stdout,
      stderr,
      configPath: manifestPath,
    });

    // Degraded ledger -> default enforcement is "warn-degraded", which
    // does NOT emit blockJson. Exit 0, stdout empty, so Claude Code does
    // not block. (Phase 4 acceptance: ledger unreachable -> warn, not
    // block, so a corrupted ledger does not silently freeze every PR.)
    expect(result.exitCode).toBe(0);
    expect(result.blocked).toBe(false);
    expect(stdoutOut()).toBe("");
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.outcome).toBe("warn-degraded");
    // Anchor on the ledger-unreachable branch specifically. A regression
    // that silently routed warn-degraded through template-unresolved or
    // requires-eval-threw would still match outcome="warn-degraded";
    // the reason string is what pins us to the spawn-failure branch.
    expect(result.decisions[0]?.reason).toMatch(/grounding-mcp/);
  });
});
