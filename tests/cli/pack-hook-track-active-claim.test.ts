import { Readable, Writable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPackHookTrackActiveClaimCli } from "../../src/cli/pack/hook-track-active-claim.js";
import {
  activeClaimPathFor,
  readActiveClaim,
  writeActiveClaim,
} from "../../src/policy-packs/builtin/understanding-before-execution-runtime.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ug-track-claim-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function manifestWithPack(enabled = true): Manifest {
  return parseManifest({
    version: 1,
    policy_packs: [
      { name: "understanding-before-execution", enabled },
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

function eventBody(
  toolName: string,
  toolInput?: Record<string, unknown>,
  sessionId = "sess-1",
): string {
  return JSON.stringify({
    session_id: sessionId,
    tool_name: toolName,
    ...(toolInput !== undefined && { tool_input: toolInput }),
  });
}

describe("pack hook track-active-claim — task_start writes the active-claim file", () => {
  it("writes <generatedDir>/active-claim with the taskId from tool_input on task_start", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const stderr = bufferStream();

    const result = await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        eventBody("mcp__agent-tasks__task_start", { taskId: "task-uuid-abc" }),
      ),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.claimWritten).toBe(true);
    expect(result.claimCleared).toBe(false);
    expect(result.taskId).toBe("task-uuid-abc");
    expect(readActiveClaim(generatedDir)).toBe("task-uuid-abc");
    expect(fs.readFileSync(activeClaimPathFor(generatedDir), "utf8")).toBe(
      "task-uuid-abc\n",
    );
    expect(stderr.read()).toMatch(/wrote active-claim for task-uuid-abc/);
  });

  it("overwrites the file when task_start fires a second time with a different taskId", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeActiveClaim(generatedDir, "task-old");

    const stderr = bufferStream();
    const result = await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        eventBody("mcp__agent-tasks__task_start", { taskId: "task-new" }),
      ),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.claimWritten).toBe(true);
    expect(readActiveClaim(generatedDir)).toBe("task-new");
  });

  it("skips when task_start carries no taskId (defensive)", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const stderr = bufferStream();

    const result = await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(eventBody("mcp__agent-tasks__task_start")),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.claimWritten).toBe(false);
    expect(readActiveClaim(generatedDir)).toBeNull();
    expect(stderr.read()).toMatch(/task_start without tool_input.taskId/);
  });

  it("rejects a path-traversal taskId without writing anything", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const stderr = bufferStream();

    const result = await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        eventBody("mcp__agent-tasks__task_start", { taskId: "../escape" }),
      ),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.claimWritten).toBe(false);
    expect(readActiveClaim(generatedDir)).toBeNull();
    expect(stderr.read()).toMatch(/writeActiveClaim failed/);
  });
});

describe("pack hook track-active-claim — task_finish / task_abandon clears the file", () => {
  it("clears the active-claim file on task_finish", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeActiveClaim(generatedDir, "task-uuid-abc");

    const stderr = bufferStream();
    const result = await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        eventBody("mcp__agent-tasks__task_finish", { taskId: "task-uuid-abc" }),
      ),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.claimCleared).toBe(true);
    expect(result.claimWritten).toBe(false);
    expect(readActiveClaim(generatedDir)).toBeNull();
    expect(stderr.read()).toMatch(/cleared active-claim after mcp__agent-tasks__task_finish/);
  });

  it("clears the active-claim file on task_abandon", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeActiveClaim(generatedDir, "task-uuid-abc");

    const stderr = bufferStream();
    const result = await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        eventBody("mcp__agent-tasks__task_abandon", { taskId: "task-uuid-abc" }),
      ),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.claimCleared).toBe(true);
    expect(readActiveClaim(generatedDir)).toBeNull();
  });

  it("is idempotent: clearing when no file exists does not error", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    fs.mkdirSync(generatedDir, { recursive: true });

    const stderr = bufferStream();
    const result = await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        eventBody("mcp__agent-tasks__task_finish"),
      ),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.claimCleared).toBe(true);
    expect(result.exitCode).toBe(0);
  });
});

describe("pack hook track-active-claim — guards and fall-through", () => {
  it("skips silently when pack is enabled:false", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const stderr = bufferStream();

    const result = await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(false),
      stdin: readableFromString(
        eventBody("mcp__agent-tasks__task_start", { taskId: "task-uuid-abc" }),
      ),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.claimWritten).toBe(false);
    expect(readActiveClaim(generatedDir)).toBeNull();
    expect(stderr.read()).toMatch(/enabled:false/);
  });

  it("skips silently when the tool is not in the tracked set (defense-in-depth)", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const stderr = bufferStream();

    const result = await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        eventBody("mcp__agent-tasks__tasks_list"),
      ),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.claimWritten).toBe(false);
    expect(result.claimCleared).toBe(false);
    expect(stderr.read()).toMatch(/not tracked/);
  });

  it("skips on malformed event JSON without crashing", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const stderr = bufferStream();

    const result = await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(),
      stdin: readableFromString("not json"),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.exitCode).toBe(0);
    expect(result.claimWritten).toBe(false);
    expect(stderr.read()).toMatch(/malformed event JSON/);
  });
});
