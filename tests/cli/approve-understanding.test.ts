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

  it("surfaces the latest parse-error log when reports/ is empty", async () => {
    // Simulate the layout the standalone Stop hook writes:
    //   <reports-parent>/.understanding-gate/{reports,parse-errors}/
    // tmp itself is the reports dir; parse-errors is its sibling.
    const reportsParent = fs.mkdtempSync(path.join(os.tmpdir(), "ug-with-parse-err-"));
    const reportsDir = path.join(reportsParent, "reports");
    const parseErrorsDir = path.join(reportsParent, "parse-errors");
    fs.mkdirSync(reportsDir);
    fs.mkdirSync(parseErrorsDir);
    fs.writeFileSync(
      path.join(parseErrorsDir, "2026-05-13T19-02-25-498Z-831a51.log"),
      `${JSON.stringify({
        sessionId: "sess-1",
        reason: "missing_sections",
        missing: ["currentUnderstanding", "intendedOutcome"],
        message: "Missing required sections: currentUnderstanding, intendedOutcome",
      })}\n--- raw ---\noriginal assistant text\n`,
    );
    try {
      const result = await approveUnderstanding({
        manifest: manifest(),
        session: "sess-1",
        reportsDir,
        ledgerAdd: async () => ({ ok: true }),
      });
      expect(result.persistedReport.ok).toBe(false);
      if (result.persistedReport.ok) return;
      expect(result.persistedReport.reason).toMatch(/no reports found/);
      expect(result.persistedReport.reason).toMatch(/latest parse-error at/);
      expect(result.persistedReport.reason).toMatch(/Missing required sections/);
    } finally {
      fs.rmSync(reportsParent, { recursive: true, force: true });
    }
  });

  it("filters parse-errors to the current session: stale logs from other sessions never leak", async () => {
    // Regression for agent-tasks/b13205b2: a previous-session parse-error
    // log would surface in the current operator's approve output and read
    // like a failure of THEIR session. The lookup is now sessionId-filtered.
    const reportsParent = fs.mkdtempSync(path.join(os.tmpdir(), "ug-cross-session-leak-"));
    const reportsDir = path.join(reportsParent, "reports");
    const parseErrorsDir = path.join(reportsParent, "parse-errors");
    fs.mkdirSync(reportsDir);
    fs.mkdirSync(parseErrorsDir);
    // Stale log from a DIFFERENT session, newer mtime than any future log.
    fs.writeFileSync(
      path.join(parseErrorsDir, "stale-other-session.log"),
      `${JSON.stringify({
        sessionId: "some-OTHER-session",
        reason: "no_marker_fast_confirm_attempt",
        mode: "fast_confirm",
      })}\n--- raw ---\nthe other session's text\n`,
    );
    try {
      const result = await approveUnderstanding({
        manifest: manifest(),
        session: "sess-1",
        reportsDir,
        ledgerAdd: async () => ({ ok: true }),
      });
      expect(result.persistedReport.ok).toBe(false);
      if (result.persistedReport.ok) return;
      expect(result.persistedReport.reason).toMatch(/no reports found/);
      // The cross-session leak: the OLD output would have surfaced
      // some-OTHER-session's log under "latest parse-error at ...".
      expect(result.persistedReport.reason).not.toMatch(/parse-error/);
      expect(result.persistedReport.reason).not.toMatch(/some-OTHER-session/);
    } finally {
      fs.rmSync(reportsParent, { recursive: true, force: true });
    }
  });

  it("picks the freshest CURRENT-session parse-error even when newer other-session logs exist", async () => {
    // The lookup must walk candidates in mtime order, not stop at the
    // first one: the directory-newest log might belong to a different
    // session, and the operator still wants their own latest failure.
    const reportsParent = fs.mkdtempSync(path.join(os.tmpdir(), "ug-mixed-sessions-"));
    const reportsDir = path.join(reportsParent, "reports");
    const parseErrorsDir = path.join(reportsParent, "parse-errors");
    fs.mkdirSync(reportsDir);
    fs.mkdirSync(parseErrorsDir);
    const ownLog = path.join(parseErrorsDir, "own.log");
    const otherLog = path.join(parseErrorsDir, "other.log");
    fs.writeFileSync(
      ownLog,
      `${JSON.stringify({
        sessionId: "sess-1",
        reason: "missing_sections",
        message: "Missing required sections: currentUnderstanding",
      })}\n--- raw ---\nown text\n`,
    );
    fs.writeFileSync(
      otherLog,
      `${JSON.stringify({
        sessionId: "another-session",
        reason: "no_marker_fast_confirm_attempt",
      })}\n--- raw ---\nother text\n`,
    );
    // Make `other.log` strictly NEWER on disk, so an unfiltered mtime
    // sort would land on it.
    const now = Date.now();
    fs.utimesSync(ownLog, now / 1000 - 60, now / 1000 - 60);
    fs.utimesSync(otherLog, now / 1000, now / 1000);
    try {
      const result = await approveUnderstanding({
        manifest: manifest(),
        session: "sess-1",
        reportsDir,
        ledgerAdd: async () => ({ ok: true }),
      });
      expect(result.persistedReport.ok).toBe(false);
      if (result.persistedReport.ok) return;
      expect(result.persistedReport.reason).toMatch(/Missing required sections/);
      expect(result.persistedReport.reason).not.toMatch(/another-session/);
    } finally {
      fs.rmSync(reportsParent, { recursive: true, force: true });
    }
  });

  it("ignores parse-error logs that cannot be attributed to a session", async () => {
    // Logs without a JSON header or without a `sessionId` field cannot be
    // attributed to anyone. Surfacing them would re-introduce the leak,
    // so they are skipped (same outcome as `no parse-error`).
    const reportsParent = fs.mkdtempSync(path.join(os.tmpdir(), "ug-with-bad-parse-err-"));
    const reportsDir = path.join(reportsParent, "reports");
    const parseErrorsDir = path.join(reportsParent, "parse-errors");
    fs.mkdirSync(reportsDir);
    fs.mkdirSync(parseErrorsDir);
    fs.writeFileSync(
      path.join(parseErrorsDir, "weird-format.log"),
      "freeform: something exploded\nmore context\n",
    );
    try {
      const result = await approveUnderstanding({
        manifest: manifest(),
        session: "sess-1",
        reportsDir,
        ledgerAdd: async () => ({ ok: true }),
      });
      expect(result.persistedReport.ok).toBe(false);
      if (result.persistedReport.ok) return;
      expect(result.persistedReport.reason).not.toMatch(/parse-error/);
      expect(result.persistedReport.reason).not.toMatch(/freeform/);
    } finally {
      fs.rmSync(reportsParent, { recursive: true, force: true });
    }
  });

  it("stays silent about parse-errors when the parse-errors dir does not exist", async () => {
    const result = await approveUnderstanding({
      manifest: manifest(),
      session: "sess-1",
      reportsDir: tmp,
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(result.persistedReport.ok).toBe(false);
    if (result.persistedReport.ok) return;
    expect(result.persistedReport.reason).not.toMatch(/parse-error/);
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

  it("clears .pending-approval even when the (audit-only) ledger write fails, as long as the marker landed (agent-tasks/88ca4bb3)", async () => {
    // Pre-v0.14.0 the ledger was the canonical signal, so its failure
    // had to keep the staging file for a later retry. With the marker
    // file as the canonical signal, the ledger write is audit-only and
    // a degraded ledger does NOT block consumption of the staged id.
    const generatedDir = path.join(tmp, "harness.generated");
    writePendingApproval(generatedDir, "sess-staged");
    const result = await approveUnderstanding({
      manifest: manifest(),
      reportsDir: tmp,
      generatedDir,
      ledgerAdd: async () => ({ ok: false, reason: "grounding-mcp timeout" }),
    });
    expect(result.ledger.ok).toBe(false);
    expect(result.marker.ok).toBe(true);
    expect(readPendingApproval(generatedDir)).toBeNull();
  });

  it("keeps .pending-approval when the (canonical) marker write fails (retry-friendly)", async () => {
    // Park a regular file where the marker's parent directory would
    // need to go: atomicWriteFile's mkdirSync fails with ENOTDIR, the
    // marker result is `ok:false`, the cleanup gate keeps the staged
    // id so the operator can retry once the path is unblocked.
    const generatedDir = path.join(tmp, "harness.generated-blocked");
    writePendingApproval(generatedDir, "sess-staged"); // creates generatedDir
    // Now park a regular file at <generatedDir>/.approvals so the
    // mkdirSync inside writeApprovalMarker fails. The .pending-approval
    // staging file already wrote into the dir and survives.
    fs.writeFileSync(path.join(generatedDir, ".approvals"), "");
    const result = await approveUnderstanding({
      manifest: manifest(),
      reportsDir: tmp,
      generatedDir,
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(result.marker.ok).toBe(false);
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

  it("error message points at `harness preflight` as the fastest bootstrap fix (task 0dbc9549)", async () => {
    // Regression for the chicken-and-egg friction the producer-side fix
    // (preflight stages .pending-approval) closes: even when neither
    // preflight nor a gate-block has fired yet, the error message must
    // tell the operator what single command unblocks them.
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
    expect((caught as Error).message).toMatch(/harness preflight/);
    expect((caught as Error).message).toMatch(/Fastest fix/);
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

describe("approveUnderstanding — task-scoped marker (harness/1ee26e77)", () => {
  it("writes a task-scoped marker alongside the session marker when --task is supplied", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const result = await approveUnderstanding({
      manifest: manifest(),
      session: "sess-1",
      task: "task-uuid-abc",
      reportsDir: tmp,
      generatedDir,
      now: new Date("2026-05-18T08:00:00Z"),
      approvedBy: "test-suite",
      ledgerAdd: async () => ({ ok: true }),
    });

    expect(result.marker.ok).toBe(true);
    if (!result.marker.ok) return;
    expect(fs.existsSync(result.marker.filePath)).toBe(true);

    expect(result.taskMarker).not.toBeNull();
    if (result.taskMarker === null || !result.taskMarker.ok) {
      throw new Error("expected ok task marker");
    }
    expect(result.taskMarker.taskId).toBe("task-uuid-abc");
    expect(result.taskMarker.filePath).toBe(
      path.join(generatedDir, ".approvals", "task-task-uuid-abc"),
    );
    expect(fs.existsSync(result.taskMarker.filePath)).toBe(true);

    const written = JSON.parse(fs.readFileSync(result.taskMarker.filePath, "utf8")) as {
      approvedAt: string;
      approvedBy: string;
    };
    expect(written.approvedAt).toBe("2026-05-18T08:00:00.000Z");
    expect(written.approvedBy).toBe("test-suite");
  });

  it("leaves taskMarker as null when --task is not supplied (no regression)", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const result = await approveUnderstanding({
      manifest: manifest(),
      session: "sess-1",
      reportsDir: tmp,
      generatedDir,
      ledgerAdd: async () => ({ ok: true }),
    });

    expect(result.marker.ok).toBe(true);
    expect(result.taskMarker).toBeNull();
    // Approvals directory has only the session marker, no task-* siblings.
    const approvals = fs.readdirSync(path.join(generatedDir, ".approvals"));
    expect(approvals.some((n) => n.startsWith("task-"))).toBe(false);
  });

  it("auto-resolves the task id from the active-claim file when --task is not supplied (harness/494fd1e5)", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    // Simulate the track-active-claim hook having written the file on
    // task_start.
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.writeFileSync(path.join(generatedDir, "active-claim"), "task-from-file\n");

    const result = await approveUnderstanding({
      manifest: manifest(),
      session: "sess-1",
      // NO `task:` option.
      reportsDir: tmp,
      generatedDir,
      now: new Date("2026-05-18T09:00:00Z"),
      approvedBy: "test-suite",
      ledgerAdd: async () => ({ ok: true }),
    });

    expect(result.taskMarker).not.toBeNull();
    if (result.taskMarker === null || !result.taskMarker.ok) {
      throw new Error("expected ok task marker");
    }
    expect(result.taskMarker.taskId).toBe("task-from-file");
    expect(result.taskMarker.source).toBe("active-claim");
    expect(result.taskMarker.filePath).toBe(
      path.join(generatedDir, ".approvals", "task-task-from-file"),
    );
    expect(fs.existsSync(result.taskMarker.filePath)).toBe(true);
  });

  it("--task overrides the active-claim file when both are present", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.writeFileSync(path.join(generatedDir, "active-claim"), "task-from-file\n");

    const result = await approveUnderstanding({
      manifest: manifest(),
      session: "sess-1",
      task: "task-from-flag", // takes precedence
      reportsDir: tmp,
      generatedDir,
      ledgerAdd: async () => ({ ok: true }),
    });

    if (result.taskMarker === null || !result.taskMarker.ok) {
      throw new Error("expected ok task marker");
    }
    expect(result.taskMarker.taskId).toBe("task-from-flag");
    expect(result.taskMarker.source).toBe("flag");
  });

  it("falls back to session-only when no --task AND no active-claim file exists (v1 back-compat)", async () => {
    const generatedDir = path.join(tmp, "harness.generated");

    const result = await approveUnderstanding({
      manifest: manifest(),
      session: "sess-1",
      reportsDir: tmp,
      generatedDir,
      ledgerAdd: async () => ({ ok: true }),
    });

    expect(result.taskMarker).toBeNull();
    const approvals = fs.readdirSync(path.join(generatedDir, ".approvals"));
    expect(approvals.some((n) => n.startsWith("task-"))).toBe(false);
  });
});
