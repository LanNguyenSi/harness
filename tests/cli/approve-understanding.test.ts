import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approveUnderstanding } from "../../src/cli/approve/understanding.js";
import { HarnessExitError } from "../../src/cli/exit-codes.js";
import { readPendingApproval, writePendingApproval } from "../../src/runtime/pending-approval.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ug-approve-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function manifest(): Manifest {
  return parseManifest({ version: 1 });
}

function writeReport(name: string, body: Record<string, unknown>): string {
  const full = path.join(tmp, name);
  fs.writeFileSync(full, `${JSON.stringify(body, null, 2)}\n`);
  return full;
}

describe("approveUnderstanding", () => {
  it("flips the latest matching report to approved + writes the ledger tag", async () => {
    const filePath = writeReport("rpt.json", {
      sessionId: "sess-1",
      approvalStatus: "pending",
    });
    const ledgerCalls: Array<{ sessionId: string; content: string }> = [];
    const result = await approveUnderstanding({
      manifest: manifest(),
      session: "sess-1",
      reportsDir: tmp,
      now: new Date("2026-05-07T08:00:00Z"),
      approvedBy: "test-suite",
      ledgerAdd: async (sessionId, content) => {
        ledgerCalls.push({ sessionId, content });
        return { ok: true };
      },
    });

    expect(result.sessionId).toBe("sess-1");
    expect(result.ledger.ok).toBe(true);
    expect(result.ledger.tag).toBe("understanding-approved:sess-1");
    expect(ledgerCalls).toEqual([
      { sessionId: "sess-1", content: "understanding-approved:sess-1" },
    ]);

    expect(result.persistedReport.ok).toBe(true);
    if (!result.persistedReport.ok) return;
    expect(result.persistedReport.previousStatus).toBe("pending");
    const after = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    expect(after.approvalStatus).toBe("approved");
    expect(after.approvedAt).toBe("2026-05-07T08:00:00.000Z");
    expect(after.approvedBy).toBe("test-suite");
  });

  it("succeeds when no persisted report exists (ledger-only path)", async () => {
    const result = await approveUnderstanding({
      manifest: manifest(),
      session: "sess-1",
      reportsDir: tmp,
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(result.ledger.ok).toBe(true);
    expect(result.persistedReport.ok).toBe(false);
    if (result.persistedReport.ok) return;
    expect(result.persistedReport.reason).toMatch(/no reports found/);
  });

  it("warns but does not throw when ledger write fails", async () => {
    writeReport("rpt.json", { sessionId: "sess-1", approvalStatus: "pending" });
    const result = await approveUnderstanding({
      manifest: manifest(),
      session: "sess-1",
      reportsDir: tmp,
      ledgerAdd: async () => ({ ok: false, reason: "grounding-mcp not declared" }),
    });
    expect(result.ledger.ok).toBe(false);
    expect(result.ledger.reason).toMatch(/not declared/);
    // Persisted report still flipped despite the ledger failure.
    expect(result.persistedReport.ok).toBe(true);
  });

  it("rejects when no session id is available", async () => {
    const before = process.env.CLAUDE_SESSION_ID;
    delete process.env.CLAUDE_SESSION_ID;
    try {
      let caught: unknown;
      try {
        await approveUnderstanding({
          manifest: manifest(),
          reportsDir: tmp,
          // Point at an empty generated dir so the .pending-approval tier
          // resolves to nothing and the test stays hermetic (no read of
          // the real ~/.claude/harness.generated/).
          generatedDir: path.join(tmp, "harness.generated"),
          ledgerAdd: async () => ({ ok: true }),
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(HarnessExitError);
      expect((caught as Error).message).toMatch(/no session id available/);
    } finally {
      if (before !== undefined) process.env.CLAUDE_SESSION_ID = before;
    }
  });

  it("falls back to a sessionless report when no exact-match report exists", async () => {
    writeReport("rpt.json", { approvalStatus: "pending" });
    const result = await approveUnderstanding({
      manifest: manifest(),
      session: "sess-1",
      reportsDir: tmp,
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(result.persistedReport.ok).toBe(true);
  });

  it("reports sessionSource=flag when --session is given", async () => {
    const result = await approveUnderstanding({
      manifest: manifest(),
      session: "sess-1",
      reportsDir: tmp,
      generatedDir: path.join(tmp, "harness.generated"),
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(result.sessionSource).toBe("flag");
  });
});

describe("approveUnderstanding — .pending-approval session resolution (task 33abc147)", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.CLAUDE_SESSION_ID;
    delete process.env.CLAUDE_SESSION_ID;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.CLAUDE_SESSION_ID;
    else process.env.CLAUDE_SESSION_ID = savedEnv;
  });

  it("resolves the session id from .pending-approval when no flag/env is set", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writePendingApproval(generatedDir, "sess-staged");
    const result = await approveUnderstanding({
      manifest: manifest(),
      reportsDir: tmp,
      generatedDir,
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(result.sessionId).toBe("sess-staged");
    expect(result.sessionSource).toBe("pending-approval");
    expect(result.ledger.tag).toBe("understanding-approved:sess-staged");
  });

  it("deletes .pending-approval after a successful (ledger-ok) resolve", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writePendingApproval(generatedDir, "sess-staged");
    await approveUnderstanding({
      manifest: manifest(),
      reportsDir: tmp,
      generatedDir,
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(readPendingApproval(generatedDir)).toBeNull();
  });

  it("keeps .pending-approval when the ledger write fails (retry-friendly)", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writePendingApproval(generatedDir, "sess-staged");
    const result = await approveUnderstanding({
      manifest: manifest(),
      reportsDir: tmp,
      generatedDir,
      ledgerAdd: async () => ({ ok: false, reason: "grounding-mcp timeout" }),
    });
    expect(result.ledger.ok).toBe(false);
    expect(readPendingApproval(generatedDir)).toBe("sess-staged");
  });

  it("prefers --session over a staged .pending-approval and leaves the file intact", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writePendingApproval(generatedDir, "sess-staged");
    const result = await approveUnderstanding({
      manifest: manifest(),
      session: "sess-flag",
      reportsDir: tmp,
      generatedDir,
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(result.sessionId).toBe("sess-flag");
    expect(result.sessionSource).toBe("flag");
    // Not consumed: the staged id was not the one we approved.
    expect(readPendingApproval(generatedDir)).toBe("sess-staged");
  });

  it("prefers $CLAUDE_SESSION_ID over a staged .pending-approval", async () => {
    process.env.CLAUDE_SESSION_ID = "sess-env";
    const generatedDir = path.join(tmp, "harness.generated");
    writePendingApproval(generatedDir, "sess-staged");
    const result = await approveUnderstanding({
      manifest: manifest(),
      reportsDir: tmp,
      generatedDir,
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(result.sessionId).toBe("sess-env");
    expect(result.sessionSource).toBe("env");
    expect(readPendingApproval(generatedDir)).toBe("sess-staged");
  });

  it("still throws when there is no flag, no env, and no staged file", async () => {
    let caught: unknown;
    try {
      await approveUnderstanding({
        manifest: manifest(),
        reportsDir: tmp,
        generatedDir: path.join(tmp, "harness.generated"),
        ledgerAdd: async () => ({ ok: true }),
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    expect((caught as Error).message).toMatch(/no session id available/);
    expect((caught as Error).message).toMatch(/\.pending-approval/);
  });
});
