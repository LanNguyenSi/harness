// PreToolUse blocker consulting a subagent's in-flight record
// (docs/decisions/2026-08-27-ug-auto-mode-approval.md "TTL, cwd, and
// subagents"). An Agent-tool subagent shares its parent's `session_id`,
// so the moment the parent crosses a task boundary (clearing the session
// marker) a subagent still mid-flight has nothing to present — even
// though ITS approval was valid when it started. `verifyInflightRecord`
// closes that gap; this file pins the PreToolUse side that consults it.
//
// Kept in its own file (mirrors pack-hook-pre-tool-use-auto-approve.test.ts's
// own rationale): the reproduction fixture (marker + subagent-start
// + post-tool-use boundary + subagent PreToolUse calls + subagent-stop)
// is elaborate and shared by several tests here, but no other blocker
// test file wants it.

import { Readable, Writable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DELEGATION_REPORT_RETRY_INSTRUCTION,
  runPackHookPreToolUseCli,
} from "../../src/cli/pack/hook-pre-tool-use.js";
import { runPackHookCodexPreToolUseCli } from "../../src/cli/pack/hook-codex-pre-tool-use.js";
import { runPackHookPostToolUseCli } from "../../src/cli/pack/hook-post-tool-use.js";
import { runPackHookSubagentStartCli } from "../../src/cli/pack/hook-subagent-start.js";
import { runPackHookSubagentStopCli } from "../../src/cli/pack/hook-subagent-stop.js";
import type { LedgerEntry } from "../../src/policies/index.js";
import type { LedgerWriteArgs } from "../../src/runtime/ledger-writer.js";
import {
  approvalMarkerPathFor,
  hashDelegationCwd,
  listPersistedReports,
  permissionModeObservationPathFor,
  taskApprovalMarkerPathFor,
  verifyInflightRecord,
  writeActiveClaim,
  writeApprovalMarker,
  writeDelegationMarker,
  writeTaskApprovalMarker,
} from "../../src/policy-packs/builtin/understanding-before-execution-runtime.js";
import { getOrCreateSigningKey, sha256Hex } from "../../src/runtime/approval-signing.js";
import { readPendingApproval } from "../../src/runtime/pending-approval.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

// Call-through `vi.mock` of `sanitizeForDisplay` (same seam shape as
// pack-hook-pre-tool-use-delegate.test.ts's `readRegularFileSpyState`):
// a single test opts a specific input value into a visibly different
// output, while every other call — every other test in this file, and
// every OTHER value within the opted-in test — falls straight through to
// the real implementation. Needed because a value that can actually
// REACH the forged-record phrase must already satisfy
// `rejectMalformedAgentId` (alphanumeric/`.`/`_`/`-` only, <=128 chars),
// so `sanitizeForDisplay` is a real no-op on it: no adversarial input
// exists that would make `displayAgentId` differ from the raw `agentId`
// at that call site, which is exactly why a plain end-to-end fixture
// cannot discriminate "used `displayAgentId`" from "used `agentId`"
// there. Forcing a visible, artificial difference is how the test pins
// which variable the call site actually references.
const sanitizeForDisplaySpyState = vi.hoisted(() => ({
  targetValue: null as string | null,
  transformedValue: null as string | null,
}));

vi.mock("../../src/policy-packs/builtin/understanding-before-execution-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../src/policy-packs/builtin/understanding-before-execution-runtime.js")
  >();
  return {
    ...actual,
    sanitizeForDisplay: (value: string): string => {
      if (
        sanitizeForDisplaySpyState.targetValue !== null &&
        value === sanitizeForDisplaySpyState.targetValue &&
        sanitizeForDisplaySpyState.transformedValue !== null
      ) {
        return sanitizeForDisplaySpyState.transformedValue;
      }
      return actual.sanitizeForDisplay(value);
    },
  };
});

const SESSION = "sess-inflight-1";

let tmp: string;
let generatedDir: string;
let reportsDir: string;
let savedClaude: string | undefined;
let savedClaudeCode: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ug-inflight-blocker-"));
  generatedDir = path.join(tmp, "harness.generated");
  reportsDir = path.join(tmp, "no-reports");
  savedClaude = process.env.CLAUDE_SESSION_ID;
  savedClaudeCode = process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  // null: no test has opted a value into custom sanitizeForDisplay
  // behaviour, i.e. every call falls through to the real implementation.
  sanitizeForDisplaySpyState.targetValue = null;
  sanitizeForDisplaySpyState.transformedValue = null;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (savedClaude === undefined) delete process.env.CLAUDE_SESSION_ID;
  else process.env.CLAUDE_SESSION_ID = savedClaude;
  if (savedClaudeCode === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = savedClaudeCode;
});

function manifestWithPack(config: Record<string, unknown> = {}): Manifest {
  return parseManifest({
    version: 1,
    policy_packs: [{ name: "understanding-before-execution", enabled: true, config }],
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

function subagentStartBody(agentId: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: SESSION,
    agent_id: agentId,
    agent_type: "general-purpose",
    hook_event_name: "SubagentStart",
    ...overrides,
  });
}

// `Edit`, not `Bash`, is the default gated call here on purpose: a Bash
// command classifies through `isReadOnlyBashPipeline` first (an
// independent exemption, unrelated to this gate), and `echo hi` would
// wrongly exercise that exemption instead of the marker/in-flight path
// under test.
function preToolUseEvent(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: SESSION,
    tool_name: "Edit",
    tool_input: { file_path: "x.txt", old_string: "a", new_string: "b" },
    ...overrides,
  });
}

async function startSubagent(
  agentId: string,
  now?: Date,
): Promise<{ recordWritten: boolean; stderr: string }> {
  const stderr = bufferStream();
  const result = await runPackHookSubagentStartCli({
    manifest: manifestWithPack(),
    stdin: readableFromString(subagentStartBody(agentId)),
    stderr: stderr.stream,
    generatedDir,
    ...(now !== undefined ? { now } : {}),
  });
  return { recordWritten: result.recordWritten, stderr: stderr.read() };
}

interface CallResult {
  blocked: boolean;
  source: string;
  detail: string;
  stderr: string;
  stdout: string;
}

async function callPreToolUse(overrides: Record<string, unknown> = {}): Promise<CallResult> {
  const stdout = bufferStream();
  const stderr = bufferStream();
  const result = await runPackHookPreToolUseCli({
    manifest: manifestWithPack(),
    stdin: readableFromString(preToolUseEvent(overrides)),
    stdout: stdout.stream,
    stderr: stderr.stream,
    reportsDir,
    generatedDir,
    ledgerQuery: async (): Promise<LedgerEntry[]> => [],
  });
  return {
    blocked: result.blocked,
    source: result.approvalCheck.source,
    detail: result.approvalCheck.detail,
    stderr: stderr.read(),
    stdout: stdout.read(),
  };
}

const SUBAGENT_SUFFIX_RE =
  /: no in-flight approval record \(the parent session held no valid approval when this subagent started, or the record was removed\); stop cleanly and report to the orchestrator instead of retrying\.$/;

// The subagent sentence is branched on the record's actual verification
// outcome (absent / forged / stale); these two cover the non-absent arms.
const STALE_SENTENCE_RE =
  /: the in-flight record for this subagent is older than the staleness window; stop cleanly and report to the orchestrator instead of retrying\.$/;
const FORGED_SENTENCE_RE =
  /: the in-flight record for this subagent failed verification; stop cleanly and report to the orchestrator instead of retrying\.$/;

describe("pack hook pre-tool-use — in-flight subagent record consult", () => {
  it("allows a subagent call via a matching in-flight record when the session marker is gone", async () => {
    writeApprovalMarker(generatedDir, SESSION, {
      approvedAt: new Date().toISOString(),
      approvedBy: "test-operator",
    });
    const start = await startSubagent("agent-abc");
    expect(start.recordWritten).toBe(true);
    // The parent's own marker is gone by the time the subagent calls a
    // tool — exactly the incident shape (a task boundary, or the TTL,
    // cleared it out from under a still-running subagent).
    fs.rmSync(approvalMarkerPathFor(generatedDir, SESSION));

    const result = await callPreToolUse({ agent_id: "agent-abc" });

    expect(result.blocked).toBe(false);
    expect(result.source).toBe("inflight");
    expect(result.stderr).toMatch(
      /harness pack hook: in-flight subagent record for agent agent-abc \(.*\), allowing\./,
    );
    expect(result.stdout).toBe("");
  });

  it("the in-flight ALLOW diagnostic renders the SANITIZED agent id, not the raw one (kills the displayAgentId-vs-agentId swap on the allow path, review T-003 R3 L2)", async () => {
    // Mirrors "the forged in-flight record phrase renders the SANITIZED
    // agent id" below, but for the ALLOW diagnostic instead of the
    // forged/deny one: that test only pins the deny-path call site,
    // leaving a swap on this allow-path call site (`in-flight subagent
    // record for agent ${displayAgentId} ..., allowing.`) undetected.
    sanitizeForDisplaySpyState.targetValue = "agent-abc";
    sanitizeForDisplaySpyState.transformedValue = "agent-abc[[SANITIZED]]";

    writeApprovalMarker(generatedDir, SESSION, {
      approvedAt: new Date().toISOString(),
      approvedBy: "test-operator",
    });
    await startSubagent("agent-abc");
    fs.rmSync(approvalMarkerPathFor(generatedDir, SESSION));

    const result = await callPreToolUse({ agent_id: "agent-abc" });

    expect(result.blocked).toBe(false);
    expect(result.source).toBe("inflight");
    expect(result.stderr).toContain(
      "in-flight subagent record for agent agent-abc[[SANITIZED]] (",
    );
    // Never the raw, un-mocked-transform value in the same slot.
    expect(result.stderr).not.toMatch(/record for agent agent-abc \(/);
  });

  it("a forged session marker sitting next to a still-valid in-flight record still allows, but the forgery is surfaced to stderr BEFORE the allow diagnostic (not laundered, not silenced)", async () => {
    writeApprovalMarker(generatedDir, SESSION, {
      approvedAt: new Date().toISOString(),
      approvedBy: "test-operator",
    });
    await startSubagent("agent-abc");
    // The session marker is REPLACED with a forged one after the subagent
    // started — an attacker (or a bug) overwriting a marker that WAS
    // valid, while the subagent's own already-issued in-flight record is
    // untouched and still verifies on its own.
    const markerPath = approvalMarkerPathFor(generatedDir, SESSION);
    const forgedBody = `${JSON.stringify(
      { approvedAt: new Date().toISOString(), approvedBy: "agent", reportContentHash: null },
      null,
      2,
    )}\n`;
    fs.writeFileSync(markerPath, forgedBody);

    const result = await callPreToolUse({ agent_id: "agent-abc" });

    expect(result.blocked).toBe(false);
    expect(result.source).toBe("inflight");
    const stderr = result.stderr;
    // Names the forgery explicitly (session id + the marker's own
    // rejection detail) rather than a bare "forged/unsigned marker
    // rejected" fragment with no session context (review T-003 R3 L1).
    const markerLineIndex = stderr.search(
      new RegExp(
        `^harness pack hook: forged/unsigned marker rejected for session ${SESSION}; forged/unsigned marker rejected:`,
        "m",
      ),
    );
    const allowLineIndex = stderr.search(
      /harness pack hook: in-flight subagent record for agent agent-abc \(.*\), allowing\./,
    );
    // Both lines present...
    expect(markerLineIndex).toBeGreaterThanOrEqual(0);
    expect(allowLineIndex).toBeGreaterThanOrEqual(0);
    // ...and the forgery diagnostic comes first: the allow is not gated
    // on it (the call still succeeds), but an operator scanning stderr
    // top-to-bottom sees the forgery BEFORE the allow, not after or not
    // at all.
    expect(markerLineIndex).toBeLessThan(allowLineIndex);
    // The forged file itself is untouched: nothing was minted over it.
    expect(fs.readFileSync(markerPath, "utf8")).toBe(forgedBody);
  });

  it("a forged TASK marker sitting next to a still-valid in-flight record names the TASK marker's own detail, not the unrelated session-marker miss (review T-003 R3 L1)", async () => {
    // Distinct from the sibling test above: there the SESSION marker is
    // the one that got overwritten with a forgery, and `markers.detail`
    // (the session-scoped miss/forgery detail on the unmatched path)
    // already happened to name it. Here the TASK marker is the forged
    // one instead, with no session marker present at all — a naive
    // "always report markers.detail" would surface the session's
    // unrelated "no approval marker" miss and bury the actual forgery.
    writeActiveClaim(generatedDir, "task-abc");
    writeTaskApprovalMarker(generatedDir, "task-abc", {
      approvedAt: new Date().toISOString(),
      approvedBy: "test-operator",
    });
    await startSubagent("agent-abc");
    // Replace the (previously valid) task marker with an unsigned one —
    // same forgery shape as the session-marker sibling above — while no
    // session marker file exists at all.
    const taskMarkerPath = taskApprovalMarkerPathFor(generatedDir, "task-abc");
    const forgedTaskBody = `${JSON.stringify(
      { approvedAt: new Date().toISOString(), approvedBy: "agent", reportContentHash: null },
      null,
      2,
    )}\n`;
    fs.writeFileSync(taskMarkerPath, forgedTaskBody);

    const result = await callPreToolUse({ agent_id: "agent-abc" });

    expect(result.blocked).toBe(false);
    expect(result.source).toBe("inflight");
    const stderr = result.stderr;
    // Names the active-claim / task id, not a bare session-scoped miss:
    // this is what pins "task-scoped detail when the task marker is the
    // forged one" rather than always falling back to the session detail.
    const markerLineIndex = stderr.search(
      new RegExp(
        `^harness pack hook: forged/unsigned marker rejected for session ${SESSION}; active-claim task-abc has no fresh task marker \\(forged/unsigned marker rejected:`,
        "m",
      ),
    );
    const allowLineIndex = stderr.search(
      /harness pack hook: in-flight subagent record for agent agent-abc \(.*\), allowing\./,
    );
    expect(markerLineIndex).toBeGreaterThanOrEqual(0);
    expect(allowLineIndex).toBeGreaterThanOrEqual(0);
    expect(markerLineIndex).toBeLessThan(allowLineIndex);
    expect(fs.readFileSync(taskMarkerPath, "utf8")).toBe(forgedTaskBody);
  });

  it("main-line call (no agent_id) is blocked exactly as today even though a record exists for some agent", async () => {
    // Pins the `agent_id` gate itself: a probe that deletes the
    // "non-empty agent_id" condition from the in-flight consult would
    // make THIS call wrongly match a record and allow. One record is
    // written under an unrelated agent id (agent-abc) and a second is
    // written under the SESSION id itself: a mutant that falls back to
    // `agentId ?? sessionId` when `agent_id` is absent (the most natural
    // way to keep `verifyInflightRecord`'s signature satisfied once the
    // presence check is deleted) would match this second record, so
    // this fixture catches that shape too, not just a wholesale removal.
    writeApprovalMarker(generatedDir, SESSION, {
      approvedAt: new Date().toISOString(),
      approvedBy: "test-operator",
    });
    await startSubagent("agent-abc");
    await startSubagent(SESSION);
    fs.rmSync(approvalMarkerPathFor(generatedDir, SESSION));

    const result = await callPreToolUse();

    expect(result.blocked).toBe(true);
    expect(result.source).toBe("none");
    expect(result.detail).toMatch(new RegExp(`^no approval marker for session ${SESSION};`));
    expect(result.detail).not.toMatch(/subagent/);
  });

  it("subagent call naming a DIFFERENT agent id than the record on disk is blocked with the suffix", async () => {
    writeApprovalMarker(generatedDir, SESSION, {
      approvedAt: new Date().toISOString(),
      approvedBy: "test-operator",
    });
    await startSubagent("agent-abc");
    fs.rmSync(approvalMarkerPathFor(generatedDir, SESSION));

    const result = await callPreToolUse({ agent_id: "agent-xyz" });

    expect(result.blocked).toBe(true);
    expect(result.source).toBe("none");
    expect(result.detail).toMatch(SUBAGENT_SUFFIX_RE);
    expect(result.detail).toContain(" subagent agent-xyz:");
  });

  it("a stale in-flight record is blocked with the STALE sentence, on both the detail and the agent-facing stdout JSON", async () => {
    writeApprovalMarker(generatedDir, SESSION, {
      approvedAt: new Date().toISOString(),
      approvedBy: "test-operator",
    });
    // Backdated well past DEFAULT_INFLIGHT_STALE_AFTER_MS (24h).
    await startSubagent("agent-abc", new Date(Date.now() - 25 * 60 * 60 * 1000));
    fs.rmSync(approvalMarkerPathFor(generatedDir, SESSION));

    const result = await callPreToolUse({ agent_id: "agent-abc" });

    expect(result.blocked).toBe(true);
    // The sentence names the record as STALE, not as merely absent: a
    // stale record is a materially different signal (the parent DID hold
    // a valid approval at some point) from one that never existed.
    expect(result.detail).toMatch(STALE_SENTENCE_RE);
    expect(result.detail).toContain(" subagent agent-abc:");
    // Stale, not forged: the distinct staleness phrase, not the forged one.
    expect(result.detail).not.toMatch(/forged/);
    const decision = JSON.parse(result.stdout) as {
      reason: string;
      hookSpecificOutput: { permissionDecisionReason: string };
    };
    expect(decision.reason).toMatch(STALE_SENTENCE_RE);
    expect(decision.hookSpecificOutput.permissionDecisionReason).toMatch(STALE_SENTENCE_RE);
  });

  it("a malformed agent_id never throws and is blocked with the suffix", async () => {
    const result = await callPreToolUse({ agent_id: "../etc/passwd" });

    expect(result.blocked).toBe(true);
    expect(result.detail).toMatch(SUBAGENT_SUFFIX_RE);
    expect(result.detail).toContain(" subagent ../etc/passwd:");
  });

  it("no record at all (subagent-start never ran) is blocked with the suffix", async () => {
    const result = await callPreToolUse({ agent_id: "agent-never-started" });

    expect(result.blocked).toBe(true);
    expect(result.detail).toMatch(SUBAGENT_SUFFIX_RE);
    expect(result.detail).toContain(" subagent agent-never-started:");
  });

  it("a forged in-flight record is blocked with the FORGED sentence, on both the detail and the agent-facing stdout JSON (not the generic 'no record' wording)", async () => {
    writeApprovalMarker(generatedDir, SESSION, {
      approvedAt: new Date().toISOString(),
      approvedBy: "test-operator",
    });
    await startSubagent("agent-abc");
    fs.rmSync(approvalMarkerPathFor(generatedDir, SESSION));
    // Tamper the same way the existing forged-record test does: rewrite
    // the unsigned `startedAt` twin so it disagrees with the signed
    // `approvedAt`.
    const recordPath = path.join(generatedDir, ".inflight", SESSION, "agent-abc");
    const raw = JSON.parse(fs.readFileSync(recordPath, "utf8")) as Record<string, unknown>;
    raw["startedAt"] = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(recordPath, `${JSON.stringify(raw, null, 2)}\n`);
    expect(verifyInflightRecord(generatedDir, SESSION, "agent-abc").forged).toBe(true);

    const result = await callPreToolUse({ agent_id: "agent-abc" });

    expect(result.blocked).toBe(true);
    // `approvalCheck.detail` / stderr already carry their OWN, more
    // specific forged phrase (unchanged by this fix, pinned separately
    // by the existing "a tampered in-flight record is rejected as
    // forged" test above) — it is the AGENT-facing stdout JSON that used
    // to fall back to the generic "no in-flight approval record" wording
    // regardless of the actual outcome.
    expect(result.detail).toMatch(
      /forged\/unsigned in-flight record for agent agent-abc rejected for session/,
    );
    const decision = JSON.parse(result.stdout) as {
      reason: string;
      hookSpecificOutput: { permissionDecisionReason: string };
    };
    expect(decision.reason).toMatch(FORGED_SENTENCE_RE);
    expect(decision.hookSpecificOutput.permissionDecisionReason).toMatch(FORGED_SENTENCE_RE);
  });

  it("generatedDir unresolvable (test/injection path) carries no subagent sentence in the agent-facing reason: no verification was ever consulted, so there is no outcome to report", async () => {
    const stdout = bufferStream();
    const stderr = bufferStream();
    const result = await runPackHookPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(preToolUseEvent({ agent_id: "agent-abc" })),
      stdout: stdout.stream,
      stderr: stderr.stream,
      reportsDir,
      // `generatedDir` intentionally omitted, and no `manifestPath` is
      // supplied either, so it resolves to `undefined` — the same
      // "test/injection path" every other suite uses for this branch.
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });

    expect(result.blocked).toBe(true);
    expect(result.approvalCheck.detail).toMatch(/^generatedDir not resolvable/);
    const decision = JSON.parse(stdout.read()) as {
      reason: string;
      hookSpecificOutput: { permissionDecisionReason: string };
    };
    expect(decision.reason).not.toMatch(/subagent/);
    expect(decision.hookSpecificOutput.permissionDecisionReason).not.toMatch(/subagent/);
  });

  it("a tampered in-flight record is rejected as forged, and no auto-approval happens even with a pending report and a when-listed permission_mode", async () => {
    process.env.CLAUDE_CODE_SESSION_ID = SESSION;
    writeApprovalMarker(generatedDir, SESSION, {
      approvedAt: new Date().toISOString(),
      approvedBy: "test-operator",
    });
    await startSubagent("agent-abc");
    fs.rmSync(approvalMarkerPathFor(generatedDir, SESSION));

    // Tamper: rewrite the unsigned `startedAt` convenience field so it
    // disagrees with the SIGNED `approvedAt` — the exact forgery shape
    // `verifyInflightRecord`'s module header calls out (reviving/altering
    // a record by editing only its unsigned twin).
    const recordPath = path.join(generatedDir, ".inflight", SESSION, "agent-abc");
    const raw = JSON.parse(fs.readFileSync(recordPath, "utf8")) as Record<string, unknown>;
    raw["startedAt"] = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(recordPath, `${JSON.stringify(raw, null, 2)}\n`);
    expect(verifyInflightRecord(generatedDir, SESSION, "agent-abc").forged).toBe(true);

    // Opt-in auto-approve config + a valid, pending, strict-session
    // report + a signing key + an allowlisted permission_mode: every
    // other condition `attemptAutoApproval` checks is satisfied, so if
    // the forged-record decline were skipped this call WOULD auto-approve.
    getOrCreateSigningKey(generatedDir);
    fs.mkdirSync(reportsDir, { recursive: true });
    const reportPath = path.join(reportsDir, "2026-09-03T00-00-00-000Z-report-aaaa1111.json");
    const reportBody = {
      sessionId: SESSION,
      approvalStatus: "pending",
      createdAt: "2026-09-03T00:00:00.000Z",
      mode: "grill_me",
      currentUnderstanding: "the tampered in-flight record test",
      priorArt: ["searched for an existing test; none exists"],
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(reportBody, null, 2)}\n`);

    const stdout = bufferStream();
    const stderr = bufferStream();
    const ledgerCalls: LedgerWriteArgs[] = [];
    const result = await runPackHookPreToolUseCli({
      manifest: manifestWithPack({
        auto_approve: { when: ["bypassPermissions"], require_report: true },
      }),
      stdin: readableFromString(
        preToolUseEvent({ agent_id: "agent-abc", permission_mode: "bypassPermissions" }),
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
    expect(result.approvalCheck.detail).toMatch(
      /forged\/unsigned in-flight record for agent agent-abc rejected for session/,
    );
    expect(stderr.read()).toMatch(/forged\/unsigned in-flight record for agent agent-abc/);
    // attemptAutoApproval's own decline wording names the actual forged
    // artifact instead of always saying "marker" — a forged MARKER (see
    // the N3 auto-approve test) keeps that wording unchanged.
    expect(stderr.read()).toMatch(
      /harness pack hook: auto-approval declined: forged\/unsigned in-flight record present/,
    );
    // No auto-approval side effect of any kind: the report is still
    // pending and no ledger fact was written.
    const afterReport = JSON.parse(fs.readFileSync(reportPath, "utf8")) as Record<string, unknown>;
    expect(afterReport["approvalStatus"]).toBe("pending");
    expect(ledgerCalls).toHaveLength(0);
    expect(stdout.read()).toMatch(/"decision"/);
  });

  it("the forged in-flight record phrase renders the SANITIZED agent id, not the raw one (kills the displayAgentId-vs-agentId swap on the forged path)", async () => {
    // No literal adversarial value (e.g. a newline) can reach this call
    // site: `verifyInflightRecord` validates `agentId` via
    // `rejectMalformedAgentId` before it can ever report `forged: true`,
    // so any value that reaches the forged phrase is already
    // `sanitizeForDisplay`-safe by construction, and a swap of
    // `displayAgentId` for the raw `agentId` would render byte-identical
    // output for every REACHABLE input. The mock above forces a visible
    // difference anyway so this call site's use of the sanitized
    // variable (not the raw one) is pinned by source, not by a
    // coincidence of which characters happen to be forbidden today.
    sanitizeForDisplaySpyState.targetValue = "agent-abc";
    sanitizeForDisplaySpyState.transformedValue = "agent-abc[[SANITIZED]]";

    writeApprovalMarker(generatedDir, SESSION, {
      approvedAt: new Date().toISOString(),
      approvedBy: "test-operator",
    });
    await startSubagent("agent-abc");
    fs.rmSync(approvalMarkerPathFor(generatedDir, SESSION));
    const recordPath = path.join(generatedDir, ".inflight", SESSION, "agent-abc");
    const raw = JSON.parse(fs.readFileSync(recordPath, "utf8")) as Record<string, unknown>;
    raw["startedAt"] = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(recordPath, `${JSON.stringify(raw, null, 2)}\n`);
    expect(verifyInflightRecord(generatedDir, SESSION, "agent-abc").forged).toBe(true);

    const result = await callPreToolUse({ agent_id: "agent-abc" });

    expect(result.blocked).toBe(true);
    expect(result.detail).toContain(
      "forged/unsigned in-flight record for agent agent-abc[[SANITIZED]] rejected for session",
    );
    // Never the raw, un-mocked-transform value in the same slot.
    expect(result.detail).not.toContain("for agent agent-abc rejected");
    // No raw control character reaches the surface either way, but the
    // discriminating assertion above is what actually proves the
    // SANITIZED variable was used at this call site.
    expect(result.detail).not.toMatch(/\n/);
  });

  it("Codex pre-tool-use is unaffected by agent_id: a valid in-flight record on disk does not open the Codex gate (fail-closed pinning)", async () => {
    writeApprovalMarker(generatedDir, SESSION, {
      approvedAt: new Date().toISOString(),
      approvedBy: "test-operator",
    });
    await startSubagent("agent-abc");
    fs.rmSync(approvalMarkerPathFor(generatedDir, SESSION));
    expect(verifyInflightRecord(generatedDir, SESSION, "agent-abc").matched).toBe(true);

    const stderr = bufferStream();
    const result = await runPackHookCodexPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        JSON.stringify({
          session_id: SESSION,
          tool_name: "apply_patch",
          agent_id: "agent-abc",
          raw_input: { command: "echo hi" },
        }),
      ),
      stderr: stderr.stream,
      reportsDir,
      generatedDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });

    expect(result.blocked).toBe(true);
    expect(result.exitCode).toBe(2);
    expect(stderr.read()).toMatch(new RegExp(`no approval marker for session ${SESSION}`));
  });

  it("a parent's task-boundary marker clear strands nothing for its in-flight subagent; subagent-stop then revokes the subagent's record", async () => {
    // 1. Operator approves the parent session.
    writeApprovalMarker(generatedDir, SESSION, {
      approvedAt: new Date().toISOString(),
      approvedBy: "test-operator",
    });

    // 2. SubagentStart for agent A copies that approval into a record.
    const startA = await startSubagent("agent-A");
    expect(startA.recordWritten).toBe(true);

    // 3. The parent crosses a task boundary; PostToolUse clears the
    // session marker (the exact mechanism that stranded a mid-flight
    // subagent in the incident).
    const postStderr = bufferStream();
    const postResult = await runPackHookPostToolUseCli({
      manifest: manifestWithPack({
        approval_lifecycle: {
          expire_on_tool_match: ["mcp__agent-tasks__task_finish"],
          max_age: "4h",
        },
      }),
      stdin: readableFromString(
        JSON.stringify({ session_id: SESSION, tool_name: "mcp__agent-tasks__task_finish" }),
      ),
      stderr: postStderr.stream,
      generatedDir,
    });
    expect(postResult.markerCleared).toBe(true);
    expect(fs.existsSync(approvalMarkerPathFor(generatedDir, SESSION))).toBe(false);

    // 4. Subagent A's own calls (Bash, then Edit) are still allowed via
    // its in-flight record — the fix under test.
    const aBash = await callPreToolUse({
      agent_id: "agent-A",
      tool_name: "Bash",
      tool_input: { command: "npm test" }, // not read-only: exercises the marker/in-flight path itself
    });
    expect(aBash.blocked).toBe(false);
    expect(aBash.source).toBe("inflight");
    const aEdit = await callPreToolUse({
      agent_id: "agent-A",
      tool_name: "Edit",
      tool_input: { file_path: "x.txt", old_string: "a", new_string: "b" },
    });
    expect(aEdit.blocked).toBe(false);
    expect(aEdit.source).toBe("inflight");

    // 5. A main-line call (the parent itself, no agent_id) is blocked:
    // the cleared marker is not resurrected by any subagent's record.
    const mainLine = await callPreToolUse();
    expect(mainLine.blocked).toBe(true);
    expect(mainLine.source).toBe("none");

    // 6. SubagentStart for agent B, AFTER the clear: the parent holds no
    // valid approval any more, so nothing is written for B.
    const startB = await startSubagent("agent-B");
    expect(startB.recordWritten).toBe(false);
    const bBash = await callPreToolUse({ agent_id: "agent-B" });
    expect(bBash.blocked).toBe(true);
    expect(bBash.detail).toMatch(SUBAGENT_SUFFIX_RE);
    expect(bBash.detail).toContain(" subagent agent-B:");

    // 7. SubagentStop for A clears its record; A's next call is blocked.
    const stopStderr = bufferStream();
    const stopResult = await runPackHookSubagentStopCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(JSON.stringify({ session_id: SESSION, agent_id: "agent-A" })),
      stderr: stopStderr.stream,
      generatedDir,
    });
    expect(stopResult.cleared).toBe(true);
    const aAfterStop = await callPreToolUse({ agent_id: "agent-A" });
    expect(aAfterStop.blocked).toBe(true);
    expect(aAfterStop.detail).toMatch(SUBAGENT_SUFFIX_RE);
    expect(aAfterStop.detail).toContain(" subagent agent-A:");
  });

  describe("agent_id shapes that are never a subagent call", () => {
    it.each([
      ["empty string", ""],
      ["array", ["agent-abc"]],
      ["object", { id: "agent-abc" }],
      ["number", 42],
    ])("agent_id is %s: main-line behaviour, no suffix", async (_label, value) => {
      const result = await callPreToolUse({ agent_id: value });
      expect(result.blocked).toBe(true);
      expect(result.source).toBe("none");
      expect(result.detail).not.toMatch(/subagent/);
    });
  });

  it("a record for a DIFFERENT session than the payload's is blocked with the suffix (records never cross sessions)", async () => {
    writeApprovalMarker(generatedDir, "sess-other-parent", {
      approvedAt: new Date().toISOString(),
      approvedBy: "test-operator",
    });
    const stderr = bufferStream();
    await runPackHookSubagentStartCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        JSON.stringify({
          session_id: "sess-other-parent",
          agent_id: "agent-A",
          agent_type: "general-purpose",
          hook_event_name: "SubagentStart",
        }),
      ),
      stderr: stderr.stream,
      generatedDir,
    });
    expect(
      verifyInflightRecord(generatedDir, "sess-other-parent", "agent-A").matched,
    ).toBe(true);

    // Same agentId, but under THIS file's own SESSION — a record filed
    // under a different session must never satisfy it.
    const result = await callPreToolUse({ agent_id: "agent-A" });
    expect(result.blocked).toBe(true);
    expect(result.detail).toMatch(SUBAGENT_SUFFIX_RE);
    expect(result.detail).toContain(" subagent agent-A:");
  });

  it("an in-flight allow stages no .pending-approval, records no permission-mode observation, and writes no ledger row (same side-effect profile as a marker allow)", async () => {
    writeApprovalMarker(generatedDir, SESSION, {
      approvedAt: new Date().toISOString(),
      approvedBy: "test-operator",
    });
    await startSubagent("agent-abc");
    fs.rmSync(approvalMarkerPathFor(generatedDir, SESSION));

    const stdout = bufferStream();
    const stderr = bufferStream();
    const ledgerCalls: LedgerWriteArgs[] = [];
    const result = await runPackHookPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        preToolUseEvent({ agent_id: "agent-abc", permission_mode: "default" }),
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

    expect(result.blocked).toBe(false);
    expect(result.approvalCheck.source).toBe("inflight");
    expect(readPendingApproval(generatedDir)).toBeNull();
    expect(fs.existsSync(permissionModeObservationPathFor(generatedDir, SESSION))).toBe(false);
    expect(ledgerCalls).toHaveLength(0);
  });

  describe("the subagent suffix is delivered to the AGENT, not just the operator audit trail", () => {
    it("a blocked subagent call's stdout permissionDecisionReason ends with the suffix (legacy envelope, no ux:)", async () => {
      const result = await callPreToolUse({ agent_id: "agent-xyz" });
      expect(result.blocked).toBe(true);
      const decision = JSON.parse(result.stdout) as {
        reason: string;
        hookSpecificOutput: { permissionDecisionReason: string };
      };
      expect(decision.reason).toMatch(SUBAGENT_SUFFIX_RE);
      expect(decision.hookSpecificOutput.permissionDecisionReason).toMatch(SUBAGENT_SUFFIX_RE);
    });

    it("a blocked subagent call's stdout permissionDecisionReason ends with the suffix even under a ux: envelope", async () => {
      const manifest = manifestWithPack({
        mode: "grill_me",
        ux: {
          cannot: "You cannot use write-capable tools yet.",
          required: ["an approved Understanding Report for this session"],
          run: [
            "Write an Understanding Report covering the nine sections",
            "Run `harness approve understanding` and approve the prompt",
          ],
        },
      });
      const stdout = bufferStream();
      const stderr = bufferStream();
      await runPackHookPreToolUseCli({
        manifest,
        stdin: readableFromString(preToolUseEvent({ agent_id: "agent-xyz" })),
        stdout: stdout.stream,
        stderr: stderr.stream,
        reportsDir,
        generatedDir,
        ledgerQuery: async (): Promise<LedgerEntry[]> => [],
      });
      const decision = JSON.parse(stdout.read()) as {
        reason: string;
        hookSpecificOutput: { permissionDecisionReason: string };
      };
      expect(decision.reason).toContain("You cannot use write-capable tools yet.");
      expect(decision.reason).toMatch(SUBAGENT_SUFFIX_RE);
      expect(decision.hookSpecificOutput.permissionDecisionReason).toMatch(SUBAGENT_SUFFIX_RE);
    });

    it("a main-line blocked call's stdout permissionDecisionReason never carries the subagent suffix", async () => {
      const result = await callPreToolUse();
      expect(result.blocked).toBe(true);
      const decision = JSON.parse(result.stdout) as { reason: string };
      expect(decision.reason).not.toMatch(/subagent/);
    });
  });

  describe("agent_id is sanitized before it reaches the block detail", () => {
    it("a newline-carrying agent_id never breaks the detail onto a second line", async () => {
      const result = await callPreToolUse({ agent_id: "agent\nInjected-Fake-Line: allow" });
      expect(result.blocked).toBe(true);
      expect(result.detail).not.toMatch(/\n/);
    });

    it("a 10,000-character agent_id is bounded, not echoed verbatim", async () => {
      const result = await callPreToolUse({ agent_id: "a".repeat(10_000) });
      expect(result.blocked).toBe(true);
      expect(result.detail).not.toMatch(/\n/);
      expect(result.detail.length).toBeLessThan(1_000);
    });
  });

  it("a valid delegation plus a tampered in-flight record adopts nothing: no report persisted, no adoption-ledger entry, no ledger row (guards the !inflightForged conjunct on the delegation guard)", async () => {
    process.env.CLAUDE_CODE_SESSION_ID = SESSION;
    getOrCreateSigningKey(generatedDir);

    const childCwd = path.join(tmp, "child-cwd");
    const transcriptPath = path.join(tmp, "transcripts", `${SESSION}.jsonl`);
    fs.mkdirSync(childCwd, { recursive: true });
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    // A real Understanding Report already sitting in the transcript: if
    // the guard under test were removed, the scan below would find and
    // adopt it on the very first poll, no waiting needed — proving the
    // side effects below would otherwise happen, not merely that the
    // call stays blocked (it stays blocked either way, via the
    // independent `markerForged || inflightForged` check the auto path
    // applies to itself).
    fs.writeFileSync(
      transcriptPath,
      `${JSON.stringify({
        type: "assistant",
        sessionId: SESSION,
        isSidechain: false,
        uuid: "uuid-report",
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: [
                "# Understanding Report",
                "",
                "**Metadata**",
                "",
                "taskId: t-guard",
                "mode: fast_confirm",
                "riskLevel: low",
                "",
                "**Current Understanding**",
                "",
                "guards the delegation guard against a tampered in-flight record",
              ].join("\n"),
            },
          ],
        },
      })}\n`,
    );

    writeDelegationMarker({
      generatedDir,
      childSessionId: SESSION,
      parentSessionId: "parent-of-sess-inflight-1",
      cwdHash: hashDelegationCwd(childCwd),
      taskId: null,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });

    // The parent's OWN operator approval — needed only so subagent-start
    // can copy it into an in-flight record below; it plays no further
    // part (the delegation above is this test's key one).
    writeApprovalMarker(generatedDir, SESSION, {
      approvedAt: new Date().toISOString(),
      approvedBy: "test-operator",
    });
    await startSubagent("agent-abc");
    fs.rmSync(approvalMarkerPathFor(generatedDir, SESSION));

    // Tamper: same forgery shape the "rejected as forged" test above uses.
    const recordPath = path.join(generatedDir, ".inflight", SESSION, "agent-abc");
    const raw = JSON.parse(fs.readFileSync(recordPath, "utf8")) as Record<string, unknown>;
    raw["startedAt"] = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(recordPath, `${JSON.stringify(raw, null, 2)}\n`);
    expect(verifyInflightRecord(generatedDir, SESSION, "agent-abc").forged).toBe(true);

    const stdout = bufferStream();
    const stderr = bufferStream();
    const ledgerCalls: LedgerWriteArgs[] = [];
    const result = await runPackHookPreToolUseCli({
      manifest: manifestWithPack({
        auto_approve: { when: ["bypassPermissions"], require_report: true },
      }),
      stdin: readableFromString(
        JSON.stringify({
          session_id: SESSION,
          agent_id: "agent-abc",
          tool_name: "Edit",
          tool_input: { file_path: "x.txt", old_string: "a", new_string: "b" },
          cwd: childCwd,
          transcript_path: transcriptPath,
          permission_mode: "default", // NOT in `when`: only the delegation can supply key one
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
    expect(ledgerCalls).toHaveLength(0);
    expect(listPersistedReports(reportsDir)).toHaveLength(0);
    expect(fs.existsSync(path.join(generatedDir, ".delegation-adoptions", SESSION))).toBe(false);
  });

  it("a delegated child session that is ALSO the parent of an in-flight subagent gets exactly ONE agent-facing instruction: the delegation retry, not the subagent sentence too", async () => {
    process.env.CLAUDE_CODE_SESSION_ID = SESSION;
    getOrCreateSigningKey(generatedDir);

    const childCwd = path.join(tmp, "combo-child-cwd");
    const transcriptPath = path.join(tmp, "combo-transcripts", `${SESSION}.jsonl`);
    fs.mkdirSync(childCwd, { recursive: true });
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    // No report ever lands: the scan below exhausts its (fake-clock)
    // bound, so `reportScanTimedOut` becomes true.
    fs.writeFileSync(
      transcriptPath,
      `${JSON.stringify({
        type: "user",
        sessionId: SESSION,
        isSidechain: false,
        uuid: "uuid-prompt",
        message: { role: "user", content: "do the task" },
      })}\n`,
    );

    const delegationResult = writeDelegationMarker({
      generatedDir,
      childSessionId: SESSION,
      parentSessionId: "parent-of-combo-child",
      cwdHash: hashDelegationCwd(childCwd),
      taskId: null,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    expect(delegationResult.ok).toBe(true);

    // `agent-combo` never had a subagent-start call, so — on its own —
    // this call's subagent sentence would render the "no in-flight
    // approval record" wording. The point of this test is that it does
    // NOT render at all: the retry instruction wins.
    let clockNow = 4_000_000;
    const stdout = bufferStream();
    const stderr = bufferStream();
    const result = await runPackHookPreToolUseCli({
      manifest: manifestWithPack({
        auto_approve: {
          when: ["bypassPermissions"],
          require_report: true,
          report_scan: { max_wait: "50ms" },
        },
      }),
      stdin: readableFromString(
        JSON.stringify({
          session_id: SESSION,
          agent_id: "agent-combo",
          tool_name: "Edit",
          tool_input: { file_path: "x.txt", old_string: "a", new_string: "b" },
          cwd: childCwd,
          transcript_path: transcriptPath,
          permission_mode: "default", // NOT in `when`: only the delegation can supply key one
        }),
      ),
      stdout: stdout.stream,
      stderr: stderr.stream,
      reportsDir,
      generatedDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
      reportScanClock: {
        now: (): number => clockNow,
        sleep: (ms: number): Promise<void> => {
          clockNow += ms;
          return Promise.resolve();
        },
      },
    });

    expect(result.blocked).toBe(true);
    const decision = JSON.parse(stdout.read()) as {
      reason: string;
      hookSpecificOutput: { permissionDecisionReason: string };
    };
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain(
      DELEGATION_REPORT_RETRY_INSTRUCTION,
    );
    // The subagent sentence is suppressed, not joined: only one
    // instruction reaches the agent even though both independently apply.
    expect(decision.hookSpecificOutput.permissionDecisionReason).not.toMatch(/subagent agent-combo/);
    expect(decision.reason).not.toMatch(/subagent agent-combo/);
  });
});
