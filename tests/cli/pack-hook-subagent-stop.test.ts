// SubagentStop hook (subagent-gate slice 2): removes the in-flight
// record `subagent-start` wrote for this (session_id, agent_id) pair.
// Fixture shapes mirror pack-hook-subagent-start.test.ts and
// pack-hook-track-active-claim.test.ts.

import { Readable, Writable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPackHookSubagentStopCli } from "../../src/cli/pack/hook-subagent-stop.js";
import {
  verifyInflightRecord,
  writeApprovalMarker,
  writeInflightRecord,
} from "../../src/policy-packs/builtin/understanding-before-execution-runtime.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ug-subagent-stop-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
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

const SESSION = "sess-subagent-1";
const AGENT = "agent-abc123";

function eventBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: SESSION,
    agent_id: AGENT,
    hook_event_name: "SubagentStop",
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

function writeExistingRecord(generatedDir: string): void {
  writeApprovalMarker(generatedDir, SESSION, {
    approvedAt: new Date().toISOString(),
    approvedBy: "test-operator",
  });
  const result = writeInflightRecord({
    generatedDir,
    sessionId: SESSION,
    agentId: AGENT,
    agentType: "general-purpose",
    parent: {
      matched: true,
      source: "session",
      detail: "matched",
      taskCheckDetail: "n/a",
      expired: false,
      forged: false,
    },
  });
  if (!result.ok) throw new Error(`fixture setup failed: ${result.detail}`);
}

describe("pack hook subagent-stop — removes the in-flight record", () => {
  it("removes an existing record", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeExistingRecord(generatedDir);
    expect(verifyInflightRecord(generatedDir, SESSION, AGENT).matched).toBe(true);
    const stderr = bufferStream();

    const result = await runPackHookSubagentStopCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(eventBody()),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.exitCode).toBe(0);
    expect(result.cleared).toBe(true);
    expect(verifyInflightRecord(generatedDir, SESSION, AGENT).matched).toBe(false);
    expect(stderr.read()).toMatch(/cleared in-flight record for agent agent-abc123/);
  });

  it("no-op when no record exists", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const stderr = bufferStream();

    const result = await runPackHookSubagentStopCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(eventBody()),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.exitCode).toBe(0);
    expect(verifyInflightRecord(generatedDir, SESSION, AGENT).matched).toBe(false);
  });

  it("pause sentinel: no-op with a distinct diagnostic, record survives", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeExistingRecord(generatedDir);
    fs.writeFileSync(path.join(generatedDir, ".harness-paused"), pauseSentinelBody(null));
    const stderr = bufferStream();

    const result = await runPackHookSubagentStopCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(eventBody()),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.exitCode).toBe(0);
    expect(result.cleared).toBe(false);
    expect(verifyInflightRecord(generatedDir, SESSION, AGENT).matched).toBe(true);
    expect(stderr.read()).toMatch(/paused/);
  });

  it("missing agent_id: exit 0, record untouched", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeExistingRecord(generatedDir);
    const stderr = bufferStream();

    const result = await runPackHookSubagentStopCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(eventBody({ agent_id: undefined })),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.exitCode).toBe(0);
    expect(result.cleared).toBe(false);
    expect(verifyInflightRecord(generatedDir, SESSION, AGENT).matched).toBe(true);
    expect(stderr.read()).toMatch(/missing agent_id/);
  });

  it("skips on malformed event JSON without crashing", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeExistingRecord(generatedDir);
    const stderr = bufferStream();

    const result = await runPackHookSubagentStopCli({
      manifest: manifestWithPack(),
      stdin: readableFromString("not json"),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.exitCode).toBe(0);
    expect(result.cleared).toBe(false);
    expect(verifyInflightRecord(generatedDir, SESSION, AGENT).matched).toBe(true);
    expect(stderr.read()).toMatch(/malformed event JSON/);
  });

  it("skips silently when pack is enabled:false", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeExistingRecord(generatedDir);
    const stderr = bufferStream();

    const result = await runPackHookSubagentStopCli({
      manifest: manifestWithPack(false),
      stdin: readableFromString(eventBody()),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.exitCode).toBe(0);
    expect(result.cleared).toBe(false);
    expect(verifyInflightRecord(generatedDir, SESSION, AGENT).matched).toBe(true);
    expect(stderr.read()).toMatch(/enabled:false/);
  });
});
