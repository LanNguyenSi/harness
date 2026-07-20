// E2E proof that `harness record {review,review-subagent,dogfood}` writes
// content the corresponding gate policy actually accepts — against the real
// `runInterceptCli` intercept path, not against documentation.
//
// Task T-002 (record-verbs): T-001 added the three `record` runners
// (`runRecordReview`, `runRecordReviewSubagent`, `runRecordDogfood`,
// src/cli/record/index.ts) and T-003 wired their `harness record ...` hints
// into the manifest policies' `ux.run`. Neither task proved the two sides
// agree on tag SHAPE: a producer that writes `review:<pr>` prose and a gate
// that requires `review:${PR_NUMBER}` only interoperate if the producer's
// content string actually contains the substring the gate's substring
// matcher (`entryMatches`, src/policies/requires.ts) looks for. This file
// closes that gap the way `tests/e2e/policy-intercept.test.ts` closes the
// manifest -> grounding-mcp spawn gap: it calls the REAL record runner
// (with only the ledger network call swapped for a no-op writer) to obtain
// the exact content string, feeds that string into a fake grounding-mcp as
// a seeded ledger fact, then drives `runInterceptCli` against a manifest
// built from the policies documented in docs/examples/full-manifest.yaml
// (review-before-merge[-bash], review-subagent-before-pr-create[-bash],
// dogfood-before-release). If a future edit changes either side's tag
// format without updating the other, the allow assertions here flip to
// deny and the suite goes red — that is the point of T-002.
//
// The review-before-merge-bash / review-subagent-before-pr-create-bash
// Bash-surface tests also pin issue #408: a review recorded from a feature
// branch (`--base master`) writes a `review:master` fact alongside
// `review:<pr>` and `review:<branch>`, so an operator who checks out the
// base branch before running `gh pr merge` (BRANCH resolves to `master`
// there) is still covered by review-before-merge-bash's
// `review:${BRANCH}` requirement — proven by driving the gate from a
// SEPARATE fake checkout directory whose `.git/HEAD` points at `master`.
//
// No real grounding-mcp process, no wall-clock assertions (the one
// freshness-gated policy, dogfood-before-release's `within: 24h`, is
// satisfied with a fresh `createdAt` set at fixture-build time, never
// asserted on). Bash-surface trigger strings (`gh pr merge`, `gh pr
// create`, `npm publish`) appear only as data inside event fixtures below
// — never as commands this test (or the agent authoring it) executes.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runInterceptCli } from "../../src/cli/policy/intercept.js";
import {
  runRecordDogfood,
  runRecordReview,
  runRecordReviewSubagent,
} from "../../src/cli/record/index.js";
import type { LedgerWriteFn } from "../../src/runtime/ledger-writer.js";

// ---------------------------------------------------------------------------
// Duplicated (not imported) from tests/e2e/policy-intercept.test.ts per the
// task contract: that file is off-limits for edits, so the small hygiene +
// fixture helpers this suite needs are re-declared locally rather than
// exported from the sibling file.
// ---------------------------------------------------------------------------

let cleanups: Array<() => void> = [];
let savedVerboseEnv: string | undefined;

beforeEach(() => {
  // Strip HARNESS_POLICY_VERBOSE so deny-reason assertions hold
  // deterministically regardless of the developer's shell env.
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

interface FakeLedgerEntry {
  id: number;
  content: string;
  createdAt: string;
}

/**
 * Minimal fake `grounding-mcp`: answers `initialize`, `tools/list`
 * (empty), `ledger_summary` (seeded `entries`), and `ledger_add`
 * (acknowledges so `recordPolicyDecisionOnSession` does not time out).
 * Trimmed from `policy-intercept.test.ts`'s version — this suite does not
 * assert invocation counts, only allow/deny outcomes.
 */
function makeFakeGroundingMcp(entries: FakeLedgerEntry[]): string {
  const dir = makeTmpDir("harness-record-e2e-fake-mcp-");
  const file = path.join(dir, "fake-grounding-mcp.js");
  const script = `#!/usr/bin/env node
const FACTS = ${JSON.stringify(entries)};
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
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } }) + "\\n");
    } else if (msg.method === "tools/call" && msg.params) {
      const toolName = msg.params.name;
      if (toolName === "ledger_summary") {
        const payload = {
          sessionId: msg.params.arguments && msg.params.arguments.sessionId,
          counts: { facts: FACTS.length, hypotheses: 0, rejected: 0, unknowns: 0 },
          entries: { facts: FACTS, hypotheses: [], rejected: [], unknowns: [] },
        };
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } }) + "\\n");
      } else if (toolName === "ledger_add") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: '{"ok":true}' }] } }) + "\\n");
      } else {
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

/**
 * Fake checkout directory: just enough of a `.git` entry for
 * `findGitEntry`/`resolveGitContext` (src/runtime/git-context.ts) to read
 * `branch` off `HEAD` — no real git init, no subprocess. Used both by the
 * record runners (branch tag resolution) and by the intercept engine's
 * `${BRANCH}` builtin (resolved from the tool event's `cwd`), so pointing
 * both sides at the SAME directory proves they agree.
 */
function writeGitCheckout(branch: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-record-e2e-checkout-"));
  fs.mkdirSync(path.join(dir, ".git"));
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), `ref: refs/heads/${branch}\n`, "utf8");
  return dir;
}

// Test seam: swap the real ledger network call for a no-op so the record
// runners exercise their full content-building logic (session/branch/base
// resolution, template assembly) without touching a real grounding-mcp.
// `RecordResult.content` carries the exact string that WOULD have been
// written — that string becomes the seeded ledger fact below.
const noopWrite: LedgerWriteFn = async () => ({ ok: true });

// ---------------------------------------------------------------------------
// Manifest fixture: the review-before-merge[-bash], review-subagent-
// before-pr-create[-bash], and dogfood-before-release policies, derived
// from docs/examples/full-manifest.yaml (not reconstructed from memory —
// trigger/requires/ux text below is copied from that file so this suite
// breaks if the source and the fixture ever drift).
//
// `${DOLLAR}` is a JS-template escape hatch: writing a literal `${VAR}`
// YAML template placeholder inside a JS template literal would otherwise
// be parsed as a JS substitution. `${DOLLAR}{VAR}` evaluates the `DOLLAR`
// substitution (producing "$"), immediately followed by the literal text
// "{VAR}" — together they render as the literal four-or-more-character
// string "${VAR}" in the generated YAML. `String.raw` keeps every
// `bash_match` regex's backslashes literal without doubling.
// ---------------------------------------------------------------------------

const DOLLAR = "$";

function writeRecordManifest(groundingMcpCommand: string[]): string {
  const dir = makeTmpDir("harness-record-e2e-manifest-");
  const manifestPath = path.join(dir, "harness.yaml");
  const cmdYaml = groundingMcpCommand.map((s) => JSON.stringify(s)).join(", ");
  const yaml = String.raw`version: 1

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
        timeout_ms: 5000
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
  - name: require-review-evidence
    event: PreToolUse
    match: "mcp__agent-tasks__pull_requests_merge"
    command: /usr/bin/true
    blocking: hard
    budget_ms: 2000

  - name: require-review-evidence-bash
    event: PreToolUse
    match: "Bash"
    command: /usr/bin/true
    blocking: hard
    budget_ms: 2000

  - name: require-review-subagent-evidence
    event: PreToolUse
    match: "mcp__agent-tasks__pull_requests_create"
    command: /usr/bin/true
    blocking: hard
    budget_ms: 2000

  - name: require-review-subagent-evidence-bash
    event: PreToolUse
    match: "Bash"
    command: /usr/bin/true
    blocking: hard
    budget_ms: 2000

  - name: require-dogfood-evidence
    event: PreToolUse
    match: "Bash"
    command: /usr/bin/true
    blocking: hard
    budget_ms: 2000

policies:
  - name: review-before-merge
    description: Block PR merges unless a ledger entry tagged review:<pr-number> exists for this session.
    trigger:
      event: PreToolUse
      match: "mcp__agent-tasks__pull_requests_merge"
      extract:
        PR_NUMBER: "toolArgs.prNumber"
    requires:
      ledger_tag: "review:${DOLLAR}{PR_NUMBER}"
    hook: require-review-evidence
    enforcement: block
    ux:
      cannot: "You cannot merge PR #${DOLLAR}{PR_NUMBER} yet."
      required:
        - "a recorded review of PR #${DOLLAR}{PR_NUMBER}"
      run:
        - 'harness record review --pr ${DOLLAR}{PR_NUMBER} "<summary>"'

  - name: review-before-merge-bash
    description: Block the gh pr merge command unless a ledger entry tagged review:<branch> exists for this session.
    trigger:
      event: PreToolUse
      match: "Bash"
      bash_match: '(^|\n|;|\||&&|\()\s*(\w+=\S+\s+)*gh pr merge\b'
    requires:
      ledger_tag: "review:${DOLLAR}{BRANCH}"
    hook: require-review-evidence-bash
    enforcement: block
    ux:
      cannot: "You cannot merge the PR for branch ${DOLLAR}{BRANCH} via gh pr merge yet."
      required:
        - "a recorded review of the PR for branch ${DOLLAR}{BRANCH}"
      run:
        - 'harness record review --pr <pr> "<summary>"'

  - name: review-subagent-before-pr-create
    description: Block agent-tasks PR creation unless a review-subagent ledger entry tagged for this task already exists.
    trigger:
      event: PreToolUse
      match: "mcp__agent-tasks__pull_requests_create"
      extract:
        TASK_ID: "toolArgs.taskId"
    requires:
      ledger_tag: "review-subagent:${DOLLAR}{TASK_ID}"
    hook: require-review-subagent-evidence
    enforcement: block
    ux:
      cannot: "You cannot open a pull request for task ${DOLLAR}{TASK_ID} yet."
      required:
        - "a completed review-subagent pass on this task"
      run:
        - 'harness record review-subagent --task ${DOLLAR}{TASK_ID} --verdict <verdict>'

  - name: review-subagent-before-pr-create-bash
    description: Block the gh pr create command unless a review-subagent ledger entry tagged review-subagent:<branch> exists for this session.
    trigger:
      event: PreToolUse
      match: "Bash"
      bash_match: '(^|\n|;|\||&&|\()\s*(\w+=\S+\s+)*gh pr create\b'
    requires:
      ledger_tag: "review-subagent:${DOLLAR}{BRANCH}"
    hook: require-review-subagent-evidence-bash
    enforcement: block
    ux:
      cannot: "You cannot open a pull request for branch ${DOLLAR}{BRANCH} via gh pr create yet."
      required:
        - "a completed review-subagent pass on branch ${DOLLAR}{BRANCH}"
      run:
        - 'harness record review-subagent --task <task-id> --verdict <verdict>'

  - name: dogfood-before-release
    description: Block npm publish / git tag v* without a recent dogfood ledger entry.
    trigger:
      event: PreToolUse
      match: "Bash"
      bash_match: '(^|\n|;|\||&&|\()\s*(\w+=\S+\s+)*(npm publish\b|git( -C \S+)* tag v)'
    requires:
      ledger_tag: "dogfood:${DOLLAR}{SESSION_ID}"
      within: 24h
    hook: require-dogfood-evidence
    enforcement: block
    ux:
      cannot: "You cannot publish a release yet."
      required:
        - "an end-to-end dogfood run in this session"
      run:
        - 'harness record dogfood "<was wurde real ausprobiert>"'
`;
  fs.writeFileSync(manifestPath, yaml, "utf8");
  return manifestPath;
}

// A deliberately stale-but-valid timestamp for facts under gates with no
// `within:` window (review-before-merge[-bash], review-subagent-before-
// pr-create[-bash]) — no freshness requirement, so a fixed date keeps the
// fixture non-wall-clock-dependent.
const STALE_ISO = "2026-05-12T08:00:00.000Z";

// ---------------------------------------------------------------------------
// Shared fixtures: fake checkouts + the REAL record-verb content strings,
// built once for the whole file.
// ---------------------------------------------------------------------------

let featureCheckout: string;
let baseCheckout: string;
let reviewContent: string;
let reviewSubagentContent: string;
let dogfoodContent: string;
let dogfoodSessionId: string;

beforeAll(async () => {
  featureCheckout = writeGitCheckout("feature");
  baseCheckout = writeGitCheckout("master");

  // review, MCP+Bash acceptance criteria: --pr 42, feature-branch checkout,
  // --base master (explicit, so no origin/HEAD filesystem fallback needed).
  const reviewResult = await runRecordReview({
    pr: "42",
    base: "master",
    cwd: featureCheckout,
    summary: "LGTM overall; two nits addressed inline, no blocking findings.",
    session: "e2e-sess-review",
    writeLedger: noopWrite,
  });
  if (!reviewResult.wrote) {
    throw new Error(`fixture setup: runRecordReview did not write: ${reviewResult.reason}`);
  }
  reviewContent = reviewResult.content;

  // review-subagent acceptance criterion: --task T-123, same feature
  // checkout so its BRANCH-tagged fact reuses the same directory the
  // Bash-surface gate test resolves BRANCH from.
  const subagentResult = await runRecordReviewSubagent({
    task: "T-123",
    verdict: "approve",
    cwd: featureCheckout,
    summary: "No blocking findings on the staged diff.",
    session: "e2e-sess-review",
    writeLedger: noopWrite,
  });
  if (!subagentResult.wrote) {
    throw new Error(
      `fixture setup: runRecordReviewSubagent did not write: ${subagentResult.reason}`,
    );
  }
  reviewSubagentContent = subagentResult.content;

  // dogfood acceptance criterion: session-tagged, no branch involved.
  dogfoodSessionId = "e2e-sess-dogfood";
  const dogfoodResult = await runRecordDogfood({
    summary:
      "Drove a live PreToolUse allow and a live PreToolUse deny through the real intercept path against a fake grounding-mcp.",
    session: dogfoodSessionId,
    writeLedger: noopWrite,
  });
  if (!dogfoodResult.wrote) {
    throw new Error(`fixture setup: runRecordDogfood did not write: ${dogfoodResult.reason}`);
  }
  dogfoodContent = dogfoodResult.content;
});

afterAll(() => {
  fs.rmSync(featureCheckout, { recursive: true, force: true });
  fs.rmSync(baseCheckout, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// review-before-merge / review-before-merge-bash
// ---------------------------------------------------------------------------

describe("harness record review -> review-before-merge[-bash] gate", () => {
  it("allows pull_requests_merge (MCP surface) once the recorded review:<pr> fact is on the ledger", async () => {
    const mcp = makeFakeGroundingMcp([
      { id: 1, content: reviewContent, createdAt: STALE_ISO },
    ]);
    const manifestPath = writeRecordManifest(["node", mcp]);
    const { stream: stdout, output: stdoutOut } = captureStream();
    const { stream: stderr } = captureStream();

    const event = {
      hook_event_name: "PreToolUse",
      tool_name: "mcp__agent-tasks__pull_requests_merge",
      tool_input: { prNumber: 42, owner: "LanNguyenSi", repo: "harness" },
      session_id: "e2e-sess-review",
      cwd: featureCheckout,
    };
    const result = await runInterceptCli({
      stdin: streamFrom(JSON.stringify(event)),
      stdout,
      stderr,
      configPath: manifestPath,
    });

    expect(result.blocked).toBe(false);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.outcome).toBe("allow");
    expect(stdoutOut()).toBe("");
  });

  it("allows gh pr merge (Bash surface) run from the BASE checkout using the SAME review fact (#408)", async () => {
    // Same fact as the MCP-surface test above: the review was recorded
    // from the feature branch with --base master, so its content contains
    // review:master alongside review:42 and review:feature. Driving the
    // gate from a checkout whose HEAD is master (BRANCH resolves to
    // master, not feature) proves review:<base> covers an operator who
    // switches to the base branch before running `gh pr merge`.
    const mcp = makeFakeGroundingMcp([
      { id: 1, content: reviewContent, createdAt: STALE_ISO },
    ]);
    const manifestPath = writeRecordManifest(["node", mcp]);
    const { stream: stdout, output: stdoutOut } = captureStream();
    const { stream: stderr } = captureStream();

    const event = {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "gh pr merge 42 --squash" },
      session_id: "e2e-sess-review",
      cwd: baseCheckout,
    };
    const result = await runInterceptCli({
      stdin: streamFrom(JSON.stringify(event)),
      stdout,
      stderr,
      configPath: manifestPath,
    });

    expect(result.blocked).toBe(false);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.outcome).toBe("allow");
    expect(stdoutOut()).toBe("");
  });

  it("denies pull_requests_merge (MCP surface) on an empty ledger, with the harness record review hint", async () => {
    const mcp = makeFakeGroundingMcp([]);
    const manifestPath = writeRecordManifest(["node", mcp]);
    const { stream: stdout, output: stdoutOut } = captureStream();
    const { stream: stderr } = captureStream();

    const event = {
      hook_event_name: "PreToolUse",
      tool_name: "mcp__agent-tasks__pull_requests_merge",
      tool_input: { prNumber: 42, owner: "LanNguyenSi", repo: "harness" },
      session_id: "e2e-sess-review",
      cwd: featureCheckout,
    };
    const result = await runInterceptCli({
      stdin: streamFrom(JSON.stringify(event)),
      stdout,
      stderr,
      configPath: manifestPath,
    });

    expect(result.blocked).toBe(true);
    const parsed = JSON.parse(stdoutOut().trim());
    expect(parsed.decision).toBe("block");
    expect(parsed.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(parsed.reason).toContain('harness record review --pr 42 "<summary>"');
  });

  it("denies gh pr merge (Bash surface) on an empty ledger, with the harness record review hint", async () => {
    const mcp = makeFakeGroundingMcp([]);
    const manifestPath = writeRecordManifest(["node", mcp]);
    const { stream: stdout, output: stdoutOut } = captureStream();
    const { stream: stderr } = captureStream();

    const event = {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "gh pr merge 42 --squash" },
      session_id: "e2e-sess-review",
      cwd: baseCheckout,
    };
    const result = await runInterceptCli({
      stdin: streamFrom(JSON.stringify(event)),
      stdout,
      stderr,
      configPath: manifestPath,
    });

    expect(result.blocked).toBe(true);
    const parsed = JSON.parse(stdoutOut().trim());
    expect(parsed.decision).toBe("block");
    expect(parsed.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(parsed.reason).toContain('harness record review --pr <pr> "<summary>"');
  });
});

// ---------------------------------------------------------------------------
// review-subagent-before-pr-create / review-subagent-before-pr-create-bash
// ---------------------------------------------------------------------------

describe("harness record review-subagent -> review-subagent-before-pr-create[-bash] gate", () => {
  it("allows pull_requests_create (MCP surface) once the recorded review-subagent:<task> fact is on the ledger", async () => {
    const mcp = makeFakeGroundingMcp([
      { id: 1, content: reviewSubagentContent, createdAt: STALE_ISO },
    ]);
    const manifestPath = writeRecordManifest(["node", mcp]);
    const { stream: stdout, output: stdoutOut } = captureStream();
    const { stream: stderr } = captureStream();

    const event = {
      hook_event_name: "PreToolUse",
      tool_name: "mcp__agent-tasks__pull_requests_create",
      tool_input: { taskId: "T-123", title: "record-verbs E2E fixture PR" },
      session_id: "e2e-sess-review",
      cwd: featureCheckout,
    };
    const result = await runInterceptCli({
      stdin: streamFrom(JSON.stringify(event)),
      stdout,
      stderr,
      configPath: manifestPath,
    });

    expect(result.blocked).toBe(false);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.outcome).toBe("allow");
    expect(stdoutOut()).toBe("");
  });

  it("allows gh pr create (Bash surface) once the SAME fact's review-subagent:<branch> token matches", async () => {
    const mcp = makeFakeGroundingMcp([
      { id: 1, content: reviewSubagentContent, createdAt: STALE_ISO },
    ]);
    const manifestPath = writeRecordManifest(["node", mcp]);
    const { stream: stdout, output: stdoutOut } = captureStream();
    const { stream: stderr } = captureStream();

    const event = {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: 'gh pr create --title "record-verbs E2E" --body "fixture"' },
      session_id: "e2e-sess-review",
      cwd: featureCheckout,
    };
    const result = await runInterceptCli({
      stdin: streamFrom(JSON.stringify(event)),
      stdout,
      stderr,
      configPath: manifestPath,
    });

    expect(result.blocked).toBe(false);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.outcome).toBe("allow");
    expect(stdoutOut()).toBe("");
  });

  it("denies pull_requests_create (MCP surface) on an empty ledger, with the harness record review-subagent hint", async () => {
    const mcp = makeFakeGroundingMcp([]);
    const manifestPath = writeRecordManifest(["node", mcp]);
    const { stream: stdout, output: stdoutOut } = captureStream();
    const { stream: stderr } = captureStream();

    const event = {
      hook_event_name: "PreToolUse",
      tool_name: "mcp__agent-tasks__pull_requests_create",
      tool_input: { taskId: "T-123", title: "record-verbs E2E fixture PR" },
      session_id: "e2e-sess-review",
      cwd: featureCheckout,
    };
    const result = await runInterceptCli({
      stdin: streamFrom(JSON.stringify(event)),
      stdout,
      stderr,
      configPath: manifestPath,
    });

    expect(result.blocked).toBe(true);
    const parsed = JSON.parse(stdoutOut().trim());
    expect(parsed.decision).toBe("block");
    expect(parsed.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(parsed.reason).toContain("harness record review-subagent --task T-123 --verdict <verdict>");
  });

  it("denies gh pr create (Bash surface) on an empty ledger, with the harness record review-subagent hint", async () => {
    const mcp = makeFakeGroundingMcp([]);
    const manifestPath = writeRecordManifest(["node", mcp]);
    const { stream: stdout, output: stdoutOut } = captureStream();
    const { stream: stderr } = captureStream();

    const event = {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: 'gh pr create --title "record-verbs E2E" --body "fixture"' },
      session_id: "e2e-sess-review",
      cwd: featureCheckout,
    };
    const result = await runInterceptCli({
      stdin: streamFrom(JSON.stringify(event)),
      stdout,
      stderr,
      configPath: manifestPath,
    });

    expect(result.blocked).toBe(true);
    const parsed = JSON.parse(stdoutOut().trim());
    expect(parsed.decision).toBe("block");
    expect(parsed.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(parsed.reason).toContain(
      "harness record review-subagent --task <task-id> --verdict <verdict>",
    );
  });
});

// ---------------------------------------------------------------------------
// dogfood-before-release
// ---------------------------------------------------------------------------

describe("harness record dogfood -> dogfood-before-release gate", () => {
  it("allows a release trigger (Bash surface) once the recorded dogfood:<session> fact is on the ledger", async () => {
    // within: 24h — a fresh createdAt is fixture setup (satisfying the
    // gate's precondition), not an assertion on elapsed time.
    const mcp = makeFakeGroundingMcp([
      { id: 1, content: dogfoodContent, createdAt: new Date().toISOString() },
    ]);
    const manifestPath = writeRecordManifest(["node", mcp]);
    const { stream: stdout, output: stdoutOut } = captureStream();
    const { stream: stderr } = captureStream();
    const releaseCwd = makeTmpDir("harness-record-e2e-non-git-");

    const event = {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm publish" },
      session_id: dogfoodSessionId,
      cwd: releaseCwd,
    };
    const result = await runInterceptCli({
      stdin: streamFrom(JSON.stringify(event)),
      stdout,
      stderr,
      configPath: manifestPath,
    });

    expect(result.blocked).toBe(false);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.outcome).toBe("allow");
    expect(stdoutOut()).toBe("");
  });

  it("denies a release trigger on an empty ledger, with the harness record dogfood hint", async () => {
    const mcp = makeFakeGroundingMcp([]);
    const manifestPath = writeRecordManifest(["node", mcp]);
    const { stream: stdout, output: stdoutOut } = captureStream();
    const { stream: stderr } = captureStream();
    const releaseCwd = makeTmpDir("harness-record-e2e-non-git-");

    const event = {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm publish" },
      session_id: dogfoodSessionId,
      cwd: releaseCwd,
    };
    const result = await runInterceptCli({
      stdin: streamFrom(JSON.stringify(event)),
      stdout,
      stderr,
      configPath: manifestPath,
    });

    expect(result.blocked).toBe(true);
    const parsed = JSON.parse(stdoutOut().trim());
    expect(parsed.decision).toBe("block");
    expect(parsed.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(parsed.reason).toContain('harness record dogfood "<was wurde real ausprobiert>"');
  });
});
