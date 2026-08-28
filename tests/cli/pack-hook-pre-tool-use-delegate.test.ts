// Slice 3 of docs/decisions/2026-08-27-ug-auto-mode-approval.md
// (agent-tasks 37ad0b05): the child's PreToolUse hook under a parent's
// delegation. The ADR's two-key design in one sentence: the delegation is
// key ONE (the trusted signal plus the parent linkage) and the child's own
// Understanding Report is key TWO, and only both together mint the child's
// auto-marker.
//
// Every fixture here is deliberately arranged so that the DELEGATION is
// the only thing that can supply key one: the payload's
// `permission_mode` is `default`, which is NOT in `auto_approve.when`. A
// test that allowed here without a valid delegation would be allowing on
// the slice-1 path, and every negative control below would be vacuous.
//
// The transcript scan is a bounded poll, so an injected clock and sleep
// drive it; no test in this file waits for real time.
//
// Helper shapes (`readableFromString`, `bufferStream`) are deliberate
// copies of pack-hook-pre-tool-use-auto-approve.test.ts's, so the two
// suites read the same way.

import { Readable, Writable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DELEGATION_REPORT_RETRY_INSTRUCTION,
  runPackHookPreToolUseCli,
} from "../../src/cli/pack/hook-pre-tool-use.js";
import type { LedgerEntry } from "../../src/policies/index.js";
import {
  approvalMarkerPathFor,
  checkApprovalMarker,
  listPersistedReports,
  parseAutoApprovedBy,
  writeActiveClaim,
  writeApprovalMarker,
} from "../../src/policy-packs/builtin/understanding-before-execution-runtime.js";
import {
  delegationMarkerPathFor,
  hashDelegationCwd,
  writeDelegationMarker,
} from "../../src/policy-packs/builtin/understanding-before-execution/delegation-markers.js";
import {
  getOrCreateSigningKey,
  signingKeyPathFor,
} from "../../src/runtime/approval-signing.js";
import type { LedgerWriteArgs } from "../../src/runtime/ledger-writer.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

const CHILD = "child-4444-5555";
const PARENT = "parent-1111-2222";
const MODE_ENV = "UNDERSTANDING_GATE_MODE";

let tmp: string;
let generatedDir: string;
let reportsDir: string;
let childCwd: string;
let transcriptPath: string;
let ledgerCalls: LedgerWriteArgs[];
let savedClaude: string | undefined;
let savedClaudeCode: string | undefined;
let savedMode: string | undefined;

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
  return { stream, read: (): string => buf };
}

/**
 * A full grill_me-shaped Understanding Report under a level-ONE heading:
 * `# Understanding Report` is exactly what the scan's heading regex looks
 * for and what the deny instruction asks the child to emit. grill_me on
 * purpose: `validatePersistedReport` (which the auto path reuses from the
 * approve CLI) short-circuits to `ok` for a fast_confirm report, so a
 * lighter fixture would not exercise the validation at all.
 */
const CHILD_REPORT_MARKDOWN = [
  "# Understanding Report",
  "",
  "**Metadata**",
  "",
  "taskId: t-37ad0b05",
  "mode: grill_me",
  "riskLevel: low",
  "",
  "**Current Understanding**",
  "",
  "The parent delegated this child session and the child must state its own understanding.",
  "",
  "**Intended Outcome**",
  "",
  "The child auto-approves through the delegation plus its own report, never the delegation alone.",
  "",
  "**Derived Todos**",
  "",
  "- capture the report from the session transcript",
  "",
  "**Acceptance Criteria**",
  "",
  "- the minted marker carries the parent linkage",
  "",
  "**Assumptions**",
  "",
  "- the transcript read is the file the payload names",
  "",
  "**Open Questions**",
  "",
  "- none",
  "",
  "**Out Of Scope**",
  "",
  "- the delegate verb itself",
  "",
  "**Risks**",
  "",
  "- the transcript write races the hook",
  "",
  "**Verification Plan**",
  "",
  "- vitest over the real hook entry point",
  "",
  "**Prior Art**",
  "",
  "- searched harness for an existing same-turn capture path; the approve stdin persister is reused",
].join("\n");

/** One transcript JSONL entry in the shape Claude Code writes. */
function transcriptEntry(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "assistant",
    sessionId: CHILD,
    isSidechain: false,
    uuid: "uuid-report",
    timestamp: "2026-08-28T09:00:00.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: CHILD_REPORT_MARKDOWN }],
    },
    ...over,
  });
}

/** The prompt turn every transcript starts with; carries no report. */
function userTurn(): string {
  return JSON.stringify({
    type: "user",
    sessionId: CHILD,
    isSidechain: false,
    uuid: "uuid-prompt",
    message: { role: "user", content: "do the task" },
  });
}

function writeTranscript(lines: string[]): void {
  fs.writeFileSync(transcriptPath, `${lines.join("\n")}\n`);
}

interface FakeClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  sleeps: number[];
}

/** Injected clock: the scan's poll advances it, so no test sleeps for real. */
function fakeClock(): FakeClock {
  let t = 2_000_000;
  const clock: FakeClock = {
    now: (): number => t,
    sleep: (ms: number): Promise<void> => {
      clock.sleeps.push(ms);
      t += ms;
      return Promise.resolve();
    },
    sleeps: [],
  };
  return clock;
}

/**
 * The opt-in manifest. `when: [bypassPermissions]` while every payload
 * below carries `permission_mode: "default"`, so the `when` allowlist can
 * never be what opens the gate here.
 */
function manifestWithAutoApprove(
  autoApproveExtra: Record<string, unknown> = {},
  configExtra: Record<string, unknown> = {},
): Manifest {
  return parseManifest({
    version: 1,
    policy_packs: [
      {
        name: "understanding-before-execution",
        enabled: true,
        config: {
          ...configExtra,
          auto_approve: {
            when: ["bypassPermissions"],
            harnesses: ["claude-code"],
            require_report: true,
            ...autoApproveExtra,
          },
        },
      },
    ],
  });
}

/** Issue (or re-issue) the child's delegation. Asserts the write itself succeeded. */
function issueDelegation(
  over: { cwdHash?: string | null; taskId?: string | null; expiresAt?: string } = {},
): void {
  const result = writeDelegationMarker({
    generatedDir,
    childSessionId: CHILD,
    parentSessionId: PARENT,
    cwdHash: over.cwdHash === undefined ? hashDelegationCwd(childCwd) : over.cwdHash,
    taskId: over.taskId ?? null,
    expiresAt: over.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  expect(result.ok).toBe(true);
}

function removeDelegation(): void {
  fs.rmSync(delegationMarkerPathFor(generatedDir, CHILD), { force: true });
}

function markerExists(): boolean {
  return fs.existsSync(approvalMarkerPathFor(generatedDir, CHILD));
}

/**
 * The once-per-session adoption ledger. A SIBLING of `.delegations/`
 * itself (`<generatedDir>/.delegation-adoptions/<sid>`), never a
 * subdirectory of it and never a flat `.delegations/<sid>.adopted`
 * sibling: `harness doctor`'s delegations metric counts every regular
 * file directly under `.delegations/` (a ledger nested in there, flat or
 * not, would be reported as an extra, unreadable delegation).
 */
function adoptedLedgerPath(): string {
  return path.join(generatedDir, ".delegation-adoptions", CHILD);
}

/** The flat `.delegations/`-sibling layout this deliberately does NOT use. */
function flatAdoptedLedgerPath(): string {
  return `${delegationMarkerPathFor(generatedDir, CHILD)}.adopted`;
}

/** The nested-subdirectory-of-`.delegations/` layout this deliberately does NOT use. */
function nestedAdoptedLedgerPath(): string {
  const delegationPath = delegationMarkerPathFor(generatedDir, CHILD);
  return path.join(path.dirname(delegationPath), "adopted", CHILD);
}

function readMarkerRaw(): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(approvalMarkerPathFor(generatedDir, CHILD), "utf8"),
  ) as Record<string, unknown>;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ug-delegate-hook-"));
  generatedDir = path.join(tmp, "harness.generated");
  reportsDir = path.join(tmp, "reports");
  childCwd = path.join(tmp, "child-cwd");
  transcriptPath = path.join(tmp, "transcripts", `${CHILD}.jsonl`);
  fs.mkdirSync(childCwd, { recursive: true });
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.mkdirSync(reportsDir, { recursive: true });
  ledgerCalls = [];

  savedClaude = process.env.CLAUDE_SESSION_ID;
  savedClaudeCode = process.env.CLAUDE_CODE_SESSION_ID;
  savedMode = process.env[MODE_ENV];
  delete process.env.CLAUDE_SESSION_ID;
  delete process.env[MODE_ENV];
  // The session-consistency check compares the payload's own session_id
  // against this; the child's hook process carries its own id.
  process.env.CLAUDE_CODE_SESSION_ID = CHILD;

  // The operator-side act, done explicitly and before anything is signed.
  getOrCreateSigningKey(generatedDir);
  // A real, valid approval marker for the PARENT session. It is here to
  // prove what it does NOT do: the parent's approval never opens the
  // child's gate; only the child's own marker does.
  writeApprovalMarker(generatedDir, PARENT, {
    approvedAt: new Date().toISOString(),
    approvedBy: "test-operator",
  });
  issueDelegation();
  writeTranscript([userTurn()]);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (savedClaude === undefined) delete process.env.CLAUDE_SESSION_ID;
  else process.env.CLAUDE_SESSION_ID = savedClaude;
  if (savedClaudeCode === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = savedClaudeCode;
  if (savedMode === undefined) delete process.env[MODE_ENV];
  else process.env[MODE_ENV] = savedMode;
});

interface CallOptions {
  manifest?: Manifest;
  toolName?: string;
  /** `tool_input.command`, for the Bash-shaped decision-order controls. */
  command?: string;
  permissionMode?: string | null;
  transcriptPathOverride?: string;
  clock?: FakeClock;
}

/** One gated PreToolUse call through the real CLI entry point. */
async function call(opts: CallOptions = {}): Promise<{
  blocked: boolean;
  source: string;
  stderr: string;
  stdout: string;
}> {
  const stdout = bufferStream();
  const stderr = bufferStream();
  const clock = opts.clock ?? fakeClock();
  const payload: Record<string, unknown> = {
    tool_name: opts.toolName ?? "Edit",
    session_id: CHILD,
    cwd: childCwd,
    transcript_path: opts.transcriptPathOverride ?? transcriptPath,
    ...(opts.command !== undefined ? { tool_input: { command: opts.command } } : {}),
    // NOT in `auto_approve.when`, on purpose: only a delegation can
    // supply key one in this suite.
    ...(opts.permissionMode === null ? {} : { permission_mode: opts.permissionMode ?? "default" }),
  };
  const result = await runPackHookPreToolUseCli({
    manifest: opts.manifest ?? manifestWithAutoApprove(),
    stdin: readableFromString(JSON.stringify(payload)),
    stdout: stdout.stream,
    stderr: stderr.stream,
    reportsDir,
    generatedDir,
    ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    writeLedger: async (args: LedgerWriteArgs): Promise<{ ok: true }> => {
      ledgerCalls.push(args);
      return { ok: true };
    },
    reportScanClock: { now: clock.now, sleep: clock.sleep },
  });
  return {
    blocked: result.blocked,
    source: result.approvalCheck.source,
    stderr: stderr.read(),
    stdout: stdout.read(),
  };
}

describe("pack hook pre-tool-use: delegation path (ADR slice 3)", () => {
  describe("negative controls", () => {
    it("(a) no delegation and permission_mode default: block, no marker", async () => {
      // ADR: "No delegation and no `when`-listed mode: no auto-approval,
      // block." Also the control that proves the whole suite is not
      // riding on the slice-1 `when` path.
      removeDelegation();
      writeTranscript([userTurn(), transcriptEntry()]);

      const result = await call();

      expect(result.blocked).toBe(true);
      expect(markerExists()).toBe(false);
      expect(ledgerCalls).toEqual([]);
      expect(listPersistedReports(reportsDir)).toEqual([]);
      expect(result.stderr).not.toMatch(/delegation for/);
    });

    it("(b) expired delegation: block, and the diagnostic names `expired`", async () => {
      // ADR: "Expired delegation: block, distinct diagnostic."
      issueDelegation({ expiresAt: new Date(Date.now() - 60_000).toISOString() });
      writeTranscript([userTurn(), transcriptEntry()]);

      const result = await call();

      expect(result.blocked).toBe(true);
      expect(result.stderr).toMatch(
        new RegExp(`delegation for ${CHILD} refused: expired: `),
      );
      expect(markerExists()).toBe(false);
      expect(ledgerCalls).toEqual([]);
      // Key two was never even looked for: a refused delegation does not
      // reach the report scan.
      expect(listPersistedReports(reportsDir)).toEqual([]);
    });

    it("(c) delegation bound to another cwd: block", async () => {
      // ADR: "Delegation for another cwd or task: block."
      const otherCwd = path.join(tmp, "somewhere-else");
      fs.mkdirSync(otherCwd, { recursive: true });
      issueDelegation({ cwdHash: hashDelegationCwd(otherCwd) });
      writeTranscript([userTurn(), transcriptEntry()]);

      const result = await call();

      expect(result.blocked).toBe(true);
      expect(result.stderr).toMatch(
        new RegExp(`delegation for ${CHILD} refused: cwd_mismatch: `),
      );
      expect(markerExists()).toBe(false);
      expect(listPersistedReports(reportsDir)).toEqual([]);
    });

    it("(d) delegation bound to another task while the active claim names a different one: block", async () => {
      // Same ADR bullet, task arm. The active-claim file is the id the
      // hook resolves for the task-scoped marker check, so it is also the
      // id a delegation's `task=` binding is held against.
      issueDelegation({ cwdHash: hashDelegationCwd(childCwd), taskId: "task-alpha" });
      writeActiveClaim(generatedDir, "task-beta");
      writeTranscript([userTurn(), transcriptEntry()]);

      const result = await call();

      expect(result.blocked).toBe(true);
      expect(result.stderr).toMatch(
        new RegExp(`delegation for ${CHILD} refused: task_mismatch: `),
      );
      expect(markerExists()).toBe(false);
      expect(listPersistedReports(reportsDir)).toEqual([]);
    });

    it("(e) forged (unsigned) delegation: block with the forged diagnostic, no marker", async () => {
      // ADR: "Forged or unsigned delegation file: block with the forged
      // diagnostic." The signing key EXISTS here on purpose: without it
      // the refusal could be attributed to the key precheck instead of to
      // the signature check.
      const delegationPath = delegationMarkerPathFor(generatedDir, CHILD);
      fs.writeFileSync(
        delegationPath,
        `${JSON.stringify(
          {
            approvedAt: new Date().toISOString(),
            approvedBy: `delegated:${PARENT};cwd=${hashDelegationCwd(
              childCwd,
            )};task=-;expires=${new Date(Date.now() + 60_000).toISOString()}`,
            reportContentHash: null,
          },
          null,
          2,
        )}\n`,
      );
      writeTranscript([userTurn(), transcriptEntry()]);

      const result = await call();

      expect(result.blocked).toBe(true);
      expect(result.stderr).toMatch(
        new RegExp(`delegation for ${CHILD} refused: forged: forged/unsigned delegation rejected`),
      );
      expect(markerExists()).toBe(false);
      expect(ledgerCalls).toEqual([]);
      expect(listPersistedReports(reportsDir)).toEqual([]);
    });

    it("(f) valid delegation but the transcript never carries a report: block, no marker, nothing persisted", async () => {
      // ADR: "Delegation present but no child report: no marker, block."
      // The delegation is key ONE only; on its own it is a
      // pre-authorization, which is exactly Option D the ADR rejected.
      const clock = fakeClock();

      const result = await call({ clock });

      expect(result.blocked).toBe(true);
      expect(markerExists()).toBe(false);
      expect(ledgerCalls).toEqual([]);
      expect(listPersistedReports(reportsDir)).toEqual([]);
      // The delegation itself verified; only key two was missing.
      expect(result.stderr).not.toMatch(/delegation for .* refused/);
      expect(result.stderr).toMatch(/no Understanding Report for session .* reached its transcript/);
      // The bound really was waited out on the injected clock, so this is
      // the fail-closed timeout and not an early abort.
      expect(clock.sleeps.length).toBeGreaterThan(0);
    });

    it("(g) a report that lands only after the bound: block with the repeated-retry instruction, and the retry then gets through", async () => {
      // ADR: "Delegation present and the report has not landed in the
      // transcript within the bound: no marker, block (the fail-closed
      // timeout, not an allow)" plus "Past the bound: block with an
      // instruction that asks for repeated retries."
      const first = await call();

      expect(first.blocked).toBe(true);
      expect(markerExists()).toBe(false);
      expect(listPersistedReports(reportsDir)).toEqual([]);
      // The exact sentence, not a paraphrase: the wording is the
      // instruction channel the ADR's retry measurement is about.
      expect(JSON.parse(first.stdout) as { reason: string }).toMatchObject({
        reason: expect.stringContaining(DELEGATION_REPORT_RETRY_INSTRUCTION),
      });
      const firstBlock = JSON.parse(first.stdout) as {
        reason: string;
        hookSpecificOutput: { permissionDecisionReason: string };
      };
      // The standard reason is kept, the sentence is appended to it.
      expect(firstBlock.reason).toMatch(/Understanding Gate: no approved Understanding Report/);
      expect(firstBlock.hookSpecificOutput.permissionDecisionReason).toContain(
        DELEGATION_REPORT_RETRY_INSTRUCTION,
      );

      // The report flushes to the transcript after the bound elapsed;
      // the retry the instruction asked for is what then gets through.
      writeTranscript([userTurn(), transcriptEntry()]);
      const retry = await call();

      expect(retry.blocked).toBe(false);
      expect(retry.source).toBe("marker");
    });

    it("(h) a report present only in a user-role entry is not adopted: block", async () => {
      // ADR: "Report present in the transcript only as user-role text
      // (the prompt echoing it back), never as an assistant entry: not
      // adopted." Otherwise the launcher's own prompt could supply key
      // two on the child's behalf.
      writeTranscript([transcriptEntry({ type: "user", message: { role: "user", content: CHILD_REPORT_MARKDOWN } })]);

      const result = await call();

      expect(result.blocked).toBe(true);
      expect(markerExists()).toBe(false);
      expect(listPersistedReports(reportsDir)).toEqual([]);
      expect(result.stderr).toMatch(/no Understanding Report for session .* reached its transcript/);
    });

    it("(i) a report present only in a sidechain assistant entry is not adopted: block", async () => {
      // ADR: "Report present only in a sidechain (subagent) assistant
      // entry synthetically placed in the payload's own transcript: not
      // adopted." The measured shape never puts such an entry there on
      // its own, so the fixture places one deliberately; without the
      // synthetic placement this control would be vacuously green.
      writeTranscript([userTurn(), transcriptEntry({ isSidechain: true })]);

      const result = await call();

      expect(result.blocked).toBe(true);
      expect(markerExists()).toBe(false);
      expect(listPersistedReports(reportsDir)).toEqual([]);
      expect(result.stderr).toMatch(/no Understanding Report for session .* reached its transcript/);
    });

    it("(j) a report whose entry carries a foreign sessionId is not adopted: block", async () => {
      // ADR: "Report in a transcript belonging to another session: not
      // adopted." The scan opens only the payload's own transcript_path,
      // so the discriminating shape is a foreign-stamped ENTRY inside
      // that very file (a resumed or forked transcript).
      writeTranscript([userTurn(), transcriptEntry({ sessionId: "some-other-session" })]);

      const result = await call();

      expect(result.blocked).toBe(true);
      expect(markerExists()).toBe(false);
      expect(listPersistedReports(reportsDir)).toEqual([]);
      expect(result.stderr).toMatch(/no Understanding Report for session .* reached its transcript/);
    });

    it("(k) a delegation copied into .approvals/ is not an approval and is no longer a delegation: block, forged diagnostic, no auto-marker", async () => {
      // ADR: "A delegation file placed in `.approvals/` instead of
      // `.delegations/`: not treated as an approval by the marker check
      // (its markerId does not match the session marker's), and not found
      // by the delegation verifier either."
      const delegationBody = fs.readFileSync(
        delegationMarkerPathFor(generatedDir, CHILD),
        "utf8",
      );
      const approvalPath = approvalMarkerPathFor(generatedDir, CHILD);
      fs.mkdirSync(path.dirname(approvalPath), { recursive: true });
      fs.writeFileSync(approvalPath, delegationBody);
      removeDelegation();
      writeTranscript([userTurn(), transcriptEntry()]);

      const result = await call();

      expect(result.blocked).toBe(true);
      expect(result.stderr).toMatch(/forged\/unsigned marker rejected/);
      // The copied file is untouched: nothing was minted over it.
      expect(fs.readFileSync(approvalPath, "utf8")).toBe(delegationBody);
      expect(checkApprovalMarker(generatedDir, CHILD).matched).toBe(false);
      expect(ledgerCalls).toEqual([]);
      expect(listPersistedReports(reportsDir)).toEqual([]);
    });

    it("(n) signing key absent with a delegation present: nothing verifies, no key is created, block", async () => {
      // The never-create rule applies to the READ path too: verifying
      // through `verifyMarkerSignature` would mint the key it is supposed
      // to require. The delegation was signed while the key existed, so
      // the artifact itself is genuine; only the key is gone.
      fs.rmSync(signingKeyPathFor(generatedDir));
      writeTranscript([userTurn(), transcriptEntry()]);

      const result = await call();

      expect(result.blocked).toBe(true);
      expect(result.stderr).toMatch(
        /delegation present but signing key absent; not verified/,
      );
      expect(fs.existsSync(signingKeyPathFor(generatedDir))).toBe(false);
      expect(markerExists()).toBe(false);
      expect(ledgerCalls).toEqual([]);
      expect(listPersistedReports(reportsDir)).toEqual([]);
    });

    it("(t) the adoption ledger's own path is a directory: fails closed on the READ, before any capture is attempted", async () => {
      // The once-per-session adoption ledger is read BEFORE the transcript
      // is scanned, on the fail-closed principle: without it the hook
      // cannot tell a fresh report from one this session already spent.
      // A directory sitting at the ledger's own file path makes the read
      // itself fail (EISDIR, not ENOENT), which is a distinct condition
      // from "no ledger yet" and must decline rather than treat the
      // transcript as unspent.
      fs.mkdirSync(path.join(generatedDir, ".delegation-adoptions", CHILD), {
        recursive: true,
      });
      writeTranscript([userTurn(), transcriptEntry()]);

      const result = await call();

      expect(result.blocked).toBe(true);
      expect(result.stderr).toMatch(
        new RegExp(
          `the adopted-entry ledger at .* could not be read \\(EISDIR.*\\); refusing to capture a transcript entry that may already have been adopted for session ${CHILD}`,
        ),
      );
      expect(markerExists()).toBe(false);
      expect(ledgerCalls).toEqual([]);
      expect(listPersistedReports(reportsDir)).toEqual([]);
    });

    it("(u) the adoption ledger directory exists but cannot be written to: the read succeeds, the capture fails closed, and nothing is persisted", async () => {
      // The mirror image of (t): the ledger READ succeeds (the directory
      // exists and the per-session file inside it does not, which reads
      // as the ordinary "nothing adopted yet" case), so the scan runs and
      // finds the report, but recording the entry as spent, the write
      // that MUST happen before the report is persisted (see the module
      // header's "RECORD THE ADOPTION FIRST" ordering), cannot land. A
      // ledger write that cannot be recorded must not let the report
      // through: the capture declines and nothing is persisted, even
      // though a valid report was sitting right there in the transcript.
      const ledgerDir = path.join(generatedDir, ".delegation-adoptions");
      fs.mkdirSync(ledgerDir, { recursive: true });
      fs.chmodSync(ledgerDir, 0o500);
      writeTranscript([userTurn(), transcriptEntry()]);

      try {
        const result = await call();

        expect(result.blocked).toBe(true);
        expect(result.stderr).toMatch(
          new RegExp(
            `could not record transcript entry uuid:uuid-report as adopted for session ${CHILD} \\(.*\\); nothing was persisted`,
          ),
        );
        expect(markerExists()).toBe(false);
        expect(ledgerCalls).toEqual([]);
        expect(listPersistedReports(reportsDir)).toEqual([]);
      } finally {
        // Restore write permission before the directory (and its `tmp`
        // ancestor) is removed in `afterEach`, or the cleanup itself fails.
        fs.chmodSync(ledgerDir, 0o700);
      }
    });

    it("(p) a read-only Bash call is allowed by the step-6 exemption and never reaches the delegation branch", async () => {
      // DECISION-ORDER control. The delegation capture is part of step 9,
      // deliberately last, so a call one of the earlier exemptions already
      // allows must not capture, persist, or mint anything on its way out.
      // Everything the delegation branch needs is in place here (valid
      // delegation, the child's report already in the transcript), so if
      // the branch ran at all it WOULD capture and persist: that nothing
      // was written is what pins the ordering. Moving the read-only-Bash
      // early return below the delegation branch turns this red.
      writeTranscript([userTurn(), transcriptEntry()]);

      const result = await call({ toolName: "Bash", command: "ls -la" });

      expect(result.blocked).toBe(false);
      expect(result.source).toBe("none");
      expect(result.stderr).toMatch(/read-only Bash command, allowing without an approved report/);
      expect(listPersistedReports(reportsDir)).toEqual([]);
      expect(result.stderr).not.toMatch(/captured the Understanding Report/);
      expect(markerExists()).toBe(false);
      expect(ledgerCalls).toEqual([]);
    });

    it("(q) a transcript report whose body does not parse persists nothing and blocks", async () => {
      // The heading IS there (so the scan adopts the entry) but the
      // required sections are not, which is exactly what
      // `persistStdinReport`'s parser rejects. Key two must stay absent:
      // a report the parser refused is not a report.
      writeTranscript([
        userTurn(),
        transcriptEntry({
          uuid: "uuid-unparseable",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "# Understanding Report\n\nJust prose. No sections at all." },
            ],
          },
        }),
      ]);

      const result = await call();

      expect(result.blocked).toBe(true);
      expect(result.stderr).toMatch(
        new RegExp(`the transcript report for session ${CHILD} did not parse`),
      );
      expect(listPersistedReports(reportsDir)).toEqual([]);
      expect(markerExists()).toBe(false);
      expect(ledgerCalls).toEqual([]);
    });
  });

  describe("acceptance criteria", () => {
    it("(l) valid delegation + the child's own main-line report: the report is captured, the marker carries the parent linkage, and the same call allows", async () => {
      writeTranscript([userTurn(), transcriptEntry()]);

      const result = await call();

      expect(result.blocked).toBe(false);
      expect(result.source).toBe("marker");
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(
        new RegExp(`auto-approval key one: valid delegation from parent session ${PARENT}`),
      );
      expect(result.stderr).toMatch(/captured the Understanding Report for session .* from its own transcript/);

      // Key two really was persisted, bound to the CHILD's session id,
      // and then consumed by the same pass.
      const reports = listPersistedReports(reportsDir);
      expect(reports).toHaveLength(1);
      const persisted = JSON.parse(fs.readFileSync(reports[0]!.filePath, "utf8")) as Record<
        string,
        unknown
      >;
      expect(persisted["sessionId"]).toBe(CHILD);
      expect(persisted["approvalStatus"]).toBe("approved");

      // The allow came from the marker re-check, and the marker is a real
      // signed one carrying both the source and the parent linkage.
      const check = checkApprovalMarker(generatedDir, CHILD);
      expect(check.matched).toBe(true);
      expect(check.forged).toBe(false);
      const approvedBy = check.marker?.approvedBy ?? "";
      // The `<mode>` segment is the neutral `delegated` literal, NOT the
      // payload's `default`: on this path the mode played no part in the
      // decision, so recording it would bucket the marker in the doctor
      // listing under a mode that never opened anything.
      expect(approvedBy).toBe(`auto-mode:claude-code:delegated;delegated:${PARENT}`);
      expect(readMarkerRaw()["approvedBy"]).toBe(approvedBy);
      // The doctor listing still buckets it by harness/mode: the
      // delegation suffix round-trips through the shared parser.
      expect(parseAutoApprovedBy(approvedBy)).toEqual({
        harness: "claude-code",
        mode: "delegated",
      });

      // Audit-only ledger fact, exactly as on the slice-1 path.
      expect(ledgerCalls).toHaveLength(1);
      expect(ledgerCalls[0]?.content).toBe(`understanding-auto-approved:${CHILD}`);
      expect(ledgerCalls[0]?.sessionId).toBe(CHILD);
    });

    it("(m) a pending report already on disk skips the scan entirely and still allows", async () => {
      // The scan exists to cover the transcript LAG, so a session whose
      // report was already captured (by an earlier, denied call) must not
      // pay for it again. Proven, not assumed: `transcript_path` names a
      // DIRECTORY here, which the scan reports as unreadable with a line
      // of its own if it runs at all.
      const unreadable = path.join(tmp, "not-a-transcript");
      fs.mkdirSync(unreadable);
      fs.writeFileSync(
        path.join(reportsDir, "2026-08-28T09-30-00-000Z-child-1111aaaa.json"),
        `${JSON.stringify(
          {
            sessionId: CHILD,
            approvalStatus: "pending",
            createdAt: "2026-08-28T09:30:00.000Z",
            mode: "grill_me",
            currentUnderstanding: "already captured on an earlier, denied call",
            priorArt: ["searched the reports directory first; a pending report is already there"],
          },
          null,
          2,
        )}\n`,
      );

      const result = await call({ transcriptPathOverride: unreadable });

      expect(result.blocked).toBe(false);
      expect(result.source).toBe("marker");
      // The scan never ran: none of its three outcome lines is present.
      expect(result.stderr).not.toMatch(/could not be read/);
      expect(result.stderr).not.toMatch(/captured the Understanding Report/);
      expect(result.stderr).not.toMatch(/reached its transcript within/);
      // No second report was persisted from the transcript.
      expect(listPersistedReports(reportsDir)).toHaveLength(1);
      const check = checkApprovalMarker(generatedDir, CHILD);
      expect(check.matched).toBe(true);
      expect(check.marker?.approvedBy).toContain(`;delegated:${PARENT}`);
      expect(ledgerCalls).toHaveLength(1);
    });

    it.each([
      ["a `;`/`:`-delimited mode", "x;delegated:someone-else"],
      ["a mode carrying a newline and a tab", "sneaky\nmode\tname"],
    ])(
      "(o) %s never reaches approvedBy on the delegation path (T-003 follow-on B)",
      async (_label, permissionMode) => {
        // The payload's permission_mode is UNCONSTRAINED here, and
        // `approvedBy` is a signed audit record. A mode of
        // `x;delegated:someone-else` would forge a second `delegated:`
        // segment; a mode carrying a newline or a tab would survive a mere
        // delimiter check and land verbatim in the doctor listing as a
        // permission mode that never existed. Both are replaced wholesale
        // by the neutral `delegated` literal
        // (src/cli/pack/auto-approve-path.ts), so only the REAL parent
        // session id (from the verified delegation, never the payload)
        // appears after `;delegated:`.
        writeTranscript([userTurn(), transcriptEntry()]);

        const result = await call({ permissionMode });

        expect(result.blocked).toBe(false);
        const check = checkApprovalMarker(generatedDir, CHILD);
        expect(check.matched).toBe(true);
        const approvedBy = check.marker?.approvedBy ?? "";
        expect(approvedBy).toBe(`auto-mode:claude-code:delegated;delegated:${PARENT}`);
        expect(approvedBy).not.toContain("someone-else");
        expect(approvedBy).not.toContain("sneaky");
        const occurrences = approvedBy.split(";delegated:").length - 1;
        expect(occurrences).toBe(1);
      },
    );

    it("(s) a `when`-listed permission_mode keeps its real literal even when a delegation is also present", async () => {
      // The mirror image of (o): here the mode IS the operator-configured
      // allowlist entry, so it is evidence of how key one was satisfied and
      // is recorded verbatim. The delegation suffix rides alongside it.
      writeTranscript([userTurn(), transcriptEntry()]);

      const result = await call({ permissionMode: "bypassPermissions" });

      expect(result.blocked).toBe(false);
      expect(result.stderr).toMatch(
        /auto-approval key one: permission_mode "bypassPermissions" in auto_approve\.when/,
      );
      const approvedBy = checkApprovalMarker(generatedDir, CHILD).marker?.approvedBy ?? "";
      expect(approvedBy).toBe(`auto-mode:claude-code:bypassPermissions;delegated:${PARENT}`);
      expect(parseAutoApprovedBy(approvedBy)).toEqual({
        harness: "claude-code",
        mode: "bypassPermissions",
      });
    });
  });

  describe("once-per-session adoption", () => {
    it("(r) the same transcript entry cannot mint a second marker once the first expired, but a fresh entry can", async () => {
      // THE REPLAY THIS CLOSES: the auto-marker's TTL is short on purpose,
      // the delegation's is not. Without a once-per-session rule the next
      // gated call after the marker aged out would re-scan the SAME
      // transcript entry, persist a fresh `pending` report from it and
      // re-mint the marker, so the delegation's lifetime would quietly
      // become the approval's.
      const manifest = manifestWithAutoApprove({}, { approval_lifecycle: { max_age: "1h" } });
      writeTranscript([userTurn(), transcriptEntry()]);

      const first = await call({ manifest });
      expect(first.blocked).toBe(false);
      expect(first.source).toBe("marker");
      expect(listPersistedReports(reportsDir)).toHaveLength(1);
      // The spent entry was recorded, one id per line, in its own SIBLING
      // directory of `.delegations/`, never as a flat `.delegations/`
      // sibling and never nested under `.delegations/` itself.
      expect(fs.readFileSync(adoptedLedgerPath(), "utf8")).toBe("uuid:uuid-report\n");
      expect(fs.existsSync(flatAdoptedLedgerPath())).toBe(false);
      expect(fs.existsSync(nestedAdoptedLedgerPath())).toBe(false);
      const mintedBy = String(readMarkerRaw()["approvedBy"]);

      // Age the marker out. Re-signed through the real writer with a
      // backdated `approvedAt` rather than hand-edited: a tampered
      // timestamp would read as FORGED, and the delegation branch (gated
      // on `!markerForged`) would then not run at all, which would make
      // the assertions below pass for the wrong reason.
      const backdated = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      writeApprovalMarker(generatedDir, CHILD, {
        approvedAt: backdated,
        approvedBy: mintedBy,
      });
      expect(checkApprovalMarker(generatedDir, CHILD).forged).toBe(false);

      const second = await call({ manifest });

      expect(second.blocked).toBe(true);
      expect(second.stderr).toMatch(
        new RegExp(
          `newest Understanding Report entry in the transcript for session ${CHILD} was already adopted`,
        ),
      );
      // No second marker was minted over the expired one, and the spent
      // entry produced no second report.
      expect(readMarkerRaw()["approvedAt"]).toBe(backdated);
      expect(listPersistedReports(reportsDir)).toHaveLength(1);

      // The intended re-arm: a NEW report entry, which the child emits in
      // response to the retry instruction, is adopted normally.
      fs.appendFileSync(transcriptPath, `${transcriptEntry({ uuid: "uuid-report-2" })}\n`);
      const third = await call({ manifest });

      expect(third.blocked).toBe(false);
      expect(third.source).toBe("marker");
      expect(readMarkerRaw()["approvedAt"]).not.toBe(backdated);
      expect(listPersistedReports(reportsDir)).toHaveLength(2);
      // Appended, not rewritten: both spent entries stay recorded.
      expect(fs.readFileSync(adoptedLedgerPath(), "utf8")).toBe(
        "uuid:uuid-report\nuuid:uuid-report-2\n",
      );
    });
  });
});
