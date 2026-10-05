// Task 7402301d: the persisted Understanding Report is EVIDENCE, not
// approval authority. Adversarial matrix run against BOTH PreToolUse
// runtimes (Claude `pre-tool-use`, Codex `codex-pre-tool-use`), one probe
// class per `it`, each executed for each runtime, so a Claude/Codex drift
// on this contract cannot recur silently (task e7c2ec3c precedent).
//
// Threat model (the one that motivated marker signing, harness/f9485cc7):
// a write primitive the `Edit|Write|Bash` blocker matcher does not cover.
// Before this task, `checkPersistedReport` was an EQUAL approval source
// consulted right after a forged marker was rejected, unsigned, with the
// gate-read tolerant fallback adopting a sessionId-less report for any
// session: one unsigned JSON write forged an approval. The closure chosen
// is structural (option B of the task): gate-time approval flows ONLY
// through the HMAC-signed marker; the report contributes a diagnostic.
//
// Task fa423e9b closed the gap that task left open: a VALID marker plus a
// report swapped after approval used to allow, because the marker's signed
// `reportContentHash` was never compared at gate time. Both hooks now apply
// one rule: a matched marker with a non-null signed hash is valid iff some
// parseable report file in the reports directory (any session, any
// approvalStatus) has the same canonical hash (lifecycle fields excluded).
// Editing the approved file in place, by swap, by symlink or by an
// unparseable rewrite removes the only match and the gate denies. A task
// marker that fails falls back to the session marker with the same check.
// Only a regular file of at most 1 MiB is read for the hash; any other
// *.json entry (oversized, a FIFO, a directory, a device) counts as a report
// file that matches nothing. Null-hash markers and a directory with no
// *.json entry keep today's behaviour. P19 and P23-P33 and the cases after
// P33 pin all of that, including the approvals that must stay allowed.
//
// Residuals named and pinned below (not closed by this task, tracked
// elsewhere):
//   - Key read + uncovered write forges a VALID marker (documented
//     honest trust model in src/runtime/approval-signing.ts). Unchanged.
//   - Content kept or re-created: any regular *.json file of the reports
//     directory within the size cap whose content equals the approved
//     content keeps a match, whether it was kept before the edit (a copy)
//     or re-created after it, so the marker still allows (pinned by the
//     RESIDUAL test). The signed hash proves the approved content is on
//     disk, not that the file the audit trail points at is unmodified.
//   - No report file left: a reports directory that is empty, unreadable or
//     holds no *.json entry falls back to the "no report file" allow, the
//     same as before the check existed (pinned below). Removing only the
//     approved report while other report files remain denies; re-approving
//     recovers (also pinned below).
//   - Volume: the size cap bounds each file, not their number, so enough
//     planted files just under the cap can still push one scan past the
//     hook's time budget (a non-blocking error for the runtime, the same
//     allow as before the check existed). Not pinned by a test here.
//   - In-flight subagent record: closed. hook-subagent-start.ts now applies
//     the same hash check before minting the record, so a refused approval
//     mints none (pinned in tests/cli/pack-hook-subagent-start.test.ts).
//   - The standalone `understanding-gate approve` CLI flips the report
//     without a signed marker and therefore no longer opens the harness
//     gate; `harness approve understanding` is the approval path. It writes a
//     new file, so an existing harness approval stays valid while the
//     approved content file is unmodified (R3 below).

import { Readable, Writable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approveUnderstanding } from "../../src/cli/approve/understanding.js";
import { EX_FAIL, HarnessExitError } from "../../src/cli/exit-codes.js";
import { runPackHookCodexPreToolUseCli } from "../../src/cli/pack/hook-codex-pre-tool-use.js";
import { runPackHookPreToolUseCli } from "../../src/cli/pack/hook-pre-tool-use.js";
import { runPackHookSubagentStartCli } from "../../src/cli/pack/hook-subagent-start.js";
import type { LedgerEntry } from "../../src/policies/index.js";
import {
  applyPostToolUseExpiry,
  approvalMarkerPathFor,
  canonicalReportHashOfFile,
  clearApprovalMarker,
  expirePersistedReport,
  MAX_HASHED_REPORT_BYTES,
  writeActiveClaim,
  writeApprovalMarker,
  writeTaskApprovalMarker,
} from "../../src/policy-packs/builtin/understanding-before-execution-runtime.js";
import {
  MAX_HASH_SCAN_BYTES,
  MIN_SCAN_ENTRY_COST_BYTES,
} from "../../src/policy-packs/builtin/understanding-before-execution/persisted-reports.js";
import { rotateSigningKey, sha256Hex } from "../../src/runtime/approval-signing.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

let tmp: string;
const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = ["CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "CODEX_SESSION_ID"] as const;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ug-report-evidence-"));
  for (const k of ENV_KEYS) {
    SAVED_ENV[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
});

function manifestWithPack(config?: Record<string, unknown>): Manifest {
  return parseManifest({
    version: 1,
    policy_packs: [
      { name: "understanding-before-execution", enabled: true, ...(config ? { config } : {}) },
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

function writeReport(dir: string, name: string, body: Record<string, unknown>): string {
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, name);
  fs.writeFileSync(full, `${JSON.stringify(body, null, 2)}\n`);
  return full;
}

const SESSION = "sess-evidence";
const REJECT = /unsigned persisted-report approval rejected/;
// The reason a matched marker whose signed report content is gone gets: names
// the marker kind(s) and the one-command fix, never a report file.
const MISMATCH = (kind: "task" | "session" | "task and session"): RegExp =>
  new RegExp(
    `no report in the reports directory matches the content the ${kind} approval markers? (?:was|were) signed for \\(the approved report was changed or removed after approval\\); re-run \`harness approve understanding\``,
  );

interface Outcome {
  blocked: boolean;
  source: string;
  detail: string;
  stderr: string;
}

interface Runtime {
  name: string;
  /** Run the hook for a mutating tool (Edit / apply_patch) unless `command` names a shell command. */
  run: (
    args: {
      generatedDir?: string;
      reportsDir: string;
      manifest?: Manifest;
      command?: string;
      session?: string;
    },
  ) => Promise<Outcome>;
}

const RUNTIMES: Runtime[] = [
  {
    name: "claude pre-tool-use",
    run: async ({ generatedDir, reportsDir, manifest, command, session }) => {
      const stderr = bufferStream();
      const result = await runPackHookPreToolUseCli({
        manifest: manifest ?? manifestWithPack(),
        stdin: readableFromString(
          JSON.stringify(
            command !== undefined
              ? { session_id: session ?? SESSION, tool_name: "Bash", tool_input: { command } }
              : { session_id: session ?? SESSION, tool_name: "Edit" },
          ),
        ),
        stdout: bufferStream().stream,
        stderr: stderr.stream,
        reportsDir,
        ...(generatedDir !== undefined ? { generatedDir } : {}),
        ledgerQuery: async (): Promise<LedgerEntry[]> => [],
      });
      return {
        blocked: result.blocked,
        source: result.approvalCheck.source,
        detail: result.approvalCheck.detail,
        stderr: stderr.read(),
      };
    },
  },
  {
    name: "codex codex-pre-tool-use",
    run: async ({ generatedDir, reportsDir, manifest, command, session }) => {
      const stderr = bufferStream();
      const result = await runPackHookCodexPreToolUseCli({
        manifest: manifest ?? manifestWithPack(),
        stdin: readableFromString(
          JSON.stringify(
            command !== undefined
              ? { session_id: session ?? SESSION, tool_name: "shell", raw_input: { command } }
              : { session_id: session ?? SESSION, tool_name: "apply_patch" },
          ),
        ),
        stderr: stderr.stream,
        reportsDir,
        ...(generatedDir !== undefined ? { generatedDir } : {}),
        ledgerQuery: async (): Promise<LedgerEntry[]> => [],
      });
      return {
        blocked: result.blocked,
        source: result.approvalCheck.source,
        detail: result.approvalCheck.detail,
        stderr: stderr.read(),
      };
    },
  },
];

describe.each(RUNTIMES)("persisted report is evidence, not authority (task 7402301d): $name", (rt) => {
  const approvedBody = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    sessionId: SESSION,
    approvalStatus: "approved",
    approvedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    ...extra,
  });

  it("P1 hand-written approved report, no marker at all: BLOCKS with the distinct audit reason (AC2)", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    writeReport(reportsDir, "forged.json", approvedBody());
    const out = await rt.run({ generatedDir, reportsDir });
    expect(out.blocked).toBe(true);
    expect(out.source).toBe("none");
    expect(out.detail).toMatch(/no approval marker for session sess-evidence/);
    expect(out.detail).toMatch(REJECT);
    expect(out.detail).toMatch(/report forged\.json has approvalStatus=approved/);
    expect(out.stderr).toMatch(REJECT);
  });

  it("P2 approved report next to a FORGED (unsigned) marker: both rejections visible, still blocks", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    fs.mkdirSync(path.join(generatedDir, ".approvals"), { recursive: true });
    fs.writeFileSync(
      path.join(generatedDir, ".approvals", SESSION),
      `${JSON.stringify({ approvedAt: new Date().toISOString(), approvedBy: "attacker" })}\n`,
    );
    writeReport(reportsDir, "forged.json", approvedBody());
    const out = await rt.run({ generatedDir, reportsDir });
    expect(out.blocked).toBe(true);
    expect(out.detail).toMatch(/forged\/unsigned marker rejected/);
    expect(out.detail).toMatch(REJECT);
  });

  it("P3 approved report plus a marker signed under a DIFFERENT key (key-rotation / foreign-machine copy): blocks", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const foreignDir = path.join(tmp, "foreign.generated");
    const reportsDir = path.join(tmp, "reports");
    // Sign under the foreign key, then copy the marker bytes into the
    // gate's own approvals dir (its key differs, so verification fails).
    const foreignMarker = writeApprovalMarker(foreignDir, SESSION, {
      approvedAt: new Date().toISOString(),
      approvedBy: "foreign-operator",
    });
    fs.mkdirSync(path.join(generatedDir, ".approvals"), { recursive: true });
    fs.copyFileSync(foreignMarker, path.join(generatedDir, ".approvals", SESSION));
    writeReport(reportsDir, "forged.json", approvedBody());
    const out = await rt.run({ generatedDir, reportsDir });
    expect(out.blocked).toBe(true);
    expect(out.detail).toMatch(/forged\/unsigned marker rejected/);
    expect(out.detail).toMatch(REJECT);
  });

  it("P4 approved report with NO sessionId (tolerant-fallback shape, adoptable by any session): blocks", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    writeReport(reportsDir, "legacy.json", { approvalStatus: "approved", createdAt: new Date().toISOString() });
    const out = await rt.run({ generatedDir, reportsDir });
    expect(out.blocked).toBe(true);
    expect(out.detail).toMatch(REJECT);
    expect(out.detail).toMatch(/report legacy\.json/);
  });

  it("P5 approved report copied from ANOTHER session and re-stamped with this session id: blocks", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    writeReport(reportsDir, "other.json", approvedBody({ sessionId: "sess-other", approvedBy: "operator" }));
    const copied = JSON.parse(fs.readFileSync(path.join(reportsDir, "other.json"), "utf8")) as Record<string, unknown>;
    copied["sessionId"] = SESSION;
    writeReport(reportsDir, "copied.json", copied);
    const out = await rt.run({ generatedDir, reportsDir });
    expect(out.blocked).toBe(true);
    expect(out.detail).toMatch(REJECT);
  });

  it("P6 approved report under a producer-shaped filename with a FUTURE timestamp (sorts newest): blocks", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    writeReport(reportsDir, "pending.json", { sessionId: SESSION, approvalStatus: "pending", createdAt: "2026-01-01T00:00:00.000Z" });
    writeReport(reportsDir, "2999-01-01T00-00-00-000Z-forged-deadbeef.json", {
      sessionId: SESSION,
      approvalStatus: "approved",
      createdAt: "2999-01-01T00:00:00.000Z",
    });
    const out = await rt.run({ generatedDir, reportsDir });
    expect(out.blocked).toBe(true);
    expect(out.detail).toMatch(REJECT);
    expect(out.detail).toMatch(/2999-01-01T00-00-00-000Z-forged-deadbeef\.json/);
  });

  it("P7 approved report whose file is a SYMLINK into the reports dir: blocks (never allows)", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    const outside = writeReport(path.join(tmp, "elsewhere"), "real.json", approvedBody());
    fs.mkdirSync(reportsDir, { recursive: true });
    fs.symlinkSync(outside, path.join(reportsDir, "link.json"));
    const out = await rt.run({ generatedDir, reportsDir });
    expect(out.blocked).toBe(true);
  });

  it("P8 approved report with a malformed sibling (parse-errors path): blocks; the malformed file is skipped, the approved one is only evidence", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    fs.mkdirSync(reportsDir, { recursive: true });
    fs.writeFileSync(path.join(reportsDir, "broken.json"), "{ not json");
    writeReport(reportsDir, "forged.json", approvedBody());
    const out = await rt.run({ generatedDir, reportsDir });
    expect(out.blocked).toBe(true);
    expect(out.detail).toMatch(REJECT);
  });

  it("P9 approved report with approvalStatus in a different CASE or with extra whitespace: blocks (no claim, no authority)", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    writeReport(reportsDir, "case.json", approvedBody({ approvalStatus: "Approved " }));
    const out = await rt.run({ generatedDir, reportsDir });
    expect(out.blocked).toBe(true);
    expect(out.detail).not.toMatch(REJECT);
    expect(out.detail).toMatch(/approvalStatus=Approved /);
  });

  it("P10 approved report plus an EXPIRED (max_age) valid marker: Edit blocks; max_age is no longer defeated by the report", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    writeApprovalMarker(generatedDir, SESSION, {
      approvedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      approvedBy: "operator",
    });
    writeReport(reportsDir, "r1.json", approvedBody());
    const out = await rt.run({
      generatedDir,
      reportsDir,
      manifest: manifestWithPack({ approval_lifecycle: { max_age: "4h" } }),
    });
    expect(out.blocked).toBe(true);
    expect(out.detail).toMatch(REJECT);
  });

  it("P11 approved report after the post-tool-use boundary cleared the marker: blocks (report flipped to expired, no claim)", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    writeApprovalMarker(generatedDir, SESSION, { approvedAt: new Date().toISOString(), approvedBy: "operator" });
    writeReport(reportsDir, "r1.json", approvedBody());
    const before = await rt.run({ generatedDir, reportsDir });
    expect(before.blocked).toBe(false);
    expect(before.source).toBe("marker");
    const expiry = applyPostToolUseExpiry(generatedDir, SESSION, {}, true, reportsDir);
    expect(expiry.wasMarkerPresent).toBe(true);
    expect(expiry.persistedReportExpired).toBe(true);
    const after = await rt.run({ generatedDir, reportsDir });
    expect(after.blocked).toBe(true);
    expect(after.detail).toMatch(/approvalStatus=expired/);
    expect(after.detail).not.toMatch(REJECT);
  });

  it("P12 boundary cleared the marker but the report expiry FAILED (report still says approved): blocks anyway", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    writeApprovalMarker(generatedDir, SESSION, { approvedAt: new Date().toISOString(), approvedBy: "operator" });
    writeReport(reportsDir, "r1.json", approvedBody());
    // Simulate a failed report expiry: only the marker is cleared.
    clearApprovalMarker(generatedDir, SESSION);
    const out = await rt.run({ generatedDir, reportsDir });
    expect(out.blocked).toBe(true);
    expect(out.detail).toMatch(REJECT);
  });

  it("P13 marker cleared plus an approved report written AFTER the clear (attacker races the boundary): blocks", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    writeApprovalMarker(generatedDir, SESSION, { approvedAt: new Date().toISOString(), approvedBy: "operator" });
    writeReport(reportsDir, "r1.json", approvedBody());
    applyPostToolUseExpiry(generatedDir, SESSION, {}, true, reportsDir);
    writeReport(reportsDir, "r2.json", approvedBody({ createdAt: new Date(Date.now() + 1000).toISOString() }));
    const out = await rt.run({ generatedDir, reportsDir });
    expect(out.blocked).toBe(true);
    expect(out.detail).toMatch(REJECT);
  });

  it("P14 signing key rotated after a real approval: the report still says approved, the gate blocks until re-approval (strict back-compat)", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    writeReport(reportsDir, "r1.json", { sessionId: SESSION, approvalStatus: "pending", createdAt: new Date().toISOString() });
    await approveUnderstanding({
      manifest: parseManifest({ version: 1 }),
      session: SESSION,
      reportsDir,
      generatedDir,
      ledgerAdd: async () => ({ ok: true }),
    });
    expect((await rt.run({ generatedDir, reportsDir })).blocked).toBe(false);
    rotateSigningKey(generatedDir);
    const out = await rt.run({ generatedDir, reportsDir });
    expect(out.blocked).toBe(true);
    expect(out.detail).toMatch(/forged\/unsigned marker rejected/);
    expect(out.detail).toMatch(REJECT);
  });

  it("P15 approved report with a task-scoped marker for a DIFFERENT task than the active claim: blocks", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    writeActiveClaim(generatedDir, "task-live");
    writeTaskApprovalMarker(generatedDir, "task-old", { approvedAt: new Date().toISOString(), approvedBy: "operator" });
    writeReport(reportsDir, "r1.json", approvedBody());
    const out = await rt.run({ generatedDir, reportsDir });
    expect(out.blocked).toBe(true);
    expect(out.detail).toMatch(REJECT);
  });

  it("P16 approved report but generatedDir unresolvable (injection path): blocks, reason names both facts", async () => {
    const reportsDir = path.join(tmp, "reports");
    writeReport(reportsDir, "r1.json", approvedBody());
    const out = await rt.run({ reportsDir });
    expect(out.blocked).toBe(true);
    expect(out.detail).toMatch(/generatedDir not resolvable/);
    expect(out.detail).toMatch(REJECT);
  });

  it("P17 CONTROL, the real approve flow: `harness approve understanding` writes the signed marker AND flips the report; the gate allows via the marker (AC3)", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    const reportPath = writeReport(reportsDir, "r1.json", {
      sessionId: SESSION,
      approvalStatus: "pending",
      createdAt: new Date().toISOString(),
    });
    const approve = await approveUnderstanding({
      manifest: parseManifest({ version: 1 }),
      session: SESSION,
      reportsDir,
      generatedDir,
      approvedBy: "operator",
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(approve.marker.ok).toBe(true);
    expect(approve.persistedReport.ok).toBe(true);
    const flipped = JSON.parse(fs.readFileSync(reportPath, "utf8")) as Record<string, unknown>;
    expect(flipped["approvalStatus"]).toBe("approved");
    const out = await rt.run({ generatedDir, reportsDir });
    expect(out.blocked).toBe(false);
    expect(out.source).toBe("marker");
    expect(out.stderr).toMatch(/signature verified/);
  });

  it("P18 CONTROL: a valid marker with NO persisted report at all still allows (the report was never required)", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, SESSION, { approvedAt: new Date().toISOString(), approvedBy: "operator" });
    const out = await rt.run({ generatedDir, reportsDir: path.join(tmp, "no-reports") });
    expect(out.blocked).toBe(false);
    expect(out.source).toBe("marker");
  });

  /** Real `harness approve understanding` flow over a pending report; returns the report path. */
  async function approveRealFlow(
    generatedDir: string,
    reportsDir: string,
    session: string = SESSION,
    body: Record<string, unknown> = {},
  ): Promise<string> {
    const reportPath = writeReport(reportsDir, "r1.json", {
      sessionId: session,
      approvalStatus: "pending",
      createdAt: new Date().toISOString(),
      content: "the understanding the operator reviewed",
      ...body,
    });
    const approve = await approveUnderstanding({
      manifest: parseManifest({ version: 1 }),
      session,
      reportsDir,
      generatedDir,
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(approve.marker.ok).toBe(true);
    expect(approve.persistedReport.ok).toBe(true);
    return reportPath;
  }

  function editReport(reportPath: string, edit: (r: Record<string, unknown>) => void): void {
    const r = JSON.parse(fs.readFileSync(reportPath, "utf8")) as Record<string, unknown>;
    edit(r);
    fs.writeFileSync(reportPath, `${JSON.stringify(r, null, 2)}\n`);
  }

  it("P19 TAMPER: valid session marker + the approved report's content edited after approval, no other file carries it: blocks with the mismatch reason naming the session marker kind and `harness approve understanding`", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    const reportPath = await approveRealFlow(generatedDir, reportsDir);
    expect((await rt.run({ generatedDir, reportsDir })).blocked).toBe(false);
    // Replace the approved report's content wholesale (a different
    // Understanding text, same session, still claiming approved).
    fs.writeFileSync(reportPath, `${JSON.stringify({ ...approvedBody(), content: "swapped" }, null, 2)}\n`);
    const out = await rt.run({ generatedDir, reportsDir });
    expect(out.blocked).toBe(true);
    expect(out.source).toBe("none");
    expect(out.detail).toMatch(MISMATCH("session"));
    expect(out.stderr).toMatch(MISMATCH("session"));
    expect(out.detail).not.toMatch(/no approval marker/);
  });

  it("P23 TAMPER, task-scoped marker (active claim set): the same edit blocks when only the task marker can match", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    writeActiveClaim(generatedDir, "task-live");
    const reportPath = await approveRealFlow(generatedDir, reportsDir);
    // Remove the session marker so the task-scoped marker is the only one
    // that can match: a check wired to the session marker alone would be inert.
    fs.rmSync(approvalMarkerPathFor(generatedDir, SESSION));
    const before = await rt.run({ generatedDir, reportsDir });
    expect(before.blocked).toBe(false);
    expect(before.stderr).toMatch(/approved via marker task-/);
    editReport(reportPath, (r) => {
      r["content"] = "edited after approval";
    });
    const out = await rt.run({ generatedDir, reportsDir });
    expect(out.blocked).toBe(true);
    expect(out.detail).toMatch(MISMATCH("task"));
  });

  it("P24 UNCHANGED path, real approve flow: the marker signs the canonical hash (not the raw bytes) and the gate allows", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    const reportPath = await approveRealFlow(generatedDir, reportsDir);
    const markerBody = JSON.parse(
      fs.readFileSync(approvalMarkerPathFor(generatedDir, SESSION), "utf8"),
    ) as Record<string, unknown>;
    expect(markerBody["reportContentHash"]).toBe(canonicalReportHashOfFile(reportPath));
    expect(markerBody["reportContentHash"]).not.toBe(sha256Hex(fs.readFileSync(reportPath, "utf8")));
    const out = await rt.run({ generatedDir, reportsDir });
    expect(out.blocked).toBe(false);
    expect(out.source).toBe("marker");
  });

  it("P25 UNCHANGED path: a later post-tool-use expiry rewrite of the report does not change what the marker signed", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    const reportPath = await approveRealFlow(generatedDir, reportsDir);
    const approvedHash = canonicalReportHashOfFile(reportPath);
    const expired = expirePersistedReport(reportsDir, SESSION, new Date(), "tool:mcp__agent-tasks__task_finish");
    expect(expired.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(reportPath, "utf8"))["approvalStatus"]).toBe("expired");
    expect(canonicalReportHashOfFile(reportPath)).toBe(approvedHash);
  });

  it("P26 null-hash marker (ledger-only / --force approval) + approved report with ANY content: allows as before", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    writeApprovalMarker(generatedDir, SESSION, { approvedAt: new Date().toISOString(), approvedBy: "operator" });
    writeReport(reportsDir, "r1.json", approvedBody({ content: "anything" }));
    const out = await rt.run({ generatedDir, reportsDir });
    expect(out.blocked).toBe(false);
    expect(out.source).toBe("marker");
  });

  it("P27 legacy marker (raw-bytes hash written before the canonical hash existed) + approved report: denies once, naming the fix; re-approving opens the gate again", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    const reportPath = writeReport(reportsDir, "r1.json", approvedBody({ content: "approved earlier" }));
    writeApprovalMarker(generatedDir, SESSION, {
      approvedAt: new Date().toISOString(),
      approvedBy: "operator",
      reportContentHash: sha256Hex(fs.readFileSync(reportPath, "utf8")),
    });
    const out = await rt.run({ generatedDir, reportsDir });
    expect(out.blocked).toBe(true);
    expect(out.detail).toMatch(MISMATCH("session"));
    // The single migration step the reason names.
    await approveUnderstanding({
      manifest: parseManifest({ version: 1 }),
      session: SESSION,
      reportsDir,
      generatedDir,
      ledgerAdd: async () => ({ ok: true }),
    });
    const after = await rt.run({ generatedDir, reportsDir });
    expect(after.blocked).toBe(false);
    expect(after.source).toBe("marker");
  });

  it("P28 task-scoped marker, NEW session whose own report is still pending: allows, because the earlier approved file still carries the signed content (approvalStatus is not part of the rule)", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    writeActiveClaim(generatedDir, "task-live");
    // Approved earlier in another session: writes the task marker too.
    await approveRealFlow(generatedDir, reportsDir, "sess-earlier");
    writeReport(reportsDir, "new-session.json", {
      sessionId: SESSION,
      approvalStatus: "pending",
      createdAt: new Date(Date.now() + 1000).toISOString(),
      content: "a different, not yet approved report",
    });
    const out = await rt.run({ generatedDir, reportsDir });
    expect(out.blocked).toBe(false);
    expect(out.source).toBe("marker");
    expect(out.stderr).toMatch(/approved via marker task-/);
  });

  it("P29 mismatch plus a read-only shell command: still allowed by the read-only carve-out, not by the marker (source none)", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    const reportPath = await approveRealFlow(generatedDir, reportsDir);
    editReport(reportPath, (r) => {
      r["content"] = "swapped";
    });
    const out = await rt.run({ generatedDir, reportsDir, command: "git status" });
    expect(out.blocked).toBe(false);
    expect(out.source).toBe("none");
    const mutating = await rt.run({ generatedDir, reportsDir, command: "rm -rf build" });
    expect(mutating.blocked).toBe(true);
    expect(mutating.detail).toMatch(MISMATCH("session"));
  });

  it("P30 the mismatch reason carries no report-derived value: a hostile report file name never reaches it", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    const reportPath = await approveRealFlow(generatedDir, reportsDir);
    const hostile = path.join(reportsDir, "r1\nreason: allowed.json");
    fs.renameSync(reportPath, hostile);
    editReport(hostile, (r) => {
      r["content"] = "swapped";
    });
    const out = await rt.run({ generatedDir, reportsDir });
    expect(out.blocked).toBe(true);
    expect(out.detail).toMatch(MISMATCH("session"));
    expect(out.detail).not.toMatch(/allowed/);
  });

  it("P31 editing only lifecycle fields of the approved report (approvedBy, approvedAt) is not a content change: allows", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    const reportPath = await approveRealFlow(generatedDir, reportsDir);
    editReport(reportPath, (r) => {
      r["approvedBy"] = "someone-else";
      r["approvedAt"] = "2000-01-01T00:00:00.000Z";
    });
    const out = await rt.run({ generatedDir, reportsDir });
    expect(out.blocked).toBe(false);
    expect(out.source).toBe("marker");
  });

  it("P32 report without a sessionId (adopted by the approve flow, which stamps the session id): the real flow still allows", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    const reportPath = writeReport(reportsDir, "legacy.json", {
      approvalStatus: "pending",
      createdAt: new Date().toISOString(),
      content: "legacy report without a session id",
    });
    const approve = await approveUnderstanding({
      manifest: parseManifest({ version: 1 }),
      session: SESSION,
      reportsDir,
      generatedDir,
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(approve.persistedReport.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(reportPath, "utf8"))["sessionId"]).toBe(SESSION);
    const out = await rt.run({ generatedDir, reportsDir });
    expect(out.blocked).toBe(false);
    expect(out.source).toBe("marker");
  });

  it("P33 the approved report replaced by a non-object file (an array): the signed content is gone, blocks", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    const reportPath = await approveRealFlow(generatedDir, reportsDir);
    const body = JSON.parse(fs.readFileSync(reportPath, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(reportPath, JSON.stringify([body]));
    const out = await rt.run({ generatedDir, reportsDir });
    expect(out.blocked).toBe(true);
    expect(out.detail).toMatch(MISMATCH("session"));
  });

  // Gate-read binding rule (task fa423e9b): a matched marker with a non-null
  // signed hash is valid iff SOME parseable report file in the reports
  // directory (any session, any approvalStatus) has that canonical hash. The
  // cases below pin the swaps that rule must refuse and the legitimate
  // approvals it must keep (a newer report approved for the same claim, two
  // sessions sharing a claim, a standalone approve writing a new file).

  const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();
  const pendingReport = (
    reportsDir: string,
    name: string,
    session: string | null,
    offsetMs: number,
    content: string,
  ): string =>
    writeReport(reportsDir, name, {
      ...(session !== null ? { sessionId: session } : {}),
      approvalStatus: "pending",
      createdAt: iso(offsetMs),
      content,
    });
  const approveFor = async (
    generatedDir: string,
    reportsDir: string,
    session: string,
    extra: { tasks?: string[] } = {},
  ): Promise<void> => {
    const approve = await approveUnderstanding({
      manifest: parseManifest({ version: 1 }),
      session,
      reportsDir,
      generatedDir,
      ledgerAdd: async () => ({ ok: true }),
      ...extra,
    });
    expect(approve.marker.ok).toBe(true);
    expect(approve.persistedReport.ok).toBe(true);
  };

  it("A1 a newer pending report for the session no longer hides a swap of the approved report: blocks", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    const reportPath = pendingReport(reportsDir, "r1.json", SESSION, -60_000, "reviewed");
    await approveFor(generatedDir, reportsDir, SESSION);
    expect((await rt.run({ generatedDir, reportsDir })).blocked).toBe(false);
    editReport(reportPath, (r) => {
      r["content"] = "SWAPPED";
    });
    pendingReport(reportsDir, "r2.json", SESSION, 0, "a newer pending report");
    const out = await rt.run({ generatedDir, reportsDir });
    expect(out.blocked).toBe(true);
    expect(out.detail).toMatch(MISMATCH("session"));
  });

  it("A2 swapping the content AND rewriting the report's sessionId does not move it out of reach: blocks", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    const reportPath = pendingReport(reportsDir, "r1.json", SESSION, -60_000, "reviewed");
    await approveFor(generatedDir, reportsDir, SESSION);
    editReport(reportPath, (r) => {
      r["content"] = "SWAPPED";
      r["sessionId"] = "sess-elsewhere";
    });
    const out = await rt.run({ generatedDir, reportsDir });
    expect(out.blocked).toBe(true);
    expect(out.detail).toMatch(MISMATCH("session"));
  });

  it.each([
    ["pending", "pending"],
    ["a case variant of approved", "Approved"],
    ["expired", "expired"],
  ])("A3 swapping the content and setting approvalStatus to %s does not hide the swap: blocks", async (_label, status) => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    const reportPath = pendingReport(reportsDir, "r1.json", SESSION, -60_000, "reviewed");
    await approveFor(generatedDir, reportsDir, SESSION);
    editReport(reportPath, (r) => {
      r["content"] = "SWAPPED";
      r["approvalStatus"] = status;
    });
    const out = await rt.run({ generatedDir, reportsDir });
    expect(out.blocked).toBe(true);
    expect(out.detail).toMatch(MISMATCH("session"));
  });

  it("A5 replacing the approved report with a symlink to a swapped file: blocks", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    const reportPath = pendingReport(reportsDir, "r1.json", SESSION, -60_000, "reviewed");
    await approveFor(generatedDir, reportsDir, SESSION);
    const body = JSON.parse(fs.readFileSync(reportPath, "utf8")) as Record<string, unknown>;
    const elsewhere = path.join(tmp, "elsewhere.json");
    fs.writeFileSync(elsewhere, JSON.stringify({ ...body, content: "SWAPPED" }));
    fs.rmSync(reportPath);
    fs.symlinkSync(elsewhere, reportPath);
    const out = await rt.run({ generatedDir, reportsDir });
    expect(out.blocked).toBe(true);
    expect(out.detail).toMatch(MISMATCH("session"));
  });

  it("E2 the approved report rewritten as unparseable JSON: blocks (report files exist, none carries the signed content)", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    const reportPath = pendingReport(reportsDir, "r1.json", SESSION, -60_000, "reviewed");
    await approveFor(generatedDir, reportsDir, SESSION);
    fs.writeFileSync(reportPath, '{ "content": "SWAPPED", "approvalStatus": "approved", ');
    const out = await rt.run({ generatedDir, reportsDir });
    expect(out.blocked).toBe(true);
    expect(out.detail).toMatch(MISMATCH("session"));
  });

  it("an extra approved report with another content next to the untouched approved one changes nothing: allows", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    pendingReport(reportsDir, "r1.json", SESSION, -60_000, "reviewed");
    await approveFor(generatedDir, reportsDir, SESSION);
    writeReport(reportsDir, "r0.json", {
      sessionId: SESSION,
      approvalStatus: "approved",
      approvedAt: iso(0),
      createdAt: iso(-3_600_000),
      content: "SWAPPED, but the report that was approved is still on disk unmodified",
    });
    const out = await rt.run({ generatedDir, reportsDir });
    expect(out.blocked).toBe(false);
    expect(out.source).toBe("marker");
  });

  it("RESIDUAL (pinned, not closed): content kept in a copy before the edit, or re-created after it, keeps a match, so the marker still allows", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    const reportPath = pendingReport(reportsDir, "r1.json", SESSION, -60_000, "reviewed");
    await approveFor(generatedDir, reportsDir, SESSION);
    // The agent keeps the approved content in a second file, then edits the
    // original. The signed hash only proves the approved content is still on
    // disk somewhere; it cannot see that the file the audit trail points at
    // was edited. Documented in the policy-pack doc.
    const approvedText = fs.readFileSync(reportPath, "utf8");
    fs.copyFileSync(reportPath, path.join(reportsDir, "r1-copy.json"));
    editReport(reportPath, (r) => {
      r["content"] = "SWAPPED";
    });
    const out = await rt.run({ generatedDir, reportsDir });
    expect(out.blocked).toBe(false);
    expect(out.source).toBe("marker");
    // No copy kept: the edit denies, and writing the approved content back
    // (here as a new file) restores the match.
    fs.rmSync(path.join(reportsDir, "r1-copy.json"));
    expect((await rt.run({ generatedDir, reportsDir })).blocked).toBe(true);
    fs.writeFileSync(path.join(reportsDir, "re-created.json"), approvedText);
    expect((await rt.run({ generatedDir, reportsDir })).blocked).toBe(false);
  });

  it("no report file left: deleting every report file falls back to the no-report allow; removing only the approved one while another report remains denies until re-approved", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    const reportPath = pendingReport(reportsDir, "r1.json", SESSION, -60_000, "reviewed");
    await approveFor(generatedDir, reportsDir, SESSION);
    const other = pendingReport(reportsDir, "other.json", "sess-other", -30_000, "another session's report");
    fs.rmSync(reportPath);
    const removed = await rt.run({ generatedDir, reportsDir });
    expect(removed.blocked).toBe(true);
    expect(removed.detail).toMatch(MISMATCH("session"));
    fs.rmSync(other);
    const empty = await rt.run({ generatedDir, reportsDir });
    expect(empty.blocked).toBe(false);
    expect(empty.source).toBe("marker");
    // Re-approving recovers the first case: a fresh report for the session.
    pendingReport(reportsDir, "other.json", "sess-other", -30_000, "another session's report");
    pendingReport(reportsDir, "r2.json", SESSION, -10_000, "reviewed again");
    await approveFor(generatedDir, reportsDir, SESSION);
    expect((await rt.run({ generatedDir, reportsDir })).blocked).toBe(false);
  });

  it("R1 batch pre-approval (--tasks a,b), a newer report approved on task a, then claim b: the task b marker still allows", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    writeActiveClaim(generatedDir, "task-a");
    pendingReport(reportsDir, "r1.json", SESSION, -120_000, "batch plan");
    await approveFor(generatedDir, reportsDir, SESSION, { tasks: ["task-a", "task-b"] });
    expect((await rt.run({ generatedDir, reportsDir })).blocked).toBe(false);
    pendingReport(reportsDir, "r2.json", SESSION, -60_000, "revised plan for task a");
    await approveFor(generatedDir, reportsDir, SESSION);
    expect((await rt.run({ generatedDir, reportsDir })).blocked).toBe(false);
    writeActiveClaim(generatedDir, "task-b");
    const onB = await rt.run({ generatedDir, reportsDir });
    expect(onB.blocked).toBe(false);
    expect(onB.source).toBe("marker");
  });

  it("R2 two sessions share one claim and each was approved: both are allowed after the second approval", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    writeActiveClaim(generatedDir, "task-x");
    pendingReport(reportsDir, "s1.json", "sess-one", -120_000, "session one report");
    await approveFor(generatedDir, reportsDir, "sess-one");
    pendingReport(reportsDir, "s2.json", "sess-two", -60_000, "session two report");
    await approveFor(generatedDir, reportsDir, "sess-two");
    // The task marker now carries session two's hash; session one is checked
    // against content that is on disk, not against its own newest report.
    expect((await rt.run({ generatedDir, reportsDir, session: "sess-one" })).blocked).toBe(false);
    expect((await rt.run({ generatedDir, reportsDir, session: "sess-two" })).blocked).toBe(false);
  });

  it("R2 session-marker fallback: the task marker's report is edited, session one's own marker still verifies against its own report and allows", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    writeActiveClaim(generatedDir, "task-x");
    pendingReport(reportsDir, "s1.json", "sess-one", -120_000, "session one report");
    await approveFor(generatedDir, reportsDir, "sess-one");
    const s2 = pendingReport(reportsDir, "s2.json", "sess-two", -60_000, "session two report");
    await approveFor(generatedDir, reportsDir, "sess-two");
    editReport(s2, (r) => {
      r["content"] = "SWAPPED";
    });
    const first = await rt.run({ generatedDir, reportsDir, session: "sess-one" });
    expect(first.blocked).toBe(false);
    expect(first.source).toBe("marker");
    // The fallback accepted the SESSION marker, not the task marker.
    expect(first.stderr).not.toMatch(/approved via marker task-/);
    const second = await rt.run({ generatedDir, reportsDir, session: "sess-two" });
    expect(second.blocked).toBe(true);
    expect(second.detail).toMatch(MISMATCH("task and session"));
  });

  it("R2 fallback is not a bypass: with both approved reports edited, both markers fail and the reason names both kinds", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    writeActiveClaim(generatedDir, "task-x");
    const s1 = pendingReport(reportsDir, "s1.json", "sess-one", -120_000, "session one report");
    await approveFor(generatedDir, reportsDir, "sess-one");
    const s2 = pendingReport(reportsDir, "s2.json", "sess-two", -60_000, "session two report");
    await approveFor(generatedDir, reportsDir, "sess-two");
    for (const file of [s1, s2]) {
      editReport(file, (r) => {
        r["content"] = "SWAPPED";
      });
    }
    const out = await rt.run({ generatedDir, reportsDir, session: "sess-one" });
    expect(out.blocked).toBe(true);
    expect(out.detail).toMatch(MISMATCH("task and session"));
  });

  // The session-marker fallback inherits the session marker's own guards: it
  // never rescues a refused task marker when the session marker is past
  // `approval_lifecycle.max_age` or bound to another claim. Markers are
  // written directly (signed) so the ages and bindings are exact.
  const fallbackSetup = (
    claimForSession: string,
    sessionApprovedAt: string,
  ): { generatedDir: string; reportsDir: string } => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    const s1 = pendingReport(reportsDir, "s1.json", "sess-one", -120_000, "session one report");
    const s2 = pendingReport(reportsDir, "s2.json", "sess-two", -60_000, "session two report");
    writeActiveClaim(generatedDir, claimForSession);
    writeApprovalMarker(generatedDir, "sess-one", {
      approvedAt: sessionApprovedAt,
      approvedBy: "operator",
      reportContentHash: canonicalReportHashOfFile(s1),
    });
    writeActiveClaim(generatedDir, "task-now");
    writeTaskApprovalMarker(generatedDir, "task-now", {
      approvedAt: new Date().toISOString(),
      approvedBy: "operator",
      reportContentHash: canonicalReportHashOfFile(s2),
    });
    // The task marker's report content is edited; only the session marker could still verify.
    editReport(s2, (r) => {
      r["content"] = "SWAPPED";
    });
    return { generatedDir, reportsDir };
  };

  it("fallback guard: a session marker past max_age does not rescue a task marker whose report was edited; without max_age it does", async () => {
    const { generatedDir, reportsDir } = fallbackSetup("task-now", iso(-2 * 3_600_000));
    const withTtl = await rt.run({
      generatedDir,
      reportsDir,
      session: "sess-one",
      manifest: manifestWithPack({ approval_lifecycle: { max_age: "1h" } }),
    });
    expect(withTtl.blocked).toBe(true);
    expect(withTtl.detail).toMatch(MISMATCH("task"));
    const noTtl = await rt.run({ generatedDir, reportsDir, session: "sess-one" });
    expect(noTtl.blocked).toBe(false);
    expect(noTtl.source).toBe("marker");
    expect(noTtl.stderr).not.toMatch(/approved via marker task-/);
  });

  it("fallback guard: a session marker bound to another claim does not rescue a task marker whose report was edited; under mode: session it does", async () => {
    const { generatedDir, reportsDir } = fallbackSetup("task-before", new Date().toISOString());
    const bound = await rt.run({ generatedDir, reportsDir, session: "sess-one" });
    expect(bound.blocked).toBe(true);
    expect(bound.detail).toMatch(MISMATCH("task"));
    const sessionMode = await rt.run({
      generatedDir,
      reportsDir,
      session: "sess-one",
      manifest: manifestWithPack({ approval_lifecycle: { mode: "session" } }),
    });
    expect(sessionMode.blocked).toBe(false);
    expect(sessionMode.source).toBe("marker");
  });

  // A *.json file nested thousands of levels deep in the reports directory
  // used to overflow the stack of the canonical hash and kill the hook
  // process, which the runtime treats as a non-blocking error (fail-open).
  // It is now a report file that matches nothing.
  const plantDeepFile = (reportsDir: string, name: string): void => {
    fs.writeFileSync(path.join(reportsDir, name), `{"content":${"[".repeat(6000)}${"]".repeat(6000)}}`);
  };

  it("deep file: a tampered approval next to a deeply nested *.json still blocks with the mismatch reason", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    const reportPath = await approveRealFlow(generatedDir, reportsDir);
    editReport(reportPath, (r) => {
      r["content"] = "SWAPPED";
    });
    for (const name of ["aa-deep.json", "zz-deep.json"]) plantDeepFile(reportsDir, name);
    const out = await rt.run({ generatedDir, reportsDir });
    expect(out.blocked).toBe(true);
    expect(out.detail).toMatch(MISMATCH("session"));
  });

  it("deep file: an untouched approval next to a deeply nested *.json (listed before and after it) still allows", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    await approveRealFlow(generatedDir, reportsDir);
    for (const name of ["aa-deep.json", "zz-deep.json"]) plantDeepFile(reportsDir, name);
    const out = await rt.run({ generatedDir, reportsDir });
    expect(out.blocked).toBe(false);
    expect(out.source).toBe("marker");
  });

  it("deep report: `harness approve understanding` refuses a report too deeply nested to hash (the marker could not bind it) and the gate stays closed; --force overrides with an unbound marker", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    fs.mkdirSync(reportsDir, { recursive: true });
    const head = JSON.stringify({
      sessionId: SESSION,
      approvalStatus: "pending",
      createdAt: new Date().toISOString(),
      content: "the understanding the operator reviewed",
    }).slice(0, -1);
    const reportPath = path.join(reportsDir, "r1.json");
    fs.writeFileSync(reportPath, `${head},"extra":${"[".repeat(200)}${"]".repeat(200)}}`);
    const approveArgs = {
      manifest: parseManifest({ version: 1 }),
      session: SESSION,
      reportsDir,
      generatedDir,
      ledgerAdd: async () => ({ ok: true as const }),
    };
    const refused = await approveUnderstanding(approveArgs);
    expect(refused.marker.ok).toBe(false);
    expect(refused.validation).toMatchObject({ ok: false, field: "report", enforced: true });
    expect(fs.existsSync(approvalMarkerPathFor(generatedDir, SESSION))).toBe(false);
    expect(JSON.parse(fs.readFileSync(reportPath, "utf8"))["approvalStatus"]).toBe("pending");
    expect((await rt.run({ generatedDir, reportsDir })).blocked).toBe(true);
    const forced = await approveUnderstanding({ ...approveArgs, force: true });
    expect(forced.marker.ok).toBe(true);
    const marker = JSON.parse(fs.readFileSync(approvalMarkerPathFor(generatedDir, SESSION), "utf8")) as Record<string, unknown>;
    expect(marker["reportContentHash"]).toBeNull();
    expect((await rt.run({ generatedDir, reportsDir })).blocked).toBe(false);
  });

  // A report file is hashed only when it is a regular file of at most
  // MAX_HASHED_REPORT_BYTES. A planted file of a few hundred megabytes used to
  // run the hook out of heap (a dead hook is a non-blocking error, so the call
  // went through); over the cap it is now a report file that matches nothing.
  // 2 MiB stands in for any size over the cap; the evidence read after a
  // refused marker and on the no-marker path reads through the same bounded
  // reader (pinned in tests/cli/pack-hook-pre-tool-use-subprocess.test.ts).
  const OVERSIZED_BYTES = 2 * MAX_HASHED_REPORT_BYTES;

  // The hash scan has a total budget (MAX_HASH_SCAN_BYTES) next to the
  // per-file cap: the cap bounds one file, not their number. Past the budget
  // without a match the check fails closed with the mismatch reason. The scan
  // reads the newest file (descending name order) first, so the approved
  // report is found early in the usual case. Every entry is charged at least
  // MIN_SCAN_ENTRY_COST_BYTES whatever its read returned, so entries that read
  // nothing (tiny files, directories named *.json, files over the cap) spend
  // the budget too and the entry count is bounded.
  const PAD_FILE_BYTES = MAX_HASHED_REPORT_BYTES - 1024;
  const padFileCount = Math.ceil(MAX_HASH_SCAN_BYTES / PAD_FILE_BYTES) + 1;

  /** Plant `count` valid report-shaped files just under the per-file cap, named to sort newer than r1.json. */
  function plantPadFiles(reportsDir: string, count: number, prefix = "z-pad-"): void {
    const pad = " ".repeat(PAD_FILE_BYTES - 40);
    for (let i = 0; i < count; i++) {
      fs.writeFileSync(
        path.join(reportsDir, `${prefix}${String(i).padStart(3, "0")}.json`),
        `{"filler":${i}}${pad}`,
      );
    }
  }

  it("scan budget: the approved report older than more report data than the budget covers denies with the mismatch reason (fail closed)", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    await approveRealFlow(generatedDir, reportsDir);
    // Control: untouched directory allows.
    expect((await rt.run({ generatedDir, reportsDir })).blocked).toBe(false);
    plantPadFiles(reportsDir, padFileCount);
    const out = await rt.run({ generatedDir, reportsDir });
    expect(out.blocked).toBe(true);
    expect(out.detail).toMatch(MISMATCH("session"));
    expect(out.detail).toMatch(/more report data than the gate-read scan budget covers/);
  });

  it("scan budget: just under the budget the same directory still allows", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    await approveRealFlow(generatedDir, reportsDir);
    plantPadFiles(reportsDir, Math.floor(MAX_HASH_SCAN_BYTES / PAD_FILE_BYTES) - 1);
    const out = await rt.run({ generatedDir, reportsDir });
    expect(out.blocked).toBe(false);
    expect(out.source).toBe("marker");
  });

  it("scan budget: the approved report is the newest by name, so it is found first however much other report data follows", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    const reportPath = await approveRealFlow(generatedDir, reportsDir);
    fs.renameSync(reportPath, path.join(reportsDir, "zzz-approved.json"));
    plantPadFiles(reportsDir, padFileCount);
    const out = await rt.run({ generatedDir, reportsDir });
    expect(out.blocked).toBe(false);
    expect(out.source).toBe("marker");
  });

  it("scan budget: a large realistic directory (1000 reports of a few KiB) with the approved report the oldest still allows", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    const reportPath = await approveRealFlow(generatedDir, reportsDir);
    fs.renameSync(reportPath, path.join(reportsDir, "0000-approved.json"));
    for (let i = 1; i <= 1000; i++) {
      const para = `Paragraph of report ${i}: ${"the understanding the operator reviewed ".repeat(8)}`;
      fs.writeFileSync(
        path.join(reportsDir, `2026-01-01T00-00-00-${String(i).padStart(4, "0")}.json`),
        JSON.stringify(
          {
            sessionId: `sess-${i}`,
            approvalStatus: "approved",
            createdAt: "2026-01-01T00:00:00.000Z",
            sections: Object.fromEntries(
              Array.from({ length: 8 }, (_, k) => [`section${k}`, { text: para, items: [para, para] }]),
            ),
          },
          null,
          2,
        ),
      );
    }
    const out = await rt.run({ generatedDir, reportsDir });
    expect(out.blocked).toBe(false);
    expect(out.source).toBe("marker");
  });

  // Entries that cost (almost) no bytes still cost an open each. The per-entry
  // floor charges them, so MAX_HASH_SCAN_BYTES / MIN_SCAN_ENTRY_COST_BYTES
  // entries spend the budget however little they read.
  const floorEntryLimit = MAX_HASH_SCAN_BYTES / MIN_SCAN_ENTRY_COST_BYTES;
  // Planting thousands of entries takes seconds on a loaded machine.
  const PLANTED_DIR_TEST_TIMEOUT_MS = 60_000;

  type UnchargedKind = "tiny files" | "directories named *.json" | "files over the size cap";
  const unchargedKinds: UnchargedKind[] = ["tiny files", "directories named *.json", "files over the size cap"];

  /** Plant `count` entries that read (almost) no bytes, named to sort newer than r1.json. */
  function plantUnchargedEntries(reportsDir: string, kind: UnchargedKind, count: number): void {
    for (let i = 0; i < count; i++) {
      const entry = path.join(reportsDir, `z-entry-${String(i).padStart(6, "0")}.json`);
      if (kind === "tiny files") fs.writeFileSync(entry, "{}");
      else if (kind === "directories named *.json") fs.mkdirSync(entry);
      else {
        const fd = fs.openSync(entry, "w");
        fs.ftruncateSync(fd, OVERSIZED_BYTES);
        fs.closeSync(fd);
      }
    }
  }

  for (const kind of unchargedKinds) {
    it(`scan bound: more ${kind} than the entry bound allows before the approved report deny, naming the bound (fail closed, nothing is opened)`, async () => {
      const generatedDir = path.join(tmp, "harness.generated");
      const reportsDir = path.join(tmp, "reports");
      await approveRealFlow(generatedDir, reportsDir);
      plantUnchargedEntries(reportsDir, kind, floorEntryLimit + 1);
      const out = await rt.run({ generatedDir, reportsDir });
      expect(out.blocked).toBe(true);
      // The listing stops at the entry bound before the scan starts, so the
      // reason names that bound (not the mismatch or the byte budget).
      expect(out.detail).toMatch(
        /no report in the reports directory could be checked against the content the session approval marker was signed for \(the reports directory \S+ holds more than 8192 \*\.json entries, or more than 16384 entries of any name, more than the gate reads; remove /,
      );
      expect(out.detail).toContain(`(the reports directory ${reportsDir} holds more than`);
      expect(out.detail).not.toMatch(/the approved report was changed or removed after approval/);
      expect(out.detail).not.toMatch(/more report data than the gate-read scan budget covers/);
    }, PLANTED_DIR_TEST_TIMEOUT_MS);

    it(`scan budget: just under the per-entry floor limit the same directory of ${kind} still allows`, async () => {
      const generatedDir = path.join(tmp, "harness.generated");
      const reportsDir = path.join(tmp, "reports");
      await approveRealFlow(generatedDir, reportsDir);
      plantUnchargedEntries(reportsDir, kind, floorEntryLimit - 2);
      const out = await rt.run({ generatedDir, reportsDir });
      expect(out.blocked).toBe(false);
      expect(out.source).toBe("marker");
    }, PLANTED_DIR_TEST_TIMEOUT_MS);
  }

  it("scan budget: 5000 realistic reports of a few KiB with the approved report the oldest still allows under the per-entry floor", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    const reportPath = await approveRealFlow(generatedDir, reportsDir);
    fs.renameSync(reportPath, path.join(reportsDir, "0000-approved.json"));
    const para = `the understanding the operator reviewed ${"x".repeat(40)} `.repeat(4);
    for (let i = 1; i <= 5000; i++) {
      fs.writeFileSync(
        path.join(reportsDir, `2026-01-01T00-00-00-${String(i).padStart(5, "0")}.json`),
        JSON.stringify({
          sessionId: `sess-${i}`,
          approvalStatus: "approved",
          createdAt: "2026-01-01T00:00:00.000Z",
          sections: Object.fromEntries(Array.from({ length: 6 }, (_, k) => [`section${k}`, { text: para, items: [para] }])),
        }),
      );
    }
    const out = await rt.run({ generatedDir, reportsDir });
    expect(out.blocked).toBe(false);
    expect(out.source).toBe("marker");
  }, PLANTED_DIR_TEST_TIMEOUT_MS);

  /** A pending report whose file is exactly MAX_HASHED_REPORT_BYTES - 50 bytes. */
  function writeNearCapReport(reportsDir: string, session: string): { filePath: string; json: string } {
    fs.mkdirSync(reportsDir, { recursive: true });
    const filePath = path.join(reportsDir, "r1.json");
    const make = (n: number): string =>
      JSON.stringify({
        sessionId: session,
        approvalStatus: "pending",
        createdAt: new Date().toISOString(),
        content: "x".repeat(n),
      });
    const json = make(MAX_HASHED_REPORT_BYTES - 50 - make(0).length);
    expect(json.length).toBe(MAX_HASHED_REPORT_BYTES - 50);
    fs.writeFileSync(filePath, json);
    return { filePath, json };
  }

  it("producer cap: `harness approve understanding` refuses a report of cap minus 50 bytes (the pretty-printed rewrite crosses the cap), even with --force, before writing anything", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    const { filePath, json } = writeNearCapReport(reportsDir, SESSION);
    let ledgerAddCalls = 0;
    const approveArgs = {
      manifest: parseManifest({ version: 1 }),
      session: SESSION,
      reportsDir,
      generatedDir,
      ledgerAdd: async () => {
        ledgerAddCalls += 1;
        return { ok: true as const };
      },
    };
    for (const force of [false, true]) {
      const rejection: unknown = await approveUnderstanding({ ...approveArgs, ...(force ? { force } : {}) }).then(
        () => null,
        (err: unknown) => err,
      );
      expect(rejection).toBeInstanceOf(HarnessExitError);
      expect((rejection as HarnessExitError).exitCode).toBe(EX_FAIL);
      expect((rejection as HarnessExitError).message).toMatch(
        /the approved report would be \d+ bytes, over the 1048576-byte cap for hashing its content/,
      );
      expect(ledgerAddCalls).toBe(0);
      expect(fs.existsSync(approvalMarkerPathFor(generatedDir, SESSION))).toBe(false);
      expect(fs.readFileSync(filePath, "utf8")).toBe(json);
      // The gate stays closed for want of an approval, not on a mismatch.
      const out = await rt.run({ generatedDir, reportsDir });
      expect(out.blocked).toBe(true);
      expect(out.detail).not.toMatch(MISMATCH("session"));
    }
  });

  it("producer cap: a report of cap minus 4 KiB still approves and the gate allows (the refusal is the size, nothing else)", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    fs.mkdirSync(reportsDir, { recursive: true });
    fs.writeFileSync(
      path.join(reportsDir, "r1.json"),
      JSON.stringify({
        sessionId: SESSION,
        approvalStatus: "pending",
        createdAt: new Date().toISOString(),
        content: "x".repeat(MAX_HASHED_REPORT_BYTES - 4096),
      }),
    );
    const approve = await approveUnderstanding({
      manifest: parseManifest({ version: 1 }),
      session: SESSION,
      reportsDir,
      generatedDir,
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(approve.marker.ok).toBe(true);
    expect((await rt.run({ generatedDir, reportsDir })).blocked).toBe(false);
  });

  it("oversized file: a tampered approval next to a 2 MiB *.json carrying the approved content blocks, because a file over the size cap matches nothing", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    const reportPath = await approveRealFlow(generatedDir, reportsDir);
    // The approved content, padded with JSON whitespace past the cap: within
    // the cap this would be a copy that keeps a match (residual 1).
    const approvedJson = fs.readFileSync(reportPath, "utf8");
    fs.writeFileSync(path.join(reportsDir, "zz-padded.json"), approvedJson + " ".repeat(OVERSIZED_BYTES));
    editReport(reportPath, (r) => {
      r["content"] = "SWAPPED";
    });
    const out = await rt.run({ generatedDir, reportsDir });
    expect(out.blocked).toBe(true);
    expect(out.detail).toMatch(MISMATCH("session"));
  });

  it("oversized file: an untouched approval next to a 2 MiB *.json still allows", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    await approveRealFlow(generatedDir, reportsDir);
    fs.writeFileSync(path.join(reportsDir, "aa-big.json"), `{"pad":"${"x".repeat(OVERSIZED_BYTES)}"}`);
    const out = await rt.run({ generatedDir, reportsDir });
    expect(out.blocked).toBe(false);
    expect(out.source).toBe("marker");
  });

  it("oversized report: `harness approve understanding` refuses before writing anything, even with --force, and the gate stays closed", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    fs.mkdirSync(reportsDir, { recursive: true });
    const reportPath = path.join(reportsDir, "r1.json");
    // A valid report whose only flaw is its size: whitespace changes no content.
    const json = JSON.stringify({
      sessionId: SESSION,
      approvalStatus: "pending",
      createdAt: new Date().toISOString(),
      content: "the understanding the operator reviewed",
    });
    fs.writeFileSync(reportPath, json + " ".repeat(OVERSIZED_BYTES));
    const approveArgs = {
      manifest: parseManifest({ version: 1 }),
      session: SESSION,
      reportsDir,
      generatedDir,
      ledgerAdd: async () => ({ ok: true as const }),
    };
    const expectedDetail = `${json.length + OVERSIZED_BYTES} bytes, over the 1048576-byte cap for hashing its content`;
    for (const force of [false, true]) {
      await expect(approveUnderstanding({ ...approveArgs, ...(force ? { force } : {}) })).rejects.toThrow(
        new RegExp(`${JSON.stringify(reportPath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: ${expectedDetail}`),
      );
      expect(fs.existsSync(approvalMarkerPathFor(generatedDir, SESSION))).toBe(false);
      expect(JSON.parse(fs.readFileSync(reportPath, "utf8"))["approvalStatus"]).toBe("pending");
      expect((await rt.run({ generatedDir, reportsDir })).blocked).toBe(true);
    }
  });

  it("R2b re-approving session one after session two: neither session is denied", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    writeActiveClaim(generatedDir, "task-x");
    pendingReport(reportsDir, "s1.json", "sess-one", -120_000, "session one report");
    await approveFor(generatedDir, reportsDir, "sess-one");
    pendingReport(reportsDir, "s2.json", "sess-two", -60_000, "session two report");
    await approveFor(generatedDir, reportsDir, "sess-two");
    await approveFor(generatedDir, reportsDir, "sess-one");
    expect((await rt.run({ generatedDir, reportsDir, session: "sess-one" })).blocked).toBe(false);
    expect((await rt.run({ generatedDir, reportsDir, session: "sess-two" })).blocked).toBe(false);
  });

  it("R3 a standalone understanding-gate approve writes a new approved file (bumped createdAt) after the harness approval: the harness approval stays valid", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    const reportPath = pendingReport(reportsDir, "r1.json", SESSION, -60_000, "reviewed");
    await approveFor(generatedDir, reportsDir, SESSION);
    const body = JSON.parse(fs.readFileSync(reportPath, "utf8")) as Record<string, unknown>;
    writeReport(reportsDir, "r1-standalone.json", { ...body, createdAt: iso(0), approvedAt: iso(0), approvedBy: "cli" });
    const out = await rt.run({ generatedDir, reportsDir });
    expect(out.blocked).toBe(false);
    expect(out.source).toBe("marker");
  });

  it("R4 task marker from an earlier session, a new session with no report yet, and a sessionId-less approved legacy report in the directory: allows", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    writeActiveClaim(generatedDir, "task-y");
    pendingReport(reportsDir, "earlier.json", "sess-earlier", -120_000, "earlier session report");
    await approveFor(generatedDir, reportsDir, "sess-earlier");
    writeReport(reportsDir, "legacy.json", {
      approvalStatus: "approved",
      approvedAt: iso(-86_400_000),
      approvedBy: "cli",
      createdAt: iso(-86_400_000),
      content: "old legacy report without a sessionId",
    });
    const out = await rt.run({ generatedDir, reportsDir });
    expect(out.blocked).toBe(false);
    expect(out.source).toBe("marker");
  });

  it("E1 approve, boundary expiry of the report, re-approve of the same report: allows after both", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    pendingReport(reportsDir, "r1.json", SESSION, -60_000, "reviewed");
    await approveFor(generatedDir, reportsDir, SESSION);
    expect(expirePersistedReport(reportsDir, SESSION, new Date(), "tool:mcp__agent-tasks__task_finish").ok).toBe(true);
    expect((await rt.run({ generatedDir, reportsDir })).blocked).toBe(false);
    await approveFor(generatedDir, reportsDir, SESSION);
    expect((await rt.run({ generatedDir, reportsDir })).blocked).toBe(false);
  });

  it("P20 expired report (post-boundary) plus EXPIRED marker: the bare recovery git commit passes via the exemption, source says so", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    writeApprovalMarker(generatedDir, SESSION, {
      approvedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      approvedBy: "operator",
    });
    writeReport(reportsDir, "r1.json", approvedBody());
    expirePersistedReport(reportsDir, SESSION);
    const out = await rt.run({
      generatedDir,
      reportsDir,
      manifest: manifestWithPack({ approval_lifecycle: { max_age: "4h" } }),
      command: 'git commit -m "recovery"',
    });
    expect(out.blocked).toBe(false);
    expect(out.source).toBe("recovery-commit");
  });

  it("P21 approved report plus a read-only shell command: allowed by the read-only carve-out, NOT by the report (source none)", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    writeReport(reportsDir, "r1.json", approvedBody());
    const out = await rt.run({ generatedDir, reportsDir, command: "git status" });
    expect(out.blocked).toBe(false);
    expect(out.source).toBe("none");
  });

  it("P22 approved report plus a mutating shell command: blocks (the report grants nothing to Bash either)", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    writeReport(reportsDir, "r1.json", approvedBody());
    const out = await rt.run({ generatedDir, reportsDir, command: "rm -rf build" });
    expect(out.blocked).toBe(true);
    expect(out.detail).toMatch(REJECT);
  });
});

describe("report hash mismatch: Claude-only call shapes (task fa423e9b)", () => {
  async function approvedSession(): Promise<{ generatedDir: string; reportsDir: string; reportPath: string }> {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    const reportPath = writeReport(reportsDir, "r1.json", {
      sessionId: SESSION,
      approvalStatus: "pending",
      createdAt: new Date().toISOString(),
      content: "reviewed",
    });
    await approveUnderstanding({
      manifest: parseManifest({ version: 1 }),
      session: SESSION,
      reportsDir,
      generatedDir,
      ledgerAdd: async () => ({ ok: true }),
    });
    return { generatedDir, reportsDir, reportPath };
  }

  function swap(reportPath: string): void {
    const r = JSON.parse(fs.readFileSync(reportPath, "utf8")) as Record<string, unknown>;
    r["content"] = "swapped";
    fs.writeFileSync(reportPath, `${JSON.stringify(r, null, 2)}\n`);
  }

  async function preToolUse(
    generatedDir: string,
    reportsDir: string,
    event: Record<string, unknown>,
  ): Promise<{ blocked: boolean; asked: boolean; source: string; detail: string }> {
    const result = await runPackHookPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(JSON.stringify({ session_id: SESSION, ...event })),
      stdout: bufferStream().stream,
      stderr: bufferStream().stream,
      reportsDir,
      generatedDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    return {
      blocked: result.blocked,
      asked: result.asked === true,
      source: result.approvalCheck.source,
      detail: result.approvalCheck.detail,
    };
  }

  it("an in-flight subagent record does not re-open the gate for a subagent under a refused approval", async () => {
    const { generatedDir, reportsDir, reportPath } = await approvedSession();
    const start = await runPackHookSubagentStartCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        JSON.stringify({ session_id: SESSION, agent_id: "agent-abc", agent_type: "general-purpose" }),
      ),
      stderr: bufferStream().stream,
      generatedDir,
    });
    expect(start.recordWritten).toBe(true);
    const subagentCall = { tool_name: "Edit", agent_id: "agent-abc" };
    // Control: before the swap the subagent call is allowed.
    expect((await preToolUse(generatedDir, reportsDir, subagentCall)).blocked).toBe(false);
    swap(reportPath);
    const out = await preToolUse(generatedDir, reportsDir, subagentCall);
    expect(out.blocked).toBe(true);
    expect(out.source).toBe("none");
    expect(out.detail).toMatch(MISMATCH("session"));
  });

  it("the operator-approval command still defers to the interactive prompt, so the fix the reason names is reachable", async () => {
    const { generatedDir, reportsDir, reportPath } = await approvedSession();
    swap(reportPath);
    const out = await preToolUse(generatedDir, reportsDir, {
      tool_name: "Bash",
      tool_input: { command: "harness approve understanding" },
    });
    expect(out.blocked).toBe(false);
    expect(out.asked).toBe(true);
    expect(out.detail).toMatch(MISMATCH("session"));
  });
});
