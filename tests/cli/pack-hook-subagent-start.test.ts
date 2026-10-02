// SubagentStart hook (subagent-gate slice 2,
// docs/decisions/2026-08-27-ug-auto-mode-approval.md "TTL, cwd, and
// subagents"): writes a signed in-flight record for a newly-started
// Agent-tool subagent when the parent session currently holds a valid
// understanding-gate approval. Fixture shapes mirror
// tests/cli/pack-hook-post-tool-use.test.ts (marker helpers) and
// tests/policy-packs/understanding-before-execution-inflight-records.test.ts
// (record verification).

import { Readable, Writable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approveUnderstanding } from "../../src/cli/approve/understanding.js";
import { runPackHookPreToolUseCli } from "../../src/cli/pack/hook-pre-tool-use.js";
import { runPackHookSubagentStartCli } from "../../src/cli/pack/hook-subagent-start.js";
import type { LedgerEntry } from "../../src/policies/index.js";
import {
  approvalMarkerPathFor,
  canonicalReportHashOfFile,
  verifyInflightRecord,
  writeActiveClaim,
  writeApprovalMarker,
  writeTaskApprovalMarker,
} from "../../src/policy-packs/builtin/understanding-before-execution-runtime.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ug-subagent-start-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function manifestWithPack(
  config: Record<string, unknown> = {},
  enabled = true,
): Manifest {
  return parseManifest({
    version: 1,
    policy_packs: [
      { name: "understanding-before-execution", enabled, config },
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

const SESSION = "sess-subagent-1";
const AGENT = "agent-abc123";

function eventBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: SESSION,
    agent_id: AGENT,
    agent_type: "general-purpose",
    hook_event_name: "SubagentStart",
    ...overrides,
  });
}

function pauseSentinelBody(expiresAt: string | null = null): string {
  return JSON.stringify({
    pausedAt: new Date().toISOString(),
    expiresAt,
    reason: null,
    pausedBy: null,
  });
}

describe("pack hook subagent-start — writes an in-flight record on a valid parent approval", () => {
  it("writes a record via the session marker; verifyInflightRecord matches with parentSource session", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, SESSION, {
      approvedAt: new Date().toISOString(),
      approvedBy: "test-operator",
    });
    const stderr = bufferStream();

    const result = await runPackHookSubagentStartCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(eventBody()),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.recordWritten).toBe(true);
    const verified = verifyInflightRecord(generatedDir, SESSION, AGENT);
    expect(verified.matched).toBe(true);
    expect(verified.detail).toMatch(/parent=session/);
    expect(stderr.read()).toMatch(/wrote in-flight record for agent agent-abc123/);
  });

  it("writes a record via a task-scoped marker for the active claim; parentSource is task", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeActiveClaim(generatedDir, "task-uuid-abc");
    writeTaskApprovalMarker(generatedDir, "task-uuid-abc", {
      approvedAt: new Date().toISOString(),
      approvedBy: "test-operator",
    });
    const stderr = bufferStream();

    const result = await runPackHookSubagentStartCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(eventBody()),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.recordWritten).toBe(true);
    const verified = verifyInflightRecord(generatedDir, SESSION, AGENT);
    expect(verified.matched).toBe(true);
    expect(verified.detail).toMatch(/parent=task/);
  });

  it("writes nothing and emits the named diagnostic when the parent holds no marker", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const stderr = bufferStream();

    const result = await runPackHookSubagentStartCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(eventBody()),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.recordWritten).toBe(false);
    expect(verifyInflightRecord(generatedDir, SESSION, AGENT).matched).toBe(false);
    expect(stderr.read()).toContain(
      `harness pack hook: subagent-start: parent session ${SESSION} holds no valid approval; no in-flight record for agent ${AGENT}`,
    );
  });

  it("writes nothing when the parent's marker is older than approval_lifecycle.max_age", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const old = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString(); // 10h old
    writeApprovalMarker(generatedDir, SESSION, {
      approvedAt: old,
      approvedBy: "test-operator",
    });
    const stderr = bufferStream();

    const result = await runPackHookSubagentStartCli({
      manifest: manifestWithPack({ approval_lifecycle: { max_age: "4h" } }),
      stdin: readableFromString(eventBody()),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.recordWritten).toBe(false);
    expect(verifyInflightRecord(generatedDir, SESSION, AGENT).matched).toBe(false);
    // Pins the hook's own `!approval.matched` guard (not merely
    // writeInflightRecord's downstream `parent_not_approved` refusal): an
    // aged-out marker must be caught by the hook BEFORE it ever calls
    // writeInflightRecord, so the diagnostic is the hook's
    // "holds no valid approval" message, never writeInflightRecord's own
    // failure text.
    const stderrText = stderr.read();
    expect(stderrText).toContain(
      "holds no valid approval; no in-flight record for agent",
    );
    expect(stderrText).not.toContain("writeInflightRecord failed");
  });

  it("pause sentinel: nothing written, exit 0, distinct diagnostic", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, SESSION, {
      approvedAt: new Date().toISOString(),
      approvedBy: "test-operator",
    });
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.writeFileSync(path.join(generatedDir, ".harness-paused"), pauseSentinelBody(null));
    const stderr = bufferStream();

    const result = await runPackHookSubagentStartCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(eventBody()),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.exitCode).toBe(0);
    expect(result.recordWritten).toBe(false);
    expect(verifyInflightRecord(generatedDir, SESSION, AGENT).matched).toBe(false);
    expect(stderr.read()).toMatch(/paused/);
  });

  it("missing agent_id: exit 0, nothing written, no throw", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, SESSION, {
      approvedAt: new Date().toISOString(),
      approvedBy: "test-operator",
    });
    const stderr = bufferStream();

    const result = await runPackHookSubagentStartCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(eventBody({ agent_id: undefined })),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.exitCode).toBe(0);
    expect(result.recordWritten).toBe(false);
    expect(stderr.read()).toMatch(/missing agent_id/);
  });

  it("malformed agent_id (contains '/'): exit 0, nothing written, no throw", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, SESSION, {
      approvedAt: new Date().toISOString(),
      approvedBy: "test-operator",
    });
    const stderr = bufferStream();

    const result = await runPackHookSubagentStartCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(eventBody({ agent_id: "a/b" })),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.exitCode).toBe(0);
    expect(result.recordWritten).toBe(false);
    expect(stderr.read()).toMatch(/malformed agent_id/);
  });

  it("missing session_id: exit 0, nothing written", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const stderr = bufferStream();

    const result = await runPackHookSubagentStartCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(eventBody({ session_id: undefined })),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.exitCode).toBe(0);
    expect(result.recordWritten).toBe(false);
    expect(stderr.read()).toMatch(/missing session_id/);
  });

  it("defaults agentType to 'unknown' when agent_type is absent", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, SESSION, {
      approvedAt: new Date().toISOString(),
      approvedBy: "test-operator",
    });
    const stderr = bufferStream();

    const result = await runPackHookSubagentStartCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(eventBody({ agent_type: undefined })),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.recordWritten).toBe(true);
    const raw = JSON.parse(
      fs.readFileSync(
        path.join(generatedDir, ".inflight", SESSION, AGENT),
        "utf8",
      ),
    ) as { agentType: string };
    expect(raw.agentType).toBe("unknown");
  });

  it("skips on malformed event JSON without crashing", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const stderr = bufferStream();

    const result = await runPackHookSubagentStartCli({
      manifest: manifestWithPack(),
      stdin: readableFromString("not json"),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.exitCode).toBe(0);
    expect(result.recordWritten).toBe(false);
    expect(stderr.read()).toMatch(/malformed event JSON/);
  });

  it("skips silently when pack is enabled:false", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, SESSION, {
      approvedAt: new Date().toISOString(),
      approvedBy: "test-operator",
    });
    const stderr = bufferStream();

    const result = await runPackHookSubagentStartCli({
      manifest: manifestWithPack({}, false),
      stdin: readableFromString(eventBody()),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.exitCode).toBe(0);
    expect(result.recordWritten).toBe(false);
    expect(verifyInflightRecord(generatedDir, SESSION, AGENT).matched).toBe(false);
    expect(stderr.read()).toMatch(/enabled:false/);
  });
});

// Gate-read report-hash cross-check at spawn time: the same rule both
// PreToolUse hooks apply after a matched marker. The Codex adapter has no
// SubagentStart hook (there is no `hook-codex-subagent-start`), so the
// Claude hook is the only runtime with this path.
describe("pack hook subagent-start: report-hash cross-check before minting the record", () => {
  let generatedDir: string;
  let reportsDir: string;
  let savedClaude: string | undefined;
  let savedClaudeCode: string | undefined;

  beforeEach(() => {
    generatedDir = path.join(tmp, "harness.generated");
    reportsDir = path.join(tmp, "reports");
    savedClaude = process.env.CLAUDE_SESSION_ID;
    savedClaudeCode = process.env.CLAUDE_CODE_SESSION_ID;
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.CLAUDE_CODE_SESSION_ID;
  });

  afterEach(() => {
    if (savedClaude === undefined) delete process.env.CLAUDE_SESSION_ID;
    else process.env.CLAUDE_SESSION_ID = savedClaude;
    if (savedClaudeCode === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = savedClaudeCode;
  });

  function writeReport(name: string, session: string, content: string): string {
    fs.mkdirSync(reportsDir, { recursive: true });
    const full = path.join(reportsDir, name);
    fs.writeFileSync(
      full,
      `${JSON.stringify(
        { sessionId: session, approvalStatus: "pending", createdAt: new Date().toISOString(), content },
        null,
        2,
      )}\n`,
    );
    return full;
  }

  function editReport(reportPath: string): void {
    const r = JSON.parse(fs.readFileSync(reportPath, "utf8")) as Record<string, unknown>;
    r["content"] = "edited after approval";
    fs.writeFileSync(reportPath, `${JSON.stringify(r, null, 2)}\n`);
  }

  /** Real approve flow: writes the signed marker carrying the report's canonical hash. */
  async function approveRealFlow(): Promise<string> {
    const reportPath = writeReport("r1.json", SESSION, "the understanding the operator reviewed");
    const approve = await approveUnderstanding({
      manifest: parseManifest({ version: 1 }),
      session: SESSION,
      reportsDir,
      generatedDir,
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(approve.marker.ok).toBe(true);
    return reportPath;
  }

  async function startSubagent(): Promise<{ recordWritten: boolean; stderr: string }> {
    const stderr = bufferStream();
    const result = await runPackHookSubagentStartCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(eventBody()),
      stderr: stderr.stream,
      generatedDir,
      reportsDir,
    });
    return { recordWritten: result.recordWritten, stderr: stderr.read() };
  }

  async function subagentCall(): Promise<{ blocked: boolean; source: string }> {
    const result = await runPackHookPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        JSON.stringify({
          session_id: SESSION,
          agent_id: AGENT,
          tool_name: "Edit",
          tool_input: { file_path: "x.txt", old_string: "a", new_string: "b" },
        }),
      ),
      stdout: bufferStream().stream,
      stderr: bufferStream().stream,
      reportsDir,
      generatedDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    return { blocked: result.blocked, source: result.approvalCheck.source };
  }

  const MISMATCH =
    /approval refused, no report in the reports directory matches the content the session approval marker was signed for \(the approved report was changed or removed after approval\); re-run `harness approve understanding`; no in-flight record for agent agent-abc123/;

  it("edited report: no in-flight record is written, and the subagent's tool call blocks once the parent marker stops matching", async () => {
    const reportPath = await approveRealFlow();
    editReport(reportPath);

    const start = await startSubagent();

    expect(start.recordWritten).toBe(false);
    expect(start.stderr).toMatch(MISMATCH);
    expect(fs.existsSync(path.join(generatedDir, ".inflight", SESSION, AGENT))).toBe(false);
    expect(verifyInflightRecord(generatedDir, SESSION, AGENT).matched).toBe(false);
    // The parent marker stops matching (claim switch, max_age lapse): modelled
    // by removing it. Without a record the subagent has nothing to present.
    fs.rmSync(approvalMarkerPathFor(generatedDir, SESSION));
    const call = await subagentCall();
    expect(call.blocked).toBe(true);
    expect(call.source).toBe("none");
  });

  it("intact approval: the record is written and the subagent is allowed through it after the parent marker is gone", async () => {
    await approveRealFlow();

    const start = await startSubagent();

    expect(start.recordWritten).toBe(true);
    expect(start.stderr).toMatch(/wrote in-flight record for agent agent-abc123 \(parent=session\)/);
    expect(verifyInflightRecord(generatedDir, SESSION, AGENT).matched).toBe(true);
    fs.rmSync(approvalMarkerPathFor(generatedDir, SESSION));
    const call = await subagentCall();
    expect(call.blocked).toBe(false);
    expect(call.source).toBe("inflight");
  });

  // Production wiring: `harness apply` bakes UNDERSTANDING_GATE_REPORT_DIR into
  // the hook command and the hook gets no reportsDir injection, so the
  // directory comes from the environment. The cwd stays elsewhere (the
  // default `<cwd>/.understanding-gate/reports` does not exist here).
  describe("reports directory resolved from UNDERSTANDING_GATE_REPORT_DIR (no reportsDir injection)", () => {
    let savedReportDir: string | undefined;

    beforeEach(() => {
      savedReportDir = process.env.UNDERSTANDING_GATE_REPORT_DIR;
      process.env.UNDERSTANDING_GATE_REPORT_DIR = reportsDir;
    });

    afterEach(() => {
      if (savedReportDir === undefined) delete process.env.UNDERSTANDING_GATE_REPORT_DIR;
      else process.env.UNDERSTANDING_GATE_REPORT_DIR = savedReportDir;
    });

    async function startSubagentFromEnv(): Promise<{ recordWritten: boolean; stderr: string }> {
      const stderr = bufferStream();
      const result = await runPackHookSubagentStartCli({
        manifest: manifestWithPack(),
        stdin: readableFromString(eventBody()),
        stderr: stderr.stream,
        generatedDir,
      });
      return { recordWritten: result.recordWritten, stderr: stderr.read() };
    }

    it("edited report: no in-flight record is written", async () => {
      const reportPath = await approveRealFlow();
      editReport(reportPath);

      const start = await startSubagentFromEnv();

      expect(start.recordWritten).toBe(false);
      expect(start.stderr).toMatch(MISMATCH);
      expect(verifyInflightRecord(generatedDir, SESSION, AGENT).matched).toBe(false);
    });

    it("intact approval: the record is written", async () => {
      await approveRealFlow();

      const start = await startSubagentFromEnv();

      expect(start.recordWritten).toBe(true);
      expect(start.stderr).toMatch(/wrote in-flight record for agent agent-abc123 \(parent=session\)/);
      expect(verifyInflightRecord(generatedDir, SESSION, AGENT).matched).toBe(true);
    });
  });

  it("null-hash marker: unchanged, the record is written even though report files exist and none matches anything", async () => {
    writeReport("unrelated.json", "sess-other", "some other report");
    writeApprovalMarker(generatedDir, SESSION, {
      approvedAt: new Date().toISOString(),
      approvedBy: "test-operator",
      reportContentHash: null,
    });

    const start = await startSubagent();

    expect(start.recordWritten).toBe(true);
    expect(verifyInflightRecord(generatedDir, SESSION, AGENT).matched).toBe(true);
  });

  it("task-scoped marker whose report was edited: no record", async () => {
    const reportPath = writeReport("t1.json", "sess-task", "task report");
    writeActiveClaim(generatedDir, "task-live");
    writeTaskApprovalMarker(generatedDir, "task-live", {
      approvedAt: new Date().toISOString(),
      approvedBy: "operator",
      reportContentHash: canonicalReportHashOfFile(reportPath),
    });
    editReport(reportPath);

    const start = await startSubagent();

    expect(start.recordWritten).toBe(false);
    expect(start.stderr).toMatch(/approval refused, no report in the reports directory matches the content the task approval marker was signed for/);
    expect(verifyInflightRecord(generatedDir, SESSION, AGENT).matched).toBe(false);
  });

  it("task marker's report edited but the session marker behind it still verifies: the record is written and names the session marker", async () => {
    const sessionReport = writeReport("s1.json", SESSION, "session report");
    const taskReport = writeReport("t1.json", "sess-task", "task report");
    writeActiveClaim(generatedDir, "task-live");
    writeApprovalMarker(generatedDir, SESSION, {
      approvedAt: new Date().toISOString(),
      approvedBy: "operator",
      reportContentHash: canonicalReportHashOfFile(sessionReport),
    });
    writeTaskApprovalMarker(generatedDir, "task-live", {
      approvedAt: new Date().toISOString(),
      approvedBy: "operator",
      reportContentHash: canonicalReportHashOfFile(taskReport),
    });
    editReport(taskReport);

    const start = await startSubagent();

    expect(start.recordWritten).toBe(true);
    const verified = verifyInflightRecord(generatedDir, SESSION, AGENT);
    expect(verified.matched).toBe(true);
    expect(verified.detail).toMatch(/parent=session/);
    // The success diagnostic names the marker that verified, like the record.
    expect(start.stderr).toMatch(/wrote in-flight record for agent agent-abc123 \(parent=session\)/);
  });
});
