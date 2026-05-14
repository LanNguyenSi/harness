import { Readable, Writable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPackHookPreToolUseCli } from "../../src/cli/pack/hook-pre-tool-use.js";
import type { LedgerEntry } from "../../src/policies/index.js";
import { readPendingApproval } from "../../src/runtime/pending-approval.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ug-blocker-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
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
  it("allows when ledger query matches the approved tag", async () => {
    const stdout = bufferStream();
    const stderr = bufferStream();
    const result = await runPackHookPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(event()),
      stdout: stdout.stream,
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      ledgerQuery: async (sessionId): Promise<LedgerEntry[]> => [
        {
          id: "1",
          content: `understanding-approved:${sessionId}`,
          createdAt: "2026-05-07T08:00:00Z",
        },
      ],
    });
    expect(result.blocked).toBe(false);
    expect(result.approvalCheck.source).toBe("ledger");
    expect(stdout.read()).toBe("");
    expect(stderr.read()).toMatch(/approved via ledger tag/);
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
    delete process.env.CLAUDE_SESSION_ID;
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
    const stdout = bufferStream();
    const stderr = bufferStream();
    const result = await runPackHookPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        event({
          tool_name: "Bash",
          tool_input: { command: 'echo "run harness approve understanding"' },
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

  it("still hard-denies a normal Bash command when no source approves", async () => {
    const stdout = bufferStream();
    const stderr = bufferStream();
    const result = await runPackHookPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        event({ tool_name: "Bash", tool_input: { command: "git status" } }),
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

  it("allows an escape command normally when the ledger already approves the session", async () => {
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
      ledgerQuery: async (sessionId): Promise<LedgerEntry[]> => [
        {
          id: "1",
          content: `understanding-approved:${sessionId}`,
          createdAt: "2026-05-07T08:00:00Z",
        },
      ],
    });
    expect(result.blocked).toBe(false);
    expect(result.asked).toBeFalsy();
    expect(result.approvalCheck.source).toBe("ledger");
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
    const result = await runPackHookPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(event()),
      stdout: bufferStream().stream,
      stderr: bufferStream().stream,
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
