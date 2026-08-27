// Slice 1 of docs/decisions/2026-08-27-ug-auto-mode-approval.md
// (agent-tasks/74b4b17d): the PreToolUse hook's operator-opt-in
// auto-approval path at decision-order step 9.
//
// Kept in its own file rather than appended to
// pack-hook-pre-tool-use.test.ts (2077 lines) because every test here
// shares one elaborate fixture (opt-in config + payload permission_mode
// + $CLAUDE_CODE_SESSION_ID + signing key + a strict-session pending
// report) that no other test in that file wants. The helpers below are
// deliberate copies of that file's `readableFromString` / `bufferStream`
// shape so the two suites read the same way.
//
// Each negative control quotes the ADR bullet it encodes. The mutation
// probes named in the ADR's slice 1 block were each applied for real and
// the named test observed red; see the implementer report for the
// probe-by-probe record.

import { Readable, Writable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPackHookPreToolUseCli } from "../../src/cli/pack/hook-pre-tool-use.js";
import type { LedgerEntry } from "../../src/policies/index.js";
import {
  applyPostToolUseExpiry,
  approvalMarkerPathFor,
  checkApprovalMarker,
  clearApprovalMarker,
  listPersistedReports,
  writeApprovalMarker,
} from "../../src/policy-packs/builtin/understanding-before-execution-runtime.js";
import {
  getOrCreateSigningKey,
  sha256Hex,
  signingKeyPathFor,
} from "../../src/runtime/approval-signing.js";
import type { LedgerWriteArgs } from "../../src/runtime/ledger-writer.js";
import { readPendingApproval } from "../../src/runtime/pending-approval.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

const SESSION = "sess-auto-1";

let tmp: string;
let generatedDir: string;
let reportsDir: string;
let savedClaude: string | undefined;
let savedClaudeCode: string | undefined;
let ledgerCalls: LedgerWriteArgs[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ug-auto-"));
  generatedDir = path.join(tmp, "harness.generated");
  reportsDir = path.join(tmp, "reports");
  savedClaude = process.env.CLAUDE_SESSION_ID;
  savedClaudeCode = process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  ledgerCalls = [];
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (savedClaude === undefined) delete process.env.CLAUDE_SESSION_ID;
  else process.env.CLAUDE_SESSION_ID = savedClaude;
  if (savedClaudeCode === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = savedClaudeCode;
});

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

/** The opt-in manifest: `bypassPermissions` allowlisted, `require_report: true`. */
function manifestWithAutoApprove(extraConfig: Record<string, unknown> = {}): Manifest {
  return parseManifest({
    version: 1,
    policy_packs: [
      {
        name: "understanding-before-execution",
        enabled: true,
        config: {
          auto_approve: { when: ["bypassPermissions"], require_report: true },
          ...extraConfig,
        },
      },
    ],
  });
}

/** No `auto_approve` block at all (N7's "opt-in absent" fixture). */
function manifestWithoutAutoApprove(): Manifest {
  return parseManifest({
    version: 1,
    policy_packs: [{ name: "understanding-before-execution", enabled: true }],
  });
}

/**
 * A structurally valid `grill_me` report body. `grill_me` on purpose:
 * `validatePersistedReport` short-circuits to `ok` for any other mode, so
 * a `fast_confirm` fixture would not exercise the validation the auto
 * path reuses from the approve CLI.
 */
function reportBody(
  sessionId: string | null,
  status: string,
  createdAt: string,
): Record<string, unknown> {
  return {
    ...(sessionId === null ? {} : { sessionId }),
    approvalStatus: status,
    createdAt,
    mode: "grill_me",
    currentUnderstanding: "the auto path under test",
    priorArt: ["searched the repo for an existing auto-approval path; none exists, so build"],
  };
}

/** Write a report file and return its path plus the sha256 of its exact bytes. */
function writeReportFile(
  name: string,
  body: Record<string, unknown>,
): { filePath: string; sha256: string } {
  fs.mkdirSync(reportsDir, { recursive: true });
  const filePath = path.join(reportsDir, name);
  const content = `${JSON.stringify(body, null, 2)}\n`;
  fs.writeFileSync(filePath, content);
  return { filePath, sha256: sha256Hex(content) };
}

/** The canonical happy-path report: newest, strict-session, `pending`, valid. */
function writePendingReport(
  sessionId: string | null = SESSION,
  createdAt = "2026-08-27T10:00:00.000Z",
  name = "2026-08-27T10-00-00-000Z-report-aaaa1111.json",
): { filePath: string; sha256: string } {
  return writeReportFile(name, reportBody(sessionId, "pending", createdAt));
}

function readReport(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

function markerExists(): boolean {
  return fs.existsSync(approvalMarkerPathFor(generatedDir, SESSION));
}

function readMarkerRaw(): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(approvalMarkerPathFor(generatedDir, SESSION), "utf8"),
  ) as Record<string, unknown>;
}

interface CallOptions {
  manifest?: Manifest;
  toolName?: string;
  command?: string;
  sessionIdInPayload?: string | null;
  permissionMode?: string | null;
  /** Inject the ledger writer; defaults to a recorder that always succeeds. */
  injectLedger?: boolean;
}

/** One gated PreToolUse call through the real CLI entry point. */
async function call(opts: CallOptions = {}): Promise<{
  blocked: boolean;
  asked: boolean;
  source: string;
  stderr: string;
  stdout: string;
}> {
  const stdout = bufferStream();
  const stderr = bufferStream();
  const payload: Record<string, unknown> = {
    tool_name: opts.toolName ?? "Edit",
    ...(opts.sessionIdInPayload === null ? {} : { session_id: opts.sessionIdInPayload ?? SESSION }),
    ...(opts.permissionMode === null ? {} : { permission_mode: opts.permissionMode ?? "bypassPermissions" }),
    ...(opts.command !== undefined ? { tool_input: { command: opts.command } } : {}),
  };
  const result = await runPackHookPreToolUseCli({
    manifest: opts.manifest ?? manifestWithAutoApprove(),
    stdin: readableFromString(JSON.stringify(payload)),
    stdout: stdout.stream,
    stderr: stderr.stream,
    reportsDir,
    generatedDir,
    ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    ...(opts.injectLedger === false
      ? {}
      : {
          writeLedger: async (args: LedgerWriteArgs): Promise<{ ok: true }> => {
            ledgerCalls.push(args);
            return { ok: true };
          },
        }),
  });
  return {
    blocked: result.blocked,
    asked: result.asked === true,
    source: result.approvalCheck.source,
    stderr: stderr.read(),
    stdout: stdout.read(),
  };
}

describe("pack hook pre-tool-use — auto-approval path (ADR slice 1)", () => {
  describe("acceptance criteria", () => {
    it("AC-H1 — opt-in + allowlisted permission_mode + newest strict-session pending report + key present + matching session env auto-approves the SAME call", async () => {
      process.env.CLAUDE_CODE_SESSION_ID = SESSION;
      getOrCreateSigningKey(generatedDir);
      const report = writePendingReport();

      const result = await call();

      expect(result.blocked).toBe(false);
      expect(result.source).toBe("marker");
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(
        /auto-approved via session marker by auto-mode:claude-code:bypassPermissions/,
      );

      // The marker is a real signed marker, verified by the same check a
      // human one goes through.
      const check = checkApprovalMarker(generatedDir, SESSION);
      expect(check.matched).toBe(true);
      expect(check.forged).toBe(false);
      expect(check.marker?.approvedBy).toBe("auto-mode:claude-code:bypassPermissions");
      expect(check.marker?.reportContentHash).toBe(report.sha256);

      // The report was consumed in the same pass.
      const after = readReport(report.filePath);
      expect(after["approvalStatus"]).toBe("approved");
      expect(after["approvedBy"]).toBe("auto-mode:claude-code:bypassPermissions");
      expect(typeof after["approvedAt"]).toBe("string");

      // Audit-only ledger fact, distinct from the human tag.
      expect(ledgerCalls).toHaveLength(1);
      expect(ledgerCalls[0]?.content).toBe(`understanding-auto-approved:${SESSION}`);
      expect(ledgerCalls[0]?.sessionId).toBe(SESSION);
      expect(ledgerCalls[0]?.source).toBe("harness-pack-hook-pre-tool-use");

      // Session marker only: no task marker is ever written on the auto path.
      const approvalsDir = path.join(generatedDir, ".approvals");
      expect(fs.readdirSync(approvalsDir).filter((n) => n.startsWith("task-"))).toEqual([]);

      // N15 (also asserted on its own below): no stale staging entry.
      expect(readPendingApproval(generatedDir)).toBeNull();
    });

    it("AC-H2 — a second gated call allows via the ordinary marker check, consuming nothing further", async () => {
      process.env.CLAUDE_CODE_SESSION_ID = SESSION;
      getOrCreateSigningKey(generatedDir);
      const report = writePendingReport();

      expect((await call()).blocked).toBe(false);
      const afterFirst = readReport(report.filePath);
      const markerAfterFirst = fs.readFileSync(
        approvalMarkerPathFor(generatedDir, SESSION),
        "utf8",
      );
      const reportCountAfterFirst = listPersistedReports(reportsDir).length;
      ledgerCalls = [];

      const second = await call();

      expect(second.blocked).toBe(false);
      expect(second.source).toBe("marker");
      // Allowed by step 3, not by a second mint: no auto-approval line,
      // no second ledger fact, no rewritten report, byte-identical marker.
      expect(second.stderr).not.toMatch(/auto-approved via session marker/);
      expect(ledgerCalls).toEqual([]);
      expect(readReport(report.filePath)).toEqual(afterFirst);
      expect(fs.readFileSync(approvalMarkerPathFor(generatedDir, SESSION), "utf8")).toBe(
        markerAfterFirst,
      );
      expect(listPersistedReports(reportsDir)).toHaveLength(reportCountAfterFirst);
    });
  });

  describe("negative controls", () => {
    it("N1 — agent-set environment variables with no payload permission_mode: block, no marker", async () => {
      // ADR: "Agent-set environment variable (any name, including
      // CLAUDE_CODE_ENTRYPOINT, AI_AGENT, an invented HARNESS_AUTO_MODE)
      // with no payload field: no marker, block."
      process.env.CLAUDE_CODE_SESSION_ID = SESSION;
      const savedEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;
      const savedAgent = process.env.AI_AGENT;
      const savedAuto = process.env.HARNESS_AUTO_MODE;
      process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
      process.env.AI_AGENT = "claude-code";
      process.env.HARNESS_AUTO_MODE = "1";
      try {
        getOrCreateSigningKey(generatedDir);
        const report = writePendingReport();

        const result = await call({ permissionMode: null });

        expect(result.blocked).toBe(true);
        expect(markerExists()).toBe(false);
        expect(ledgerCalls).toEqual([]);
        expect(readReport(report.filePath)["approvalStatus"]).toBe("pending");
      } finally {
        if (savedEntrypoint === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
        else process.env.CLAUDE_CODE_ENTRYPOINT = savedEntrypoint;
        if (savedAgent === undefined) delete process.env.AI_AGENT;
        else process.env.AI_AGENT = savedAgent;
        if (savedAuto === undefined) delete process.env.HARNESS_AUTO_MODE;
        else process.env.HARNESS_AUTO_MODE = savedAuto;
      }
    });

    it("N2 — agent-written files (hand-written approved report, unsigned marker, fake .last-apply): block with the forged/unsigned diagnostic, no auto-marker", async () => {
      // ADR: "Agent-written file (a hand-written 'approved' report, a fake
      // marker without signature, a fake .last-apply): no auto-marker,
      // block with the existing forged/unsigned diagnostics."
      process.env.CLAUDE_CODE_SESSION_ID = SESSION;
      getOrCreateSigningKey(generatedDir);
      const report = writeReportFile(
        "2026-08-27T10-00-00-000Z-handwritten-bbbb2222.json",
        reportBody(SESSION, "approved", "2026-08-27T10:00:00.000Z"),
      );
      fs.mkdirSync(path.join(generatedDir, ".approvals"), { recursive: true });
      const markerPath = approvalMarkerPathFor(generatedDir, SESSION);
      const forgedBody = `${JSON.stringify(
        { approvedAt: new Date().toISOString(), approvedBy: "agent", reportContentHash: null },
        null,
        2,
      )}\n`;
      fs.writeFileSync(markerPath, forgedBody);
      fs.writeFileSync(path.join(generatedDir, ".last-apply"), "{}\n");

      const result = await call();

      expect(result.blocked).toBe(true);
      expect(result.stderr).toMatch(/forged\/unsigned marker rejected/);
      // The forged file is untouched: no auto-marker was written over it.
      expect(fs.readFileSync(markerPath, "utf8")).toBe(forgedBody);
      expect(readReport(report.filePath)["approvedBy"]).toBeUndefined();
      expect(ledgerCalls).toEqual([]);
    });

    it("N3 — a forged marker plus a valid pending report and the opt-in does not launder the forgery", async () => {
      // ADR: "A forged or unsigned marker at the session marker path,
      // together with the opt-in, a `when`-listed permission_mode and a
      // valid strict-session pending report on disk: no auto-marker, block
      // with the `forged/unsigned marker rejected` diagnostic, and the
      // forged file is still on disk afterwards (condition 6)."
      process.env.CLAUDE_CODE_SESSION_ID = SESSION;
      // Key present on purpose: without it the decline could be
      // attributed to the key precheck and the markerForged-guard
      // mutation would not discriminate.
      getOrCreateSigningKey(generatedDir);
      const report = writePendingReport();
      fs.mkdirSync(path.join(generatedDir, ".approvals"), { recursive: true });
      const markerPath = approvalMarkerPathFor(generatedDir, SESSION);
      const forgedBody = `${JSON.stringify(
        {
          approvedAt: new Date().toISOString(),
          approvedBy: "operator",
          reportContentHash: null,
        },
        null,
        2,
      )}\n`;
      fs.writeFileSync(markerPath, forgedBody);

      const result = await call();

      expect(result.blocked).toBe(true);
      expect(result.stderr).toMatch(/forged\/unsigned marker rejected/);
      expect(result.stderr).toMatch(/auto-approval declined: forged\/unsigned marker present/);
      expect(fs.readFileSync(markerPath, "utf8")).toBe(forgedBody);
      expect(readReport(report.filePath)["approvalStatus"]).toBe("pending");
      expect(ledgerCalls).toEqual([]);
    });

    it("N4 — no report: block, no marker", async () => {
      // ADR: "No report: no marker, block."
      process.env.CLAUDE_CODE_SESSION_ID = SESSION;
      getOrCreateSigningKey(generatedDir);

      const result = await call();

      expect(result.blocked).toBe(true);
      expect(result.stderr).toMatch(/auto-approval declined: no persisted report bound to session/);
      expect(markerExists()).toBe(false);
      expect(ledgerCalls).toEqual([]);
    });

    it("N5(a) — a report bound to a DIFFERENT non-null session id is not adopted: block", async () => {
      // ADR: "Report for another session id (strict mismatch, including
      // the sessionId-null shape): not adopted, block."
      process.env.CLAUDE_CODE_SESSION_ID = SESSION;
      getOrCreateSigningKey(generatedDir);
      const other = writePendingReport("some-other-session");

      const result = await call();

      expect(result.blocked).toBe(true);
      expect(markerExists()).toBe(false);
      expect(readReport(other.filePath)["approvalStatus"]).toBe("pending");
    });

    it("N5(b) — a sessionId-NULL report is not adopted by the tolerant fallback: block", async () => {
      // Same ADR bullet; this is the shape that discriminates the
      // "replace strict session match with the tolerant fallback"
      // mutation, since sessionId-null is the ONLY shape that fallback
      // adopts (persisted-reports.ts:249-259).
      process.env.CLAUDE_CODE_SESSION_ID = SESSION;
      getOrCreateSigningKey(generatedDir);
      const anon = writePendingReport(null);

      const result = await call();

      expect(result.blocked).toBe(true);
      expect(markerExists()).toBe(false);
      expect(readReport(anon.filePath)["approvalStatus"]).toBe("pending");
    });

    it.each([
      ["absent", null],
      ["empty string", ""],
      ["default", "default"],
      ["acceptEdits", "acceptEdits"],
      ["plan", "plan"],
      ["auto", "auto"],
      ["an unknown literal", "definitelyNotAMode"],
    ])(
      "N6 — permission_mode %s with the opt-in present: block",
      async (_label, mode) => {
        // ADR: "permission_mode absent, empty, default, acceptEdits, plan,
        // or an unknown literal, with opt-in present: block."
        process.env.CLAUDE_CODE_SESSION_ID = SESSION;
        getOrCreateSigningKey(generatedDir);
        const report = writePendingReport();

        const result = await call({ permissionMode: mode });

        expect(result.blocked).toBe(true);
        expect(markerExists()).toBe(false);
        expect(readReport(report.filePath)["approvalStatus"]).toBe("pending");
        expect(ledgerCalls).toEqual([]);
      },
    );

    it("N7(a) — opt-in absent entirely: block", async () => {
      // ADR: "Opt-in absent, or `when` does not contain the payload value: block."
      process.env.CLAUDE_CODE_SESSION_ID = SESSION;
      getOrCreateSigningKey(generatedDir);
      const report = writePendingReport();

      const result = await call({ manifest: manifestWithoutAutoApprove() });

      expect(result.blocked).toBe(true);
      expect(markerExists()).toBe(false);
      expect(readReport(report.filePath)["approvalStatus"]).toBe("pending");
    });

    it("N7(b) — `when` does not contain the payload's permission_mode: block", async () => {
      process.env.CLAUDE_CODE_SESSION_ID = SESSION;
      getOrCreateSigningKey(generatedDir);
      const report = writePendingReport();
      const manifest = parseManifest({
        version: 1,
        policy_packs: [
          {
            name: "understanding-before-execution",
            enabled: true,
            config: { auto_approve: { when: ["acceptEdits"], require_report: true } },
          },
        ],
      });

      const result = await call({ manifest });

      expect(result.blocked).toBe(true);
      expect(markerExists()).toBe(false);
      expect(readReport(report.filePath)["approvalStatus"]).toBe("pending");
    });

    it("N8 — signing key absent: no key is created, no marker, block", async () => {
      // ADR: "Signing key absent: no key is created, no marker, block."
      process.env.CLAUDE_CODE_SESSION_ID = SESSION;
      const report = writePendingReport();
      expect(fs.existsSync(signingKeyPathFor(generatedDir))).toBe(false);

      const result = await call();

      expect(result.blocked).toBe(true);
      expect(result.stderr).toMatch(
        /auto-approval declined: signing key absent \(never created by the hook\)/,
      );
      expect(fs.existsSync(signingKeyPathFor(generatedDir))).toBe(false);
      expect(markerExists()).toBe(false);
      expect(readReport(report.filePath)["approvalStatus"]).toBe("pending");
    });

    it("N9(a) — payload.session_id differs from $CLAUDE_CODE_SESSION_ID: no marker, block", async () => {
      // ADR: "payload.session_id differs from $CLAUDE_CODE_SESSION_ID: no
      // marker, block." The key exists and the report is valid and bound
      // to the PAYLOAD's id, so the session check is the only thing left
      // standing between this call and a marker.
      process.env.CLAUDE_CODE_SESSION_ID = "a-different-session";
      getOrCreateSigningKey(generatedDir);
      const report = writePendingReport();

      const result = await call();

      expect(result.blocked).toBe(true);
      expect(result.stderr).toMatch(
        /auto-approval declined: payload session_id does not match \$CLAUDE_CODE_SESSION_ID/,
      );
      expect(markerExists()).toBe(false);
      expect(readReport(report.filePath)["approvalStatus"]).toBe("pending");
    });

    it("N9(b) — $CLAUDE_CODE_SESSION_ID unset: no marker, block", async () => {
      // The env var is deleted in beforeEach; nothing sets it here.
      getOrCreateSigningKey(generatedDir);
      const report = writePendingReport();

      const result = await call();

      expect(result.blocked).toBe(true);
      expect(result.stderr).toMatch(
        /auto-approval declined: \$CLAUDE_CODE_SESSION_ID is not set/,
      );
      expect(markerExists()).toBe(false);
      expect(readReport(report.filePath)["approvalStatus"]).toBe("pending");
    });

    it("N10 — after a task-boundary clear, the same report yields no second auto-marker", async () => {
      // ADR: "Auto-approve, then fire a boundary tool so
      // applyPostToolUseExpiry clears the marker and expires the (now
      // approved) report, then make another gated call with the same
      // report on disk: no new marker, block."
      process.env.CLAUDE_CODE_SESSION_ID = SESSION;
      getOrCreateSigningKey(generatedDir);
      const report = writePendingReport();
      expect((await call()).blocked).toBe(false);

      const expiry = applyPostToolUseExpiry(generatedDir, SESSION, {}, false, reportsDir);
      expect(expiry.wasMarkerPresent).toBe(true);
      expect(expiry.persistedReportExpired).toBe(true);
      expect(markerExists()).toBe(false);
      expect(readReport(report.filePath)["approvalStatus"]).toBe("expired");
      ledgerCalls = [];

      const second = await call();

      expect(second.blocked).toBe(true);
      expect(markerExists()).toBe(false);
      expect(ledgerCalls).toEqual([]);
      expect(readReport(report.filePath)["approvalStatus"]).toBe("expired");
    });

    it("N11 — after max_age, the same report yields no second auto-marker; markerExpired stays true so the recovery `git commit` is still allowed", async () => {
      // ADR: "Auto-approve, advance the clock past
      // approval_lifecycle.max_age, then make another gated call: the
      // marker check reports expired, the auto path finds no pending
      // report, no new marker, block (and markerExpired stays true, so the
      // recovery-commit exemption still applies to a bare `git commit`)."
      process.env.CLAUDE_CODE_SESSION_ID = SESSION;
      getOrCreateSigningKey(generatedDir);
      const report = writePendingReport();
      const manifest = manifestWithAutoApprove({ approval_lifecycle: { max_age: "4h" } });
      expect((await call({ manifest })).blocked).toBe(false);

      // The marker check takes no injected clock, so elapsed time is
      // simulated the way this suite's existing max_age tests do it: the
      // marker is re-signed with a backdated `approvedAt`, keeping the
      // auto path's own approvedBy and reportContentHash.
      const minted = readMarkerRaw();
      writeApprovalMarker(generatedDir, SESSION, {
        approvedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        approvedBy: minted["approvedBy"] as string,
        reportContentHash: minted["reportContentHash"] as string,
      });
      ledgerCalls = [];

      const second = await call({ manifest });

      expect(second.blocked).toBe(true);
      expect(ledgerCalls).toEqual([]);
      // No re-mint: the marker on disk is still the backdated one.
      const afterSecond = checkApprovalMarker(generatedDir, SESSION, {
        maxAgeMs: 4 * 60 * 60 * 1000,
      });
      expect(afterSecond.matched).toBe(false);
      expect(afterSecond.expired).toBe(true);
      expect(afterSecond.marker?.approvedBy).toBe("auto-mode:claude-code:bypassPermissions");
      expect(readReport(report.filePath)["approvalStatus"]).toBe("approved");

      // markerExpired is still true, so the recovery-commit exemption fires.
      const recovery = await call({
        manifest,
        toolName: "Bash",
        command: 'git commit -m "chore: consolidate approved work"',
      });
      expect(recovery.blocked).toBe(false);
      expect(recovery.source).toBe("recovery-commit");
    });

    it.each([["approved"], ["expired"]])(
      "N12 — a report already %s for this session and nothing else on disk: block",
      async (status) => {
        // ADR: "Report already approved or already expired for this session
        // and nothing else on disk: not eligible, no marker, block."
        process.env.CLAUDE_CODE_SESSION_ID = SESSION;
        getOrCreateSigningKey(generatedDir);
        const report = writeReportFile(
          "2026-08-27T10-00-00-000Z-report-cccc3333.json",
          reportBody(SESSION, status, "2026-08-27T10:00:00.000Z"),
        );

        const result = await call();

        expect(result.blocked).toBe(true);
        expect(result.stderr).toMatch(
          new RegExp(`auto-approval declined: newest report .* is approvalStatus=${status}`),
        );
        expect(markerExists()).toBe(false);
        expect(readReport(report.filePath)["approvalStatus"]).toBe(status);
      },
    );

    it("N13 — a consumed newest report plus an OLDER pending report for the same session yields no second auto-marker", async () => {
      // ADR: "Eligibility is evaluated on the newest strict-session report
      // only; an older pending report further down the list is never
      // scanned for, so: block."
      process.env.CLAUDE_CODE_SESSION_ID = SESSION;
      getOrCreateSigningKey(generatedDir);
      const older = writeReportFile(
        "2026-08-27T09-00-00-000Z-older-dddd4444.json",
        reportBody(SESSION, "pending", "2026-08-27T09:00:00.000Z"),
      );
      const newest = writePendingReport(SESSION, "2026-08-27T10:00:00.000Z");

      expect((await call()).blocked).toBe(false);
      expect(readReport(newest.filePath)["approvalStatus"]).toBe("approved");
      expect(readReport(older.filePath)["approvalStatus"]).toBe("pending");

      // Simulate the marker being cleared (a task boundary) WITHOUT
      // touching the reports, so the only question left is which report
      // the auto path considers.
      clearApprovalMarker(generatedDir, SESSION);
      ledgerCalls = [];

      const second = await call();

      expect(second.blocked).toBe(true);
      expect(markerExists()).toBe(false);
      expect(ledgerCalls).toEqual([]);
      expect(readReport(older.filePath)["approvalStatus"]).toBe("pending");
    });

    it("N14(a) — a read-only Bash call mints nothing", async () => {
      // ADR: "A call the gate was already going to open mints nothing. A
      // read-only Bash call (`ls`, `git status`) ... no auto-marker, no
      // ledger fact, and the report is still pending afterwards."
      process.env.CLAUDE_CODE_SESSION_ID = SESSION;
      getOrCreateSigningKey(generatedDir);
      const report = writePendingReport();

      const result = await call({ toolName: "Bash", command: "ls" });

      expect(result.blocked).toBe(false);
      expect(result.source).toBe("none");
      expect(result.stderr).toMatch(/read-only Bash command, allowing/);
      expect(markerExists()).toBe(false);
      expect(ledgerCalls).toEqual([]);
      expect(readReport(report.filePath)["approvalStatus"]).toBe("pending");
    });

    it("N14(b) — a bare recovery `git commit` on an expired marker mints nothing", async () => {
      process.env.CLAUDE_CODE_SESSION_ID = SESSION;
      const report = writePendingReport();
      // A real (human) approval that aged out 24h ago; max_age is 4h.
      writeApprovalMarker(generatedDir, SESSION, {
        approvedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        approvedBy: "test-operator",
      });

      const result = await call({
        manifest: manifestWithAutoApprove({ approval_lifecycle: { max_age: "4h" } }),
        toolName: "Bash",
        command: 'git commit -m "chore: consolidate"',
      });

      expect(result.blocked).toBe(false);
      expect(result.source).toBe("recovery-commit");
      expect(ledgerCalls).toEqual([]);
      expect(readMarkerRaw()["approvedBy"]).toBe("test-operator");
      expect(readReport(report.filePath)["approvalStatus"]).toBe("pending");
    });

    it("N14(c) — a bare `harness approve understanding` escape call mints nothing", async () => {
      process.env.CLAUDE_CODE_SESSION_ID = SESSION;
      getOrCreateSigningKey(generatedDir);
      const report = writePendingReport();

      const result = await call({
        toolName: "Bash",
        command: "harness approve understanding",
      });

      expect(result.blocked).toBe(false);
      expect(result.asked).toBe(true);
      expect(result.stdout).toMatch(/"permissionDecision":"ask"/);
      expect(markerExists()).toBe(false);
      expect(ledgerCalls).toEqual([]);
      expect(readReport(report.filePath)["approvalStatus"]).toBe("pending");
    });

    it("N15 — a successful auto-approval leaves no stale `.pending-approval` entry", async () => {
      // ADR: "After the auto path mints,
      // harness.generated/.pending-approval does not carry the
      // auto-approved session id (cleared or never written), so an
      // arg-less `harness approve understanding` from a shell without
      // session env does not resolve to it."
      process.env.CLAUDE_CODE_SESSION_ID = SESSION;
      getOrCreateSigningKey(generatedDir);
      writePendingReport();

      expect((await call()).blocked).toBe(false);

      expect(readPendingApproval(generatedDir)).toBeNull();
    });

    it("N16 — a second pending report re-arms the auto path, by design", async () => {
      // ADR: "Auto-approve, fire a task boundary so the marker is cleared,
      // write a second pending report for the same session, then make
      // another gated call: a new auto-marker IS written from the second
      // report."
      process.env.CLAUDE_CODE_SESSION_ID = SESSION;
      getOrCreateSigningKey(generatedDir);
      const first = writePendingReport();
      expect((await call()).blocked).toBe(false);
      expect(checkApprovalMarker(generatedDir, SESSION).marker?.reportContentHash).toBe(
        first.sha256,
      );

      applyPostToolUseExpiry(generatedDir, SESSION, {}, false, reportsDir);
      expect(markerExists()).toBe(false);

      const second = writeReportFile(
        "2026-08-27T11-00-00-000Z-second-eeee5555.json",
        reportBody(SESSION, "pending", "2026-08-27T11:00:00.000Z"),
      );
      ledgerCalls = [];

      const result = await call();

      expect(result.blocked).toBe(false);
      expect(result.source).toBe("marker");
      const check = checkApprovalMarker(generatedDir, SESSION);
      expect(check.matched).toBe(true);
      expect(check.marker?.reportContentHash).toBe(second.sha256);
      expect(readReport(second.filePath)["approvalStatus"]).toBe("approved");
      expect(ledgerCalls).toHaveLength(1);
    });

    it("N17 — a call the existing marker check already allows writes no auto-marker", async () => {
      // ADR acceptance criterion 3 / mutation "move the auto path above
      // checkOperatorApprovalMarkers". Fixture that makes it
      // discriminate: a VALID (human) marker AND a pending report for the
      // session on disk at the same time.
      process.env.CLAUDE_CODE_SESSION_ID = SESSION;
      const report = writePendingReport();
      writeApprovalMarker(generatedDir, SESSION, {
        approvedAt: new Date().toISOString(),
        approvedBy: "test-operator",
        reportContentHash: "not-the-auto-hash",
      });

      const result = await call();

      expect(result.blocked).toBe(false);
      expect(result.source).toBe("marker");
      expect(result.stderr).not.toMatch(/auto-approved via session marker/);
      expect(readMarkerRaw()["approvedBy"]).toBe("test-operator");
      expect(readMarkerRaw()["reportContentHash"]).toBe("not-the-auto-hash");
      expect(readReport(report.filePath)["approvalStatus"]).toBe("pending");
      expect(ledgerCalls).toEqual([]);
    });
  });

  describe("supporting behaviour", () => {
    it("declines a report that fails the approve CLI's own content validation", async () => {
      // Condition 3's second half: the auto path applies
      // `validatePersistedReport`, the same check `harness approve
      // understanding` runs — a grill_me report with no Prior Art is
      // refused there and must be refused here.
      process.env.CLAUDE_CODE_SESSION_ID = SESSION;
      getOrCreateSigningKey(generatedDir);
      const body = reportBody(SESSION, "pending", "2026-08-27T10:00:00.000Z");
      delete body["priorArt"];
      const report = writeReportFile("2026-08-27T10-00-00-000Z-invalid-ffff6666.json", body);

      const result = await call();

      expect(result.blocked).toBe(true);
      expect(result.stderr).toMatch(/auto-approval declined: report invalid \(priorArt:/);
      expect(markerExists()).toBe(false);
      expect(readReport(report.filePath)["approvalStatus"]).toBe("pending");
    });

    it("mints even when the ledger is unreachable (audit only, never a gate input)", async () => {
      process.env.CLAUDE_CODE_SESSION_ID = SESSION;
      getOrCreateSigningKey(generatedDir);
      writePendingReport();

      // No injected writer and no grounding-mcp in the manifest, so the
      // manifest resolution fails.
      const result = await call({ injectLedger: false });

      expect(result.blocked).toBe(false);
      expect(result.source).toBe("marker");
      expect(result.stderr).toMatch(
        /auto-approval ledger fact understanding-auto-approved:.* not recorded/,
      );
      expect(checkApprovalMarker(generatedDir, SESSION).matched).toBe(true);
    });
  });

  describe("review round-1 fixes (agent-tasks 74b4b17d)", () => {
    it("3a(i) - malformed auto_approve on the runtime path (require_report absent) is fail-closed: parseAutoApprove is the only runtime defence, since parseManifest accepts config as a free record", async () => {
      process.env.CLAUDE_CODE_SESSION_ID = SESSION;
      getOrCreateSigningKey(generatedDir);
      const report = writePendingReport();
      const manifest = parseManifest({
        version: 1,
        policy_packs: [
          {
            name: "understanding-before-execution",
            enabled: true,
            config: { auto_approve: { when: ["bypassPermissions"] } },
          },
        ],
      });

      const result = await call({ manifest });

      expect(result.blocked).toBe(true);
      expect(markerExists()).toBe(false);
      expect(readReport(report.filePath)["approvalStatus"]).toBe("pending");
      expect(result.stderr).toMatch(
        /config\.auto_approve ignored \(require_report must be true, got undefined\)/,
      );
    });

    it("3a(ii) - malformed auto_approve on the runtime path (when is a string, not an array) is fail-closed", async () => {
      process.env.CLAUDE_CODE_SESSION_ID = SESSION;
      getOrCreateSigningKey(generatedDir);
      const report = writePendingReport();
      const manifest = parseManifest({
        version: 1,
        policy_packs: [
          {
            name: "understanding-before-execution",
            enabled: true,
            config: { auto_approve: { when: "bypassPermissions", require_report: true } },
          },
        ],
      });

      const result = await call({ manifest });

      expect(result.blocked).toBe(true);
      expect(markerExists()).toBe(false);
      expect(readReport(report.filePath)["approvalStatus"]).toBe("pending");
      expect(result.stderr).toMatch(
        /config\.auto_approve\.when ignored \(expected a non-empty string\[\], got string\)/,
      );
    });

    it("3b - a marker write failure AFTER the report is consumed blocks and leaves the report consumed, and the same consumed report cannot mint on a later call", async () => {
      // ADR consume-then-sign ordering: if the marker write fails after
      // the report is consumed, the report must stay consumed (never
      // reset to pending), so the same report can never mint on a later
      // call. Reviewer round-1 finding: this ordering had no test.
      process.env.CLAUDE_CODE_SESSION_ID = SESSION;
      getOrCreateSigningKey(generatedDir);
      const report = writePendingReport();

      // Force `writeApprovalMarker`'s `atomicWriteFile` to fail
      // deterministically: it does `fs.mkdirSync(path.dirname(filePath),
      // { recursive: true })` where the marker's directory is
      // `<generatedDir>/.approvals`. Pre-creating that path as a
      // regular FILE makes `mkdirSync` throw, without mocking the
      // module.
      const approvalsPath = path.join(generatedDir, ".approvals");
      fs.writeFileSync(approvalsPath, "blocking .approvals on purpose (test 3b)");

      const result = await call();

      expect(result.blocked).toBe(true);
      expect(markerExists()).toBe(false);
      expect(result.stderr).toMatch(/failed to write the approval marker/);

      const afterFirst = readReport(report.filePath);
      expect(afterFirst["approvalStatus"]).toBe("approved");
      expect(afterFirst["approvedBy"]).toBe("auto-mode:claude-code:bypassPermissions");

      // Unblock the marker write, then run a second gated call: the
      // report is already consumed (no longer pending), so this call
      // must still block and must not mint anything.
      fs.rmSync(approvalsPath);
      const second = await call();

      expect(second.blocked).toBe(true);
      expect(markerExists()).toBe(false);
      // Shared phrase with the N3 forgery case (persisted-reports.ts's
      // `UNSIGNED_REPORT_APPROVAL_REJECTED`): a report that claims
      // `approvalStatus: approved` with no signed marker to back it
      // reads identically here and in an agent-forged report. Documented
      // in the lockout runbook (reviewer round-1 finding).
      expect(second.stderr).toMatch(/unsigned persisted-report approval rejected/);
    });

    it("3c - generatedDir unresolvable declines (injected-manifest test path: no manifestPath, no injected generatedDir)", async () => {
      process.env.CLAUDE_CODE_SESSION_ID = SESSION;
      const stdout = bufferStream();
      const stderr = bufferStream();
      const payload = {
        tool_name: "Edit",
        session_id: SESSION,
        permission_mode: "bypassPermissions",
      };

      // `generatedDir` deliberately omitted. `manifest` is injected, so
      // `loadManifestOrInjected` returns `manifestPath: undefined` too
      // (hook-bootstrap.ts), together these are the only way
      // `generatedDir` resolves to `undefined` (hook-pre-tool-use.ts's
      // `opts.generatedDir ?? (manifestPath !== undefined ? ... :
      // undefined)`).
      const result = await runPackHookPreToolUseCli({
        manifest: manifestWithAutoApprove(),
        stdin: readableFromString(JSON.stringify(payload)),
        stdout: stdout.stream,
        stderr: stderr.stream,
        reportsDir,
        ledgerQuery: async (): Promise<LedgerEntry[]> => [],
      });

      expect(result.blocked).toBe(true);
      expect(stderr.read()).toMatch(
        /auto-approval declined: harness\.generated\/ could not be resolved/,
      );
    });
  });
});
