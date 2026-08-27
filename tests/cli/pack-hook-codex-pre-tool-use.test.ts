import { Readable, Writable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseReport } from "@lannguyensi/understanding-gate";
import { runPackHookCodexPreToolUseCli } from "../../src/cli/pack/hook-codex-pre-tool-use.js";
import type { LedgerEntry } from "../../src/policies/index.js";
import {
  clearApprovalMarker,
  writeActiveClaim,
  writeApprovalMarker,
  writeTaskApprovalMarker,
} from "../../src/policy-packs/builtin/understanding-before-execution-runtime.js";
import { readPendingApproval } from "../../src/runtime/pending-approval.js";
import { writeSentinel, type PauseSentinel } from "../../src/runtime/pause-sentinel.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

let tmp: string;
let savedClaude: string | undefined;
let savedClaudeCode: string | undefined;
let savedCodex: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ug-codex-blocker-"));
  // The hook reads three env vars as session-id fallbacks; clear them
  // so the dev host's $CLAUDE_CODE_SESSION_ID doesn't make tests that
  // expect "no session_id" pass an unexpected env-resolved id.
  savedClaude = process.env.CLAUDE_SESSION_ID;
  savedClaudeCode = process.env.CLAUDE_CODE_SESSION_ID;
  savedCodex = process.env.CODEX_SESSION_ID;
  delete process.env.CLAUDE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CODEX_SESSION_ID;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (savedClaude === undefined) delete process.env.CLAUDE_SESSION_ID;
  else process.env.CLAUDE_SESSION_ID = savedClaude;
  if (savedClaudeCode === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = savedClaudeCode;
  if (savedCodex === undefined) delete process.env.CODEX_SESSION_ID;
  else process.env.CODEX_SESSION_ID = savedCodex;
});

function manifestWithPack(enabled = true): Manifest {
  return parseManifest({
    version: 1,
    policy_packs: [{ name: "understanding-before-execution", enabled }],
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
  JSON.stringify({ session_id: "sess-codex", tool_name: "apply_patch", ...overrides });

function writeReport(dir: string, name: string, body: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), `${JSON.stringify(body, null, 2)}\n`);
}

describe("pack hook codex-pre-tool-use blocker", () => {
  it("allows a read-only Bash command without an approved Understanding Report", async () => {
    const stderr = bufferStream();
    const result = await runPackHookCodexPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        event({ tool_name: "Bash", raw_input: { command: "git status" } }),
      ),
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir: path.join(tmp, "harness.generated"),
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.approvalCheck.source).toBe("none");
    expect(stderr.read()).toMatch(/read-only Bash command, allowing/);
  });

  it("allows read-only Codex shell aliases using command/cmd input shapes", async () => {
    for (const [toolName, rawInput] of [
      ["shell", { command: "ls -la" }],
      ["exec_command", { cmd: "gh pr view 240" }],
      ["functions.exec_command", "git log --oneline -3"],
    ] as const) {
      const stderr = bufferStream();
      const result = await runPackHookCodexPreToolUseCli({
        manifest: manifestWithPack(),
        stdin: readableFromString(
          event({ tool_name: toolName, raw_input: rawInput }),
        ),
        stderr: stderr.stream,
        reportsDir: path.join(tmp, "no-reports"),
        generatedDir: path.join(tmp, `harness.generated-${toolName}`),
        ledgerQuery: async (): Promise<LedgerEntry[]> => [],
      });
      expect(result.blocked).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(stderr.read()).toMatch(/read-only Bash command, allowing/);
    }
  });

  it("blocks a mutating Codex shell command even with the classifier in place", async () => {
    const stderr = bufferStream();
    const result = await runPackHookCodexPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        event({ tool_name: "exec_command", raw_input: { cmd: "git push origin master" } }),
      ),
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir: path.join(tmp, "harness.generated"),
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(true);
    expect(result.exitCode).toBe(2);
    expect(stderr.read()).toMatch(/BLOCK: no approval marker/);
  });

  it("fails closed when raw_input has conflicting command aliases", async () => {
    const stderr = bufferStream();
    const result = await runPackHookCodexPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        event({
          tool_name: "exec_command",
          raw_input: { command: "git status", cmd: "git push origin master" },
        }),
      ),
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir: path.join(tmp, "harness.generated"),
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(true);
    expect(result.exitCode).toBe(2);
    expect(stderr.read()).toMatch(/BLOCK: no approval marker/);
  });

  it("does not apply the Bash classifier to apply_patch", async () => {
    const stderr = bufferStream();
    const result = await runPackHookCodexPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        event({ tool_name: "apply_patch", raw_input: { command: "git status" } }),
      ),
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir: path.join(tmp, "harness.generated"),
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(true);
    expect(result.exitCode).toBe(2);
  });

  it("blocks with exit 2 + stderr reason when no source approves", async () => {
    const stderr = bufferStream();
    const generatedDir = path.join(tmp, "harness.generated");
    const result = await runPackHookCodexPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(event()),
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(true);
    expect(result.exitCode).toBe(2);
    expect(stderr.read()).toMatch(/BLOCK: no approval marker for session sess-codex/);
    expect(stderr.read()).toMatch(/apply_patch/);
    expect(stderr.read()).toMatch(/harness approve understanding/);
    // Schema hint enumerates the parser's required sections so the agent
    // can produce a parser-acceptable report on the first try (task 5ec5772d).
    const stderrSnapshot = stderr.read();
    expect(stderrSnapshot).toContain("Report format");
    expect(stderrSnapshot).toContain("Current Understanding");
    expect(stderrSnapshot).toContain("Intended Outcome");
    expect(stderrSnapshot).toContain("Derived Todos");
    expect(stderrSnapshot).toContain("Acceptance Criteria");
    expect(stderrSnapshot).toContain("Assumptions");
    expect(stderrSnapshot).toContain("Open Questions");
    expect(stderrSnapshot).toContain("Out Of Scope");
    expect(stderrSnapshot).toContain("Risks");
    expect(stderrSnapshot).toContain("Verification Plan");
  });

  it("allows on exit 0 when an approval marker is present for the session (agent-tasks/88ca4bb3)", async () => {
    const stderr = bufferStream();
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-codex", {
      approvedAt: "2026-05-07T08:00:00Z",
      approvedBy: "test-operator",
    });
    const result = await runPackHookCodexPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(event()),
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.approvalCheck.source).toBe("marker");
    expect(stderr.read()).toMatch(/approved via marker sess-codex/);
  });

  // harness/f9485cc7 regression (AC #3), Codex parity with the Claude hook
  // test of the same shape: a hand-written, unsigned marker must not
  // satisfy the gate, with a distinct audit reason.
  it("BLOCKS when the marker is hand-written without a signature (forgery regression, distinct audit reason)", async () => {
    const stderr = bufferStream();
    const generatedDir = path.join(tmp, "harness.generated");
    fs.mkdirSync(path.join(generatedDir, ".approvals"), { recursive: true });
    fs.writeFileSync(
      path.join(generatedDir, ".approvals", "sess-codex"),
      `${JSON.stringify({ approvedAt: "2026-05-07T08:00:00Z", approvedBy: "attacker" })}\n`,
    );
    const result = await runPackHookCodexPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(event()),
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(true);
    expect(result.approvalCheck.approved).toBe(false);
    expect(result.approvalCheck.detail).toMatch(/forged\/unsigned marker rejected/);
    expect(stderr.read()).toMatch(/forged\/unsigned marker rejected/);
  });

  it("ledger entry ALONE does not approve (codex parity with claude blocker, agent-tasks/88ca4bb3)", async () => {
    const stderr = bufferStream();
    const generatedDir = path.join(tmp, "harness.generated");
    const result = await runPackHookCodexPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(event()),
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
    expect(result.exitCode).toBe(2);
    expect(result.approvalCheck.source).toBe("none");
    expect(stderr.read()).toMatch(/no approval marker for session sess-codex/);
  });

  // Task 7402301d, Codex parity with the Claude hook test of the same
  // shape: until that task this pinned "falls back to persisted report
  // when ledger has no match" (allow, source "persisted-report"). The
  // report is evidence now; an approved-looking report alone blocks with
  // exit 2 and the distinct audit reason on stderr.
  it("BLOCKS on an approved persisted report alone (report is evidence, not authority; task 7402301d)", async () => {
    const reportsDir = path.join(tmp, "reports");
    writeReport(reportsDir, "2026-05-07-codex-approval.json", {
      sessionId: "sess-codex",
      approvalStatus: "approved",
      approvedAt: "2026-05-07T09:00:00Z",
    });
    const stderr = bufferStream();
    const result = await runPackHookCodexPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(event()),
      stderr: stderr.stream,
      reportsDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(true);
    expect(result.exitCode).toBe(2);
    expect(result.approvalCheck.approved).toBe(false);
    expect(result.approvalCheck.source).toBe("none");
    expect(result.approvalCheck.detail).toMatch(
      /unsigned persisted-report approval rejected: report 2026-05-07-codex-approval\.json has approvalStatus=approved/,
    );
    expect(stderr.read()).toMatch(/BLOCK: .*unsigned persisted-report approval rejected/);
  });

  it("ignores policy_decision rows whose content shadow-includes the tag", async () => {
    const stderr = bufferStream();
    const result = await runPackHookCodexPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(event()),
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      ledgerQuery: async (sessionId): Promise<LedgerEntry[]> => [
        {
          id: "policy-decision-row",
          type: "policy_decision",
          content: `policy_decision: ... reason="understanding-approved:${sessionId}"`,
          createdAt: "2026-05-07T08:00:00Z",
        },
      ],
    });
    expect(result.blocked).toBe(true);
    expect(result.exitCode).toBe(2);
  });

  it("allows when pack is disabled (enabled:false)", async () => {
    const stderr = bufferStream();
    const result = await runPackHookCodexPreToolUseCli({
      manifest: manifestWithPack(false),
      stdin: readableFromString(event()),
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
    });
    expect(result.blocked).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(stderr.read()).toMatch(/enabled:false/);
  });

  it("allows when no session_id can be resolved", async () => {
    const stderr = bufferStream();
    const result = await runPackHookCodexPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(JSON.stringify({ tool_name: "apply_patch" })),
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
    });
    expect(result.blocked).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(stderr.read()).toMatch(/no session_id/);
  });

  it("resolves session_id from $CLAUDE_CODE_SESSION_ID when CODEX_SESSION_ID is unset (task 6562b9f6)", async () => {
    process.env.CLAUDE_CODE_SESSION_ID = "code-env-sess-codex";
    const stderr = bufferStream();
    const result = await runPackHookCodexPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(JSON.stringify({ tool_name: "apply_patch" })),
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
    });
    // The "no session_id" allow-branch must NOT fire — env fallback supplied the id.
    expect(stderr.read()).not.toMatch(/no session_id/);
    expect(result.blocked).toBeDefined();
  });

  it("prefers $CODEX_SESSION_ID over $CLAUDE_CODE_SESSION_ID and $CLAUDE_SESSION_ID", async () => {
    process.env.CODEX_SESSION_ID = "codex-env-wins";
    process.env.CLAUDE_CODE_SESSION_ID = "code-env-loses";
    process.env.CLAUDE_SESSION_ID = "legacy-env-loses";
    const stderr = bufferStream();
    const result = await runPackHookCodexPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(JSON.stringify({ tool_name: "apply_patch" })),
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
    });
    expect(stderr.read()).not.toMatch(/no session_id/);
    expect(result.blocked).toBeDefined();
  });

  it("tolerates the Codex-native `tool` synonym in the envelope", async () => {
    const stderr = bufferStream();
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-codex", {
      approvedAt: "2026-05-07T08:00:00Z",
      approvedBy: "test-operator",
    });
    const result = await runPackHookCodexPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        JSON.stringify({ session_id: "sess-codex", tool: "apply_patch" }),
      ),
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(false);
    expect(result.approvalCheck.source).toBe("marker");
  });

  it("does NOT alias `event.id` to session_id (event-id is not session-id)", async () => {
    const stderr = bufferStream();
    const result = await runPackHookCodexPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        JSON.stringify({ id: "msg-event-id-not-a-session", tool: "apply_patch" }),
      ),
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
    });
    expect(result.blocked).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(stderr.read()).toMatch(/no session_id/);
  });

  it("allows with a LOUD diagnostic when stdin is malformed JSON (not silent-allow)", async () => {
    // The previous behavior swallowed the parse error and allowed
    // silently — exactly the false-confidence failure mode a
    // governance hook must avoid. Allow is fine, silent is not.
    const stderr = bufferStream();
    const result = await runPackHookCodexPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString("{not-json"),
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
    });
    expect(result.blocked).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(stderr.read()).toMatch(/malformed event JSON on stdin/);
  });
});

describe("pack hook codex-pre-tool-use blocker — .pending-approval staging (task f608b4ee)", () => {
  // Mirrors the Claude pre-tool-use staging contract: on the block path,
  // write the resolved session id into <generatedDir>/.pending-approval so
  // arg-less `harness approve understanding` from the operator's shell
  // resolves it without scraping the runtime's logs.
  it("stages the session id when it blocks a Codex tool call", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const result = await runPackHookCodexPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(event()),
      stderr: bufferStream().stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(true);
    expect(readPendingApproval(generatedDir)).toBe("sess-codex");
  });

  it("does NOT stage anything when a source already approves (allow path)", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-codex", {
      approvedAt: "2026-05-19T07:00:00Z",
      approvedBy: "test-operator",
    });
    const result = await runPackHookCodexPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(event()),
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
    const stderr = bufferStream();
    const result = await runPackHookCodexPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(event()),
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(true);
    expect(result.exitCode).toBe(2);
  });

  it("blocks normally even when the staging write throws (best-effort)", async () => {
    // A regular file sits where the generated dir's parent component
    // should be, so writePendingApproval's mkdir/atomicWrite throws.
    // The block must still fire and exit 2.
    const notADir = path.join(tmp, "not-a-dir");
    fs.writeFileSync(notADir, "");
    const generatedDir = path.join(notADir, "harness.generated");
    const stderr = bufferStream();
    const result = await runPackHookCodexPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(event()),
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(true);
    expect(result.exitCode).toBe(2);
  });
});

describe("pack hook codex-pre-tool-use blocker — agent-facing ux (agent-tasks/e48e3b45)", () => {
  // Codex blocks via non-zero exit + stderr (no stdout JSON wire).
  // When config.ux is declared, the stderr diagnostic carries the
  // plain-language { cannot, required, run } shape instead of the
  // legacy "Run `harness approve understanding` once you have produced..."
  // + schemaHint vocabulary. The engine-vocabulary `reason` prefix
  // (BLOCK: no approval marker ...) stays so a flapping gate remains
  // diagnosable from logs.
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

  it("emits the agent-facing block in the stderr diagnostic on block", async () => {
    const stderr = bufferStream();
    const result = await runPackHookCodexPreToolUseCli({
      manifest: manifestWithUx(),
      stdin: readableFromString(event()),
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir: path.join(tmp, "harness.generated"),
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(true);
    expect(result.exitCode).toBe(2);
    const out = stderr.read();
    expect(out).toContain("You cannot use write-capable tools yet.");
    expect(out).toContain("Required:\n- an approved Understanding Report for this session");
    expect(out).toContain("Run:\n  Write an Understanding Report covering the nine sections");
    expect(out).toContain("  Run `harness approve understanding` and approve the prompt");
  });

  it("does not leak schemaHint vocabulary when ux is declared", async () => {
    const stderr = bufferStream();
    await runPackHookCodexPreToolUseCli({
      manifest: manifestWithUx(),
      stdin: readableFromString(event()),
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir: path.join(tmp, "harness.generated"),
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    const out = stderr.read();
    // schemaHint enumerates 9 sections as a "Report format" paragraph.
    // With ux declared we replaced it with a plain-language run line.
    expect(out).not.toContain("Report format");
  });

  it("keeps the engine-vocabulary BLOCK reason prefix (operator audit)", async () => {
    const stderr = bufferStream();
    await runPackHookCodexPreToolUseCli({
      manifest: manifestWithUx(),
      stdin: readableFromString(event()),
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir: path.join(tmp, "harness.generated"),
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(stderr.read()).toMatch(/BLOCK: no approval marker for session sess-codex/);
  });

  it("falls back to the legacy stderr text when ux is missing", async () => {
    const stderr = bufferStream();
    await runPackHookCodexPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(event()),
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    const out = stderr.read();
    expect(out).toContain("Run `harness approve understanding`");
    expect(out).toContain("Report format");
  });
});

describe("pack hook codex-pre-tool-use blocker — approval_lifecycle parity (task e7c2ec3c)", () => {
  // The Codex hook previously called the bare session-marker check, so
  // `approval_lifecycle.max_age` and task-scoped (active-claim) markers
  // silently applied only to Claude sessions. These tests mirror the
  // Claude blocker's lifecycle block in pack-hook-pre-tool-use.test.ts.
  function manifestWithMaxAge(): Manifest {
    return parseManifest({
      version: 1,
      policy_packs: [
        {
          name: "understanding-before-execution",
          enabled: true,
          config: { approval_lifecycle: { max_age: "4h" } },
        },
      ],
    });
  }

  it("blocks when the session approval marker is EXPIRED (max_age exceeded)", async () => {
    const stderr = bufferStream();
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-codex", {
      approvedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      approvedBy: "test-operator",
    });
    const result = await runPackHookCodexPreToolUseCli({
      manifest: manifestWithMaxAge(),
      stdin: readableFromString(event()),
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(true);
    expect(result.exitCode).toBe(2);
    expect(result.approvalCheck.source).toBe("none");
  });

  it("allows when the session approval marker is FRESH (must-pass control)", async () => {
    const stderr = bufferStream();
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-codex", {
      approvedAt: new Date(Date.now() - 60 * 1000).toISOString(),
      approvedBy: "test-operator",
    });
    const result = await runPackHookCodexPreToolUseCli({
      manifest: manifestWithMaxAge(),
      stdin: readableFromString(event()),
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(false);
    expect(result.approvalCheck.source).toBe("marker");
    expect(stderr.read()).toMatch(/approved via marker sess-codex/);
    // The task-scope trace line is emitted on the session-marker path too
    // (mirrors the Claude hook's fall-through tracing).
    expect(stderr.read()).toMatch(
      /harness pack hook codex: task-scoped check: no active-claim recorded/,
    );
  });

  it("allows via the task-scoped marker for the active claim, even from a different session id", async () => {
    const stderr = bufferStream();
    const generatedDir = path.join(tmp, "harness.generated");
    writeActiveClaim(generatedDir, "task-uuid-codex");
    writeTaskApprovalMarker(generatedDir, "task-uuid-codex", {
      approvedAt: new Date(Date.now() - 60 * 1000).toISOString(),
      approvedBy: "test-operator",
    });
    const result = await runPackHookCodexPreToolUseCli({
      manifest: manifestWithMaxAge(),
      stdin: readableFromString(event()),
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(false);
    expect(result.approvalCheck.source).toBe("marker");
    expect(stderr.read()).toMatch(/task-scoped marker for active-claim task-uuid-codex/);
  });

  it("BLOCKS when a marker exists for a DIFFERENT task than the active-claim (PR #198 parity)", async () => {
    const stderr = bufferStream();
    const generatedDir = path.join(tmp, "harness.generated");
    writeActiveClaim(generatedDir, "task-current");
    writeTaskApprovalMarker(generatedDir, "task-stale-from-yesterday", {
      approvedAt: new Date(Date.now() - 60 * 1000).toISOString(),
      approvedBy: "test-operator",
    });
    const result = await runPackHookCodexPreToolUseCli({
      manifest: manifestWithMaxAge(),
      stdin: readableFromString(event()),
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(true);
    const stderrText = stderr.read();
    expect(stderrText).toMatch(/active-claim task-current has no fresh task marker/);
    expect(stderrText).not.toMatch(/marker for active-claim task-stale-from-yesterday/);
  });

  it("blocks when the active-claim's task marker is STALE (max_age exceeded)", async () => {
    const stderr = bufferStream();
    const generatedDir = path.join(tmp, "harness.generated");
    writeActiveClaim(generatedDir, "task-stale");
    writeTaskApprovalMarker(generatedDir, "task-stale", {
      approvedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      approvedBy: "test-operator",
    });
    const result = await runPackHookCodexPreToolUseCli({
      manifest: manifestWithMaxAge(),
      stdin: readableFromString(event()),
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(true);
    expect(result.approvalCheck.source).toBe("none");
    // Pins that the TASK-scoped path (not merely an absent session marker)
    // produced the miss — this assertion fails on pre-change code, which
    // never consulted task markers at all.
    expect(stderr.read()).toMatch(
      /active-claim task-stale has no fresh task marker \(.*expired/,
    );
  });
});

describe("pack hook codex-pre-tool-use blocker — malformed config.ux (task 19e293c6)", () => {
  it("warns with the codex-prefixed line and falls back to the legacy envelope", async () => {
    const stderr = bufferStream();
    const generatedDir = path.join(tmp, "harness.generated");
    const result = await runPackHookCodexPreToolUseCli({
      manifest: parseManifest({
        version: 1,
        policy_packs: [
          {
            name: "understanding-before-execution",
            enabled: true,
            config: { ux: { cannot: 42 } },
          },
        ],
      }),
      stdin: readableFromString(event()),
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(true);
    const out = stderr.read();
    // Full prefix pins the label->hook binding (task 19e293c6 review).
    expect(out).toContain("harness pack hook codex: config.ux ignored (");
    expect(out).toMatch(/BLOCK: no approval marker/);
  });
});

describe("pack hook codex-pre-tool-use blocker — recovery git-commit exemption after approval expiry (task 6e888423)", () => {
  // Codex parity with the Claude hook's fix (pack-hook-pre-tool-use.test.ts).
  // Both hooks share checkOperatorApprovalMarkers + isRecoveryGitCommit so
  // this class of Claude/Codex drift (task e7c2ec3c precedent) cannot
  // recur silently.
  function manifestWithMaxAge(): Manifest {
    return parseManifest({
      version: 1,
      policy_packs: [
        {
          name: "understanding-before-execution",
          enabled: true,
          config: { approval_lifecycle: { max_age: "4h" } },
        },
      ],
    });
  }

  function expireMarker(generatedDir: string, sessionId: string): void {
    writeApprovalMarker(generatedDir, sessionId, {
      approvedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      approvedBy: "test-operator",
    });
  }

  it("CONTROL — an expired marker still hard-blocks apply_patch (the wedge is real)", async () => {
    const stderr = bufferStream();
    const generatedDir = path.join(tmp, "harness.generated");
    expireMarker(generatedDir, "sess-codex");
    const result = await runPackHookCodexPreToolUseCli({
      manifest: manifestWithMaxAge(),
      stdin: readableFromString(event()), // tool_name: "apply_patch"
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(true);
    expect(result.exitCode).toBe(2);
    expect(result.approvalCheck.source).toBe("none");
  });

  it("FIX — an expired marker no longer blocks the bare recovery `git commit` over shell", async () => {
    const stderr = bufferStream();
    const generatedDir = path.join(tmp, "harness.generated");
    expireMarker(generatedDir, "sess-codex");
    const result = await runPackHookCodexPreToolUseCli({
      manifest: manifestWithMaxAge(),
      stdin: readableFromString(
        event({
          tool_name: "shell",
          raw_input: { command: 'git commit -am "fix: address reviewer feedback"' },
        }),
      ),
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.approvalCheck.source).toBe("recovery-commit");
    expect(stderr.read()).toMatch(/recovery-commit exemption/);
  });

  it("CONVERGENCE (review HIGH) — the recovery commit carrying THIS REPO'S REAL commit trailer (with the <email> angle brackets) converges without operator intervention", async () => {
    // Codex parity with the Claude hook's inert-test guard: fails against
    // the pre-HIGH-fix metachar screen (which rejected `<`/`>`
    // unconditionally, even inside a quoted -m value) and only passes
    // once the scan is quote-aware.
    const stderr = bufferStream();
    const generatedDir = path.join(tmp, "harness.generated");
    expireMarker(generatedDir, "sess-codex");
    const result = await runPackHookCodexPreToolUseCli({
      manifest: manifestWithMaxAge(),
      stdin: readableFromString(
        event({
          tool_name: "shell",
          raw_input: {
            command:
              'git commit -am "fix(understanding-gate): address reviewer feedback" ' +
              '-m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"',
          },
        }),
      ),
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.approvalCheck.source).toBe("recovery-commit");
  });

  it("does NOT converge: an unquoted `>` redirect after a safely-quoted message still hard-blocks (negative control for the HIGH relaxation)", async () => {
    const stderr = bufferStream();
    const generatedDir = path.join(tmp, "harness.generated");
    expireMarker(generatedDir, "sess-codex");
    const result = await runPackHookCodexPreToolUseCli({
      manifest: manifestWithMaxAge(),
      stdin: readableFromString(
        event({
          tool_name: "shell",
          raw_input: { command: 'git commit -am "safe message" > /tmp/out' },
        }),
      ),
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(true);
    expect(result.exitCode).toBe(2);
  });

  describe("CRITICAL — backslash-escaped quote injection must not bypass the gate (found on re-review of commit 872c9a6)", () => {
    // Codex parity: it shares isRecoveryGitCommit with the Claude hook,
    // so it inherits the same bypass. See the Claude hook test suite's
    // identical describe block for the full mechanism.
    it.each([
      'git commit -am a\\" ; echo INJECTED ; \\"',
      'git commit -am a\\" || echo INJECTED \\"',
      'git commit -am a\\" | echo INJECTED \\"bar',
    ])("still hard-blocks %s even with an expired (previously-approved) marker", async (cmd) => {
      const stderr = bufferStream();
      const generatedDir = path.join(tmp, "harness.generated");
      expireMarker(generatedDir, "sess-codex");
      const result = await runPackHookCodexPreToolUseCli({
        manifest: manifestWithMaxAge(),
        stdin: readableFromString(
          event({
            tool_name: "shell",
            raw_input: { command: cmd },
          }),
        ),
        stderr: stderr.stream,
        reportsDir: path.join(tmp, "no-reports"),
        generatedDir,
        ledgerQuery: async (): Promise<LedgerEntry[]> => [],
      });
      expect(result.blocked).toBe(true);
      expect(result.exitCode).toBe(2);
      expect(result.approvalCheck.source).not.toBe("recovery-commit");
    });
  });

  it("does not widen: a chained `git commit && ...` is not exempted", async () => {
    const stderr = bufferStream();
    const generatedDir = path.join(tmp, "harness.generated");
    expireMarker(generatedDir, "sess-codex");
    const result = await runPackHookCodexPreToolUseCli({
      manifest: manifestWithMaxAge(),
      stdin: readableFromString(
        event({
          tool_name: "exec_command",
          raw_input: { cmd: 'git commit -am "msg" && rm -rf /tmp/x' },
        }),
      ),
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(true);
  });

  it("a session that was NEVER approved still hard-blocks the same git-commit shape", async () => {
    const stderr = bufferStream();
    const generatedDir = path.join(tmp, "harness.generated");
    const result = await runPackHookCodexPreToolUseCli({
      manifest: manifestWithMaxAge(),
      stdin: readableFromString(
        JSON.stringify({
          session_id: "sess-codex-never-approved",
          tool_name: "shell",
          raw_input: { command: 'git commit -am "msg"' },
        }),
      ),
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(true);
    expect(result.approvalCheck.source).toBe("none");
  });

  it("RE-ARMS for a new task: a marker CLEARED by a task-completion boundary tool still hard-blocks the next task's first git commit", async () => {
    const stderr = bufferStream();
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-codex", {
      approvedAt: new Date().toISOString(),
      approvedBy: "test-operator",
    });
    clearApprovalMarker(generatedDir, "sess-codex");
    const result = await runPackHookCodexPreToolUseCli({
      manifest: manifestWithMaxAge(),
      stdin: readableFromString(
        event({
          tool_name: "shell",
          raw_input: { command: 'git commit -am "first commit of the new task"' },
        }),
      ),
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(true);
    expect(result.approvalCheck.source).toBe("none");
  });
});

describe("pack hook codex-pre-tool-use blocker: malformed-sections surfacing (task 823837fd)", () => {
  function writeParseErrorLog(
    parseErrorsDir: string,
    name: string,
    body: Record<string, unknown>,
  ): void {
    fs.mkdirSync(parseErrorsDir, { recursive: true });
    fs.writeFileSync(
      path.join(parseErrorsDir, name),
      `${JSON.stringify(body, null, 2)}\n\n--- raw ---\noriginal assistant text\n`,
    );
  }

  // Derived from an ACTUAL `parseReport` call (task 823837fd review Fix 2)
  // rather than hand-written, so this fixture cannot drift from what the
  // producer really emits: the real parser returns camelCase section
  // keys ("risks", "priorArt"), never the display names
  // ("Risks (list)", "Prior Art (list)") `renderReportSchemaHint` shows
  // an agent; a prior version of this fixture used the display names,
  // which the producer never emits and the hooks would never see in
  // practice.
  function malformedSectionsParseError(): {
    missing: string[];
    malformedSections: string[];
    message: string;
  } {
    const markdown = [
      "# Understanding Report",
      "",
      "## Current Understanding",
      "I understand the task.",
      "",
      "## Intended Outcome",
      "Ship the fix.",
      "",
      "## Derived Todos",
      "- do the thing",
      "",
      "## Acceptance Criteria",
      "- it works",
      "",
      "## Assumptions",
      "- none",
      "",
      "## Open Questions",
      "- none",
      "",
      "## Out Of Scope",
      "- nothing",
      "",
      "## Risks",
      "This is prose instead of a list.",
      "",
      "## Verification Plan",
      "- ran tests",
      "",
      "## Prior Art",
      "Also prose here, not a list.",
      "",
    ].join("\n");
    const result = parseReport(markdown, { mode: "grill_me" });
    if (result.ok) {
      throw new Error("test fixture markdown unexpectedly parsed cleanly");
    }
    return {
      missing: result.error.missing,
      malformedSections: result.error.malformedSections ?? [],
      message: result.error.message,
    };
  }

  it("names the malformed sections in the stderr block reason when the session's latest parse-error log carries them", async () => {
    const reportsParent = fs.mkdtempSync(path.join(tmp, "codex-malformed-"));
    const reportsDir = path.join(reportsParent, "reports");
    const parseErrorsDir = path.join(reportsParent, "parse-errors");
    const { missing, malformedSections, message } = malformedSectionsParseError();
    writeParseErrorLog(parseErrorsDir, "err.log", {
      sessionId: "sess-codex",
      reason: "missing_sections",
      missing,
      malformedSections,
      message,
    });
    const stderr = bufferStream();
    const result = await runPackHookCodexPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(event()),
      stderr: stderr.stream,
      reportsDir,
      generatedDir: path.join(tmp, "harness.generated"),
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(true);
    // The agent-facing sentence maps each raw key to its display name
    // (task 823837fd review Fix 3): "Risks (risks)", "Prior Art
    // (priorArt)", not the bare camelCase keys.
    expect(stderr.read()).toMatch(
      /malformed sections \(present but not a markdown list\): Risks \(risks\), Prior Art \(priorArt\)/,
    );
  });

  it("does not mention malformed sections when the session's parse-error log has none", async () => {
    const reportsParent = fs.mkdtempSync(path.join(tmp, "codex-no-malformed-"));
    const reportsDir = path.join(reportsParent, "reports");
    const parseErrorsDir = path.join(reportsParent, "parse-errors");
    writeParseErrorLog(parseErrorsDir, "err.log", {
      sessionId: "sess-codex",
      reason: "missing_sections",
      missing: ["Prior Art (list)"],
      message: "Missing required sections: Prior Art (list)",
    });
    const stderr = bufferStream();
    const result = await runPackHookCodexPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(event()),
      stderr: stderr.stream,
      reportsDir,
      generatedDir: path.join(tmp, "harness.generated"),
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(true);
    expect(stderr.read()).not.toMatch(/malformed sections/);
  });

  it("does not mention malformed sections when a persisted report already exists for the session, even if only pending (task 823837fd review Fix 1)", async () => {
    // Regression repro: `checkPersistedReport` returns `approved: false`
    // BOTH for "no report at all" and "report pending operator
    // approval"; so an agent who FIXED their report (a new, well-formed
    // one now sits pending) and is waiting for `harness approve
    // understanding` must NOT still be told their earlier, superseded
    // parse-error attempt had malformed sections. Gate matches the CLI's
    // own `if (!latest)` gate (approve/understanding.ts:836):
    // malformed-sections lookup only fires when NO persisted report
    // exists for the session at all (`report.report === null`).
    const reportsParent = fs.mkdtempSync(path.join(tmp, "codex-malformed-pending-report-"));
    const reportsDir = path.join(reportsParent, "reports");
    const parseErrorsDir = path.join(reportsParent, "parse-errors");
    const { missing, malformedSections, message } = malformedSectionsParseError();
    writeParseErrorLog(parseErrorsDir, "err.log", {
      sessionId: "sess-codex",
      reason: "missing_sections",
      missing,
      malformedSections,
      message,
    });
    writeReport(reportsDir, "rpt.json", {
      sessionId: "sess-codex",
      approvalStatus: "pending",
    });
    const stderr = bufferStream();
    const result = await runPackHookCodexPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(event()),
      stderr: stderr.stream,
      reportsDir,
      generatedDir: path.join(tmp, "harness.generated"),
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(true);
    expect(stderr.read()).not.toMatch(/malformed sections/);
  });
});

// ---------------------------------------------------------------------------
// Pause sentinel (task 1432e053), mirroring the behavioural pause coverage
// on the sibling hook (tests/cli/pack-hook-codex-post-tool-use.test.ts,
// "honours the pause sentinel and skips marker expiry").
// ---------------------------------------------------------------------------
describe("pack hook codex-pre-tool-use blocker -- pause sentinel (task 1432e053)", () => {
  let sentinelTmp: string;
  let generatedDir: string;

  const ACTIVE_SENTINEL: PauseSentinel = {
    pausedAt: new Date().toISOString(),
    expiresAt: null, // indefinite, never auto-expires during test
    reason: "operator recovery",
    pausedBy: "test",
  };

  beforeEach(() => {
    sentinelTmp = fs.mkdtempSync(path.join(os.tmpdir(), "ug-codex-pre-pause-"));
    generatedDir = path.join(sentinelTmp, "harness.generated");
    fs.mkdirSync(generatedDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(sentinelTmp, { recursive: true, force: true });
  });

  it("honours the pause sentinel: allows without evaluating and emits a PAUSED notice", async () => {
    writeSentinel(generatedDir, ACTIVE_SENTINEL);
    const stderr = bufferStream();
    const result = await runPackHookCodexPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(event()),
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.approvalCheck.source).toBe("none");
    const stderrText = stderr.read();
    expect(stderrText).toContain("PAUSED");
    expect(stderrText).toContain("operator recovery");
  });

  it("resumes normal evaluation after the pause sentinel expires (negative control)", async () => {
    // `runPackHookCodexPreToolUseCli` (unlike its stop / user-prompt-submit
    // / post-tool-use siblings) has no `now` test-injection knob, so this
    // uses a sentinel whose `expiresAt` is genuinely in the past against
    // the real wall clock rather than an injected one.
    writeSentinel(generatedDir, {
      pausedAt: "2020-01-01T00:00:00.000Z",
      expiresAt: "2020-01-01T01:00:00.000Z",
      reason: "operator recovery",
      pausedBy: "test",
    });
    const stderr = bufferStream();
    const result = await runPackHookCodexPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(event()),
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    // No marker, no persisted report, no ledger match, and the sentinel is
    // expired: normal evaluation runs and blocks, proving the expired
    // sentinel no longer short-circuits the check.
    expect(result.blocked).toBe(true);
    expect(stderr.read()).not.toContain("PAUSED");
  });
});
