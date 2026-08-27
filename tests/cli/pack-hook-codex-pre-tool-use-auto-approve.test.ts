// Slice 2 of docs/decisions/2026-08-27-ug-auto-mode-approval.md
// (agent-tasks/57058364): the CODEX PreToolUse hook running the same
// operator-opt-in auto-approval attempt slice 1 added for Claude Code,
// at the same place in its decision order.
//
// Deliberately a sibling of tests/cli/pack-hook-pre-tool-use-auto-approve.test.ts
// rather than an addition to tests/cli/pack-hook-codex-pre-tool-use.test.ts
// (1210 lines): every test here shares one elaborate fixture (opt-in
// config + payload `permission_mode` + a transcript file named for the
// session + signing key + a strict-session pending report) that no other
// test in that file wants, and the slice 1 suite is the file this one is
// meant to be read against. The helper shapes below are deliberate
// copies of that suite's so the two read the same way.
//
// What is Codex-specific, and why it is tested here rather than assumed:
//
//   - `approvedBy` carries `auto-mode:codex:<mode>`, not `claude-code`.
//   - Session consistency has no environment counterpart. A Codex hook
//     process carries NO session-id variable (live capture, Codex
//     0.150.1: only CODEX_HOME, CODEX_MANAGED_BY_NPM,
//     CODEX_MANAGED_PACKAGE_ROOT), so the payload's own
//     `transcript_path` is the second input: it must be a non-empty
//     string, its basename must name this session, and the file must
//     exist. Like the Claude env check, this is a CONSISTENCY check and
//     not a boundary — see `SessionConsistencyCheck` in
//     src/cli/pack/auto-approve-path.ts.
//   - Real Codex sends tool args in `tool_input`; harness's older
//     published envelope used `raw_input`. Both shapes are exercised for
//     the two exemptions that have to see the command.
//
// Review round 1 added four more concerns, each with its own control
// below: the per-harness opt-in (`auto_approve.harnesses`, so sharing
// one body does not share one opt-in), the exemption's own view of
// `tool_input` / `raw_input` (a disagreeing pair, and a null
// `tool_input` shadowing a real `raw_input`), the Codex-specific ledger
// source and stderr label, and a transcript path that names a directory
// rather than a file.
//
// The mutation probes named in the task assignment were each applied for
// real against this file and the named test observed red; see the
// implementer report for the probe-by-probe record.

import { Readable, Writable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildUgAutoApprovals } from "../../src/cli/doctor/ug-auto-approvals.js";
import { runPackHookCodexPreToolUseCli } from "../../src/cli/pack/hook-codex-pre-tool-use.js";
import { runPackHookPreToolUseCli } from "../../src/cli/pack/hook-pre-tool-use.js";
import type { LedgerEntry } from "../../src/policies/index.js";
import {
  applyPostToolUseExpiry,
  approvalMarkerPathFor,
  checkApprovalMarker,
  clearApprovalMarker,
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

const SESSION = "01998f2a-codex-auto-1";

let tmp: string;
let generatedDir: string;
let reportsDir: string;
let sessionsDir: string;
/** The transcript file every test that does not override it names in the payload. */
let transcriptPath: string;
let savedClaude: string | undefined;
let savedClaudeCode: string | undefined;
let savedCodex: string | undefined;
let ledgerCalls: LedgerWriteArgs[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ug-codex-auto-"));
  generatedDir = path.join(tmp, "harness.generated");
  reportsDir = path.join(tmp, "reports");
  sessionsDir = path.join(tmp, "sessions");
  // The Codex hook falls back to three session-id env vars; clear them
  // so nothing here can be satisfied by the dev host's environment, and
  // so the "no env counterpart on Codex" claim is actually exercised.
  savedClaude = process.env.CLAUDE_SESSION_ID;
  savedClaudeCode = process.env.CLAUDE_CODE_SESSION_ID;
  savedCodex = process.env.CODEX_SESSION_ID;
  delete process.env.CLAUDE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CODEX_SESSION_ID;
  ledgerCalls = [];
  transcriptPath = writeTranscriptFile();
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (savedClaude === undefined) delete process.env.CLAUDE_SESSION_ID;
  else process.env.CLAUDE_SESSION_ID = savedClaude;
  if (savedClaudeCode === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = savedClaudeCode;
  if (savedCodex === undefined) delete process.env.CODEX_SESSION_ID;
  else process.env.CODEX_SESSION_ID = savedCodex;
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

/**
 * Create a rollout transcript file shaped like the one real Codex names
 * in the payload: `rollout-<timestamp>-<session_id>.jsonl` under a
 * `sessions/` directory (live capture, Codex 0.150.1; the real path
 * additionally carries YYYY/MM/DD segments, which nothing here reads).
 */
function writeTranscriptFile(sessionId: string = SESSION): string {
  fs.mkdirSync(sessionsDir, { recursive: true });
  const filePath = path.join(sessionsDir, `rollout-2026-08-27T00-00-00-${sessionId}.jsonl`);
  fs.writeFileSync(filePath, "");
  return filePath;
}

/**
 * The opt-in manifest: `bypassPermissions` allowlisted, `require_report:
 * true`, and BOTH harnesses opted in. `harnesses` is required for any
 * Codex auto-approval (review round 1): the shared auto path declines
 * for a harness the operator did not name, and an absent key means
 * Claude Code only, so the whole happy-path fixture would block without
 * this. The controls in "the per-harness opt-in" below are the ones that
 * leave it out on purpose.
 */
function manifestWithAutoApprove(extraConfig: Record<string, unknown> = {}): Manifest {
  return parseManifest({
    version: 1,
    policy_packs: [
      {
        name: "understanding-before-execution",
        enabled: true,
        config: {
          auto_approve: {
            when: ["bypassPermissions"],
            harnesses: ["claude-code", "codex"],
            require_report: true,
          },
          ...extraConfig,
        },
      },
    ],
  });
}

/**
 * The same opt-in with an explicit `harnesses` value, or — when the
 * argument is omitted — with NO `harnesses` key at all, which is the
 * shape every `auto_approve` block written before the Codex hook existed
 * has.
 */
function manifestWithHarnesses(harnesses?: string[]): Manifest {
  return parseManifest({
    version: 1,
    policy_packs: [
      {
        name: "understanding-before-execution",
        enabled: true,
        config: {
          auto_approve: {
            when: ["bypassPermissions"],
            ...(harnesses === undefined ? {} : { harnesses }),
            require_report: true,
          },
        },
      },
    ],
  });
}

/** No `auto_approve` block at all (the "opt-in absent" fixture). */
function manifestWithoutAutoApprove(): Manifest {
  return parseManifest({
    version: 1,
    policy_packs: [{ name: "understanding-before-execution", enabled: true }],
  });
}

/**
 * A structurally valid `grill_me` report body. `grill_me` on purpose:
 * `validatePersistedReport` short-circuits to `ok` for any other mode,
 * so a `fast_confirm` fixture would not exercise the validation the auto
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
    currentUnderstanding: "the Codex auto path under test",
    priorArt: ["searched the repo for an existing Codex auto path; slice 1 is Claude-only"],
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
  /** Shell command, wired into the payload under `commandField`. */
  command?: string;
  /** Which wire shape carries the command: real Codex sends `tool_input`. */
  commandField?: "tool_input" | "raw_input";
  /** `null` omits the field entirely. */
  sessionIdInPayload?: string | null;
  /**
   * `null` omits the field entirely; `""` sends the empty literal. Typed
   * `unknown` so the non-string controls can send an array/object/number
   * the way a malformed or hostile payload would.
   */
  permissionMode?: unknown;
  /**
   * `null` omits the field entirely; defaults to the matching transcript
   * file. `unknown` for the same reason as `permissionMode`.
   */
  transcriptPath?: unknown;
  /** Extra top-level payload fields (e.g. a Claude-shaped `tool_use_id`). */
  extraPayload?: Record<string, unknown>;
  /**
   * Inject the ledger writer (default). `false` leaves the hook to
   * resolve one from the manifest, which carries no `grounding-mcp`
   * server — the audit-only `write: null` branch.
   */
  injectLedger?: boolean;
}

function buildPayload(opts: CallOptions): Record<string, unknown> {
  const transcript = opts.transcriptPath === undefined ? transcriptPath : opts.transcriptPath;
  return {
    tool_name: opts.toolName ?? "apply_patch",
    ...(opts.sessionIdInPayload === null ? {} : { session_id: opts.sessionIdInPayload ?? SESSION }),
    ...(opts.permissionMode === null
      ? {}
      : { permission_mode: opts.permissionMode ?? "bypassPermissions" }),
    ...(transcript === null ? {} : { transcript_path: transcript }),
    ...(opts.command !== undefined
      ? { [opts.commandField ?? "tool_input"]: { command: opts.command } }
      : {}),
    ...(opts.extraPayload ?? {}),
  };
}

/** One gated Codex PreToolUse call through the real CLI entry point. */
async function call(opts: CallOptions = {}): Promise<{
  blocked: boolean;
  exitCode: number;
  source: string;
  stderr: string;
}> {
  const stderr = bufferStream();
  const result = await runPackHookCodexPreToolUseCli({
    manifest: opts.manifest ?? manifestWithAutoApprove(),
    stdin: readableFromString(JSON.stringify(buildPayload(opts))),
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
    exitCode: result.exitCode,
    source: result.approvalCheck.source,
    stderr: stderr.read(),
  };
}

describe("pack hook codex-pre-tool-use — auto-approval path (ADR slice 2)", () => {
  describe("acceptance criteria", () => {
    it("H1 — opt-in + allowlisted permission_mode + a matching transcript file + a newest strict-session pending report + key present auto-approves the SAME call, stamping the codex harness", async () => {
      getOrCreateSigningKey(generatedDir);
      const report = writePendingReport();

      const result = await call();

      expect(result.blocked).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.source).toBe("marker");
      expect(result.stderr).toMatch(
        /auto-approved via session marker by auto-mode:codex:bypassPermissions/,
      );
      // The allow is reported through the hook's ordinary allow shape.
      expect(result.stderr).toMatch(/harness pack hook codex: .*, allowing\./);

      // A real signed marker, verified by the same check a human one goes
      // through, carrying the CODEX harness segment.
      const check = checkApprovalMarker(generatedDir, SESSION);
      expect(check.matched).toBe(true);
      expect(check.forged).toBe(false);
      expect(check.marker?.approvedBy).toBe("auto-mode:codex:bypassPermissions");
      expect(check.marker?.reportContentHash).toBe(report.sha256);

      // The report was consumed in the same pass.
      const after = readReport(report.filePath);
      expect(after["approvalStatus"]).toBe("approved");
      expect(after["approvedBy"]).toBe("auto-mode:codex:bypassPermissions");
      expect(typeof after["approvedAt"]).toBe("string");

      // Audit-only ledger fact, distinct from the human tag.
      expect(ledgerCalls).toHaveLength(1);
      expect(ledgerCalls[0]?.content).toBe(`understanding-auto-approved:${SESSION}`);
      expect(ledgerCalls[0]?.sessionId).toBe(SESSION);

      // Session marker only: no task marker is ever written on the auto path.
      const approvalsDir = path.join(generatedDir, ".approvals");
      expect(fs.readdirSync(approvalsDir).filter((n) => n.startsWith("task-"))).toEqual([]);

      // No stale staging entry: the auto attempt runs BEFORE the
      // `.pending-approval` write, so an arg-less `harness approve
      // understanding` cannot later resolve to this auto-approved id.
      expect(readPendingApproval(generatedDir)).toBeNull();
    });

    it("H2 — a second gated call allows via the ordinary marker check, consuming nothing further", async () => {
      getOrCreateSigningKey(generatedDir);
      const report = writePendingReport();

      expect((await call()).blocked).toBe(false);
      const afterFirst = readReport(report.filePath);
      const markerAfterFirst = fs.readFileSync(
        approvalMarkerPathFor(generatedDir, SESSION),
        "utf8",
      );
      ledgerCalls = [];

      const second = await call();

      expect(second.blocked).toBe(false);
      expect(second.source).toBe("marker");
      expect(second.stderr).not.toMatch(/auto-approved via session marker/);
      expect(ledgerCalls).toEqual([]);
      expect(readReport(report.filePath)).toEqual(afterFirst);
      expect(fs.readFileSync(approvalMarkerPathFor(generatedDir, SESSION), "utf8")).toBe(
        markerAfterFirst,
      );
    });
  });

  describe("negative controls — the slice 1 list, re-run through the Codex hook", () => {
    it.each([
      ["absent", null],
      ["the empty string", ""],
      ["default", "default"],
      ["acceptEdits", "acceptEdits"],
      ["plan", "plan"],
      ["dontAsk", "dontAsk"],
      ["an unknown literal", "definitelyNotAMode"],
    ])("N1 — permission_mode %s with the opt-in present: block", async (_label, mode) => {
      getOrCreateSigningKey(generatedDir);
      const report = writePendingReport();

      const result = await call({ permissionMode: mode });

      expect(result.blocked).toBe(true);
      expect(result.exitCode).toBe(2);
      expect(markerExists()).toBe(false);
      expect(ledgerCalls).toEqual([]);
      expect(readReport(report.filePath)["approvalStatus"]).toBe("pending");
    });

    it("N2(a) — opt-in absent entirely: block", async () => {
      getOrCreateSigningKey(generatedDir);
      const report = writePendingReport();

      const result = await call({ manifest: manifestWithoutAutoApprove() });

      expect(result.blocked).toBe(true);
      expect(markerExists()).toBe(false);
      expect(readReport(report.filePath)["approvalStatus"]).toBe("pending");
    });

    it("N2(b) — `when` does not contain the payload's permission_mode: block", async () => {
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

    it("N3 — no report at all: block, no marker", async () => {
      getOrCreateSigningKey(generatedDir);

      const result = await call();

      expect(result.blocked).toBe(true);
      expect(result.stderr).toMatch(/auto-approval declined: no persisted report bound to session/);
      expect(markerExists()).toBe(false);
      expect(ledgerCalls).toEqual([]);
    });

    it("N4(a) — a report bound to a DIFFERENT non-null session id is not adopted: block", async () => {
      getOrCreateSigningKey(generatedDir);
      const other = writePendingReport("some-other-session");

      const result = await call();

      expect(result.blocked).toBe(true);
      expect(markerExists()).toBe(false);
      expect(readReport(other.filePath)["approvalStatus"]).toBe("pending");
    });

    it("N4(b) — a sessionId-NULL report is not adopted by the tolerant fallback: block", async () => {
      // The sessionId-null shape is the ONLY one the tolerant fallback
      // adopts, so it is what discriminates a swap of
      // `selectNewestStrictSessionReport` for `selectReportForSession`.
      getOrCreateSigningKey(generatedDir);
      const anon = writePendingReport(null);

      const result = await call();

      expect(result.blocked).toBe(true);
      expect(markerExists()).toBe(false);
      expect(readReport(anon.filePath)["approvalStatus"]).toBe("pending");
    });

    it.each([["approved"], ["expired"]])(
      "N5 — the newest report for this session is already %s, with an OLDER pending report on disk: block",
      async (status) => {
        // Eligibility is evaluated on the NEWEST strict-session report
        // only; an older pending report further down the list is never
        // scanned for.
        getOrCreateSigningKey(generatedDir);
        const older = writeReportFile(
          "2026-08-27T09-00-00-000Z-older-dddd4444.json",
          reportBody(SESSION, "pending", "2026-08-27T09:00:00.000Z"),
        );
        const newest = writeReportFile(
          "2026-08-27T10-00-00-000Z-newest-cccc3333.json",
          reportBody(SESSION, status, "2026-08-27T10:00:00.000Z"),
        );

        const result = await call();

        expect(result.blocked).toBe(true);
        expect(result.stderr).toMatch(
          new RegExp(`auto-approval declined: newest report .* is approvalStatus=${status}`),
        );
        expect(markerExists()).toBe(false);
        expect(readReport(newest.filePath)["approvalStatus"]).toBe(status);
        expect(readReport(older.filePath)["approvalStatus"]).toBe("pending");
      },
    );

    it("N6 — signing key absent: no key is created, no marker, block", async () => {
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

    it("N7 — a forged marker plus a valid pending report and the opt-in does not launder the forgery", async () => {
      // Key present on purpose: without it the decline could be
      // attributed to the key precheck and the markerForged guard would
      // not discriminate.
      getOrCreateSigningKey(generatedDir);
      const report = writePendingReport();
      fs.mkdirSync(path.join(generatedDir, ".approvals"), { recursive: true });
      const markerPath = approvalMarkerPathFor(generatedDir, SESSION);
      const forgedBody = `${JSON.stringify(
        { approvedAt: new Date().toISOString(), approvedBy: "operator", reportContentHash: null },
        null,
        2,
      )}\n`;
      fs.writeFileSync(markerPath, forgedBody);

      const result = await call();

      expect(result.blocked).toBe(true);
      expect(result.stderr).toMatch(/forged\/unsigned marker rejected/);
      expect(result.stderr).toMatch(/auto-approval declined: forged\/unsigned marker present/);
      // The forged file is byte-identical afterwards: no auto-marker was
      // written over it.
      expect(fs.readFileSync(markerPath, "utf8")).toBe(forgedBody);
      expect(readReport(report.filePath)["approvalStatus"]).toBe("pending");
      expect(ledgerCalls).toEqual([]);
    });

    it("N8 — after a task-boundary clear, the same report yields no second auto-marker", async () => {
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

    it("N9 — after max_age, the same report yields no second auto-marker; markerExpired stays true so the recovery `git commit` is still allowed", async () => {
      getOrCreateSigningKey(generatedDir);
      const report = writePendingReport();
      const manifest = manifestWithAutoApprove({ approval_lifecycle: { max_age: "4h" } });
      expect((await call({ manifest })).blocked).toBe(false);

      // The marker check takes no injected clock, so elapsed time is
      // simulated the way the slice 1 suite does it: re-sign the marker
      // with a backdated `approvedAt`, keeping the auto path's own
      // approvedBy and reportContentHash.
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
      const afterSecond = checkApprovalMarker(generatedDir, SESSION, {
        maxAgeMs: 4 * 60 * 60 * 1000,
      });
      expect(afterSecond.matched).toBe(false);
      expect(afterSecond.expired).toBe(true);
      expect(afterSecond.marker?.approvedBy).toBe("auto-mode:codex:bypassPermissions");
      expect(readReport(report.filePath)["approvalStatus"]).toBe("approved");

      // markerExpired is still true, so the recovery-commit exemption fires.
      const recovery = await call({
        manifest,
        toolName: "shell",
        command: 'git commit -m "chore: consolidate approved work"',
      });
      expect(recovery.blocked).toBe(false);
      expect(recovery.source).toBe("recovery-commit");
    });

    it("N10 — a second pending report re-arms the auto path, by design", async () => {
      getOrCreateSigningKey(generatedDir);
      const first = writePendingReport();
      expect((await call()).blocked).toBe(false);
      expect(checkApprovalMarker(generatedDir, SESSION).marker?.reportContentHash).toBe(
        first.sha256,
      );

      clearApprovalMarker(generatedDir, SESSION);
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
  });

  describe("negative controls — a call the gate was already going to open mints nothing", () => {
    it.each([["tool_input"], ["raw_input"]] as const)(
      "N11 — a read-only `ls` in the %s shape mints nothing and leaves the report pending",
      async (field) => {
        getOrCreateSigningKey(generatedDir);
        const report = writePendingReport();

        const result = await call({ toolName: "shell", command: "ls", commandField: field });

        expect(result.blocked).toBe(false);
        expect(result.source).toBe("none");
        expect(result.stderr).toMatch(/read-only Bash command, allowing/);
        expect(markerExists()).toBe(false);
        expect(ledgerCalls).toEqual([]);
        expect(readReport(report.filePath)["approvalStatus"]).toBe("pending");
      },
    );

    it.each([["tool_input"], ["raw_input"]] as const)(
      "N12 — a read-only `ls` in the %s shape is allowed with no report on disk at all",
      async (field) => {
        // Discriminates the "read `raw_input` only" mutation independently
        // of the auto path: with no report there is nothing to mint from,
        // so the ONLY thing standing between this call and a block is the
        // exemption seeing the command in the field the payload used.
        const result = await call({ toolName: "shell", command: "ls", commandField: field });

        expect(result.blocked).toBe(false);
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toMatch(
          /read-only Bash command, allowing without an approved report \(`ls`\)/,
        );
        expect(markerExists()).toBe(false);
      },
    );

    it.each([["tool_input"], ["raw_input"]] as const)(
      "N13 — a bare recovery `git commit` on an expired marker in the %s shape mints nothing",
      async (field) => {
        const report = writePendingReport();
        // A real (human) approval that aged out 24h ago; max_age is 4h.
        writeApprovalMarker(generatedDir, SESSION, {
          approvedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
          approvedBy: "test-operator",
        });

        const result = await call({
          manifest: manifestWithAutoApprove({ approval_lifecycle: { max_age: "4h" } }),
          toolName: "shell",
          command: 'git commit -m "chore: consolidate"',
          commandField: field,
        });

        expect(result.blocked).toBe(false);
        expect(result.source).toBe("recovery-commit");
        expect(ledgerCalls).toEqual([]);
        expect(readMarkerRaw()["approvedBy"]).toBe("test-operator");
        expect(readReport(report.filePath)["approvalStatus"]).toBe("pending");
      },
    );

    it("N14 — a call the existing marker check already allows writes no auto-marker", async () => {
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

  describe("negative controls — the Codex session-consistency check", () => {
    it("N15 — transcript_path absent: no marker, block", async () => {
      getOrCreateSigningKey(generatedDir);
      const report = writePendingReport();

      const result = await call({ transcriptPath: null });

      expect(result.blocked).toBe(true);
      expect(result.stderr).toMatch(
        /auto-approval declined: event payload carries no transcript_path/,
      );
      expect(markerExists()).toBe(false);
      expect(readReport(report.filePath)["approvalStatus"]).toBe("pending");
    });

    it("N16 — transcript_path basename carries a different session id: no marker, block", async () => {
      // The file EXISTS on purpose, so the existence check cannot be what
      // declines: the basename comparison is the only thing left standing
      // between this call and a marker.
      getOrCreateSigningKey(generatedDir);
      const report = writePendingReport();
      const foreign = writeTranscriptFile("some-other-session");
      expect(fs.existsSync(foreign)).toBe(true);

      const result = await call({ transcriptPath: foreign });

      expect(result.blocked).toBe(true);
      expect(result.stderr).toMatch(
        new RegExp(`auto-approval declined: transcript_path does not name session ${SESSION}`),
      );
      expect(markerExists()).toBe(false);
      expect(readReport(report.filePath)["approvalStatus"]).toBe("pending");
    });

    it("N17 — transcript_path names a file that does not exist: no marker, block", async () => {
      getOrCreateSigningKey(generatedDir);
      const report = writePendingReport();
      // Correctly named for THIS session (so the basename comparison
      // passes and cannot be what declines) but absent from disk.
      const absent = path.join(sessionsDir, `rollout-2026-08-26T00-00-00-${SESSION}.jsonl`);
      expect(fs.existsSync(absent)).toBe(false);

      const result = await call({ transcriptPath: absent });

      expect(result.blocked).toBe(true);
      expect(result.stderr).toMatch(
        /auto-approval declined: transcript_path does not name an existing file/,
      );
      expect(markerExists()).toBe(false);
      expect(readReport(report.filePath)["approvalStatus"]).toBe("pending");
    });
  });

  describe("negative controls — cross-runtime payloads", () => {
    it("N18 — a Claude-shaped payload piped to the Codex hook yields no marker", async () => {
      // Claude Code's payload carries no `transcript_path` field for the
      // Codex check to hold the session id against (it carries the id in
      // the hook ENVIRONMENT instead), and a `tool_use_id` of the
      // `toolu_...` shape rather than Codex's `exec_...`.
      getOrCreateSigningKey(generatedDir);
      const report = writePendingReport();

      const result = await call({
        toolName: "Edit",
        transcriptPath: null,
        extraPayload: { tool_use_id: "toolu_01AbCdEfGhIjKlMnOpQrStUv" },
      });

      expect(result.blocked).toBe(true);
      expect(result.stderr).toMatch(
        /auto-approval declined: event payload carries no transcript_path/,
      );
      expect(markerExists()).toBe(false);
      expect(ledgerCalls).toEqual([]);
      expect(readReport(report.filePath)["approvalStatus"]).toBe("pending");
    });

    it("N19 — a Codex-shaped payload piped to the CLAUDE hook with $CLAUDE_CODE_SESSION_ID unset yields no marker", async () => {
      // The mirror control: Codex's own `transcript_path` is no substitute
      // for the env variable the Claude hook's consistency check reads,
      // and that variable is deleted in beforeEach.
      getOrCreateSigningKey(generatedDir);
      const report = writePendingReport();
      const stdout = bufferStream();
      const stderr = bufferStream();

      const result = await runPackHookPreToolUseCli({
        manifest: manifestWithAutoApprove(),
        stdin: readableFromString(
          JSON.stringify({
            session_id: SESSION,
            tool_name: "apply_patch",
            permission_mode: "bypassPermissions",
            transcript_path: transcriptPath,
            tool_use_id: "exec-9c1f0d2e-0000-4000-8000-000000000000",
          }),
        ),
        stdout: stdout.stream,
        stderr: stderr.stream,
        reportsDir,
        generatedDir,
        ledgerQuery: async (): Promise<LedgerEntry[]> => [],
        writeLedger: async (args: LedgerWriteArgs): Promise<{ ok: true }> => {
          ledgerCalls.push(args);
          return { ok: true };
        },
      });

      expect(result.blocked).toBe(true);
      expect(stderr.read()).toMatch(
        /auto-approval declined: \$CLAUDE_CODE_SESSION_ID is not set/,
      );
      expect(markerExists()).toBe(false);
      expect(ledgerCalls).toEqual([]);
      expect(readReport(report.filePath)["approvalStatus"]).toBe("pending");
    });
  });

  // One body, two call sites, but NOT one opt-in: `auto_approve.harnesses`
  // is what keeps a Claude-only opt-in from silently covering every Codex
  // session once the Codex hook started calling the same path (review
  // round 1, HIGH). Every fixture below is otherwise complete — key,
  // pending report, allowlisted mode, matching transcript — so the
  // harness allowlist is the only thing that can decide the outcome.
  describe("negative controls — the per-harness opt-in (auto_approve.harnesses)", () => {
    it("N20 — an opt-in with NO harnesses key (the pre-Codex shape) does not cover Codex: block, no marker", async () => {
      getOrCreateSigningKey(generatedDir);
      const report = writePendingReport();

      const result = await call({ manifest: manifestWithHarnesses() });

      expect(result.blocked).toBe(true);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(
        'harness pack hook codex: auto-approval declined: harness "codex" is not listed in auto_approve.harnesses',
      );
      expect(markerExists()).toBe(false);
      expect(ledgerCalls).toEqual([]);
      expect(readReport(report.filePath)["approvalStatus"]).toBe("pending");
    });

    it("N21 — harnesses: [claude-code] explicitly: block, no marker", async () => {
      getOrCreateSigningKey(generatedDir);
      const report = writePendingReport();

      const result = await call({ manifest: manifestWithHarnesses(["claude-code"]) });

      expect(result.blocked).toBe(true);
      expect(result.stderr).toMatch(
        /auto-approval declined: harness "codex" is not listed in auto_approve\.harnesses/,
      );
      expect(markerExists()).toBe(false);
      expect(readReport(report.filePath)["approvalStatus"]).toBe("pending");
    });

    it("N22 — harnesses: [codex] alone does auto-approve on Codex (the fixture is otherwise complete)", async () => {
      // Positive control for N20/N21: without it, a fixture broken for
      // some unrelated reason would produce the same block and the two
      // controls above would pass for the wrong reason.
      getOrCreateSigningKey(generatedDir);
      const report = writePendingReport();

      const result = await call({ manifest: manifestWithHarnesses(["codex"]) });

      expect(result.blocked).toBe(false);
      expect(result.source).toBe("marker");
      expect(checkApprovalMarker(generatedDir, SESSION).marker?.approvedBy).toBe(
        "auto-mode:codex:bypassPermissions",
      );
      expect(readReport(report.filePath)["approvalStatus"]).toBe("approved");
    });

    it("N23 — harnesses: [codex] only does not cover CLAUDE CODE either: the Claude hook blocks with its own stderr prefix", async () => {
      // The mirror of N20/N21, and the reason the check lives in the
      // shared body rather than in the Codex hook: the allowlist gates
      // whichever runtime is calling.
      getOrCreateSigningKey(generatedDir);
      const report = writePendingReport();
      process.env.CLAUDE_CODE_SESSION_ID = SESSION;

      const claudeCall = async (manifest: Manifest) => {
        const stdout = bufferStream();
        const stderr = bufferStream();
        const result = await runPackHookPreToolUseCli({
          manifest,
          stdin: readableFromString(
            JSON.stringify({
              session_id: SESSION,
              tool_name: "Edit",
              permission_mode: "bypassPermissions",
            }),
          ),
          stdout: stdout.stream,
          stderr: stderr.stream,
          reportsDir,
          generatedDir,
          ledgerQuery: async (): Promise<LedgerEntry[]> => [],
          writeLedger: async (args: LedgerWriteArgs): Promise<{ ok: true }> => {
            ledgerCalls.push(args);
            return { ok: true };
          },
        });
        return { blocked: result.blocked, stderr: stderr.read() };
      };

      const blockedRun = await claudeCall(manifestWithHarnesses(["codex"]));

      expect(blockedRun.blocked).toBe(true);
      expect(blockedRun.stderr).toContain(
        'harness pack hook: auto-approval declined: harness "claude-code" is not listed in auto_approve.harnesses',
      );
      expect(markerExists()).toBe(false);
      expect(ledgerCalls).toEqual([]);
      expect(readReport(report.filePath)["approvalStatus"]).toBe("pending");

      // Sanity: the SAME fixture with claude-code listed auto-approves,
      // so the block above is the allowlist's doing.
      const allowedRun = await claudeCall(manifestWithHarnesses(["claude-code"]));
      expect(allowedRun.blocked).toBe(false);
      expect(checkApprovalMarker(generatedDir, SESSION).marker?.approvedBy).toBe(
        "auto-mode:claude-code:bypassPermissions",
      );
    });

    it("N24 — a malformed auto_approve block is still fail-closed, and says so with the Codex prefix", async () => {
      // `parseManifest` accepts `config` as a free record, so the runtime
      // parser is the only defence here; the label it is called with is
      // what makes the line readable next to the hook's other output.
      getOrCreateSigningKey(generatedDir);
      const report = writePendingReport();
      const manifest = parseManifest({
        version: 1,
        policy_packs: [
          {
            name: "understanding-before-execution",
            enabled: true,
            config: {
              auto_approve: {
                when: ["bypassPermissions"],
                harnesses: ["codex"],
                // require_report missing: the whole block is ignored.
              },
            },
          },
        ],
      });

      const result = await call({ manifest });

      expect(result.blocked).toBe(true);
      expect(result.stderr).toContain(
        "harness pack hook codex: config.auto_approve ignored (require_report must be true",
      );
      expect(markerExists()).toBe(false);
      expect(readReport(report.filePath)["approvalStatus"]).toBe("pending");
    });
  });

  // Which command the two EXEMPTIONS act on. `resolveToolInput`'s
  // `!== undefined` precedence is right for the PostToolUse observers
  // that share it, but at a gate it fails open in two shapes (review
  // round 1, MEDIUM), so the Codex hook resolves its own.
  describe("negative controls — the exemption's view of tool_input / raw_input", () => {
    it("N25 — tool_input and raw_input naming DIFFERENT commands is not exempted on the harmless one", async () => {
      // No signing key on purpose: with one, the auto path would open
      // this call anyway and "blocked" would stop discriminating. So the
      // exemption is the only thing that could allow it.
      const report = writePendingReport();
      expect(fs.existsSync(signingKeyPathFor(generatedDir))).toBe(false);

      const result = await call({
        toolName: "shell",
        extraPayload: {
          tool_input: { command: "ls" },
          raw_input: { command: "rm -rf /tmp/x" },
        },
      });

      expect(result.blocked).toBe(true);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).not.toMatch(/read-only Bash command, allowing/);
      expect(markerExists()).toBe(false);
      expect(ledgerCalls).toEqual([]);
      expect(readReport(report.filePath)["approvalStatus"]).toBe("pending");
    });

    it("N26 — the same fixture with the two fields AGREEING is exempted (so N25 is the disagreement's doing)", async () => {
      writePendingReport();

      const result = await call({
        toolName: "shell",
        extraPayload: {
          tool_input: { command: "ls" },
          raw_input: { command: "ls" },
        },
      });

      expect(result.blocked).toBe(false);
      expect(result.stderr).toMatch(/read-only Bash command, allowing/);
    });

    it("N27 — a null tool_input does not shadow a read-only raw_input: exempted, and nothing is minted", async () => {
      // Key + pending report present on purpose: if the exemption did
      // NOT see the command, this call would reach the auto path and
      // mint, so "no marker" is what discriminates.
      getOrCreateSigningKey(generatedDir);
      const report = writePendingReport();

      const result = await call({
        toolName: "shell",
        extraPayload: { tool_input: null, raw_input: { command: "ls" } },
      });

      expect(result.blocked).toBe(false);
      expect(result.source).toBe("none");
      expect(result.stderr).toMatch(
        /read-only Bash command, allowing without an approved report \(`ls`\)/,
      );
      expect(markerExists()).toBe(false);
      expect(ledgerCalls).toEqual([]);
      expect(readReport(report.filePath)["approvalStatus"]).toBe("pending");
    });
  });

  describe("negative controls — malformed payload fields never throw into an allow", () => {
    it("N28 — a session id resolvable only from $CODEX_SESSION_ID, with no payload session_id: block, no marker", async () => {
      // The auto path compares the PAYLOAD's own session_id against the
      // transcript file, never the env-resolved fallback the rest of the
      // hook runs on — otherwise the env variant would compare the
      // environment with itself.
      getOrCreateSigningKey(generatedDir);
      const report = writePendingReport();
      process.env.CODEX_SESSION_ID = SESSION;

      const result = await call({ sessionIdInPayload: null });

      expect(result.blocked).toBe(true);
      expect(result.stderr).toMatch(
        /auto-approval declined: event payload carries no session_id/,
      );
      expect(markerExists()).toBe(false);
      expect(ledgerCalls).toEqual([]);
      expect(readReport(report.filePath)["approvalStatus"]).toBe("pending");
    });

    it.each([
      ["an array", ["bypassPermissions"]],
      ["an object", { mode: "bypassPermissions" }],
      ["a number", 1],
      ["true", true],
    ])("N29 — a non-string permission_mode (%s): block, no marker, no throw", async (_l, mode) => {
      getOrCreateSigningKey(generatedDir);
      const report = writePendingReport();

      const result = await call({ permissionMode: mode });

      expect(result.blocked).toBe(true);
      expect(result.exitCode).toBe(2);
      expect(markerExists()).toBe(false);
      expect(ledgerCalls).toEqual([]);
      expect(readReport(report.filePath)["approvalStatus"]).toBe("pending");
    });

    it.each([
      ["a number", 42],
      ["an object", { path: "/tmp/rollout.jsonl" }],
      ["an array", ["/tmp/rollout.jsonl"]],
    ])("N30 — a non-string transcript_path (%s): block, no marker, no throw", async (_l, value) => {
      getOrCreateSigningKey(generatedDir);
      const report = writePendingReport();

      const result = await call({ transcriptPath: value });

      expect(result.blocked).toBe(true);
      expect(result.stderr).toMatch(
        /auto-approval declined: event payload carries no transcript_path/,
      );
      expect(markerExists()).toBe(false);
      expect(readReport(report.filePath)["approvalStatus"]).toBe("pending");
    });

    it("N31 — a DIRECTORY named like the transcript file is not a transcript: block, no marker", async () => {
      // `existsSync` cannot tell the two apart, so a session that can
      // create a directory could satisfy the consistency check without
      // ever naming a real rollout file. Still a consistency check and
      // not a boundary (see SessionConsistencyCheck) — but a check that
      // holds against what it says it holds against.
      getOrCreateSigningKey(generatedDir);
      const report = writePendingReport();
      const dirPath = path.join(sessionsDir, `${SESSION}.jsonl`);
      fs.mkdirSync(dirPath, { recursive: true });
      expect(fs.existsSync(dirPath)).toBe(true);
      expect(fs.statSync(dirPath).isDirectory()).toBe(true);

      const result = await call({ transcriptPath: dirPath });

      expect(result.blocked).toBe(true);
      expect(result.stderr).toMatch(
        /auto-approval declined: transcript_path does not name an existing file/,
      );
      expect(markerExists()).toBe(false);
      expect(ledgerCalls).toEqual([]);
      expect(readReport(report.filePath)["approvalStatus"]).toBe("pending");
    });

    it("N32 — a bare `<sid>.jsonl` FILE in the same place is accepted, so N31 is the directory's doing", async () => {
      getOrCreateSigningKey(generatedDir);
      writePendingReport();
      const filePath = path.join(sessionsDir, `${SESSION}.jsonl`);
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.writeFileSync(filePath, "");

      const result = await call({ transcriptPath: filePath });

      expect(result.blocked).toBe(false);
      expect(result.source).toBe("marker");
      expect(markerExists()).toBe(true);
    });
  });

  describe("audit trail", () => {
    it("A1 — the ledger fact names the CODEX hook as its source, not the Claude verb", async () => {
      getOrCreateSigningKey(generatedDir);
      writePendingReport();

      expect((await call()).blocked).toBe(false);

      expect(ledgerCalls).toHaveLength(1);
      expect(ledgerCalls[0]?.source).toBe("harness-pack-hook-codex-pre-tool-use");
    });

    it("A2 — with no ledger writer resolvable at all, the auto-approval still allows and says the fact was not recorded", async () => {
      // `injectLedger: false` leaves the hook to resolve a writer from
      // the manifest, which declares no `grounding-mcp` server: the
      // `write: null` branch. The ledger is audit-only and never a gate
      // input, so this must cost one stderr line and nothing else.
      getOrCreateSigningKey(generatedDir);
      const report = writePendingReport();

      const result = await call({ injectLedger: false });

      expect(result.blocked).toBe(false);
      expect(result.source).toBe("marker");
      expect(result.stderr).toMatch(
        new RegExp(
          `auto-approval ledger fact understanding-auto-approved:${SESSION} not recorded \\(grounding-mcp not declared in manifest\\); audit only, continuing`,
        ),
      );
      expect(ledgerCalls).toEqual([]);
      expect(checkApprovalMarker(generatedDir, SESSION).matched).toBe(true);
      expect(readReport(report.filePath)["approvalStatus"]).toBe("approved");
    });

    it("A3 — a marker MINTED by this hook shows up under `codex` in the doctor auto-approval listing", async () => {
      // The ADR's slice 2 doctor probe, end to end: the marker is not
      // hand-written here, it is whatever the Codex hook actually mints,
      // so the listing is read against the real `approvedBy` shape.
      getOrCreateSigningKey(generatedDir);
      writePendingReport();

      expect((await call()).blocked).toBe(false);

      const listing = buildUgAutoApprovals(generatedDir, { recentSessions: 20 });
      expect(listing.approvalsDirPresent).toBe(true);
      expect(listing.byHarness["codex"]).toBeGreaterThanOrEqual(1);
      expect(listing.byMode["bypassPermissions"]).toBeGreaterThanOrEqual(1);
      expect(listing.entries).toContainEqual(
        expect.objectContaining({ sessionId: SESSION, harness: "codex" }),
      );
    });
  });
});
