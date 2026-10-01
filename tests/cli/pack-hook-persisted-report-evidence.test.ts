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
// Null-hash markers and a directory with no report file keep today's
// behaviour. P19 and P23-P33 and the cases after P33 pin all of that,
// including the approvals that must stay allowed.
//
// Residuals named and pinned below (not closed by this task, tracked
// elsewhere):
//   - Key read + uncovered write forges a VALID marker (documented
//     honest trust model in src/runtime/approval-signing.ts). Unchanged.
//   - Copy-then-edit: an agent that keeps the approved content in a second
//     file of the reports directory and then edits the original keeps a
//     match, so the marker still allows (pinned by the RESIDUAL test). The
//     signed hash proves the approved content is still on disk, not that the
//     file the audit trail points at is unmodified.
//   - In-flight subagent record: hook-subagent-start.ts mints the in-flight
//     record without the hash check, so a record written under a refused
//     approval can open the gate for that subagent once the parent marker
//     stops matching (claim switch, max_age). Pre-existing, unchanged here.
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
  writeActiveClaim,
  writeApprovalMarker,
  writeTaskApprovalMarker,
} from "../../src/policy-packs/builtin/understanding-before-execution-runtime.js";
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

  it("P19 TAMPER: valid session marker + approved report whose content was edited after approval: blocks with the mismatch reason naming the file and `harness approve understanding`", async () => {
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

  it("P28 task-scoped marker, NEW session whose own report is still pending: allows as before (the check needs an approved report)", async () => {
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

  it("RESIDUAL (pinned, not closed): content preserved in a copy before the edit keeps a match, so the marker still allows", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    const reportPath = pendingReport(reportsDir, "r1.json", SESSION, -60_000, "reviewed");
    await approveFor(generatedDir, reportsDir, SESSION);
    // The agent keeps the approved content in a second file, then edits the
    // original. The signed hash only proves the approved content is still on
    // disk somewhere; it cannot see that the file the audit trail points at
    // was edited. Documented in the policy-pack doc.
    fs.copyFileSync(reportPath, path.join(reportsDir, "r1-copy.json"));
    editReport(reportPath, (r) => {
      r["content"] = "SWAPPED";
    });
    const out = await rt.run({ generatedDir, reportsDir });
    expect(out.blocked).toBe(false);
    expect(out.source).toBe("marker");
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
