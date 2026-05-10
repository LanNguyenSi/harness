import { Readable, Writable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPackHookCodexPreToolUseCli } from "../../src/cli/pack/hook-codex-pre-tool-use.js";
import type { LedgerEntry } from "../../src/policies/index.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ug-codex-blocker-"));
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

const event = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({ session_id: "sess-codex", tool_name: "apply_patch", ...overrides });

function writeReport(dir: string, name: string, body: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), `${JSON.stringify(body, null, 2)}\n`);
}

describe("pack hook codex-pre-tool-use blocker", () => {
  it("blocks with exit 2 + stderr reason when no source approves", async () => {
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
    expect(stderr.read()).toMatch(/BLOCK — no ledger entry matched .+ no reports found/);
    expect(stderr.read()).toMatch(/apply_patch/);
    expect(stderr.read()).toMatch(/harness approve understanding/);
  });

  it("allows on exit 0 when ledger query matches the approved tag", async () => {
    const stderr = bufferStream();
    const result = await runPackHookCodexPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(event()),
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
    expect(result.exitCode).toBe(0);
    expect(result.approvalCheck.source).toBe("ledger");
    expect(stderr.read()).toMatch(/approved via ledger tag/);
  });

  it("falls back to persisted report when ledger has no match", async () => {
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
    expect(result.blocked).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.approvalCheck.source).toBe("persisted-report");
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

  it("tolerates Codex-native field names (tool, id) in the envelope", async () => {
    const stderr = bufferStream();
    const result = await runPackHookCodexPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(JSON.stringify({ id: "sess-codex", tool: "apply_patch" })),
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
  });

  it("allows with diagnostic when stdin is malformed JSON", async () => {
    const stderr = bufferStream();
    const result = await runPackHookCodexPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString("{not-json"),
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
    });
    expect(result.blocked).toBe(false);
    expect(result.exitCode).toBe(0);
  });
});
