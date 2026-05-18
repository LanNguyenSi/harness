import { Readable, Writable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPackHookPostToolUseCli } from "../../src/cli/pack/hook-post-tool-use.js";
import {
  approvalMarkerPathFor,
  taskApprovalMarkerPathFor,
  writeApprovalMarker,
  writeTaskApprovalMarker,
} from "../../src/policy-packs/builtin/understanding-before-execution-runtime.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ug-post-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function manifestWithPack(
  config: Record<string, unknown> = {},
  enabled = true,
): Manifest {
  return parseManifest({
    version: 1,
    policy_packs: [
      { name: "understanding-before-execution", enabled, config },
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

const eventBody = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    session_id: "sess-1",
    tool_name: "mcp__agent-tasks__task_finish",
    ...overrides,
  });

const DEFAULT_LIFECYCLE = {
  expire_on_tool_match: [
    "mcp__agent-tasks__task_finish",
    "mcp__agent-tasks__task_abandon",
    "mcp__agent-tasks__pull_requests_merge",
  ],
  max_age: "4h",
};

describe("pack hook post-tool-use marker-expiry (agent-tasks/d8ee60ca)", () => {
  it("deletes the approval marker when the just-completed tool matches the configured list", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-1", {
      approvedAt: "2026-05-17T08:00:00Z",
      approvedBy: "test-operator",
    });
    const markerPath = approvalMarkerPathFor(generatedDir, "sess-1");
    expect(fs.existsSync(markerPath)).toBe(true);

    const stderr = bufferStream();
    const result = await runPackHookPostToolUseCli({
      manifest: manifestWithPack({ approval_lifecycle: DEFAULT_LIFECYCLE }),
      stdin: readableFromString(eventBody()),
      stderr: stderr.stream,
      generatedDir,
    });
    expect(result.matchedExpiry).toBe(true);
    expect(result.markerCleared).toBe(true);
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(stderr.read()).toMatch(/expired approval marker for session sess-1/);
  });

  it("logs but does not blow up when the tool matches and no marker is present", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const stderr = bufferStream();
    const result = await runPackHookPostToolUseCli({
      manifest: manifestWithPack({ approval_lifecycle: DEFAULT_LIFECYCLE }),
      stdin: readableFromString(eventBody()),
      stderr: stderr.stream,
      generatedDir,
    });
    expect(result.matchedExpiry).toBe(true);
    expect(result.markerCleared).toBe(false);
    expect(stderr.read()).toMatch(
      /matched tool name but no marker present/,
    );
  });

  it("skips when the tool is not in expire_on_tool_match", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-1", {
      approvedAt: "2026-05-17T08:00:00Z",
      approvedBy: "test-operator",
    });
    const markerPath = approvalMarkerPathFor(generatedDir, "sess-1");
    const stderr = bufferStream();
    const result = await runPackHookPostToolUseCli({
      manifest: manifestWithPack({ approval_lifecycle: DEFAULT_LIFECYCLE }),
      stdin: readableFromString(eventBody({ tool_name: "Edit" })),
      stderr: stderr.stream,
      generatedDir,
    });
    expect(result.matchedExpiry).toBe(false);
    expect(result.markerCleared).toBe(false);
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(stderr.read()).toMatch(/tool Edit not in expire_on_tool_match/);
  });

  it("skips when the pack opted out via approval_lifecycle.mode = session", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-1", {
      approvedAt: "2026-05-17T08:00:00Z",
      approvedBy: "test-operator",
    });
    const stderr = bufferStream();
    const result = await runPackHookPostToolUseCli({
      manifest: manifestWithPack({ approval_lifecycle: { mode: "session" } }),
      stdin: readableFromString(eventBody()),
      stderr: stderr.stream,
      generatedDir,
    });
    expect(result.matchedExpiry).toBe(false);
    expect(result.markerCleared).toBe(false);
    expect(fs.existsSync(approvalMarkerPathFor(generatedDir, "sess-1"))).toBe(true);
    expect(stderr.read()).toMatch(/legacy-session mode/);
  });

  it("skips when the pack is disabled", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-1", {
      approvedAt: "2026-05-17T08:00:00Z",
      approvedBy: "test-operator",
    });
    const stderr = bufferStream();
    const result = await runPackHookPostToolUseCli({
      manifest: manifestWithPack({ approval_lifecycle: DEFAULT_LIFECYCLE }, false),
      stdin: readableFromString(eventBody()),
      stderr: stderr.stream,
      generatedDir,
    });
    expect(result.matchedExpiry).toBe(false);
    expect(result.markerCleared).toBe(false);
    expect(fs.existsSync(approvalMarkerPathFor(generatedDir, "sess-1"))).toBe(true);
    expect(stderr.read()).toMatch(/is enabled:false/);
  });

  it("skips on malformed event JSON without throwing", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const stderr = bufferStream();
    const result = await runPackHookPostToolUseCli({
      manifest: manifestWithPack({ approval_lifecycle: DEFAULT_LIFECYCLE }),
      stdin: readableFromString("not json"),
      stderr: stderr.stream,
      generatedDir,
    });
    expect(result.matchedExpiry).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(stderr.read()).toMatch(/malformed event JSON/);
  });

  it("skips on missing session_id without throwing", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const stderr = bufferStream();
    const result = await runPackHookPostToolUseCli({
      manifest: manifestWithPack({ approval_lifecycle: DEFAULT_LIFECYCLE }),
      stdin: readableFromString(JSON.stringify({ tool_name: "mcp__agent-tasks__task_finish" })),
      stderr: stderr.stream,
      generatedDir,
    });
    expect(result.matchedExpiry).toBe(false);
    expect(stderr.read()).toMatch(/missing session_id/);
  });
});

describe("pack hook post-tool-use marker-expiry: expire_on_bash_match (harness/f54e0ecb)", () => {
  const BASH_LIFECYCLE = {
    expire_on_bash_match: ["^gh pr (merge|close)\\b", "^git push origin (master|main)\\b"],
  };
  const bashEvent = (command: string): string =>
    JSON.stringify({
      session_id: "sess-1",
      tool_name: "Bash",
      tool_input: { command },
    });

  it("deletes the marker when a Bash command matches an expire_on_bash_match regex", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-1", {
      approvedAt: "2026-05-17T08:00:00Z",
      approvedBy: "test-operator",
    });
    const stderr = bufferStream();
    const result = await runPackHookPostToolUseCli({
      manifest: manifestWithPack({ approval_lifecycle: BASH_LIFECYCLE }),
      stdin: readableFromString(bashEvent("gh pr merge 42 --squash")),
      stderr: stderr.stream,
      generatedDir,
    });
    expect(result.matchedExpiry).toBe(true);
    expect(result.markerCleared).toBe(true);
    expect(fs.existsSync(approvalMarkerPathFor(generatedDir, "sess-1"))).toBe(false);
    expect(stderr.read()).toMatch(/bash regex \/\^gh pr/);
  });

  it("no-ops when the Bash command does not match any regex", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-1", {
      approvedAt: "2026-05-17T08:00:00Z",
      approvedBy: "test-operator",
    });
    const stderr = bufferStream();
    const result = await runPackHookPostToolUseCli({
      manifest: manifestWithPack({ approval_lifecycle: BASH_LIFECYCLE }),
      stdin: readableFromString(bashEvent("git status")),
      stderr: stderr.stream,
      generatedDir,
    });
    expect(result.matchedExpiry).toBe(false);
    expect(result.markerCleared).toBe(false);
    expect(fs.existsSync(approvalMarkerPathFor(generatedDir, "sess-1"))).toBe(true);
    expect(stderr.read()).toMatch(/Bash command did not match/);
  });

  it("ignores expire_on_bash_match when the tool is NOT Bash", async () => {
    // An MCP tool whose name happens to match a regex must NOT trigger
    // the bash branch, which is event-scoped to actual Bash only.
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-1", {
      approvedAt: "2026-05-17T08:00:00Z",
      approvedBy: "test-operator",
    });
    const stderr = bufferStream();
    const result = await runPackHookPostToolUseCli({
      manifest: manifestWithPack({ approval_lifecycle: BASH_LIFECYCLE }),
      // A non-Bash tool name that, if accidentally subjected to regex
      // match, would look like "gh pr merge ...".
      stdin: readableFromString(
        JSON.stringify({
          session_id: "sess-1",
          tool_name: "mcp__unrelated__verb",
          tool_input: { command: "gh pr merge 42" },
        }),
      ),
      stderr: stderr.stream,
      generatedDir,
    });
    expect(result.matchedExpiry).toBe(false);
    expect(fs.existsSync(approvalMarkerPathFor(generatedDir, "sess-1"))).toBe(true);
  });

  it("combines with expire_on_tool_match: either source matches", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-1", {
      approvedAt: "2026-05-17T08:00:00Z",
      approvedBy: "test-operator",
    });
    const stderr = bufferStream();
    const result = await runPackHookPostToolUseCli({
      manifest: manifestWithPack({
        approval_lifecycle: {
          expire_on_tool_match: ["mcp__agent-tasks__task_finish"],
          expire_on_bash_match: ["^gh pr merge\\b"],
        },
      }),
      stdin: readableFromString(bashEvent("gh pr merge 99")),
      stderr: stderr.stream,
      generatedDir,
    });
    expect(result.matchedExpiry).toBe(true);
    expect(result.markerCleared).toBe(true);
  });

  it("invalid regex pattern is dropped at parse time, others still match", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-1", {
      approvedAt: "2026-05-17T08:00:00Z",
      approvedBy: "test-operator",
    });
    const stderr = bufferStream();
    const result = await runPackHookPostToolUseCli({
      manifest: manifestWithPack({
        approval_lifecycle: {
          expire_on_bash_match: ["[unclosed-character-class", "^gh pr merge\\b"],
        },
      }),
      stdin: readableFromString(bashEvent("gh pr merge 1")),
      stderr: stderr.stream,
      generatedDir,
    });
    expect(result.matchedExpiry).toBe(true);
    const stderrText = stderr.read();
    expect(stderrText).toMatch(/expire_on_bash_match entry ignored/);
    expect(stderrText).toMatch(/expired approval marker/);
  });
});

describe("pack hook post-tool-use — task-scoped marker cleanup (harness/1ee26e77)", () => {
  it("clears a task-scoped marker when tool_input.taskId is present and a marker exists for it", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-1", {
      approvedAt: "2026-05-18T08:00:00Z",
      approvedBy: "test-operator",
    });
    writeTaskApprovalMarker(generatedDir, "task-uuid-abc", {
      approvedAt: "2026-05-18T08:00:00Z",
      approvedBy: "test-operator",
    });
    const stderr = bufferStream();

    const result = await runPackHookPostToolUseCli({
      manifest: manifestWithPack({ approval_lifecycle: DEFAULT_LIFECYCLE }),
      stdin: readableFromString(
        eventBody({ tool_input: { taskId: "task-uuid-abc" } }),
      ),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.matchedExpiry).toBe(true);
    expect(result.markerCleared).toBe(true);
    expect(result.taskMarkerCleared).toBe(true);
    // Both files are gone.
    expect(
      fs.existsSync(approvalMarkerPathFor(generatedDir, "sess-1")),
    ).toBe(false);
    expect(
      fs.existsSync(taskApprovalMarkerPathFor(generatedDir, "task-uuid-abc")),
    ).toBe(false);
    expect(stderr.read()).toMatch(/also cleared task marker for task task-uuid-abc/);
  });

  it("leaves the task-scoped marker untouched when tool_input.taskId is absent", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-1", {
      approvedAt: "2026-05-18T08:00:00Z",
      approvedBy: "test-operator",
    });
    writeTaskApprovalMarker(generatedDir, "task-uuid-xyz", {
      approvedAt: "2026-05-18T08:00:00Z",
      approvedBy: "test-operator",
    });
    const stderr = bufferStream();

    const result = await runPackHookPostToolUseCli({
      manifest: manifestWithPack({ approval_lifecycle: DEFAULT_LIFECYCLE }),
      stdin: readableFromString(eventBody()), // no tool_input
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.matchedExpiry).toBe(true);
    expect(result.markerCleared).toBe(true);
    expect(result.taskMarkerCleared).toBe(false);
    // Session marker cleared, task marker preserved.
    expect(
      fs.existsSync(approvalMarkerPathFor(generatedDir, "sess-1")),
    ).toBe(false);
    expect(
      fs.existsSync(taskApprovalMarkerPathFor(generatedDir, "task-uuid-xyz")),
    ).toBe(true);
  });

  it("flips the persisted report from approved to expired when the matched tool fires (closes the bypass introduced in PR #172)", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-1", {
      approvedAt: "2026-05-18T08:00:00Z",
      approvedBy: "test-operator",
    });
    // Reports dir is a sibling of generatedDir.
    const reportsDir = path.join(tmp, "reports");
    fs.mkdirSync(reportsDir, { recursive: true });
    const reportPath = path.join(reportsDir, "rpt-sess-1.json");
    fs.writeFileSync(
      reportPath,
      `${JSON.stringify(
        {
          sessionId: "sess-1",
          approvalStatus: "approved",
          approvedAt: "2026-05-18T08:00:00Z",
          approvedBy: "test-operator",
          body: "the operator's actual understanding text",
        },
        null,
        2,
      )}\n`,
    );

    const stderr = bufferStream();
    const result = await runPackHookPostToolUseCli({
      manifest: manifestWithPack({ approval_lifecycle: DEFAULT_LIFECYCLE }),
      stdin: readableFromString(eventBody()),
      stderr: stderr.stream,
      generatedDir,
      reportsDir,
      now: new Date("2026-05-18T10:00:00Z"),
    });

    expect(result.matchedExpiry).toBe(true);
    expect(result.markerCleared).toBe(true);
    expect(result.persistedReportExpired).toBe(true);

    const after = JSON.parse(fs.readFileSync(reportPath, "utf8")) as Record<string, unknown>;
    expect(after.approvalStatus).toBe("expired");
    expect(after.expiredAt).toBe("2026-05-18T10:00:00.000Z");
    // Operator's report body preserved for audit.
    expect(after.body).toBe("the operator's actual understanding text");
    expect(after.approvedAt).toBe("2026-05-18T08:00:00Z");
    expect(stderr.read()).toMatch(/expired persisted report/);
  });

  it("degrades gracefully when no persisted report exists for the session", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-1", {
      approvedAt: "2026-05-18T08:00:00Z",
      approvedBy: "test-operator",
    });
    const reportsDir = path.join(tmp, "empty-reports");

    const stderr = bufferStream();
    const result = await runPackHookPostToolUseCli({
      manifest: manifestWithPack({ approval_lifecycle: DEFAULT_LIFECYCLE }),
      stdin: readableFromString(eventBody()),
      stderr: stderr.stream,
      generatedDir,
      reportsDir,
    });

    expect(result.matchedExpiry).toBe(true);
    expect(result.markerCleared).toBe(true);
    expect(result.persistedReportExpired).toBe(false);
    expect(stderr.read()).toMatch(/persisted-report expiry skipped \(no reports/);
  });

  it("is idempotent: a second post-tool-use call on an already-expired report does not re-touch it", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    fs.mkdirSync(reportsDir, { recursive: true });
    const reportPath = path.join(reportsDir, "rpt-sess-1.json");
    fs.writeFileSync(
      reportPath,
      `${JSON.stringify({ sessionId: "sess-1", approvalStatus: "expired" }, null, 2)}\n`,
    );

    const stderr = bufferStream();
    const result = await runPackHookPostToolUseCli({
      manifest: manifestWithPack({ approval_lifecycle: DEFAULT_LIFECYCLE }),
      stdin: readableFromString(eventBody()),
      stderr: stderr.stream,
      generatedDir,
      reportsDir,
    });

    expect(result.persistedReportExpired).toBe(false);
    expect(stderr.read()).toMatch(/persisted-report expiry skipped/);
    // File untouched.
    const after = JSON.parse(fs.readFileSync(reportPath, "utf8")) as Record<string, unknown>;
    expect(after.approvalStatus).toBe("expired");
  });

  it("leaves the task-scoped marker untouched when the matched event is a Bash regex boundary (no taskId on Bash)", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-1", {
      approvedAt: "2026-05-18T08:00:00Z",
      approvedBy: "test-operator",
    });
    writeTaskApprovalMarker(generatedDir, "task-uuid-still-active", {
      approvedAt: "2026-05-18T08:00:00Z",
      approvedBy: "test-operator",
    });
    const stderr = bufferStream();

    const result = await runPackHookPostToolUseCli({
      manifest: manifestWithPack({
        approval_lifecycle: {
          expire_on_bash_match: ["^gh pr merge\\b"],
        },
      }),
      stdin: readableFromString(
        JSON.stringify({
          session_id: "sess-1",
          tool_name: "Bash",
          tool_input: { command: "gh pr merge 1", taskId: "decoy-should-be-ignored" },
        }),
      ),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.matchedExpiry).toBe(true);
    expect(result.markerCleared).toBe(true);
    // taskId on a Bash event is ignored by design (only toolNameMatched
    // triggers task-scoped cleanup).
    expect(result.taskMarkerCleared).toBe(false);
    expect(
      fs.existsSync(taskApprovalMarkerPathFor(generatedDir, "task-uuid-still-active")),
    ).toBe(true);
    expect(
      fs.existsSync(taskApprovalMarkerPathFor(generatedDir, "decoy-should-be-ignored")),
    ).toBe(false);
  });
});

describe("pack hook post-tool-use — tasks_transition v1 status filter (PR #200)", () => {
  const LIFECYCLE_WITH_TASKS_TRANSITION = {
    expire_on_tool_match: [
      "mcp__agent-tasks__task_finish",
      "mcp__agent-tasks__tasks_transition",
    ],
    max_age: "4h",
  };

  it("clears session + task markers on tasks_transition status=done", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-1", {
      approvedAt: "2026-05-18T08:00:00Z",
      approvedBy: "test-operator",
    });
    writeTaskApprovalMarker(generatedDir, "task-uuid-abc", {
      approvedAt: "2026-05-18T08:00:00Z",
      approvedBy: "test-operator",
    });
    const stderr = bufferStream();

    const result = await runPackHookPostToolUseCli({
      manifest: manifestWithPack({ approval_lifecycle: LIFECYCLE_WITH_TASKS_TRANSITION }),
      stdin: readableFromString(
        JSON.stringify({
          session_id: "sess-1",
          tool_name: "mcp__agent-tasks__tasks_transition",
          tool_input: { taskId: "task-uuid-abc", status: "done" },
        }),
      ),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.matchedExpiry).toBe(true);
    expect(result.markerCleared).toBe(true);
    expect(result.taskMarkerCleared).toBe(true);
    expect(fs.existsSync(approvalMarkerPathFor(generatedDir, "sess-1"))).toBe(false);
    expect(
      fs.existsSync(taskApprovalMarkerPathFor(generatedDir, "task-uuid-abc")),
    ).toBe(false);
  });

  it("is a no-op on tasks_transition status=review (work claim kept per v2 docs)", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-1", {
      approvedAt: "2026-05-18T08:00:00Z",
      approvedBy: "test-operator",
    });
    writeTaskApprovalMarker(generatedDir, "task-uuid-abc", {
      approvedAt: "2026-05-18T08:00:00Z",
      approvedBy: "test-operator",
    });
    const stderr = bufferStream();

    const result = await runPackHookPostToolUseCli({
      manifest: manifestWithPack({ approval_lifecycle: LIFECYCLE_WITH_TASKS_TRANSITION }),
      stdin: readableFromString(
        JSON.stringify({
          session_id: "sess-1",
          tool_name: "mcp__agent-tasks__tasks_transition",
          tool_input: { taskId: "task-uuid-abc", status: "review" },
        }),
      ),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.matchedExpiry).toBe(false);
    expect(result.markerCleared).toBe(false);
    expect(fs.existsSync(approvalMarkerPathFor(generatedDir, "sess-1"))).toBe(true);
    expect(
      fs.existsSync(taskApprovalMarkerPathFor(generatedDir, "task-uuid-abc")),
    ).toBe(true);
    expect(stderr.read()).toMatch(/tasks_transition status keeps work claim/);
  });

  it("is a no-op on tasks_transition status=in_progress", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-1", {
      approvedAt: "2026-05-18T08:00:00Z",
      approvedBy: "test-operator",
    });
    const stderr = bufferStream();

    const result = await runPackHookPostToolUseCli({
      manifest: manifestWithPack({ approval_lifecycle: LIFECYCLE_WITH_TASKS_TRANSITION }),
      stdin: readableFromString(
        JSON.stringify({
          session_id: "sess-1",
          tool_name: "mcp__agent-tasks__tasks_transition",
          tool_input: { taskId: "task-uuid-abc", status: "in_progress" },
        }),
      ),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.matchedExpiry).toBe(false);
    expect(fs.existsSync(approvalMarkerPathFor(generatedDir, "sess-1"))).toBe(true);
  });

  it("is a no-op on tasks_transition with missing status (defensive)", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-1", {
      approvedAt: "2026-05-18T08:00:00Z",
      approvedBy: "test-operator",
    });
    const stderr = bufferStream();

    const result = await runPackHookPostToolUseCli({
      manifest: manifestWithPack({ approval_lifecycle: LIFECYCLE_WITH_TASKS_TRANSITION }),
      stdin: readableFromString(
        JSON.stringify({
          session_id: "sess-1",
          tool_name: "mcp__agent-tasks__tasks_transition",
          tool_input: { taskId: "task-uuid-abc" },
        }),
      ),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.matchedExpiry).toBe(false);
    expect(fs.existsSync(approvalMarkerPathFor(generatedDir, "sess-1"))).toBe(true);
  });

  it("is a no-op on tasks_transition when tool_input is malformed (non-object)", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-1", {
      approvedAt: "2026-05-18T08:00:00Z",
      approvedBy: "test-operator",
    });
    const stderr = bufferStream();

    const result = await runPackHookPostToolUseCli({
      manifest: manifestWithPack({ approval_lifecycle: LIFECYCLE_WITH_TASKS_TRANSITION }),
      stdin: readableFromString(
        JSON.stringify({
          session_id: "sess-1",
          tool_name: "mcp__agent-tasks__tasks_transition",
          tool_input: "not-an-object",
        }),
      ),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.matchedExpiry).toBe(false);
    expect(fs.existsSync(approvalMarkerPathFor(generatedDir, "sess-1"))).toBe(true);
  });
});
