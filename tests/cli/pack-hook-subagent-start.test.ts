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
import { runPackHookSubagentStartCli } from "../../src/cli/pack/hook-subagent-start.js";
import {
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
