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
// Residuals named and pinned below (not closed by this task, tracked
// elsewhere):
//   R1. A VALID marker plus a swapped/replaced report still allows: the
//       operator did approve this session; the marker's
//       `reportContentHash` is not yet cross-checked at gate time (C1
//       staleness follow-up, task fa423e9b). Under this task that is an
//       audit-fidelity gap, no longer an authority gap.
//   R2. Key read + uncovered write forges a VALID marker (documented
//       honest trust model in src/runtime/approval-signing.ts). Unchanged.
//   R3. The standalone `understanding-gate approve` CLI flips the report
//       without a signed marker and therefore no longer opens the harness
//       gate; `harness approve understanding` is the approval path.

import { Readable, Writable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approveUnderstanding } from "../../src/cli/approve/understanding.js";
import { runPackHookCodexPreToolUseCli } from "../../src/cli/pack/hook-codex-pre-tool-use.js";
import { runPackHookPreToolUseCli } from "../../src/cli/pack/hook-pre-tool-use.js";
import type { LedgerEntry } from "../../src/policies/index.js";
import {
  applyPostToolUseExpiry,
  clearApprovalMarker,
  expirePersistedReport,
  writeActiveClaim,
  writeApprovalMarker,
  writeTaskApprovalMarker,
} from "../../src/policy-packs/builtin/understanding-before-execution-runtime.js";
import { rotateSigningKey } from "../../src/runtime/approval-signing.js";
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
    args: { generatedDir?: string; reportsDir: string; manifest?: Manifest; command?: string },
  ) => Promise<Outcome>;
}

const RUNTIMES: Runtime[] = [
  {
    name: "claude pre-tool-use",
    run: async ({ generatedDir, reportsDir, manifest, command }) => {
      const stderr = bufferStream();
      const result = await runPackHookPreToolUseCli({
        manifest: manifest ?? manifestWithPack(),
        stdin: readableFromString(
          JSON.stringify(
            command !== undefined
              ? { session_id: SESSION, tool_name: "Bash", tool_input: { command } }
              : { session_id: SESSION, tool_name: "Edit" },
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
    run: async ({ generatedDir, reportsDir, manifest, command }) => {
      const stderr = bufferStream();
      const result = await runPackHookCodexPreToolUseCli({
        manifest: manifest ?? manifestWithPack(),
        stdin: readableFromString(
          JSON.stringify(
            command !== undefined
              ? { session_id: SESSION, tool_name: "shell", raw_input: { command } }
              : { session_id: SESSION, tool_name: "apply_patch" },
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

  it("P19 RESIDUAL R1 (pinned, tracked by fa423e9b): valid marker + report SWAPPED after approval still allows via the marker", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    const reportPath = writeReport(reportsDir, "r1.json", {
      sessionId: SESSION,
      approvalStatus: "pending",
      createdAt: new Date().toISOString(),
    });
    await approveUnderstanding({
      manifest: parseManifest({ version: 1 }),
      session: SESSION,
      reportsDir,
      generatedDir,
      ledgerAdd: async () => ({ ok: true }),
    });
    // Replace the approved report's content wholesale (a different
    // Understanding text, same session). The marker's reportContentHash
    // is not cross-checked at gate time yet.
    fs.writeFileSync(reportPath, `${JSON.stringify({ ...approvedBody(), content: "swapped" }, null, 2)}\n`);
    const out = await rt.run({ generatedDir, reportsDir });
    expect(out.blocked).toBe(false);
    expect(out.source).toBe("marker");
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
