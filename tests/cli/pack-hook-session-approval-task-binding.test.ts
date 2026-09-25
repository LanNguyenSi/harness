import { Readable, Writable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPackHookCodexPreToolUseCli } from "../../src/cli/pack/hook-codex-pre-tool-use.js";
import { runPackHookPostToolUseCli } from "../../src/cli/pack/hook-post-tool-use.js";
import { runPackHookPreToolUseCli } from "../../src/cli/pack/hook-pre-tool-use.js";
import { runPackHookTrackActiveClaimCli } from "../../src/cli/pack/hook-track-active-claim.js";
import type { LedgerEntry } from "../../src/policies/index.js";
import {
  approvalMarkerPathFor,
  checkOperatorApprovalMarkers,
  checkSessionApprovalMarker,
  readActiveClaim,
  writeActiveClaim,
  writeApprovalMarker,
  writeTaskApprovalMarker,
} from "../../src/policy-packs/builtin/understanding-before-execution-runtime.js";
import { signMarker } from "../../src/runtime/approval-signing.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

// Harness task 5018c0c4, operator decision "bind the session marker to the
// task": a task_finish that lands in review keeps the session approval,
// so the approval has to stop at the task boundary on its own. The
// session marker records the active-claim task id when it is written and
// the gate accepts it only while the active claim still names that task.
// This closes the out-of-band completion path (the task is merged or
// moved to done outside the session, where no PostToolUse hook can
// expire anything) independently of any hook seeing the completion.

const FIXTURE_PATH = path.join(
  __dirname,
  "..",
  "fixtures",
  "track-active-claim",
  "real-posttooluse-task-finish-2.1.280.json",
);
// The verbatim capture's own ids.
const SESSION = "redacted-session-id";
const TASK = "abc-123";
const OTHER = "other-999";

// The FULL scaffold's tool list, task_merge included.
const LIFECYCLE = {
  expire_on_tool_match: [
    "mcp__agent-tasks__task_finish",
    "mcp__agent-tasks__task_abandon",
    "mcp__agent-tasks__task_merge",
    "mcp__agent-tasks__pull_requests_merge",
    "mcp__agent-tasks__tasks_transition",
  ],
  max_age: "4h",
};

let tmp: string;
let generatedDir: string;
let reportsDir: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "CODEX_SESSION_ID"];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ug-task-binding-"));
  generatedDir = path.join(tmp, "harness.generated");
  reportsDir = path.join(tmp, "reports");
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function manifest(config: Record<string, unknown> = { approval_lifecycle: LIFECYCLE }): Manifest {
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

function loadFixture(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as Record<string, unknown>;
}

/** task_start through the real track-active-claim hook. */
async function taskStart(taskId: string): Promise<void> {
  const result = await runPackHookTrackActiveClaimCli({
    manifest: manifest(),
    stdin: readableFromString(
      JSON.stringify({
        session_id: SESSION,
        tool_name: "mcp__agent-tasks__task_start",
        tool_input: { taskId },
      }),
    ),
    stderr: bufferStream().stream,
    generatedDir,
  });
  expect(result.claimWritten).toBe(true);
  expect(readActiveClaim(generatedDir)).toBe(taskId);
}

/** The operator approves: the one writer records the active claim. */
function approve(): void {
  writeApprovalMarker(generatedDir, SESSION, {
    approvedAt: new Date().toISOString(),
    approvedBy: "test-operator",
  });
}

/** Replay a PostToolUse event through both PostToolUse hooks the pack ships. */
async function postToolUse(event: Record<string, unknown>): Promise<boolean> {
  await runPackHookTrackActiveClaimCli({
    manifest: manifest(),
    stdin: readableFromString(JSON.stringify(event)),
    stderr: bufferStream().stream,
    generatedDir,
  });
  const result = await runPackHookPostToolUseCli({
    manifest: manifest(),
    stdin: readableFromString(JSON.stringify(event)),
    stderr: bufferStream().stream,
    generatedDir,
    reportsDir,
  });
  return result.matchedExpiry;
}

/** One gated Edit through the real Claude PreToolUse hook. */
async function gatedEdit(): Promise<{ blocked: boolean; source: string; stderr: string }> {
  const stderr = bufferStream();
  const result = await runPackHookPreToolUseCli({
    manifest: manifest(),
    stdin: readableFromString(JSON.stringify({ session_id: SESSION, tool_name: "Edit" })),
    stdout: bufferStream().stream,
    stderr: stderr.stream,
    reportsDir,
    generatedDir,
    ledgerQuery: async (): Promise<LedgerEntry[]> => [],
  });
  return {
    blocked: result.blocked,
    source: result.approvalCheck.source,
    stderr: stderr.read(),
  };
}

/** A session marker as an older release wrote it: signed, no binding field. */
function writeLegacyUnboundMarker(): void {
  const filePath = approvalMarkerPathFor(generatedDir, SESSION);
  const signed = signMarker(generatedDir, SESSION, {
    approvedAt: new Date().toISOString(),
    approvedBy: "test-operator",
    reportContentHash: null,
  });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(signed, null, 2)}\n`);
}

describe("session approval marker bound to the claimed task (harness 5018c0c4)", () => {
  it("finish to review keeps the approval for the same task, but after an out-of-band done a task_start on another id blocks", async () => {
    await taskStart(TASK);
    approve();
    expect((await gatedEdit()).blocked).toBe(false);

    // The verbatim live capture: task_finish lands abc-123 in review. Both
    // markers survive (claim kept, approval kept) and the gate still opens.
    expect(await postToolUse(loadFixture())).toBe(false);
    expect(readActiveClaim(generatedDir)).toBe(TASK);
    expect(fs.existsSync(approvalMarkerPathFor(generatedDir, SESSION))).toBe(true);
    const sameTask = await gatedEdit();
    expect(sameTask.blocked).toBe(false);
    expect(sameTask.source).toBe("marker");

    // Out of band: a human merges in the UI, a webhook moves abc-123 to
    // done. No hook fires in this session, so nothing expires.
    // The agent claims the next task.
    await taskStart(OTHER);
    expect(fs.existsSync(approvalMarkerPathFor(generatedDir, SESSION))).toBe(true);

    const next = await gatedEdit();
    expect(next.blocked).toBe(true);
    expect(next.source).toBe("none");
    expect(next.stderr).toMatch(
      /BLOCK \S+ session approval for redacted-session-id belongs to another task: it was granted for task abc-123, the active claim is now task other-999/,
    );

    const markers = checkOperatorApprovalMarkers(generatedDir, SESSION, {
      approval_lifecycle: LIFECYCLE,
    });
    expect(markers).toMatchObject({
      matched: false,
      source: null,
      expired: false,
      forged: false,
      sessionBindingRefused: true,
    });
  });

  it("resuming the same task id opens the gate again with the same approval", async () => {
    await taskStart(TASK);
    approve();
    await taskStart(OTHER);
    expect((await gatedEdit()).blocked).toBe(true);

    await taskStart(TASK);
    const resumed = await gatedEdit();
    expect(resumed.blocked).toBe(false);
    expect(resumed.source).toBe("marker");
  });

  it("a legacy session marker without the binding field is refused, with or without a claim", async () => {
    writeLegacyUnboundMarker();
    const noClaim = await gatedEdit();
    expect(noClaim.blocked).toBe(true);
    expect(noClaim.stderr).toMatch(
      /session approval marker for redacted-session-id carries no task binding \(written by a harness release before approvals were bound to the claimed task\); approve once more to bind it to no claimed task/,
    );

    writeActiveClaim(generatedDir, TASK);
    const withClaim = await gatedEdit();
    expect(withClaim.blocked).toBe(true);
    expect(withClaim.stderr).toMatch(/carries no task binding/);

    // One fresh approve re-binds it.
    approve();
    expect((await gatedEdit()).blocked).toBe(false);
  });

  it("an approval granted while no task was claimed stops at the next task_start", async () => {
    approve();
    const solo = await gatedEdit();
    expect(solo.blocked).toBe(false);
    expect(solo.source).toBe("marker");

    await taskStart(TASK);
    const claimed = await gatedEdit();
    expect(claimed.blocked).toBe(true);
    expect(claimed.stderr).toMatch(
      /it was granted for no claimed task, the active claim is now task abc-123/,
    );
  });

  it("an approval for a task stops when the claim is released without a new one (session marker bound to a task, no claim now)", async () => {
    await taskStart(TASK);
    approve();
    fs.rmSync(path.join(generatedDir, "active-claim"));
    const r = checkSessionApprovalMarker(generatedDir, SESSION);
    expect(r.matched).toBe(false);
    expect(r.bindingRefused).toBe(true);
    expect(r.detail).toMatch(/granted for task abc-123, the active claim is now no claimed task/);
  });

  it("the binding is signed: changing or dropping it fails verification as a forgery", async () => {
    await taskStart(TASK);
    approve();
    const filePath = approvalMarkerPathFor(generatedDir, SESSION);
    const body = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    expect(body["claimTaskId"]).toBe(TASK);

    await taskStart(OTHER);
    fs.writeFileSync(filePath, `${JSON.stringify({ ...body, claimTaskId: OTHER })}\n`);
    const rebound = checkSessionApprovalMarker(generatedDir, SESSION);
    expect(rebound.matched).toBe(false);
    expect(rebound.forged).toBe(true);

    const { claimTaskId: _drop, ...unbound } = body;
    fs.writeFileSync(filePath, `${JSON.stringify(unbound)}\n`);
    const dropped = checkSessionApprovalMarker(generatedDir, SESSION);
    expect(dropped.matched).toBe(false);
    expect(dropped.forged).toBe(true);

    fs.writeFileSync(filePath, `${JSON.stringify({ ...body, claimTaskId: 7 })}\n`);
    const malformed = checkSessionApprovalMarker(generatedDir, SESSION);
    expect(malformed.forged).toBe(true);
    expect(malformed.detail).toMatch(/malformed claimTaskId/);
  });

  it("a marker bound to another task never reads as expired, even past max_age (the recovery-commit exemption stays closed)", async () => {
    await taskStart(TASK);
    writeApprovalMarker(generatedDir, SESSION, {
      approvedAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
      approvedBy: "test-operator",
    });
    expect(
      checkOperatorApprovalMarkers(generatedDir, SESSION, { approval_lifecycle: LIFECYCLE })
        .expired,
    ).toBe(true);

    await taskStart(OTHER);
    const other = checkOperatorApprovalMarkers(generatedDir, SESSION, {
      approval_lifecycle: LIFECYCLE,
    });
    expect(other.matched).toBe(false);
    expect(other.expired).toBe(false);
    expect(other.sessionBindingRefused).toBe(true);
  });

  it("the task-scoped marker keeps its semantics: a pre-approved task opens the gate while the session marker is bound elsewhere", async () => {
    await taskStart(TASK);
    approve();
    writeTaskApprovalMarker(generatedDir, OTHER, {
      approvedAt: new Date().toISOString(),
      approvedBy: "test-operator",
    });
    await taskStart(OTHER);
    const r = await gatedEdit();
    expect(r.blocked).toBe(false);
    expect(r.source).toBe("marker");
    expect(r.stderr).toMatch(/task-scoped marker for active-claim other-999/);
  });

  it("Codex PreToolUse blocks on the same binding refusal", async () => {
    await taskStart(TASK);
    approve();
    await taskStart(OTHER);
    const stderr = bufferStream();
    const result = await runPackHookCodexPreToolUseCli({
      manifest: manifest(),
      stdin: readableFromString(JSON.stringify({ session_id: SESSION, tool_name: "apply_patch" })),
      stderr: stderr.stream,
      reportsDir,
      generatedDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(true);
    expect(result.exitCode).toBe(2);
    expect(stderr.read()).toMatch(
      /session approval for redacted-session-id belongs to another task: it was granted for task abc-123, the active claim is now task other-999/,
    );

    await taskStart(TASK);
    const resumed = await runPackHookCodexPreToolUseCli({
      manifest: manifest(),
      stdin: readableFromString(JSON.stringify({ session_id: SESSION, tool_name: "apply_patch" })),
      stderr: bufferStream().stream,
      reportsDir,
      generatedDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(resumed.blocked).toBe(false);
  });
});
