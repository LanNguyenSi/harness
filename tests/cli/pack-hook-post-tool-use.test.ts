import { Readable, Writable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPackHookPostToolUseCli } from "../../src/cli/pack/hook-post-tool-use.js";
import {
  approvalMarkerPathFor,
  writeApprovalMarker,
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
