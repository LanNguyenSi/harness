// Task a1348c89 — Codex PostToolUse marker-expiry parity.
//
// Mirrors tests/cli/pack-hook-post-tool-use.test.ts (the Claude sibling)
// so the two suites can be diffed to confirm identical tool-boundary
// coverage, plus Codex-specific additions: the `tool`/`tool_name` and
// `tool_input`/`raw_input` synonyms, the multi-alias shell surface
// (Bash/shell/exec_command/functions.exec_command), the $CODEX_SESSION_ID
// fallback, and an integration "must-pass control" proving the expiry
// actually re-locks the PreToolUse blocker (not just a marker-file no-op).

import { Readable, Writable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPackHookCodexPostToolUseCli } from "../../src/cli/pack/hook-codex-post-tool-use.js";
import { runPackHookCodexPreToolUseCli } from "../../src/cli/pack/hook-codex-pre-tool-use.js";
import {
  approvalMarkerPathFor,
  taskApprovalMarkerPathFor,
  writeApprovalMarker,
  writeTaskApprovalMarker,
} from "../../src/policy-packs/builtin/understanding-before-execution-runtime.js";
import { writeSentinel } from "../../src/runtime/pause-sentinel.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

let tmp: string;
let savedClaude: string | undefined;
let savedClaudeCode: string | undefined;
let savedCodex: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ug-codex-post-"));
  // The hook reads all three env vars as session-id fallbacks; clear them
  // so the dev host's ambient session ids don't bleed into tests.
  savedClaude = process.env.CLAUDE_SESSION_ID;
  savedClaudeCode = process.env.CLAUDE_CODE_SESSION_ID;
  savedCodex = process.env.CODEX_SESSION_ID;
  delete process.env.CLAUDE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CODEX_SESSION_ID;
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

describe("pack hook codex-post-tool-use marker-expiry (task a1348c89)", () => {
  it("deletes the approval marker when the just-completed tool matches the configured list (tool_input field)", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-1", {
      approvedAt: "2026-07-01T08:00:00Z",
      approvedBy: "test-operator",
    });
    const markerPath = approvalMarkerPathFor(generatedDir, "sess-1");
    expect(fs.existsSync(markerPath)).toBe(true);

    const stderr = bufferStream();
    const result = await runPackHookCodexPostToolUseCli({
      manifest: manifestWithPack({ approval_lifecycle: DEFAULT_LIFECYCLE }),
      stdin: readableFromString(eventBody({ tool_input: {} })),
      stderr: stderr.stream,
      generatedDir,
    });
    expect(result.matchedExpiry).toBe(true);
    expect(result.markerCleared).toBe(true);
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(stderr.read()).toMatch(/expired approval marker for session sess-1/);
  });

  it("resolves the tool arguments from raw_input when tool_input is absent (harness-published shim compatibility)", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-1", {
      approvedAt: "2026-07-01T08:00:00Z",
      approvedBy: "test-operator",
    });
    const stderr = bufferStream();
    const result = await runPackHookCodexPostToolUseCli({
      manifest: manifestWithPack({
        approval_lifecycle: { expire_on_bash_match: ["^gh pr merge\\b"] },
      }),
      stdin: readableFromString(
        JSON.stringify({
          session_id: "sess-1",
          tool_name: "Bash",
          raw_input: { command: "gh pr merge 42" },
        }),
      ),
      stderr: stderr.stream,
      generatedDir,
    });
    expect(result.matchedExpiry).toBe(true);
    expect(result.markerCleared).toBe(true);
    expect(stderr.read()).toMatch(/bash regex \/\^gh pr/);
  });

  it("prefers tool_input over raw_input when both are present", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-1", {
      approvedAt: "2026-07-01T08:00:00Z",
      approvedBy: "test-operator",
    });
    const stderr = bufferStream();
    const result = await runPackHookCodexPostToolUseCli({
      manifest: manifestWithPack({
        approval_lifecycle: { expire_on_bash_match: ["^gh pr merge\\b"] },
      }),
      stdin: readableFromString(
        JSON.stringify({
          session_id: "sess-1",
          tool_name: "Bash",
          tool_input: { command: "gh pr merge 42" },
          raw_input: { command: "git status" },
        }),
      ),
      stderr: stderr.stream,
      generatedDir,
    });
    expect(result.matchedExpiry).toBe(true);
  });

  it("logs but does not blow up when the tool matches and no marker is present", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const stderr = bufferStream();
    const result = await runPackHookCodexPostToolUseCli({
      manifest: manifestWithPack({ approval_lifecycle: DEFAULT_LIFECYCLE }),
      stdin: readableFromString(eventBody()),
      stderr: stderr.stream,
      generatedDir,
    });
    expect(result.matchedExpiry).toBe(true);
    expect(result.markerCleared).toBe(false);
    expect(stderr.read()).toMatch(/matched tool name but no marker present/);
  });

  it("must-pass control: skips (marker survives) when the tool is not in expire_on_tool_match", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-1", {
      approvedAt: "2026-07-01T08:00:00Z",
      approvedBy: "test-operator",
    });
    const markerPath = approvalMarkerPathFor(generatedDir, "sess-1");
    const stderr = bufferStream();
    const result = await runPackHookCodexPostToolUseCli({
      manifest: manifestWithPack({ approval_lifecycle: DEFAULT_LIFECYCLE }),
      stdin: readableFromString(eventBody({ tool_name: "apply_patch" })),
      stderr: stderr.stream,
      generatedDir,
    });
    expect(result.matchedExpiry).toBe(false);
    expect(result.markerCleared).toBe(false);
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(stderr.read()).toMatch(/tool apply_patch not in expire_on_tool_match/);
  });

  it("accepts the `tool` synonym for tool_name", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-1", {
      approvedAt: "2026-07-01T08:00:00Z",
      approvedBy: "test-operator",
    });
    const stderr = bufferStream();
    const result = await runPackHookCodexPostToolUseCli({
      manifest: manifestWithPack({ approval_lifecycle: DEFAULT_LIFECYCLE }),
      stdin: readableFromString(
        JSON.stringify({ session_id: "sess-1", tool: "mcp__agent-tasks__task_finish" }),
      ),
      stderr: stderr.stream,
      generatedDir,
    });
    expect(result.matchedExpiry).toBe(true);
    expect(result.markerCleared).toBe(true);
  });

  it("skips when the pack opted out via approval_lifecycle.mode = session", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-1", {
      approvedAt: "2026-07-01T08:00:00Z",
      approvedBy: "test-operator",
    });
    const stderr = bufferStream();
    const result = await runPackHookCodexPostToolUseCli({
      manifest: manifestWithPack({ approval_lifecycle: { mode: "session" } }),
      stdin: readableFromString(eventBody()),
      stderr: stderr.stream,
      generatedDir,
    });
    expect(result.matchedExpiry).toBe(false);
    expect(fs.existsSync(approvalMarkerPathFor(generatedDir, "sess-1"))).toBe(true);
    expect(stderr.read()).toMatch(/legacy-session mode/);
  });

  it("skips when the pack is disabled", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-1", {
      approvedAt: "2026-07-01T08:00:00Z",
      approvedBy: "test-operator",
    });
    const stderr = bufferStream();
    const result = await runPackHookCodexPostToolUseCli({
      manifest: manifestWithPack({ approval_lifecycle: DEFAULT_LIFECYCLE }, false),
      stdin: readableFromString(eventBody()),
      stderr: stderr.stream,
      generatedDir,
    });
    expect(result.matchedExpiry).toBe(false);
    expect(fs.existsSync(approvalMarkerPathFor(generatedDir, "sess-1"))).toBe(true);
    expect(stderr.read()).toMatch(/is enabled:false/);
  });

  it("skips on malformed event JSON without throwing", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const stderr = bufferStream();
    const result = await runPackHookCodexPostToolUseCli({
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
    const result = await runPackHookCodexPostToolUseCli({
      manifest: manifestWithPack({ approval_lifecycle: DEFAULT_LIFECYCLE }),
      stdin: readableFromString(JSON.stringify({ tool_name: "mcp__agent-tasks__task_finish" })),
      stderr: stderr.stream,
      generatedDir,
    });
    expect(result.matchedExpiry).toBe(false);
    expect(stderr.read()).toMatch(/missing session_id/);
  });

  it("resolves session_id from $CODEX_SESSION_ID when the event omits it, ahead of $CLAUDE_CODE_SESSION_ID", async () => {
    process.env.CODEX_SESSION_ID = "codex-env-sess";
    process.env.CLAUDE_CODE_SESSION_ID = "claude-code-env-sess";
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "codex-env-sess", {
      approvedAt: "2026-07-01T08:00:00Z",
      approvedBy: "test-operator",
    });
    const stderr = bufferStream();
    const result = await runPackHookCodexPostToolUseCli({
      manifest: manifestWithPack({ approval_lifecycle: DEFAULT_LIFECYCLE }),
      stdin: readableFromString(
        JSON.stringify({ tool_name: "mcp__agent-tasks__task_finish" }),
      ),
      stderr: stderr.stream,
      generatedDir,
    });
    expect(stderr.read()).not.toMatch(/missing session_id/);
    expect(result.matchedExpiry).toBe(true);
    expect(result.markerCleared).toBe(true);
    // The claude-code-env marker must be untouched: $CODEX_SESSION_ID won.
    expect(fs.existsSync(approvalMarkerPathFor(generatedDir, "claude-code-env-sess"))).toBe(false);
  });

  it("honours the pause sentinel and skips marker expiry", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    fs.mkdirSync(generatedDir, { recursive: true });
    writeSentinel(generatedDir, {
      pausedAt: new Date().toISOString(),
      expiresAt: null,
      reason: "test",
      pausedBy: "test-operator",
    });
    writeApprovalMarker(generatedDir, "sess-1", {
      approvedAt: "2026-07-01T08:00:00Z",
      approvedBy: "test-operator",
    });
    const stderr = bufferStream();
    const result = await runPackHookCodexPostToolUseCli({
      manifest: manifestWithPack({ approval_lifecycle: DEFAULT_LIFECYCLE }),
      stdin: readableFromString(eventBody()),
      stderr: stderr.stream,
      generatedDir,
    });
    expect(result.matchedExpiry).toBe(false);
    expect(fs.existsSync(approvalMarkerPathFor(generatedDir, "sess-1"))).toBe(true);
    expect(stderr.read()).toMatch(/paused/);
  });
});

describe("pack hook codex-post-tool-use: expire_on_bash_match across Codex shell aliases (task a1348c89)", () => {
  const BASH_LIFECYCLE = {
    expire_on_bash_match: ["^gh pr (merge|close)\\b", "^git push origin (master|main)\\b"],
  };

  for (const shellTool of ["Bash", "shell", "exec_command", "functions.exec_command"]) {
    it(`deletes the marker when a "${shellTool}" command matches an expire_on_bash_match regex`, async () => {
      const generatedDir = path.join(tmp, "harness.generated");
      writeApprovalMarker(generatedDir, "sess-1", {
        approvedAt: "2026-07-01T08:00:00Z",
        approvedBy: "test-operator",
      });
      const stderr = bufferStream();
      const result = await runPackHookCodexPostToolUseCli({
        manifest: manifestWithPack({ approval_lifecycle: BASH_LIFECYCLE }),
        stdin: readableFromString(
          JSON.stringify({
            session_id: "sess-1",
            tool_name: shellTool,
            tool_input: { command: "gh pr merge 42 --squash" },
          }),
        ),
        stderr: stderr.stream,
        generatedDir,
      });
      expect(result.matchedExpiry).toBe(true);
      expect(result.markerCleared).toBe(true);
      expect(fs.existsSync(approvalMarkerPathFor(generatedDir, "sess-1"))).toBe(false);
    });
  }

  it("must-pass control: no-ops when the Bash command does not match any regex", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-1", {
      approvedAt: "2026-07-01T08:00:00Z",
      approvedBy: "test-operator",
    });
    const stderr = bufferStream();
    const result = await runPackHookCodexPostToolUseCli({
      manifest: manifestWithPack({ approval_lifecycle: BASH_LIFECYCLE }),
      stdin: readableFromString(
        JSON.stringify({
          session_id: "sess-1",
          tool_name: "Bash",
          tool_input: { command: "git status" },
        }),
      ),
      stderr: stderr.stream,
      generatedDir,
    });
    expect(result.matchedExpiry).toBe(false);
    expect(fs.existsSync(approvalMarkerPathFor(generatedDir, "sess-1"))).toBe(true);
    expect(stderr.read()).toMatch(/Bash command did not match/);
  });

  it("must-pass control: ignores expire_on_bash_match when the tool is NOT a shell alias", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-1", {
      approvedAt: "2026-07-01T08:00:00Z",
      approvedBy: "test-operator",
    });
    const stderr = bufferStream();
    const result = await runPackHookCodexPostToolUseCli({
      manifest: manifestWithPack({ approval_lifecycle: BASH_LIFECYCLE }),
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
});

describe("pack hook codex-post-tool-use — task-scoped marker cleanup (parity with harness/1ee26e77)", () => {
  it("clears a task-scoped marker when tool_input.taskId is present and a marker exists for it", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-1", {
      approvedAt: "2026-07-01T08:00:00Z",
      approvedBy: "test-operator",
    });
    writeTaskApprovalMarker(generatedDir, "task-uuid-abc", {
      approvedAt: "2026-07-01T08:00:00Z",
      approvedBy: "test-operator",
    });
    const stderr = bufferStream();

    const result = await runPackHookCodexPostToolUseCli({
      manifest: manifestWithPack({ approval_lifecycle: DEFAULT_LIFECYCLE }),
      stdin: readableFromString(eventBody({ tool_input: { taskId: "task-uuid-abc" } })),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.matchedExpiry).toBe(true);
    expect(result.markerCleared).toBe(true);
    expect(result.taskMarkerCleared).toBe(true);
    expect(fs.existsSync(approvalMarkerPathFor(generatedDir, "sess-1"))).toBe(false);
    expect(fs.existsSync(taskApprovalMarkerPathFor(generatedDir, "task-uuid-abc"))).toBe(false);
    expect(stderr.read()).toMatch(/also cleared task marker for task task-uuid-abc/);
  });

  it("flips the persisted report from approved to expired when the matched tool fires", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-1", {
      approvedAt: "2026-07-01T08:00:00Z",
      approvedBy: "test-operator",
    });
    const reportsDir = path.join(tmp, "reports");
    fs.mkdirSync(reportsDir, { recursive: true });
    const reportPath = path.join(reportsDir, "rpt-sess-1.json");
    fs.writeFileSync(
      reportPath,
      `${JSON.stringify(
        {
          sessionId: "sess-1",
          approvalStatus: "approved",
          approvedAt: "2026-07-01T08:00:00Z",
          approvedBy: "test-operator",
          body: "the operator's actual understanding text",
        },
        null,
        2,
      )}\n`,
    );

    const stderr = bufferStream();
    const result = await runPackHookCodexPostToolUseCli({
      manifest: manifestWithPack({ approval_lifecycle: DEFAULT_LIFECYCLE }),
      stdin: readableFromString(eventBody()),
      stderr: stderr.stream,
      generatedDir,
      reportsDir,
      now: new Date("2026-07-01T10:00:00Z"),
    });

    expect(result.matchedExpiry).toBe(true);
    expect(result.persistedReportExpired).toBe(true);

    const after = JSON.parse(fs.readFileSync(reportPath, "utf8")) as Record<string, unknown>;
    expect(after.approvalStatus).toBe("expired");
    expect(after.expiredAt).toBe("2026-07-01T10:00:00.000Z");
    expect(after.body).toBe("the operator's actual understanding text");
    expect(stderr.read()).toMatch(/expired persisted report/);
  });
});

describe("pack hook codex-post-tool-use — tasks_transition v1 status filter (parity with PR #200)", () => {
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
      approvedAt: "2026-07-01T08:00:00Z",
      approvedBy: "test-operator",
    });
    writeTaskApprovalMarker(generatedDir, "task-uuid-abc", {
      approvedAt: "2026-07-01T08:00:00Z",
      approvedBy: "test-operator",
    });
    const stderr = bufferStream();

    const result = await runPackHookCodexPostToolUseCli({
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
    expect(result.taskMarkerCleared).toBe(true);
    expect(fs.existsSync(approvalMarkerPathFor(generatedDir, "sess-1"))).toBe(false);
    expect(fs.existsSync(taskApprovalMarkerPathFor(generatedDir, "task-uuid-abc"))).toBe(false);
  });

  it("must-pass control: is a no-op on tasks_transition status=review (work claim kept)", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-1", {
      approvedAt: "2026-07-01T08:00:00Z",
      approvedBy: "test-operator",
    });
    const stderr = bufferStream();

    const result = await runPackHookCodexPostToolUseCli({
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
    expect(fs.existsSync(approvalMarkerPathFor(generatedDir, "sess-1"))).toBe(true);
    expect(stderr.read()).toMatch(/tasks_transition status keeps work claim/);
  });
});

describe("pack hook codex-post-tool-use — real generatedDir resolution via homeDir (temp-dir HOME override)", () => {
  it("resolves generatedDir from { homeDir, configPath } instead of an injected generatedDir/manifest, and clears the marker", async () => {
    // Realistic wiring: no `manifest` or `generatedDir` injection — the
    // hook loads harness.yaml from disk (under a scratch HOME) and
    // derives generatedDir from that same homeDir, exactly as the real
    // `harness pack hook codex-post-tool-use` binary does when Codex
    // invokes it via config.toml.
    const homeDir = path.join(tmp, "scratch-home");
    fs.mkdirSync(homeDir, { recursive: true });
    const manifestPath = path.join(homeDir, "harness.yaml");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        policy_packs: [
          {
            name: "understanding-before-execution",
            enabled: true,
            config: { approval_lifecycle: DEFAULT_LIFECYCLE },
          },
        ],
      }),
    );
    const generatedDir = path.join(homeDir, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-1", {
      approvedAt: "2026-07-01T08:00:00Z",
      approvedBy: "test-operator",
    });

    const stderr = bufferStream();
    const result = await runPackHookCodexPostToolUseCli({
      homeDir,
      stdin: readableFromString(eventBody()),
      stderr: stderr.stream,
    });

    expect(result.matchedExpiry).toBe(true);
    expect(result.markerCleared).toBe(true);
    expect(fs.existsSync(approvalMarkerPathFor(generatedDir, "sess-1"))).toBe(false);
  });
});

describe("pack hook codex-post-tool-use — integration must-pass control: expiry actually re-locks the PreToolUse blocker (task a1348c89)", () => {
  it("blocks apply_patch again after task_finish expires the marker that previously allowed it", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const reportsDir = path.join(tmp, "reports");
    // No max_age here on purpose: this test isolates the TOOL-BOUNDARY
    // expiry path from the (separately covered, e7c2ec3c) TTL path — a
    // stale fixed approvedAt would age out under max_age by real wall-clock
    // time and falsely "pass" this must-fail assertion for the wrong reason.
    const manifest = manifestWithPack({
      approval_lifecycle: {
        expire_on_tool_match: DEFAULT_LIFECYCLE.expire_on_tool_match,
      },
    });

    writeApprovalMarker(generatedDir, "sess-1", {
      approvedAt: new Date().toISOString(),
      approvedBy: "test-operator",
    });

    // Sanity/must-pass: with the marker present, the blocker ALLOWS.
    const preBefore = await runPackHookCodexPreToolUseCli({
      manifest,
      generatedDir,
      reportsDir,
      stdin: readableFromString(
        JSON.stringify({
          session_id: "sess-1",
          tool_name: "apply_patch",
          raw_input: { path: "foo.ts" },
        }),
      ),
      stderr: bufferStream().stream,
    });
    expect(preBefore.exitCode).toBe(0);
    expect(preBefore.blocked).toBe(false);

    // The agent finishes the task: PostToolUse fires and expires the marker.
    const postResult = await runPackHookCodexPostToolUseCli({
      manifest,
      generatedDir,
      reportsDir,
      stdin: readableFromString(eventBody()),
      stderr: bufferStream().stream,
    });
    expect(postResult.matchedExpiry).toBe(true);
    expect(postResult.markerCleared).toBe(true);

    // Must-fail (the actual assertion this test exists for): the SAME
    // apply_patch call the marker previously allowed is now blocked —
    // proving the expiry genuinely re-locks the gate rather than just
    // deleting a file no code path reads.
    const preAfter = await runPackHookCodexPreToolUseCli({
      manifest,
      generatedDir,
      reportsDir,
      stdin: readableFromString(
        JSON.stringify({
          session_id: "sess-1",
          tool_name: "apply_patch",
          raw_input: { path: "foo.ts" },
        }),
      ),
      stderr: bufferStream().stream,
    });
    expect(preAfter.exitCode).toBe(2);
    expect(preAfter.blocked).toBe(true);
  });
});
