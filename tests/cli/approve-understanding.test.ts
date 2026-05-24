import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approveUnderstanding, dedupeTaskIds } from "../../src/cli/approve/understanding.js";
import { buildProgram } from "../../src/cli/index.js";
import { HarnessExitError } from "../../src/cli/exit-codes.js";
import { REPORTS_DIR_ENV } from "../../src/policy-packs/builtin/understanding-before-execution-runtime.js";
import { readPendingApproval, writePendingApproval } from "../../src/runtime/pending-approval.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

let tmp: string;
// Top-level env hygiene: a global beforeEach clears all three session-id
// env vars so describe blocks that don't carry their own save/restore
// (the first one, plus any future block) cannot inherit an export from
// the operator's interactive shell or the harness CI shell. Describes
// that DO carry save/restore (the .pending-approval, runtime-neutral,
// and tier-5 blocks) layer on top: their beforeEach saves whatever this
// hook just cleared (`undefined`), runs the test, and restores to
// `undefined` — net effect identical.
let savedClaudeCodeTop: string | undefined;
let savedClaudeTop: string | undefined;
let savedCodexTop: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ug-approve-"));
  savedClaudeCodeTop = process.env.CLAUDE_CODE_SESSION_ID;
  savedClaudeTop = process.env.CLAUDE_SESSION_ID;
  savedCodexTop = process.env.CODEX_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_SESSION_ID;
  delete process.env.CODEX_SESSION_ID;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (savedClaudeCodeTop === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = savedClaudeCodeTop;
  if (savedClaudeTop === undefined) delete process.env.CLAUDE_SESSION_ID;
  else process.env.CLAUDE_SESSION_ID = savedClaudeTop;
  if (savedCodexTop === undefined) delete process.env.CODEX_SESSION_ID;
  else process.env.CODEX_SESSION_ID = savedCodexTop;
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
      generatedDir: path.join(tmp, "harness.generated"),
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
      generatedDir: path.join(tmp, "harness.generated"),
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
        generatedDir: path.join(reportsParent, "harness.generated"),
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
        generatedDir: path.join(reportsParent, "harness.generated"),
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
        generatedDir: path.join(reportsParent, "harness.generated"),
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
        generatedDir: path.join(reportsParent, "harness.generated"),
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
      generatedDir: path.join(tmp, "harness.generated"),
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
      generatedDir: path.join(tmp, "harness.generated"),
      ledgerAdd: async () => ({ ok: false, reason: "grounding-mcp not declared" }),
    });
    expect(result.ledger.ok).toBe(false);
    expect(result.ledger.reason).toMatch(/not declared/);
    // Persisted report still flipped despite the ledger failure.
    expect(result.persistedReport.ok).toBe(true);
  });

  it("rejects when no session id is available", async () => {
    const beforeClaudeCode = process.env.CLAUDE_CODE_SESSION_ID;
    const beforeClaude = process.env.CLAUDE_SESSION_ID;
    const beforeCodex = process.env.CODEX_SESSION_ID;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.CODEX_SESSION_ID;
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
      if (beforeClaudeCode !== undefined)
        process.env.CLAUDE_CODE_SESSION_ID = beforeClaudeCode;
      if (beforeClaude !== undefined) process.env.CLAUDE_SESSION_ID = beforeClaude;
      if (beforeCodex !== undefined) process.env.CODEX_SESSION_ID = beforeCodex;
    }
  });

  it("falls back to a sessionless report when no exact-match report exists", async () => {
    writeReport("rpt.json", { approvalStatus: "pending" });
    const result = await approveUnderstanding({
      manifest: manifest(),
      session: "sess-1",
      reportsDir: tmp,
      generatedDir: path.join(tmp, "harness.generated"),
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
  let savedClaudeCode: string | undefined;
  let savedEnv: string | undefined;
  let savedCodex: string | undefined;

  beforeEach(() => {
    savedClaudeCode = process.env.CLAUDE_CODE_SESSION_ID;
    savedEnv = process.env.CLAUDE_SESSION_ID;
    savedCodex = process.env.CODEX_SESSION_ID;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.CODEX_SESSION_ID;
  });

  afterEach(() => {
    if (savedClaudeCode === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = savedClaudeCode;
    if (savedEnv === undefined) delete process.env.CLAUDE_SESSION_ID;
    else process.env.CLAUDE_SESSION_ID = savedEnv;
    if (savedCodex === undefined) delete process.env.CODEX_SESSION_ID;
    else process.env.CODEX_SESSION_ID = savedCodex;
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
    expect(result.sessionSource).toBe("env-claude");
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

describe("approveUnderstanding — runtime-neutral session-id resolution (task f608b4ee)", () => {
  // Codex-only operators (no Claude Code installed) running arg-less
  // `harness approve understanding` historically saw a hint that named
  // only $CLAUDE_SESSION_ID and ~/.claude/projects/*/*.jsonl. Two
  // complementary fixes in this task: (a) $CODEX_SESSION_ID is now a
  // peer of $CLAUDE_SESSION_ID in the env-tier, (b) the freshest
  // persisted report's sessionId field is a tier-5 fallback so the
  // post-Understanding-Report-pre-block window also resolves cleanly.
  let savedClaudeCode: string | undefined;
  let savedClaude: string | undefined;
  let savedCodex: string | undefined;

  beforeEach(() => {
    savedClaudeCode = process.env.CLAUDE_CODE_SESSION_ID;
    savedClaude = process.env.CLAUDE_SESSION_ID;
    savedCodex = process.env.CODEX_SESSION_ID;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.CODEX_SESSION_ID;
  });

  afterEach(() => {
    if (savedClaudeCode === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = savedClaudeCode;
    if (savedClaude === undefined) delete process.env.CLAUDE_SESSION_ID;
    else process.env.CLAUDE_SESSION_ID = savedClaude;
    if (savedCodex === undefined) delete process.env.CODEX_SESSION_ID;
    else process.env.CODEX_SESSION_ID = savedCodex;
  });

  it("resolves $CLAUDE_CODE_SESSION_ID when only the canonical Claude Code var is set", async () => {
    // Task 058b31a3: Claude Code exports CLAUDE_CODE_SESSION_ID (not
    // CLAUDE_SESSION_ID) into the agent shell. Resolve it first so an
    // arg-less `harness approve understanding` from inside Claude Code
    // never silently falls through to the report-guess tier.
    process.env.CLAUDE_CODE_SESSION_ID = "sess-claude-code-env";
    writeReport("rpt.json", {
      sessionId: "sess-claude-code-env",
      approvalStatus: "pending",
    });
    const result = await approveUnderstanding({
      manifest: manifest(),
      reportsDir: tmp,
      generatedDir: path.join(tmp, "harness.generated"),
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(result.sessionId).toBe("sess-claude-code-env");
    expect(result.sessionSource).toBe("env-claude-code");
  });

  it("prefers $CLAUDE_CODE_SESSION_ID over $CLAUDE_SESSION_ID when both are set", async () => {
    // Documented precedence: an operator inside a Claude Code session
    // who has ALSO manually exported the legacy CLAUDE_SESSION_ID
    // (e.g. as a workaround for the pre-058b31a3 bug) gets the runtime
    // value, not their hand-typed one. Prevents the workaround from
    // shadowing the runtime export after the fix lands.
    process.env.CLAUDE_CODE_SESSION_ID = "sess-claude-code-env";
    process.env.CLAUDE_SESSION_ID = "sess-claude-legacy-env";
    writeReport("rpt.json", {
      sessionId: "sess-claude-code-env",
      approvalStatus: "pending",
    });
    const result = await approveUnderstanding({
      manifest: manifest(),
      reportsDir: tmp,
      generatedDir: path.join(tmp, "harness.generated"),
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(result.sessionId).toBe("sess-claude-code-env");
    expect(result.sessionSource).toBe("env-claude-code");
  });

  it("resolves $CODEX_SESSION_ID when $CLAUDE_SESSION_ID is unset", async () => {
    process.env.CODEX_SESSION_ID = "sess-codex-env";
    writeReport("rpt.json", {
      sessionId: "sess-codex-env",
      approvalStatus: "pending",
    });
    const result = await approveUnderstanding({
      manifest: manifest(),
      reportsDir: tmp,
      generatedDir: path.join(tmp, "harness.generated"),
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(result.sessionId).toBe("sess-codex-env");
    expect(result.sessionSource).toBe("env-codex");
  });

  it("prefers $CLAUDE_SESSION_ID over $CODEX_SESSION_ID when both are set", async () => {
    // Documented precedence: a dual-env environment (an operator running
    // Codex from inside a Claude shell, or vice versa) takes the Claude
    // tier first — this is back-compat with the pre-task behaviour where
    // $CLAUDE_SESSION_ID was the only env tier. The PR body / hint text
    // calls out this precedence so the operator can pin via --session if
    // the wrong one wins.
    process.env.CLAUDE_SESSION_ID = "sess-claude-env";
    process.env.CODEX_SESSION_ID = "sess-codex-env";
    writeReport("rpt.json", {
      sessionId: "sess-claude-env",
      approvalStatus: "pending",
    });
    const result = await approveUnderstanding({
      manifest: manifest(),
      reportsDir: tmp,
      generatedDir: path.join(tmp, "harness.generated"),
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(result.sessionId).toBe("sess-claude-env");
    expect(result.sessionSource).toBe("env-claude");
  });

  it("falls back to the newest report's sessionId when flag/env/pending-approval are all empty", async () => {
    // Three reports, second one is newest by mtime; sessionId comes
    // from that one. Mirrors the Codex dogfood flow where the agent
    // produced an Understanding Report but no Bash tool call has yet
    // tripped the PreToolUse hook to stage `.pending-approval`.
    const older = writeReport("rpt-older.json", {
      sessionId: "sess-older",
      approvalStatus: "pending",
    });
    const newest = writeReport("rpt-newest.json", {
      sessionId: "sess-newest",
      approvalStatus: "pending",
    });
    // Force mtime ordering: older's mtime BEFORE newest's, by an amount
    // larger than fs mtime quantum (s on some platforms).
    const past = new Date("2026-05-19T07:00:00Z");
    const now = new Date("2026-05-19T08:00:00Z");
    fs.utimesSync(older, past, past);
    fs.utimesSync(newest, now, now);
    const result = await approveUnderstanding({
      manifest: manifest(),
      reportsDir: tmp,
      generatedDir: path.join(tmp, "harness.generated"),
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(result.sessionId).toBe("sess-newest");
    expect(result.sessionSource).toBe("newest-report");
  });

  it("skips reports whose sessionId is null and picks the newest one that has it", async () => {
    // Legacy package versions wrote reports without a sessionId field.
    // The tier-5 lookup must walk past them, not stop at the bare-newest.
    const legacy = writeReport("rpt-legacy.json", {
      approvalStatus: "pending",
    });
    const tagged = writeReport("rpt-tagged.json", {
      sessionId: "sess-tagged",
      approvalStatus: "pending",
    });
    // Legacy is newer by mtime, but its sessionId is null so the tier-5
    // lookup skips it and picks the older tagged one.
    const newer = new Date("2026-05-19T08:00:00Z");
    const older = new Date("2026-05-19T07:00:00Z");
    fs.utimesSync(legacy, newer, newer);
    fs.utimesSync(tagged, older, older);
    const result = await approveUnderstanding({
      manifest: manifest(),
      reportsDir: tmp,
      generatedDir: path.join(tmp, "harness.generated"),
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(result.sessionId).toBe("sess-tagged");
    expect(result.sessionSource).toBe("newest-report");
  });

  it("staged .pending-approval still wins over a newer report (tier-4 beats tier-5)", async () => {
    // Documented precedence: a recent gate-block staging signal beats
    // an even-newer report file, because the staging file was written
    // by an actual gate trip and is therefore guaranteed to match the
    // session that is currently being blocked.
    const generatedDir = path.join(tmp, "harness.generated");
    writePendingApproval(generatedDir, "sess-staged");
    writeReport("rpt-newer.json", {
      sessionId: "sess-newer-report",
      approvalStatus: "pending",
    });
    const result = await approveUnderstanding({
      manifest: manifest(),
      reportsDir: tmp,
      generatedDir,
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(result.sessionId).toBe("sess-staged");
    expect(result.sessionSource).toBe("pending-approval");
  });

  it("no-session error message names every accepted env var and the reports dir, not Claude's transcript path", async () => {
    let caught: unknown;
    try {
      await approveUnderstanding({
        manifest: manifest(),
        reportsDir: path.join(tmp, "no-reports"),
        generatedDir: path.join(tmp, "harness.generated"),
        ledgerAdd: async () => ({ ok: true }),
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    const msg = (caught as Error).message;
    // Every accepted env var is named so an operator inside any runtime
    // can fix the call themselves.
    expect(msg).toContain("$CLAUDE_CODE_SESSION_ID");
    expect(msg).toContain("$CLAUDE_SESSION_ID");
    expect(msg).toContain("$CODEX_SESSION_ID");
    // Runtime-neutral discovery: the reports dir + sessionId JSON field.
    expect(msg).toContain("sessionId");
    expect(msg).toContain(path.join(tmp, "no-reports"));
    // Claude-only transcript-grep guidance must be gone.
    expect(msg).not.toContain("~/.claude/projects/");
    expect(msg).not.toContain(".jsonl");
    // The "harness preflight" fastest-fix line is preserved.
    expect(msg).toMatch(/harness preflight/);
    expect(msg).toMatch(/Fastest fix/);
  });
});

describe("approveUnderstanding — tier-5 only adopts a pending report (harness/56f51f2b)", () => {
  // Bug observed 2026-05-20: bare `harness approve understanding` (no
  // --session, no env, no staged `.pending-approval`) fell through to
  // tier 5 and adopted the freshest report with ANY approvalStatus.
  // That picked a 2-day-old `approved`/`expired` report from an
  // unrelated Codex session and approved THAT session; the live
  // session stayed gated. Tier 5 now only adopts a `pending` report (a
  // fresh, not-yet-consumed gate cycle).
  let savedClaudeCode: string | undefined;
  let savedClaude: string | undefined;
  let savedCodex: string | undefined;

  beforeEach(() => {
    savedClaudeCode = process.env.CLAUDE_CODE_SESSION_ID;
    savedClaude = process.env.CLAUDE_SESSION_ID;
    savedCodex = process.env.CODEX_SESSION_ID;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.CODEX_SESSION_ID;
  });

  afterEach(() => {
    if (savedClaudeCode === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = savedClaudeCode;
    if (savedClaude === undefined) delete process.env.CLAUDE_SESSION_ID;
    else process.env.CLAUDE_SESSION_ID = savedClaude;
    if (savedCodex === undefined) delete process.env.CODEX_SESSION_ID;
    else process.env.CODEX_SESSION_ID = savedCodex;
  });

  it("skips a newer approved/expired report and adopts the older pending one", async () => {
    // The stale reports are NEWER by mtime: pre-fix the resolver stopped
    // at the bare-newest and would approve a `sess-stale-*` session.
    const staleApproved = writeReport("rpt-approved.json", {
      sessionId: "sess-stale-approved",
      approvalStatus: "approved",
    });
    const staleExpired = writeReport("rpt-expired.json", {
      sessionId: "sess-stale-expired",
      approvalStatus: "expired",
    });
    const livePending = writeReport("rpt-live.json", {
      sessionId: "sess-live",
      approvalStatus: "pending",
    });
    const newer = new Date("2026-05-20T09:00:00Z");
    const older = new Date("2026-05-18T09:00:00Z");
    fs.utimesSync(staleApproved, newer, newer);
    fs.utimesSync(staleExpired, newer, newer);
    fs.utimesSync(livePending, older, older);
    const result = await approveUnderstanding({
      manifest: manifest(),
      reportsDir: tmp,
      generatedDir: path.join(tmp, "harness.generated"),
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(result.sessionId).toBe("sess-live");
    expect(result.sessionSource).toBe("newest-report");
    expect(result.newestReportPath).toBe(livePending);
  });

  it("throws the no-session-id error when every report is approved/expired", async () => {
    // A finished gate cycle must NOT be silently adopted; with no fresh
    // `pending` report and no explicit id, the command must fail loudly
    // rather than approve a stale unrelated session.
    writeReport("rpt-approved.json", {
      sessionId: "sess-a",
      approvalStatus: "approved",
    });
    writeReport("rpt-expired.json", {
      sessionId: "sess-b",
      approvalStatus: "expired",
    });
    let caught: unknown;
    try {
      await approveUnderstanding({
        manifest: manifest(),
        reportsDir: tmp,
        generatedDir: path.join(tmp, "harness.generated"),
        ledgerAdd: async () => ({ ok: true }),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    expect((caught as Error).message).toContain("no session id available");
  });

  it("leaves newestReportPath undefined for non-tier-5 sources", async () => {
    writeReport("rpt.json", { sessionId: "sess-flag", approvalStatus: "pending" });
    const result = await approveUnderstanding({
      session: "sess-flag",
      manifest: manifest(),
      reportsDir: tmp,
      generatedDir: path.join(tmp, "harness.generated"),
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(result.sessionSource).toBe("flag");
    expect(result.newestReportPath).toBeUndefined();
  });

  it("skips a report whose approvalStatus field is missing (legacy Stop-hook output)", async () => {
    // Older @lannguyensi/understanding-gate versions wrote reports
    // without an approvalStatus field; readPersistedReport maps that to
    // null, which is not "pending", so tier 5 must skip it rather than
    // adopt an unverifiable session id from it.
    const legacy = writeReport("rpt-legacy.json", {
      sessionId: "sess-legacy-nostatus",
    });
    const pending = writeReport("rpt-pending.json", {
      sessionId: "sess-pending",
      approvalStatus: "pending",
    });
    const newer = new Date("2026-05-20T09:00:00Z");
    const older = new Date("2026-05-18T09:00:00Z");
    fs.utimesSync(legacy, newer, newer);
    fs.utimesSync(pending, older, older);
    const result = await approveUnderstanding({
      manifest: manifest(),
      reportsDir: tmp,
      generatedDir: path.join(tmp, "harness.generated"),
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(result.sessionId).toBe("sess-pending");
    expect(result.sessionSource).toBe("newest-report");
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

    expect(result.taskMarkers).toHaveLength(1);
    const tm = result.taskMarkers[0];
    if (tm === undefined || !tm.ok) {
      throw new Error("expected ok task marker");
    }
    expect(tm.taskId).toBe("task-uuid-abc");
    expect(tm.filePath).toBe(
      path.join(generatedDir, ".approvals", "task-task-uuid-abc"),
    );
    expect(fs.existsSync(tm.filePath)).toBe(true);

    const written = JSON.parse(fs.readFileSync(tm.filePath, "utf8")) as {
      approvedAt: string;
      approvedBy: string;
    };
    expect(written.approvedAt).toBe("2026-05-18T08:00:00.000Z");
    expect(written.approvedBy).toBe("test-suite");
  });

  it("leaves taskMarkers empty when --task is not supplied (no regression)", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const result = await approveUnderstanding({
      manifest: manifest(),
      session: "sess-1",
      reportsDir: tmp,
      generatedDir,
      ledgerAdd: async () => ({ ok: true }),
    });

    expect(result.marker.ok).toBe(true);
    expect(result.taskMarkers).toEqual([]);
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

    expect(result.taskMarkers).toHaveLength(1);
    const tm = result.taskMarkers[0];
    if (tm === undefined || !tm.ok) {
      throw new Error("expected ok task marker");
    }
    expect(tm.taskId).toBe("task-from-file");
    expect(tm.source).toBe("active-claim");
    expect(tm.filePath).toBe(
      path.join(generatedDir, ".approvals", "task-task-from-file"),
    );
    expect(fs.existsSync(tm.filePath)).toBe(true);
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

    const tm = result.taskMarkers[0];
    if (tm === undefined || !tm.ok) {
      throw new Error("expected ok task marker");
    }
    expect(tm.taskId).toBe("task-from-flag");
    expect(tm.source).toBe("flag");
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

    expect(result.taskMarkers).toEqual([]);
    const approvals = fs.readdirSync(path.join(generatedDir, ".approvals"));
    expect(approvals.some((n) => n.startsWith("task-"))).toBe(false);
  });
});

describe("approveUnderstanding — multi-task pre-approval (harness/0dce3880)", () => {
  it("writes one marker per id when opts.tasks lists several", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const result = await approveUnderstanding({
      manifest: manifest(),
      session: "sess-1",
      tasks: ["task-a", "task-b", "task-c"],
      reportsDir: tmp,
      generatedDir,
      now: new Date("2026-05-20T08:00:00Z"),
      approvedBy: "test-suite",
      ledgerAdd: async () => ({ ok: true }),
    });

    expect(result.taskMarkers).toHaveLength(3);
    for (const tm of result.taskMarkers) {
      if (!tm.ok) throw new Error(`expected ok task marker, got ${tm.reason}`);
      expect(tm.source).toBe("flag");
      expect(fs.existsSync(tm.filePath)).toBe(true);
    }
    expect(result.taskMarkers.map((t) => t.ok && t.taskId)).toEqual([
      "task-a",
      "task-b",
      "task-c",
    ]);
    const approvals = fs.readdirSync(path.join(generatedDir, ".approvals"));
    expect(approvals.filter((n) => n.startsWith("task-")).sort()).toEqual([
      "task-task-a",
      "task-task-b",
      "task-task-c",
    ]);
  });

  it("comma-splits and de-duplicates opts.tasks entries", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const result = await approveUnderstanding({
      manifest: manifest(),
      session: "sess-1",
      // mixed comma-joined + repeated + padded; expect t1,t2,t3 unique.
      tasks: ["t1,t2", " t2 ", "t3"],
      reportsDir: tmp,
      generatedDir,
      ledgerAdd: async () => ({ ok: true }),
    });

    expect(result.taskMarkers.map((t) => t.ok && t.taskId)).toEqual([
      "t1",
      "t2",
      "t3",
    ]);
  });

  it("opts.tasks takes precedence over the single-id opts.task", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const result = await approveUnderstanding({
      manifest: manifest(),
      session: "sess-1",
      task: "single",
      tasks: ["multi-a", "multi-b"],
      reportsDir: tmp,
      generatedDir,
      ledgerAdd: async () => ({ ok: true }),
    });

    expect(result.taskMarkers.map((t) => t.ok && t.taskId)).toEqual([
      "multi-a",
      "multi-b",
    ]);
  });

  it("a single failing id does not abort the surrounding markers", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    // The middle id contains a path separator; writeTaskApprovalMarker's
    // rejectMalformedTaskId throws for it. The surrounding ids must
    // still get their markers.
    const result = await approveUnderstanding({
      manifest: manifest(),
      session: "sess-1",
      tasks: ["good-1", "bad/traversal", "good-2"],
      reportsDir: tmp,
      generatedDir,
      ledgerAdd: async () => ({ ok: true }),
    });

    expect(result.taskMarkers).toHaveLength(3);
    const [a, b, c] = result.taskMarkers;
    expect(a?.ok).toBe(true);
    expect(b?.ok).toBe(false);
    expect(c?.ok).toBe(true);
    if (b === undefined || b.ok) throw new Error("expected middle marker to fail");
    expect(b.taskId).toBe("bad/traversal");
    expect(b.reason).toMatch(/path-separator|traversal/);
    // Both good markers landed on disk.
    const approvals = fs.readdirSync(path.join(generatedDir, ".approvals"));
    expect(approvals.filter((n) => n.startsWith("task-")).sort()).toEqual([
      "task-good-1",
      "task-good-2",
    ]);
  });
});

describe("dedupeTaskIds", () => {
  it("comma-splits, trims, drops blanks, de-dups preserving first-seen order", () => {
    expect(dedupeTaskIds(["t1,t2", " t2 ", "t3", "", "  "])).toEqual([
      "t1",
      "t2",
      "t3",
    ]);
  });

  it("returns an empty array for all-blank input", () => {
    expect(dedupeTaskIds(["", "  ", ","])).toEqual([]);
  });

  it("leaves a clean single-element list untouched", () => {
    expect(dedupeTaskIds(["only"])).toEqual(["only"]);
  });
});

describe("harness approve understanding — CLI --task option", () => {
  it("declares --task as a variadic option", () => {
    const program = buildProgram();
    const approve = program.commands.find((c) => c.name() === "approve");
    const understanding = approve?.commands.find((c) => c.name() === "understanding");
    const taskOpt = understanding?.options.find((o) => o.long === "--task");
    expect(taskOpt, "--task option should be registered").toBeDefined();
    expect(taskOpt?.variadic, "--task should be variadic for batch pre-approval").toBe(true);
  });

  it("declares --force as a non-variadic boolean option", () => {
    const program = buildProgram();
    const approve = program.commands.find((c) => c.name() === "approve");
    const understanding = approve?.commands.find((c) => c.name() === "understanding");
    const forceOpt = understanding?.options.find((o) => o.long === "--force");
    expect(forceOpt, "--force option should be registered").toBeDefined();
    expect(forceOpt?.variadic).toBeFalsy();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Approve-time content validation: priorArt enforcement on grill_me reports.
// The dogfood loop (2026-05-24, session eff67763-…) found that the approve
// CLI was writing the marker without re-checking the report against any
// structural rule. v1 enforces the one rule the dogfood made concrete:
// a `grill_me` report must declare a non-empty priorArt list with no
// literal `- None`. `fast_confirm` reports are exempt (the relaxed schema
// drops priorArt from `required`). `--force` bypasses with audit.
// ─────────────────────────────────────────────────────────────────────

describe("approveUnderstanding — approve-time validation (priorArt on grill_me)", () => {
  function generatedDirFor(): string {
    return path.join(tmp, "harness.generated");
  }

  function approvalMarkerPath(sessionId: string): string {
    return path.join(generatedDirFor(), ".approvals", sessionId);
  }

  it("rejects a grill_me report whose priorArt field is missing", async () => {
    const filePath = writeReport("rpt.json", {
      sessionId: "sess-1",
      mode: "grill_me",
      approvalStatus: "pending",
      // NO priorArt field.
    });
    const result = await approveUnderstanding({
      manifest: manifest(),
      session: "sess-1",
      reportsDir: tmp,
      generatedDir: generatedDirFor(),
      ledgerAdd: async () => ({ ok: true }),
    });

    expect(result.marker.ok).toBe(false);
    if (result.marker.ok) return;
    expect(result.marker.reason).toMatch(/priorArt/);
    expect(result.ledger.ok).toBe(false);
    expect(result.persistedReport.ok).toBe(false);
    // The validation field carries the structured failure.
    expect("ok" in result.validation && result.validation.ok).toBe(false);
    if ("ok" in result.validation && result.validation.ok === false) {
      expect(result.validation.field).toBe("priorArt");
      expect(result.validation.enforced).toBe(true);
    }
    // No marker file on disk.
    expect(fs.existsSync(approvalMarkerPath("sess-1"))).toBe(false);
    // Report NOT flipped to approved.
    const after = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    expect(after.approvalStatus).toBe("pending");
  });

  it("rejects a grill_me report whose priorArt is an empty array", async () => {
    writeReport("rpt.json", {
      sessionId: "sess-1",
      mode: "grill_me",
      priorArt: [],
      approvalStatus: "pending",
    });
    const result = await approveUnderstanding({
      manifest: manifest(),
      session: "sess-1",
      reportsDir: tmp,
      generatedDir: generatedDirFor(),
      ledgerAdd: async () => ({ ok: true }),
    });

    expect(result.marker.ok).toBe(false);
    if (result.marker.ok) return;
    expect(result.marker.reason).toMatch(/priorArt/);
    expect(fs.existsSync(approvalMarkerPath("sess-1"))).toBe(false);
  });

  it("rejects a grill_me report whose priorArt is entirely literal `- None`", async () => {
    writeReport("rpt.json", {
      sessionId: "sess-1",
      mode: "grill_me",
      priorArt: ["- None"],
      approvalStatus: "pending",
    });
    const result = await approveUnderstanding({
      manifest: manifest(),
      session: "sess-1",
      reportsDir: tmp,
      generatedDir: generatedDirFor(),
      ledgerAdd: async () => ({ ok: true }),
    });

    expect(result.marker.ok).toBe(false);
    if (result.marker.ok) return;
    expect(result.marker.reason).toMatch(/None/i);
  });

  it("accepts a grill_me report with a mixed priorArt list (some None, some real entries)", async () => {
    // Mixed signal — there is substance, so v1 lets it through. Only
    // a list that is ENTIRELY the None placeholder is rejected.
    writeReport("rpt.json", {
      sessionId: "sess-1",
      mode: "grill_me",
      priorArt: ["checked npm: nothing matches", "None"],
      approvalStatus: "pending",
    });
    const result = await approveUnderstanding({
      manifest: manifest(),
      session: "sess-1",
      reportsDir: tmp,
      generatedDir: generatedDirFor(),
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(result.marker.ok).toBe(true);
    expect("ok" in result.validation && result.validation.ok).toBe(true);
  });

  it("rejects a grill_me report with an empty-string priorArt item", async () => {
    writeReport("rpt.json", {
      sessionId: "sess-1",
      mode: "grill_me",
      priorArt: ["a real entry", "   "],
      approvalStatus: "pending",
    });
    const result = await approveUnderstanding({
      manifest: manifest(),
      session: "sess-1",
      reportsDir: tmp,
      generatedDir: generatedDirFor(),
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(result.marker.ok).toBe(false);
  });

  it("approves cleanly when grill_me priorArt is a non-empty list of real entries", async () => {
    const filePath = writeReport("rpt.json", {
      sessionId: "sess-1",
      mode: "grill_me",
      priorArt: [
        "Channels checked: npm, MCP directory, local repos",
        "Closest existing: none — first iteration",
        "Judgment: build new",
      ],
      approvalStatus: "pending",
    });
    const result = await approveUnderstanding({
      manifest: manifest(),
      session: "sess-1",
      reportsDir: tmp,
      generatedDir: generatedDirFor(),
      ledgerAdd: async () => ({ ok: true }),
    });

    expect(result.marker.ok).toBe(true);
    expect(result.persistedReport.ok).toBe(true);
    expect("ok" in result.validation && result.validation.ok).toBe(true);
    if ("ok" in result.validation && result.validation.ok) {
      expect(result.validation.mode).toBe("grill_me");
    }
    // Marker file present, ledger tag intact (no `:forced:` suffix).
    expect(fs.existsSync(approvalMarkerPath("sess-1"))).toBe(true);
    expect(result.ledger.tag).toBe("understanding-approved:sess-1");
    const after = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    expect(after.approvalStatus).toBe("approved");
  });

  it("approves a fast_confirm report without priorArt (no regression)", async () => {
    writeReport("rpt.json", {
      sessionId: "sess-1",
      mode: "fast_confirm",
      approvalStatus: "pending",
      // NO priorArt — fast_confirm schema does not require it.
    });
    const result = await approveUnderstanding({
      manifest: manifest(),
      session: "sess-1",
      reportsDir: tmp,
      generatedDir: generatedDirFor(),
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(result.marker.ok).toBe(true);
    expect(result.persistedReport.ok).toBe(true);
    expect("ok" in result.validation && result.validation.ok).toBe(true);
    if ("ok" in result.validation && result.validation.ok) {
      expect(result.validation.mode).toBe("fast_confirm");
    }
  });

  it("approves a legacy report without `mode` field (lenient on pre-v0.4.0 reports)", async () => {
    // Reports written before the mode field was introduced get a null
    // mode at parse time; validation must waive enforcement so the
    // schema bump does not retroactively reject historical reports.
    writeReport("rpt.json", {
      sessionId: "sess-1",
      // NO mode field, NO priorArt.
      approvalStatus: "pending",
    });
    const result = await approveUnderstanding({
      manifest: manifest(),
      session: "sess-1",
      reportsDir: tmp,
      generatedDir: generatedDirFor(),
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(result.marker.ok).toBe(true);
    expect("ok" in result.validation && result.validation.ok).toBe(true);
  });

  it("--force bypasses validation, writes the marker, and stamps the ledger tag with `:forced:<field>`", async () => {
    const filePath = writeReport("rpt.json", {
      sessionId: "sess-1",
      mode: "grill_me",
      approvalStatus: "pending",
      // NO priorArt.
    });
    const ledgerCalls: Array<{ sessionId: string; content: string }> = [];
    const result = await approveUnderstanding({
      manifest: manifest(),
      session: "sess-1",
      force: true,
      reportsDir: tmp,
      generatedDir: generatedDirFor(),
      ledgerAdd: async (sessionId, content) => {
        ledgerCalls.push({ sessionId, content });
        return { ok: true };
      },
    });

    expect(result.marker.ok).toBe(true);
    expect(result.persistedReport.ok).toBe(true);
    // Validation is NOT-ok but `enforced: false` because --force was set.
    expect("ok" in result.validation && result.validation.ok).toBe(false);
    if ("ok" in result.validation && result.validation.ok === false) {
      expect(result.validation.enforced).toBe(false);
      expect(result.validation.field).toBe("priorArt");
    }
    // Ledger tag carries the audit suffix.
    expect(result.ledger.tag).toBe("understanding-approved:sess-1:forced:priorArt");
    expect(ledgerCalls).toEqual([
      {
        sessionId: "sess-1",
        content: "understanding-approved:sess-1:forced:priorArt",
      },
    ]);
    // Marker file present + report flipped to approved.
    expect(fs.existsSync(approvalMarkerPath("sess-1"))).toBe(true);
    const after = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    expect(after.approvalStatus).toBe("approved");
  });

  it("marks validation as skipped when no report is loaded (ledger-only path)", async () => {
    const result = await approveUnderstanding({
      manifest: manifest(),
      session: "sess-1",
      reportsDir: tmp,
      generatedDir: generatedDirFor(),
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(result.marker.ok).toBe(true);
    expect("skipped" in result.validation && result.validation.skipped).toBe(true);
  });
});

describe("approveUnderstanding — report sessionId binding (harness/0dce3880 friction #1)", () => {
  it("stamps the current sessionId onto a report that lacks one", async () => {
    const filePath = writeReport("no-session.json", {
      // NO sessionId field — older Stop-hook package output.
      approvalStatus: "pending",
    });
    const result = await approveUnderstanding({
      manifest: manifest(),
      session: "sess-stamp",
      reportsDir: tmp,
      generatedDir: path.join(tmp, "harness.generated"),
      ledgerAdd: async () => ({ ok: true }),
    });

    expect(result.persistedReport.ok).toBe(true);
    if (!result.persistedReport.ok) return;
    expect(result.persistedReport.sessionIdStamped).toBe(true);
    const after = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    expect(after.sessionId).toBe("sess-stamp");
    expect(after.approvalStatus).toBe("approved");
  });

  it("leaves an existing sessionId untouched and reports sessionIdStamped=false", async () => {
    const filePath = writeReport("own-session.json", {
      sessionId: "sess-keep",
      approvalStatus: "pending",
    });
    const result = await approveUnderstanding({
      manifest: manifest(),
      session: "sess-keep",
      reportsDir: tmp,
      generatedDir: path.join(tmp, "harness.generated"),
      ledgerAdd: async () => ({ ok: true }),
    });

    expect(result.persistedReport.ok).toBe(true);
    if (!result.persistedReport.ok) return;
    expect(result.persistedReport.sessionIdStamped).toBe(false);
    const after = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    expect(after.sessionId).toBe("sess-keep");
  });

  it("does NOT adopt a stale completed (expired) sessionId-null report", async () => {
    // Reproduces the friction: a 2-day-old report from a different task,
    // already cycled to `expired`, with no sessionId. A fresh session's
    // `harness approve understanding` must not flip it to approved.
    writeReport("stale-expired.json", {
      // NO sessionId; from a finished prior cycle.
      approvalStatus: "expired",
      currentUnderstanding: "an unrelated investigation from days ago",
    });
    const result = await approveUnderstanding({
      manifest: manifest(),
      session: "fresh-session",
      reportsDir: tmp,
      generatedDir: path.join(tmp, "harness.generated"),
      ledgerAdd: async () => ({ ok: true }),
    });

    expect(result.persistedReport.ok).toBe(false);
    if (result.persistedReport.ok) return;
    expect(result.persistedReport.reason).toMatch(/no report matched/);
  });

  it("still adopts a fresh pending sessionId-null report (the legitimate case)", async () => {
    const filePath = writeReport("fresh-pending.json", {
      // NO sessionId, but pending — a current Stop-hook report.
      approvalStatus: "pending",
    });
    const result = await approveUnderstanding({
      manifest: manifest(),
      session: "fresh-session",
      reportsDir: tmp,
      generatedDir: path.join(tmp, "harness.generated"),
      ledgerAdd: async () => ({ ok: true }),
    });

    expect(result.persistedReport.ok).toBe(true);
    if (!result.persistedReport.ok) return;
    expect(result.persistedReport.sessionIdStamped).toBe(true);
    const after = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    expect(after.sessionId).toBe("fresh-session");
  });
});
