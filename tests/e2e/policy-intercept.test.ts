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
  /**
   * Path to a file the fake appends one line to at process startup.
   * Line count == number of grounding-mcp subprocesses spawned, which is
   * the connection-pooling contract under test (2026-07-01 review:
   * O(1) connections per intercept, not 2 per matching policy).
   */
  startLog?: string;
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
  const startLog = opts.startLog ?? "";
  const script = `#!/usr/bin/env node
const fs = require("fs");
const FACTS = ${JSON.stringify(facts)};
const INVOCATION_LOG = ${JSON.stringify(invocationLog)};
const START_LOG = ${JSON.stringify(startLog)};
if (START_LOG) {
  fs.appendFileSync(START_LOG, JSON.stringify({ pid: process.pid, ts: Date.now() }) + "\\n");
}

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
  /**
   * Additional block-enforcement policies appended AFTER the base
   * `review-before-merge` policy, matching the same PR-merge trigger but
   * each requiring its own ledger tag. Used by the connection-pooling
   * tests to drive K matching policies through one intercept invocation.
   */
  extraPolicies?: Array<{ name: string; tagPrefix: string }>;
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
  const extras = (opts.extraPolicies ?? [])
    .map(
      (p) => `
  - name: ${p.name}
    description: Extra pooled-connection test policy requiring ${p.tagPrefix}:<pr-number>.
    trigger:
      event: PreToolUse
      match: "mcp__agent-tasks__pull_requests_merge"
      extract:
        PR_NUMBER: "toolArgs.prNumber"
    requires:
      ledger_tag: "${p.tagPrefix}:\${PR_NUMBER}"
    hook: policy-intercept-pretooluse
    enforcement: block
`,
    )
    .join("");
  fs.writeFileSync(manifestPath, yaml + extras, "utf8");
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

// 2026-07-01 review, enforcement-subprocess-latency (task a2589fa3): the
// PreToolUse gate used to spawn 2 grounding-mcp subprocesses per matching
// policy (query + record), sequentially — K policies approached the 30s
// hook budget under load and a hook timeout is conventionally fail-open.
// realLedgerClient now holds ONE session per intercept invocation and the
// per-policy summary queries collapse into one cached round-trip. These
// tests pin the O(1)-connections contract and that pooling changed neither
// the decision ordering nor audit-record completeness.
describe("policy intercept: pooled grounding-mcp connection", () => {
  const THREE_POLICY_EXTRAS = [
    { name: "audit-before-merge", tagPrefix: "audit" },
    { name: "signoff-before-merge", tagPrefix: "signoff" },
  ];

  it("spawns exactly ONE grounding-mcp for 3 matching policies (1 summary + 3 records)", async () => {
    const logDir = makeTmpDir("harness-mcp-pool-log-");
    const invocationLog = path.join(logDir, "calls.jsonl");
    const startLog = path.join(logDir, "starts.jsonl");
    const mcp = makeFakeGroundingMcp({ entries: [], invocationLog, startLog });
    const manifestPath = writeManifest({
      groundingMcpCommand: ["node", mcp],
      extraPolicies: THREE_POLICY_EXTRAS,
    });

    const { stream: stdout } = captureStream();
    const { stream: stderr, output: stderrOut } = captureStream();
    const result = await runInterceptCli({
      stdin: streamFrom(JSON.stringify(PR_MERGE_EVENT)),
      stdout,
      stderr,
      configPath: manifestPath,
    });

    // All three policies evaluated and denied (empty ledger).
    expect(result.decisions).toHaveLength(3);
    expect(result.blocked).toBe(true);

    // THE contract: one subprocess for the whole intercept invocation,
    // not 2 per policy (the old behaviour would show 6 start lines).
    const starts = fs.readFileSync(startLog, "utf8").trim().split("\n");
    expect(starts).toHaveLength(1);

    const calls = fs
      .readFileSync(invocationLog, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    // The 3 per-policy queries hit the same sessionId and dedupe into ONE
    // ledger_summary round-trip (per-tag filtering is client-side).
    const summaries = calls.filter((c) => c.tool === "ledger_summary");
    expect(summaries).toHaveLength(1);
    // Audit completeness: one ledger_add per decision, no dropped rows.
    const adds = calls.filter((c) => c.tool === "ledger_add");
    expect(adds).toHaveLength(3);
    const recordedPolicies = adds.map(
      (c) => JSON.parse(String(c.args.content).slice(String(c.args.content).indexOf(" ") + 1)).name,
    );
    expect(recordedPolicies).toEqual([
      "review-before-merge",
      "audit-before-merge",
      "signoff-before-merge",
    ]);
    // No audit-write failures surfaced.
    expect(stderrOut()).not.toContain("audit-write failed");
  });

  it("keeps first-blocking-decision-in-manifest-order semantics with two denying policies", async () => {
    const mcp = makeFakeGroundingMcp({ entries: [] });
    const manifestPath = writeManifest({
      groundingMcpCommand: ["node", mcp],
      extraPolicies: [{ name: "audit-before-merge", tagPrefix: "audit" }],
    });

    const { stream: stdout, output: stdoutOut } = captureStream();
    const { stream: stderr } = captureStream();
    const result = await runInterceptCli({
      stdin: streamFrom(JSON.stringify(PR_MERGE_EVENT)),
      stdout,
      stderr,
      configPath: manifestPath,
    });

    expect(result.blocked).toBe(true);
    expect(result.decisions.map((d) => d.outcome)).toEqual(["deny", "deny"]);
    // The FIRST policy in manifest order owns the deny envelope.
    const parsed = JSON.parse(stdoutOut().trim());
    expect(parsed.reason).toContain("review-before-merge");
    expect(parsed.reason).not.toContain("audit-before-merge");
  });

  it("hands the envelope to the second policy when the first allows (order, not name, decides)", async () => {
    // Seed review:42 so the base policy allows; audit:42 is absent so the
    // second policy denies. Proves the envelope owner is the first
    // BLOCKING decision in manifest order, not simply the first policy.
    const mcp = makeFakeGroundingMcp({
      entries: [
        {
          id: 1,
          content: "review:42 approved by reviewer",
          createdAt: "2026-05-12T08:00:00.000Z",
        },
      ],
    });
    const manifestPath = writeManifest({
      groundingMcpCommand: ["node", mcp],
      extraPolicies: [{ name: "audit-before-merge", tagPrefix: "audit" }],
    });

    const { stream: stdout, output: stdoutOut } = captureStream();
    const { stream: stderr } = captureStream();
    const result = await runInterceptCli({
      stdin: streamFrom(JSON.stringify(PR_MERGE_EVENT)),
      stdout,
      stderr,
      configPath: manifestPath,
    });

    expect(result.blocked).toBe(true);
    expect(result.decisions.map((d) => d.outcome)).toEqual(["allow", "deny"]);
    const parsed = JSON.parse(stdoutOut().trim());
    expect(parsed.reason).toContain("audit-before-merge");
  });

  it("degrades ALL matching policies off one cached round-trip when the ledger is unreachable", async () => {
    // Broken mcp + 2 matching policies: the cached degraded summary fans
    // out to every policy as warn-degraded (fail-open by contract), and
    // nothing blocks. Old behavior retried per policy; the pooled client
    // deliberately does not.
    const dir = makeTmpDir("harness-broken-mcp-pool-");
    const brokenScript = path.join(dir, "broken-grounding-mcp.sh");
    fs.writeFileSync(
      brokenScript,
      "#!/bin/sh\necho 'broken-mcp: simulated startup failure' >&2\nexit 1\n",
      "utf8",
    );
    fs.chmodSync(brokenScript, 0o755);
    const manifestPath = writeManifest({
      groundingMcpCommand: [brokenScript],
      extraPolicies: [{ name: "audit-before-merge", tagPrefix: "audit" }],
    });

    const { stream: stdout, output: stdoutOut } = captureStream();
    const { stream: stderr } = captureStream();
    const result = await runInterceptCli({
      stdin: streamFrom(JSON.stringify(PR_MERGE_EVENT)),
      stdout,
      stderr,
      configPath: manifestPath,
    });

    expect(result.blocked).toBe(false);
    expect(stdoutOut()).toBe("");
    expect(result.decisions).toHaveLength(2);
    expect(result.decisions.map((d) => d.outcome)).toEqual([
      "warn-degraded",
      "warn-degraded",
    ]);
  });
});
