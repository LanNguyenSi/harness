import { Readable, Writable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPackHookPreToolUseCli } from "../../src/cli/pack/hook-pre-tool-use.js";
import type { LedgerEntry } from "../../src/policies/index.js";
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
    };
    expect(decision.decision).toBe("block");
    expect(decision.reason).toMatch(/Understanding Gate/);
    expect(decision.reason).toMatch(/harness approve understanding/);
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
