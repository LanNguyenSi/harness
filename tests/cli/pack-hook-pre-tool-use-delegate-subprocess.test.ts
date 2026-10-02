// E2E subprocess tests for the slice-3 DELEGATION path of
// `harness pack hook pre-tool-use` (ADR
// docs/decisions/2026-08-27-ug-auto-mode-approval.md, agent-tasks
// 37ad0b05).
//
// BUILD PREREQUISITE, like its sibling
// tests/cli/pack-hook-pre-tool-use-subprocess.test.ts: these spawn the
// REAL built CLI at `dist/cli/main.js`, so `npm run build` must have run
// against the current sources first. A stale `dist/` tests the previous
// revision, silently.
//
// WHY A SUBPROCESS FOR THIS PATH SPECIFICALLY. The in-process suite
// (pack-hook-pre-tool-use-delegate.test.ts) injects a fake clock and a
// fake sleep, so the transcript poll never touches the real event loop.
// That is what makes it fast and deterministic, and it is also exactly
// what hid the failure this file exists to catch: an `unref`'d poll timer
// let the real hook process EXIT in the middle of the bounded wait, with
// stdin already drained and no other ref'd handle. The process ended with
// exit 0 and an EMPTY stdout, which Claude Code reads as ALLOW, on
// precisely the delegation path the gate is supposed to be strictest on.
// Only a real process, a real timer and a real sleep can observe that, so
// these two cases run against the built binary with no injection at all.
//
// Home-dir isolation follows the sibling's recipe: `--config <tmp>/harness.yaml`
// plus `HARNESS_HOME` and `UNDERSTANDING_GATE_REPORT_DIR` under the tmp
// dir, so the child reads and writes only there. `harness.generated/`
// resolves next to the named manifest, which is where the signing key and
// the delegation are planted.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DELEGATION_REPORT_RETRY_INSTRUCTION } from "../../src/cli/pack/hook-pre-tool-use.js";
import { checkApprovalMarker } from "../../src/policy-packs/builtin/understanding-before-execution-runtime.js";
import {
  hashDelegationCwd,
  writeDelegationMarker,
} from "../../src/policy-packs/builtin/understanding-before-execution/delegation-markers.js";
import { DEFAULT_REPORT_SCAN_MAX_WAIT_MS } from "../../src/policy-packs/builtin/understanding-before-execution/auto-approve.js";
import { getOrCreateSigningKey } from "../../src/runtime/approval-signing.js";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..", "..");
const MAIN_JS = path.join(REPO_ROOT, "dist", "cli", "main.js");

const CHILD = "child-e2e-4444";
const PARENT = "parent-e2e-1111";

// Opted in, and `when` lists a mode the payloads below never carry: the
// DELEGATION is the only thing that can supply key one here, exactly as
// in the in-process suite. `report_scan.max_wait` is left absent so the
// real default bound is what the block case actually waits out.
const MANIFEST = `version: 1
policy_packs:
  - name: understanding-before-execution
    enabled: true
    config:
      auto_approve:
        when: [bypassPermissions]
        harnesses: [claude-code]
        require_report: true
hooks: []
policies: []
tools:
  builtin:
    known: [Bash, Edit, Write]
`;

/**
 * A full grill_me-shaped Understanding Report under a level-one heading.
 * Deliberately the same shape as the in-process suite's fixture: the
 * capture path validates it with the approve CLI's own validator, which
 * short-circuits for a fast_confirm report and would not be exercised by
 * anything lighter.
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
  "- the built CLI emits a decision on stdout instead of exiting silently",
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
  "- the poll timer lets the hook process exit before it decides",
  "",
  "**Verification Plan**",
  "",
  "- spawn the built CLI and assert stdout is not empty",
  "",
  "**Prior Art**",
  "",
  "- reused the sibling subprocess suite's spawn/isolation recipe rather than writing a second one",
].join("\n");

let tmpDir: string;
let configPath: string;
let generatedDir: string;
let reportsDir: string;
let childCwd: string;
let transcriptPath: string;

function assistantEntry(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "assistant",
    sessionId: CHILD,
    isSidechain: false,
    uuid: "uuid-e2e-report",
    timestamp: "2026-08-28T09:00:00.000Z",
    message: { role: "assistant", content: [{ type: "text", text: CHILD_REPORT_MARKDOWN }] },
    ...over,
  });
}

function userTurn(): string {
  return JSON.stringify({
    type: "user",
    sessionId: CHILD,
    isSidechain: false,
    uuid: "uuid-e2e-prompt",
    message: { role: "user", content: "do the task" },
  });
}

function writeTranscript(lines: string[]): void {
  fs.writeFileSync(transcriptPath, `${lines.join("\n")}\n`);
}

beforeAll(() => {
  if (!fs.existsSync(MAIN_JS)) {
    throw new Error(`${MAIN_JS} is missing: run \`npm run build\` before this suite`);
  }
});

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ug-delegate-e2e-"));
  configPath = path.join(tmpDir, "harness.yaml");
  generatedDir = path.join(tmpDir, "harness.generated");
  reportsDir = path.join(tmpDir, "reports");
  childCwd = path.join(tmpDir, "child-cwd");
  transcriptPath = path.join(tmpDir, "transcripts", `${CHILD}.jsonl`);
  fs.mkdirSync(childCwd, { recursive: true });
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.writeFileSync(configPath, MANIFEST, "utf8");

  // Operator-side act, done explicitly: the hook never creates the key.
  getOrCreateSigningKey(generatedDir);
  const delegation = writeDelegationMarker({
    generatedDir,
    childSessionId: CHILD,
    parentSessionId: PARENT,
    cwdHash: hashDelegationCwd(childCwd),
    taskId: null,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  expect(delegation.ok).toBe(true);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runHook(timeoutMs = 30_000): {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
} {
  const childEnv = { ...process.env };
  delete childEnv["CLAUDE_SESSION_ID"];
  delete childEnv["UNDERSTANDING_GATE_MODE"];
  // The session-consistency check holds the payload's session_id against
  // this, so the child's own hook environment carries the child's id.
  childEnv["CLAUDE_CODE_SESSION_ID"] = CHILD;
  childEnv["HARNESS_HOME"] = path.join(tmpDir, "home");
  childEnv["UNDERSTANDING_GATE_REPORT_DIR"] = reportsDir;

  const payload = JSON.stringify({
    session_id: CHILD,
    tool_name: "Edit",
    tool_input: { file_path: path.join(childCwd, "file.ts"), old_string: "x", new_string: "y" },
    cwd: childCwd,
    transcript_path: transcriptPath,
    // NOT in `auto_approve.when`: only the delegation can supply key one.
    permission_mode: "default",
  });

  const result = spawnSync(
    "node",
    [MAIN_JS, "pack", "hook", "pre-tool-use", "--config", configPath],
    // A hook stuck in a blocking open() is killed outright at the timeout.
    { input: payload, encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", env: childEnv },
  );
  return {
    status: result.status,
    stdout: result.stdout as string,
    stderr: result.stderr as string,
    timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
  };
}

describe("pack hook pre-tool-use: delegation path, subprocess E2E", () => {
  it("emits the block/deny envelope after the REAL bounded poll when the child's report never lands", () => {
    // The report-less transcript makes the hook wait out the full default
    // bound on a real timer. The load-bearing assertion is the first one:
    // an empty stdout here would be read as ALLOW by Claude Code, which is
    // what an `unref`'d poll timer produces (the process exits mid-wait).
    writeTranscript([userTurn()]);

    const startedAt = Date.now();
    const { status, stdout, stderr } = runHook();
    const elapsedMs = Date.now() - startedAt;

    expect(status).toBe(0);
    expect(stdout.trim()).not.toBe("");
    const decision = JSON.parse(stdout.trim()) as {
      decision?: string;
      reason?: string;
      hookSpecificOutput?: { hookEventName?: string; permissionDecision?: string };
    };
    expect(decision.decision).toBe("block");
    expect(decision.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(decision.hookSpecificOutput?.hookEventName).toBe("PreToolUse");
    // The repeated-retry instruction, byte-for-byte: this block is the one
    // the child can act on alone.
    expect(decision.reason).toContain(DELEGATION_REPORT_RETRY_INSTRUCTION);
    // A literal, independent check on the instruction's actual wording,
    // not just a re-comparison of the imported constant against itself:
    // the retry sentence must ask for the schema's real heading rule.
    expect(decision.reason).toContain("any heading level");
    // The poll really ran and really timed out, rather than the call
    // blocking for some earlier reason.
    expect(stderr).toMatch(/reached its transcript within/);
    expect(checkApprovalMarker(generatedDir, CHILD).matched).toBe(false);
    // WALL-TIME FLOOR: a block that comes back near-instantly proves the
    // poll never really ran (e.g. the hook process exiting mid-wait, or a
    // future change that skips the poll on this path) even though the
    // decision envelope above looks correct. A small tolerance absorbs
    // process start/stop and JSON overhead; the suite's own configured
    // bound is the floor, not a value hardcoded here.
    expect(elapsedMs).toBeGreaterThanOrEqual(DEFAULT_REPORT_SCAN_MAX_WAIT_MS - 50);
  });

  it("captures the child's own report from the real transcript and allows with a parent-linked marker", () => {
    writeTranscript([userTurn(), assistantEntry()]);

    const { status, stdout, stderr } = runHook();

    expect(status).toBe(0);
    // The allow envelope: this hook writes nothing to stdout when it allows.
    expect(stdout.trim()).toBe("");
    expect(stderr).toMatch(/captured the Understanding Report for session .* from its own transcript/);

    const check = checkApprovalMarker(generatedDir, CHILD);
    expect(check.matched).toBe(true);
    expect(check.forged).toBe(false);
    expect(check.marker?.approvedBy).toBe(
      `auto-mode:claude-code:delegated;delegated:${PARENT}`,
    );
  });

  // The delegation lookup lists the reports directory too, before it decides
  // whether the child's report still has to be captured. It reads through the
  // bounded reader, so an entry it cannot read is no report there: the
  // capture from the transcript still runs. (Read whole, a 2 MiB pending
  // report of the child would stand in for the missing one and the capture
  // would not run at all.) The auto-approval precondition that follows lists
  // the same directory, skips the same entry and declines, so the call stays
  // blocked: a skipped entry is never a reason to mint.
  it("an oversized pending report of the child (over the 1 MiB cap) is skipped by the delegation lookup: the capture still runs, the auto-approval declines and no marker is minted", () => {
    writeTranscript([userTurn(), assistantEntry()]);
    fs.writeFileSync(
      path.join(reportsDir, "zz-big-pending.json"),
      JSON.stringify({
        sessionId: CHILD,
        approvalStatus: "pending",
        createdAt: new Date().toISOString(),
        mode: "grill_me",
      }) + " ".repeat(2 * 1024 * 1024),
    );

    const { status, stdout, stderr, timedOut } = runHook(20_000);

    expect(timedOut).toBe(false);
    expect(status).toBe(0);
    expect(stderr).toMatch(/captured the Understanding Report for session .* from its own transcript/);
    expect(stderr).toMatch(/auto-approval declined: report invalid \(\d+ bytes, over the 1048576-byte cap/);
    expect((JSON.parse(stdout.trim()) as { decision?: string }).decision).toBe("block");
    expect(checkApprovalMarker(generatedDir, CHILD).matched).toBe(false);
  });

  it("a FIFO named *.json with no writer is skipped by the delegation lookup within the bound: the capture still runs, the auto-approval declines and no marker is minted", () => {
    writeTranscript([userTurn(), assistantEntry()]);
    execFileSync("mkfifo", [path.join(reportsDir, "zz-fifo.json")]);

    const { status, stdout, stderr, timedOut } = runHook(20_000);

    // A blocking open() of the FIFO would wait for a writer forever; the
    // child is killed at the bound and the run reports it as timed out.
    expect(timedOut).toBe(false);
    expect(status).toBe(0);
    expect(stderr).toMatch(/captured the Understanding Report for session .* from its own transcript/);
    expect(stderr).toMatch(/auto-approval declined: report listing skipped 1 unreadable entry/);
    expect((JSON.parse(stdout.trim()) as { decision?: string }).decision).toBe("block");
    expect(checkApprovalMarker(generatedDir, CHILD).matched).toBe(false);
  });
});
