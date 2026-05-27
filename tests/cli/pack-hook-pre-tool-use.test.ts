import { Readable, Writable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPackHookPreToolUseCli } from "../../src/cli/pack/hook-pre-tool-use.js";
import type { LedgerEntry } from "../../src/policies/index.js";
import {
  writeActiveClaim,
  writeApprovalMarker,
  writeTaskApprovalMarker,
} from "../../src/policy-packs/builtin/understanding-before-execution-runtime.js";
import { readPendingApproval } from "../../src/runtime/pending-approval.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

let tmp: string;
let savedClaude: string | undefined;
let savedClaudeCode: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ug-blocker-"));
  // The hook reads both env vars as session-id fallbacks; clear them so
  // the dev host's $CLAUDE_CODE_SESSION_ID doesn't make tests that
  // expect "no session_id" path fall into the env-fallback branch.
  savedClaude = process.env.CLAUDE_SESSION_ID;
  savedClaudeCode = process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (savedClaude === undefined) delete process.env.CLAUDE_SESSION_ID;
  else process.env.CLAUDE_SESSION_ID = savedClaude;
  if (savedClaudeCode === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = savedClaudeCode;
});

function manifestWithPack(enabled = true): Manifest {
  return parseManifest({
    version: 1,
    policy_packs: [
      { name: "understanding-before-execution", enabled },
    ],
  });
}

function readableFromString(s: string): Readable {
  const r = new Readable();
  r.push(s);
  r.push(null);
  return r;
}

function bufferStream(): { stream: Writable; read: () => string } {
  let buf = "";
  const stream = new Writable({
    write(chunk, _enc, cb): void {
      buf += chunk.toString();
      cb();
    },
  });
  return { stream, read: () => buf };
}

const event = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({ session_id: "sess-1", tool_name: "Edit", ...overrides });

function writeReport(dir: string, name: string, body: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), `${JSON.stringify(body, null, 2)}\n`);
}

describe("pack hook pre-tool-use blocker", () => {
  it("allows a read-only Bash command without an approved Understanding Report", async () => {
    // `git status` mutates nothing. Hard-blocking it behind a full
    // Understanding Report cycle trains the agent and operator to
    // experience the gate as noise, which erodes its credibility on
    // the writes that actually matter.
    const stdout = bufferStream();
    const stderr = bufferStream();
    const result = await runPackHookPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        JSON.stringify({
          session_id: "sess-1",
          tool_name: "Bash",
          tool_input: { command: "git status" },
        }),
      ),
      stdout: stdout.stream,
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir: path.join(tmp, "harness.generated"),
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(false);
    expect(result.approvalCheck.source).toBe("none");
    expect(stdout.read()).toBe("");
    expect(stderr.read()).toMatch(/read-only Bash command, allowing/);
  });

  it("blocks a mutating Bash command even with the classifier in place", async () => {
    // `git push` is a write. The classifier must not authorize it
    // just because `git` appears at the front — only explicit
    // read-only subcommands pass.
    const stdout = bufferStream();
    const stderr = bufferStream();
    const result = await runPackHookPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        JSON.stringify({
          session_id: "sess-1",
          tool_name: "Bash",
          tool_input: { command: "git push origin master" },
        }),
      ),
      stdout: stdout.stream,
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir: path.join(tmp, "harness.generated"),
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(true);
    expect(stderr.read()).toMatch(/BLOCK/);
  });

  it("blocks a Bash command with shell chaining (fail-closed)", async () => {
    // The classifier rejects any shell metachar that could hide a
    // write. `git status; rm -rf /` would otherwise look read-only at
    // its first token.
    const stdout = bufferStream();
    const stderr = bufferStream();
    const result = await runPackHookPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        JSON.stringify({
          session_id: "sess-1",
          tool_name: "Bash",
          tool_input: { command: "git status; rm -rf /tmp/foo" },
        }),
      ),
      stdout: stdout.stream,
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir: path.join(tmp, "harness.generated"),
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(true);
  });

  it("blocks Edit even if the classifier would allow a parallel Bash command", async () => {
    // Edit is hard-blocked regardless. The classifier only fires on
    // tool_name === "Bash".
    const stdout = bufferStream();
    const stderr = bufferStream();
    const result = await runPackHookPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        JSON.stringify({
          session_id: "sess-1",
          tool_name: "Edit",
          tool_input: { command: "git status" },
        }),
      ),
      stdout: stdout.stream,
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir: path.join(tmp, "harness.generated"),
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(true);
  });

  it("emits a loud stderr diagnostic when stdin is malformed JSON (fail-loud, not silent-allow)", async () => {
    // Failure mode is still "allow" — a runtime that can't even parse
    // the hook envelope shouldn't brick the session — but it MUST be
    // visible to the operator. A silent allow on a broken contract is
    // the canonical false-confidence failure for a governance hook.
    const stdout = bufferStream();
    const stderr = bufferStream();
    const result = await runPackHookPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString("{this-is-not-json"),
      stdout: stdout.stream,
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir: path.join(tmp, "harness.generated"),
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(false);
    expect(stderr.read()).toMatch(/malformed event JSON on stdin/);
  });

  it("allows when active-claim names an approved task, even from a different session id (harness/1ee26e77 + PR #198 scope)", async () => {
    // Operator approved via `harness approve understanding --task <id>`
    // from a previous session; the task marker is keyed by task id, not
    // by the current session id, so the gate accepts it across sessions
    // for as long as the active-claim still names that same task.
    const stdout = bufferStream();
    const stderr = bufferStream();
    const generatedDir = path.join(tmp, "harness.generated");
    writeActiveClaim(generatedDir, "task-uuid-abc");
    writeTaskApprovalMarker(generatedDir, "task-uuid-abc", {
      approvedAt: "2026-05-18T08:00:00Z",
      approvedBy: "test-operator",
    });
    const result = await runPackHookPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(event({ session_id: "sess-different" })),
      stdout: stdout.stream,
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(false);
    expect(result.approvalCheck.source).toBe("marker");
    expect(stdout.read()).toBe("");
    expect(stderr.read()).toMatch(/task-scoped marker for active-claim task-uuid-abc/);
  });

  it("BLOCKS when a marker exists for a DIFFERENT task than the active-claim (PR #198 security pin)", async () => {
    // The pre-#198 contract was "any fresh task marker satisfies the
    // gate". This let a stale approval from a finished task silently
    // authorise every Edit/Write/Bash in the next session. The fix
    // requires the marker to match the currently-claimed task.
    const stdout = bufferStream();
    const stderr = bufferStream();
    const generatedDir = path.join(tmp, "harness.generated");
    writeActiveClaim(generatedDir, "task-current");
    writeTaskApprovalMarker(generatedDir, "task-stale-from-yesterday", {
      approvedAt: new Date(Date.now() - 60 * 1000).toISOString(),
      approvedBy: "test-operator",
    });
    const result = await runPackHookPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(event()),
      stdout: stdout.stream,
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(true);
    expect(result.approvalCheck.source).toBe("none");
    // Sibling task marker must not appear in any allow-path diagnostic.
    const stderrText = stderr.read();
    expect(stderrText).not.toMatch(/marker for active-claim task-stale-from-yesterday/);
    expect(stderrText).not.toMatch(/marker for task task-stale-from-yesterday/);
  });

  it("falls through from task-scoped to session-scoped marker check (legacy compat)", async () => {
    // No task markers present, session marker present → gate allows via
    // the legacy session path. Pins the fall-through ordering.
    const stdout = bufferStream();
    const stderr = bufferStream();
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-1", {
      approvedAt: "2026-05-18T08:00:00Z",
      approvedBy: "test-operator",
    });
    const result = await runPackHookPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(event()),
      stdout: stdout.stream,
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(false);
    expect(result.approvalCheck.source).toBe("marker");
    expect(stderr.read()).toMatch(/approved via marker sess-1/);
  });

  it("ignores a stale sibling marker even when the active-claim task is approved (max_age applies per-claim)", async () => {
    // Active-claim points at task-fresh, which has a fresh marker.
    // A stale task-old marker also exists, but the new check only
    // consults the active-claim's marker — the sibling marker should
    // not influence the decision either way (pre-#198 this scan
    // returned the first match across all task markers).
    const stdout = bufferStream();
    const stderr = bufferStream();
    const generatedDir = path.join(tmp, "harness.generated");
    writeActiveClaim(generatedDir, "task-fresh");
    writeTaskApprovalMarker(generatedDir, "task-old", {
      approvedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      approvedBy: "test-operator",
    });
    writeTaskApprovalMarker(generatedDir, "task-fresh", {
      approvedAt: new Date(Date.now() - 60 * 1000).toISOString(),
      approvedBy: "test-operator",
    });
    const result = await runPackHookPreToolUseCli({
      manifest: parseManifest({
        version: 1,
        policy_packs: [
          {
            name: "understanding-before-execution",
            enabled: true,
            config: {
              approval_lifecycle: { max_age: "4h" },
            },
          },
        ],
      }),
      stdin: readableFromString(event()),
      stdout: stdout.stream,
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(false);
    expect(result.approvalCheck.source).toBe("marker");
    expect(stderr.read()).toMatch(/task-scoped marker for active-claim task-fresh/);
  });

  it("blocks when active-claim's task marker is STALE (max_age exceeded)", async () => {
    const stdout = bufferStream();
    const stderr = bufferStream();
    const generatedDir = path.join(tmp, "harness.generated");
    writeActiveClaim(generatedDir, "task-stale");
    // Marker approved 24h ago.
    writeTaskApprovalMarker(generatedDir, "task-stale", {
      approvedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      approvedBy: "test-operator",
    });
    const result = await runPackHookPreToolUseCli({
      manifest: parseManifest({
        version: 1,
        policy_packs: [
          {
            name: "understanding-before-execution",
            enabled: true,
            config: {
              approval_lifecycle: { max_age: "4h" },
            },
          },
        ],
      }),
      stdin: readableFromString(event()),
      stdout: stdout.stream,
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(true);
    expect(result.approvalCheck.source).toBe("none");
  });

  it("allows when an approval marker is present for the session (agent-tasks/88ca4bb3)", async () => {
    const stdout = bufferStream();
    const stderr = bufferStream();
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-1", {
      approvedAt: "2026-05-07T08:00:00Z",
      approvedBy: "test-operator",
    });
    const result = await runPackHookPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(event()),
      stdout: stdout.stream,
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(false);
    expect(result.approvalCheck.source).toBe("marker");
    expect(stdout.read()).toBe("");
    expect(stderr.read()).toMatch(/approved via marker sess-1/);
  });

  it("agent self-approval via MCP ledger_add does not satisfy the gate (agent-tasks/88ca4bb3, headline security test)", async () => {
    // Threat model: an agent with grounding-MCP wired can call
    // ledger_add and write `understanding-approved:<sid>` for its own
    // session id. Pre-v0.14.0 that row alone unblocked the gate. This
    // test pins the new boundary: the row is still in the ledger (and
    // surfaces in the diagnostic for forensics), but the gate blocks
    // because no operator wrote the marker file.
    const stdout = bufferStream();
    const stderr = bufferStream();
    const generatedDir = path.join(tmp, "harness.generated");
    const result = await runPackHookPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(event()),
      stdout: stdout.stream,
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir,
      // Agent self-write: same shape ledger_add would emit.
      ledgerQuery: async (sessionId): Promise<LedgerEntry[]> => [
        {
          id: "agent-self-write",
          content: `understanding-approved:${sessionId}`,
          source: "mcp",
          createdAt: "2026-05-15T12:00:00Z",
        },
      ],
    });
    expect(result.blocked).toBe(true);
    expect(result.approvalCheck.source).toBe("none");
    const stderrText = stderr.read();
    expect(stderrText).toContain("no approval marker for session sess-1");
    expect(stderrText).toContain("audit: ledger tag understanding-approved:sess-1");
    expect(stderrText).toContain("no longer satisfies the gate");
  });

  it("ledger entry ALONE does not approve (closes the self-approval backdoor, agent-tasks/88ca4bb3)", async () => {
    // Pre-v0.14.0 contract: any `understanding-approved:<sid>` row in
    // the ledger unblocked the gate. Because the agent has direct MCP
    // access to that ledger, it could self-approve. The marker file
    // (which Edit / Write / Bash all cannot reach) is now the canonical
    // signal; the ledger row remains for forensics but no longer
    // satisfies on its own.
    const stdout = bufferStream();
    const stderr = bufferStream();
    const generatedDir = path.join(tmp, "harness.generated");
    const result = await runPackHookPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(event()),
      stdout: stdout.stream,
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir,
      ledgerQuery: async (sessionId): Promise<LedgerEntry[]> => [
        {
          id: "1",
          content: `understanding-approved:${sessionId}`,
          createdAt: "2026-05-07T08:00:00Z",
        },
      ],
    });
    expect(result.blocked).toBe(true);
    expect(result.approvalCheck.source).toBe("none");
    expect(stderr.read()).toMatch(/no approval marker for session sess-1/);
    expect(stderr.read()).toMatch(/no longer satisfies the gate/);
  });

  it("falls back to persisted report when ledger has no match", async () => {
    const reportsDir = path.join(tmp, "reports");
    writeReport(reportsDir, "rpt.json", {
      sessionId: "sess-1",
      approvalStatus: "approved",
      approvedAt: "2026-05-07T08:00:00Z",
    });
    const stdout = bufferStream();
    const stderr = bufferStream();
    const result = await runPackHookPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(event()),
      stdout: stdout.stream,
      stderr: stderr.stream,
      reportsDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(false);
    expect(result.approvalCheck.source).toBe("persisted-report");
    expect(stdout.read()).toBe("");
  });

  it("does NOT match a tag for a different session id", async () => {
    const stdout = bufferStream();
    const stderr = bufferStream();
    const result = await runPackHookPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(event()), // session_id: sess-1
      stdout: stdout.stream,
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      ledgerQuery: async (): Promise<LedgerEntry[]> => [
        {
          id: "1",
          content: "understanding-approved:other-session",
          createdAt: "2026-05-07T08:00:00Z",
        },
      ],
    });
    expect(result.blocked).toBe(true);
    expect(stderr.read()).toMatch(/no ledger entry matched understanding-approved:sess-1/);
  });

  it("ignores policy_decision rows that happen to contain the approval substring", async () => {
    // Substring-pollution defence: a policy_decision payload with the
    // approval tag embedded in its reason field must NOT match.
    const stdout = bufferStream();
    const stderr = bufferStream();
    const result = await runPackHookPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(event()),
      stdout: stdout.stream,
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      ledgerQuery: async (): Promise<LedgerEntry[]> => [
        {
          id: "1",
          type: "policy_decision",
          content:
            'policy_decision:something:deny {"reason":"User cited understanding-approved:sess-1 but no actual approval row"}',
          createdAt: "2026-05-07T08:00:00Z",
        },
        // Same payload without the typed flag, to exercise the
        // legacy-prefix backstop.
        {
          id: "2",
          content:
            'policy_decision:legacy {"reason":"understanding-approved:sess-1 just text"}',
          createdAt: "2026-05-07T08:00:01Z",
        },
      ],
    });
    expect(result.blocked).toBe(true);
    expect(stderr.read()).toMatch(/scanned 0 non-policy_decision row/);
  });

  it("blocks when neither source approves", async () => {
    const stdout = bufferStream();
    const stderr = bufferStream();
    const result = await runPackHookPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(event()),
      stdout: stdout.stream,
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(true);
    const decision = JSON.parse(stdout.read().trim()) as {
      decision: string;
      reason: string;
      hookSpecificOutput?: {
        hookEventName?: string;
        permissionDecision?: string;
        permissionDecisionReason?: string;
      };
    };
    expect(decision.decision).toBe("block");
    expect(decision.reason).toMatch(/Understanding Gate/);
    expect(decision.reason).toMatch(/harness approve understanding/);
    // Claude Code 2.1+ envelope: mirrors PR #81 in runtime/intercept.ts.
    expect(decision.hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: decision.reason,
    });
    expect(stderr.read()).toMatch(/BLOCK/);
  });

  it("renders config.producers into the deny envelope (agent-tasks/25bced52)", async () => {
    const stdout = bufferStream();
    const stderr = bufferStream();
    // Manifest that exercises the config.producers extension. The
    // engine validates at-least-one-ask and substitutes ${SESSION_ID}.
    const manifest = parseManifest({
      version: 1,
      policy_packs: [
        {
          name: "understanding-before-execution",
          enabled: true,
          config: {
            mode: "grill_me",
            producers: [
              {
                kind: "ask",
                command: "harness approve understanding",
                description: "Bare command. Operator approval IS the gate satisfaction.",
              },
              {
                kind: "bash",
                command: "harness approve understanding",
                description: "From un-hooked terminal. Writes marker at .approvals/${SESSION_ID}.",
              },
            ],
          },
        },
      ],
    });
    const result = await runPackHookPreToolUseCli({
      manifest,
      stdin: readableFromString(event()),
      stdout: stdout.stream,
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(true);
    const decision = JSON.parse(stdout.read().trim()) as { reason: string };
    expect(decision.reason).toMatch(/Understanding Gate/);
    expect(decision.reason).toMatch(/harness approve understanding/);
    // New: producer block appended with substituted ${SESSION_ID}.
    expect(decision.reason).toContain("To produce this tag:");
    expect(decision.reason).toContain("1. [ask]  `harness approve understanding`");
    expect(decision.reason).toContain("2. [bash] `harness approve understanding`");
    expect(decision.reason).toContain(".approvals/sess-1");
    // Suffix comes BEFORE producer block.
    expect(decision.reason.indexOf("Run `harness approve")).toBeLessThan(
      decision.reason.indexOf("To produce this tag:"),
    );
    // Schema hint enumerates the parser's required sections so the agent
    // can produce a parser-acceptable report on the first try (task 5ec5772d).
    expect(decision.reason).toContain("Current Understanding");
    expect(decision.reason).toContain("Intended Outcome");
    expect(decision.reason).toContain("Derived Todos");
    expect(decision.reason).toContain("Acceptance Criteria");
    expect(decision.reason).toContain("Assumptions");
    expect(decision.reason).toContain("Open Questions");
    expect(decision.reason).toContain("Out Of Scope");
    expect(decision.reason).toContain("Risks");
    expect(decision.reason).toContain("Verification Plan");
    // Hint sits between suffix and producer block, in that order.
    expect(decision.reason.indexOf("Report format")).toBeGreaterThan(
      decision.reason.indexOf("Run `harness approve"),
    );
    expect(decision.reason.indexOf("Report format")).toBeLessThan(
      decision.reason.indexOf("To produce this tag:"),
    );
  });

  it("rejects malformed config.producers and falls back to legacy envelope", async () => {
    const stdout = bufferStream();
    const stderr = bufferStream();
    // producers: bash-only (no ask) violates the at-least-one-ask
    // constraint for the understanding-gate. The hook should log the
    // rejection to stderr and emit the legacy deny envelope without
    // the producer block.
    const manifest = parseManifest({
      version: 1,
      policy_packs: [
        {
          name: "understanding-before-execution",
          enabled: true,
          config: {
            mode: "grill_me",
            producers: [
              { kind: "bash", command: "harness approve understanding", description: "bash only" },
            ],
          },
        },
      ],
    });
    const result = await runPackHookPreToolUseCli({
      manifest,
      stdin: readableFromString(event()),
      stdout: stdout.stream,
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(true);
    const decision = JSON.parse(stdout.read().trim()) as { reason: string };
    expect(decision.reason).not.toContain("To produce this tag:");
    expect(stderr.read()).toMatch(/config\.producers ignored/);
  });

  it("treats a degraded ledger as no-match (still falls through to report)", async () => {
    const reportsDir = path.join(tmp, "reports");
    writeReport(reportsDir, "rpt.json", {
      sessionId: "sess-1",
      approvalStatus: "approved",
    });
    const stdout = bufferStream();
    const stderr = bufferStream();
    const result = await runPackHookPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(event()),
      stdout: stdout.stream,
      stderr: stderr.stream,
      reportsDir,
      ledgerQuery: async (): Promise<{ degraded: string }> => ({
        degraded: "grounding-mcp not declared in manifest",
      }),
    });
    expect(result.blocked).toBe(false);
    expect(result.approvalCheck.source).toBe("persisted-report");
  });

  it("allows when the pack is enabled:false", async () => {
    const stdout = bufferStream();
    const stderr = bufferStream();
    const result = await runPackHookPreToolUseCli({
      manifest: manifestWithPack(false),
      stdin: readableFromString(event()),
      stdout: stdout.stream,
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
    });
    expect(result.blocked).toBe(false);
    expect(stderr.read()).toMatch(/enabled:false/);
  });

  it("allows when no session_id is resolvable", async () => {
    const stdout = bufferStream();
    const stderr = bufferStream();
    const before = process.env.CLAUDE_SESSION_ID;
    const beforeCode = process.env.CLAUDE_CODE_SESSION_ID;
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    try {
      const result = await runPackHookPreToolUseCli({
        manifest: manifestWithPack(),
        stdin: readableFromString("{}"),
        stdout: stdout.stream,
        stderr: stderr.stream,
        reportsDir: path.join(tmp, "no-reports"),
      });
      expect(result.blocked).toBe(false);
      expect(stderr.read()).toMatch(/no session_id resolvable/);
    } finally {
      if (before !== undefined) process.env.CLAUDE_SESSION_ID = before;
      if (beforeCode !== undefined) process.env.CLAUDE_CODE_SESSION_ID = beforeCode;
    }
  });

  it("resolves session_id from $CLAUDE_CODE_SESSION_ID when the event omits it", async () => {
    // Regression for task 6562b9f6: pre-fix this hook only fell back to
    // $CLAUDE_SESSION_ID, the var Claude Code does NOT export.
    const stdout = bufferStream();
    const stderr = bufferStream();
    const before = process.env.CLAUDE_SESSION_ID;
    const beforeCode = process.env.CLAUDE_CODE_SESSION_ID;
    delete process.env.CLAUDE_SESSION_ID;
    process.env.CLAUDE_CODE_SESSION_ID = "code-env-sess";
    try {
      const result = await runPackHookPreToolUseCli({
        manifest: manifestWithPack(),
        // No session_id in the event envelope.
        stdin: readableFromString(JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } })),
        stdout: stdout.stream,
        stderr: stderr.stream,
        reportsDir: path.join(tmp, "no-reports"),
      });
      // The "no session_id resolvable" branch must NOT fire — the env
      // fallback supplied the id.
      expect(stderr.read()).not.toMatch(/no session_id resolvable/);
      expect(result.blocked).toBeDefined();
    } finally {
      if (before !== undefined) process.env.CLAUDE_SESSION_ID = before;
      else delete process.env.CLAUDE_SESSION_ID;
      if (beforeCode !== undefined) process.env.CLAUDE_CODE_SESSION_ID = beforeCode;
      else delete process.env.CLAUDE_CODE_SESSION_ID;
    }
  });

  it("allows when the pack is not declared in the manifest", async () => {
    const stdout = bufferStream();
    const stderr = bufferStream();
    const result = await runPackHookPreToolUseCli({
      manifest: parseManifest({ version: 1 }),
      stdin: readableFromString(event()),
      stdout: stdout.stream,
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
    });
    expect(result.blocked).toBe(false);
    expect(stderr.read()).toMatch(/not declared in manifest/);
  });
});

describe("pack hook pre-tool-use blocker — operator-approval escape commands (task 367fb12f)", () => {
  type Decision = {
    decision?: string;
    hookSpecificOutput?: { hookEventName?: string; permissionDecision?: string };
  };

  it("asks (not denies) for `harness approve understanding` when no source approves", async () => {
    const stdout = bufferStream();
    const stderr = bufferStream();
    const result = await runPackHookPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        event({ tool_name: "Bash", tool_input: { command: "harness approve understanding" } }),
      ),
      stdout: stdout.stream,
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(false);
    expect(result.asked).toBe(true);
    const decision = JSON.parse(stdout.read().trim()) as Decision;
    // PreToolUse "ask" envelope: no legacy top-level `decision` (that would
    // hard-block legacy 2.0.x CLIs), just the hookSpecificOutput nesting.
    expect(decision.decision).toBeUndefined();
    expect(decision.hookSpecificOutput?.permissionDecision).toBe("ask");
    expect(decision.hookSpecificOutput?.hookEventName).toBe("PreToolUse");
    expect(stderr.read()).toMatch(/ASK/);
  });

  it("hard-denies an escape command carrying substitution or redirection", async () => {
    for (const command of [
      "harness approve understanding $(whoami)",
      "harness approve understanding `id`",
      "harness approve understanding > /etc/x",
      "harness approve understanding < /etc/shadow",
    ]) {
      const stdout = bufferStream();
      const stderr = bufferStream();
      const result = await runPackHookPreToolUseCli({
        manifest: manifestWithPack(),
        stdin: readableFromString(event({ tool_name: "Bash", tool_input: { command } })),
        stdout: stdout.stream,
        stderr: stderr.stream,
        reportsDir: path.join(tmp, "no-reports"),
        ledgerQuery: async (): Promise<LedgerEntry[]> => [],
      });
      expect(result.blocked, command).toBe(true);
      expect(result.asked, command).toBeFalsy();
    }
  });

  it("hard-denies a chained command even when it starts with an escape command", async () => {
    const stdout = bufferStream();
    const stderr = bufferStream();
    const result = await runPackHookPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        event({
          tool_name: "Bash",
          tool_input: { command: "harness approve understanding && rm -rf /tmp/x" },
        }),
      ),
      stdout: stdout.stream,
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(true);
    expect(result.asked).toBeFalsy();
    const decision = JSON.parse(stdout.read().trim()) as Decision;
    expect(decision.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("hard-denies a command that merely mentions an escape command", async () => {
    // The escape exception (isEscapeCommand) is deliberately strict
    // about *what* the command is. A mutating command that happens
    // to contain the literal string "harness approve" in an argument
    // must still hard-block. `npm install` is the mutating shape
    // here (previously `echo "..."` was used, but `echo` is now on
    // the read-only allowlist).
    const stdout = bufferStream();
    const stderr = bufferStream();
    const result = await runPackHookPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        event({
          tool_name: "Bash",
          tool_input: {
            command: 'npm install --save "harness-approve-understanding-pkg"',
          },
        }),
      ),
      stdout: stdout.stream,
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(true);
    expect(result.asked).toBeFalsy();
  });

  it("still hard-denies a mutating Bash command when no source approves", async () => {
    // Originally used `git status` as the "normal" Bash command, but
    // the read-only classifier (task 7146694c) now allows that. A
    // mutating command (`git push`) is the right shape to assert
    // the hard-block path on.
    const stdout = bufferStream();
    const stderr = bufferStream();
    const result = await runPackHookPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        event({ tool_name: "Bash", tool_input: { command: "git push origin master" } }),
      ),
      stdout: stdout.stream,
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(true);
    expect(result.asked).toBeFalsy();
    const decision = JSON.parse(stdout.read().trim()) as Decision;
    expect(decision.decision).toBe("block");
  });

  it("allows an escape command normally when the marker already approves the session", async () => {
    const stdout = bufferStream();
    const stderr = bufferStream();
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-1", {
      approvedAt: "2026-05-07T08:00:00Z",
      approvedBy: "test-operator",
    });
    const result = await runPackHookPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        event({ tool_name: "Bash", tool_input: { command: "harness approve understanding" } }),
      ),
      stdout: stdout.stream,
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(false);
    expect(result.asked).toBeFalsy();
    expect(result.approvalCheck.source).toBe("marker");
    expect(stdout.read()).toBe("");
  });
});

describe("pack hook pre-tool-use blocker — .pending-approval staging (task 33abc147)", () => {
  it("stages the session id when it blocks a normal tool", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const result = await runPackHookPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(event({ tool_name: "Edit" })),
      stdout: bufferStream().stream,
      stderr: bufferStream().stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(true);
    expect(readPendingApproval(generatedDir)).toBe("sess-1");
  });

  it("stages the session id on the ask path (operator-approval escape command)", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const result = await runPackHookPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        event({ tool_name: "Bash", tool_input: { command: "harness approve understanding" } }),
      ),
      stdout: bufferStream().stream,
      stderr: bufferStream().stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.asked).toBe(true);
    expect(readPendingApproval(generatedDir)).toBe("sess-1");
  });

  it("does NOT stage anything when a source already approves (allow path)", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-1", {
      approvedAt: "2026-05-07T08:00:00Z",
      approvedBy: "test-operator",
    });
    const result = await runPackHookPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(event()),
      stdout: bufferStream().stream,
      stderr: bufferStream().stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(false);
    expect(readPendingApproval(generatedDir)).toBeNull();
  });

  it("blocks normally even when no generatedDir is resolvable (staging skipped)", async () => {
    // An injected manifest carries no resolved path, so generatedDir is
    // undefined and staging is skipped — but the block must still fire.
    const stdout = bufferStream();
    const result = await runPackHookPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(event({ tool_name: "Edit" })),
      stdout: stdout.stream,
      stderr: bufferStream().stream,
      reportsDir: path.join(tmp, "no-reports"),
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(true);
    const decision = JSON.parse(stdout.read().trim()) as { decision: string };
    expect(decision.decision).toBe("block");
  });

  it("blocks normally even when the staging write throws (best-effort)", async () => {
    // Force writePendingApproval to throw: a regular file sits where the
    // generated dir's parent component should be, so the mkdir inside
    // atomicWriteFile fails with ENOTDIR. The block must still fire.
    const notADir = path.join(tmp, "not-a-dir");
    fs.writeFileSync(notADir, "");
    const generatedDir = path.join(notADir, "harness.generated");
    const stdout = bufferStream();
    const result = await runPackHookPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(event({ tool_name: "Edit" })),
      stdout: stdout.stream,
      stderr: bufferStream().stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(true);
    const decision = JSON.parse(stdout.read().trim()) as { decision: string };
    expect(decision.decision).toBe("block");
  });
});

describe("pack hook pre-tool-use blocker — agent-facing ux (agent-tasks/e48e3b45)", () => {
  // When config.ux is declared, the deny envelope the agent sees
  // becomes the plain-language { cannot, required, run } shape and
  // the legacy "Understanding Gate: ..." + schemaHint + producers
  // vocabulary is suppressed. The stderr BLOCK diagnostic keeps the
  // engine-vocabulary reason for operator audit.
  function manifestWithUx(): Manifest {
    return parseManifest({
      version: 1,
      policy_packs: [
        {
          name: "understanding-before-execution",
          enabled: true,
          config: {
            mode: "grill_me",
            ux: {
              cannot: "You cannot use write-capable tools yet.",
              required: ["an approved Understanding Report for this session"],
              run: [
                "Write an Understanding Report covering the nine sections",
                "Run `harness approve understanding` and approve the prompt",
              ],
            },
          },
        },
      ],
    });
  }

  it("emits the verbatim agent-facing block on no-approval block", async () => {
    const stdout = bufferStream();
    const result = await runPackHookPreToolUseCli({
      manifest: manifestWithUx(),
      stdin: readableFromString(event()),
      stdout: stdout.stream,
      stderr: bufferStream().stream,
      reportsDir: path.join(tmp, "no-reports"),
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(true);
    const decision = JSON.parse(stdout.read().trim()) as {
      reason: string;
      hookSpecificOutput: { permissionDecisionReason: string };
    };
    const expected = [
      "You cannot use write-capable tools yet.",
      "",
      "Required:",
      "- an approved Understanding Report for this session",
      "",
      "Run:",
      "  Write an Understanding Report covering the nine sections",
      "  Run `harness approve understanding` and approve the prompt",
    ].join("\n");
    expect(decision.reason).toBe(expected);
    expect(decision.hookSpecificOutput.permissionDecisionReason).toBe(expected);
  });

  it("does not leak engine vocabulary to the agent surface when ux is declared", async () => {
    const stdout = bufferStream();
    await runPackHookPreToolUseCli({
      manifest: manifestWithUx(),
      stdin: readableFromString(event()),
      stdout: stdout.stream,
      stderr: bufferStream().stream,
      reportsDir: path.join(tmp, "no-reports"),
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    const decision = JSON.parse(stdout.read().trim()) as { reason: string };
    expect(decision.reason).not.toContain("Understanding Gate:");
    expect(decision.reason).not.toContain("Report format");
    expect(decision.reason).not.toContain("To produce this tag:");
    expect(decision.reason).not.toMatch(/ledger/i);
  });

  it("keeps the engine-vocabulary BLOCK reason on stderr (operator audit surface)", async () => {
    const stderr = bufferStream();
    await runPackHookPreToolUseCli({
      manifest: manifestWithUx(),
      stdin: readableFromString(event()),
      stdout: bufferStream().stream,
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir: path.join(tmp, "harness.generated"),
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(stderr.read()).toMatch(/BLOCK — no approval marker for session sess-1/);
  });

  it("falls back to the legacy envelope when ux is missing", async () => {
    // Manifest without config.ux: agent-facing surface stays on the
    // legacy "Understanding Gate: ..." + schemaHint path.
    const stdout = bufferStream();
    await runPackHookPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(event()),
      stdout: stdout.stream,
      stderr: bufferStream().stream,
      reportsDir: path.join(tmp, "no-reports"),
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    const decision = JSON.parse(stdout.read().trim()) as { reason: string };
    expect(decision.reason).toContain("Understanding Gate:");
    expect(decision.reason).toContain("Run `harness approve understanding`");
  });

  it("logs to stderr and falls back to the legacy envelope when config.ux is malformed", async () => {
    const manifest = parseManifest({
      version: 1,
      policy_packs: [
        {
          name: "understanding-before-execution",
          enabled: true,
          config: {
            mode: "grill_me",
            // Empty required array violates min(1)
            ux: { cannot: "x", required: [], run: ["y"] },
          },
        },
      ],
    });
    const stdout = bufferStream();
    const stderr = bufferStream();
    await runPackHookPreToolUseCli({
      manifest,
      stdin: readableFromString(event()),
      stdout: stdout.stream,
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(stderr.read()).toMatch(/config\.ux ignored/);
    const decision = JSON.parse(stdout.read().trim()) as { reason: string };
    expect(decision.reason).toContain("Understanding Gate:");
  });
});
