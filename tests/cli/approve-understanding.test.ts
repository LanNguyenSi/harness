import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approveUnderstanding } from "../../src/cli/approve/understanding.js";
import { HarnessExitError } from "../../src/cli/exit-codes.js";
import { REPORTS_DIR_ENV } from "../../src/policy-packs/builtin/understanding-before-execution-runtime.js";
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

describe("approveUnderstanding — reports-dir resolution (task 4f4a1178)", () => {
  let savedEnv: string | undefined;
  let originalCwd: string;

  beforeEach(() => {
    savedEnv = process.env[REPORTS_DIR_ENV];
    delete process.env[REPORTS_DIR_ENV];
    originalCwd = process.cwd();
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[REPORTS_DIR_ENV];
    else process.env[REPORTS_DIR_ENV] = savedEnv;
    process.chdir(originalCwd);
  });

  it("anchors the reports dir to the manifest directory when env + opt are unset", async () => {
    // The manifest's location is the stable anchor. The operator's cwd
    // is intentionally something completely unrelated so the test fails
    // loudly if the old cwd-relative resolution sneaks back in.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ug-approve-home-"));
    const unrelated = fs.mkdtempSync(path.join(os.tmpdir(), "ug-approve-cwd-"));
    try {
      const reportsDir = path.join(home, ".understanding-gate", "reports");
      fs.mkdirSync(reportsDir, { recursive: true });
      fs.writeFileSync(
        path.join(reportsDir, "rpt.json"),
        `${JSON.stringify({ sessionId: "sess-x", approvalStatus: "pending" }, null, 2)}\n`,
      );
      // Also pre-create the harness.yaml stub so resolvePaths().base
      // resolves under `home` (it computes <home>/harness.yaml).
      fs.writeFileSync(path.join(home, "harness.yaml"), "version: 1\n");

      process.chdir(unrelated);
      const result = await approveUnderstanding({
        manifest: manifest(),
        homeDir: home,
        session: "sess-x",
        generatedDir: path.join(home, "harness.generated"),
        ledgerAdd: async () => ({ ok: true }),
      });

      expect(result.persistedReport.ok).toBe(true);
      if (!result.persistedReport.ok) return;
      // The flipped report sits under the manifest-anchored dir, not
      // under `unrelated` (the operator's cwd).
      expect(result.persistedReport.filePath.startsWith(reportsDir)).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(unrelated, { recursive: true, force: true });
    }
  });

  it("honors UNDERSTANDING_GATE_REPORT_DIR over the manifest-anchored fallback", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ug-approve-home-"));
    const envDir = fs.mkdtempSync(path.join(os.tmpdir(), "ug-approve-env-"));
    try {
      fs.writeFileSync(path.join(home, "harness.yaml"), "version: 1\n");
      // Decoy: a report under the manifest-anchored dir that should NOT
      // be picked up because the env-var-pointed dir takes precedence.
      const manifestAnchored = path.join(home, ".understanding-gate", "reports");
      fs.mkdirSync(manifestAnchored, { recursive: true });
      fs.writeFileSync(
        path.join(manifestAnchored, "decoy.json"),
        `${JSON.stringify({ sessionId: "sess-x", approvalStatus: "pending" }, null, 2)}\n`,
      );
      // Real report lives under the env-var-pointed dir.
      fs.writeFileSync(
        path.join(envDir, "rpt.json"),
        `${JSON.stringify({ sessionId: "sess-x", approvalStatus: "pending" }, null, 2)}\n`,
      );

      process.env[REPORTS_DIR_ENV] = envDir;
      const result = await approveUnderstanding({
        manifest: manifest(),
        homeDir: home,
        session: "sess-x",
        generatedDir: path.join(home, "harness.generated"),
        ledgerAdd: async () => ({ ok: true }),
      });

      expect(result.persistedReport.ok).toBe(true);
      if (!result.persistedReport.ok) return;
      expect(result.persistedReport.filePath.startsWith(envDir)).toBe(true);
      // Decoy file untouched.
      const decoyAfter = JSON.parse(
        fs.readFileSync(path.join(manifestAnchored, "decoy.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(decoyAfter.approvalStatus).toBe("pending");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(envDir, { recursive: true, force: true });
    }
  });
});
