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

function eventBodyWithResponse(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  toolResponse: unknown,
  sessionId = "sess-1",
): string {
  return JSON.stringify({
    session_id: sessionId,
    tool_name: toolName,
    ...(toolInput !== undefined && { tool_input: toolInput }),
    tool_response: toolResponse,
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

describe("pack hook track-active-claim: task_finish resulting status decides the effect (task c86e3c4a)", () => {
  it("clears the active-claim file on task_finish whose resulting status is done", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeActiveClaim(generatedDir, "task-uuid-abc");

    const stderr = bufferStream();
    const result = await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        eventBodyWithResponse(
          "mcp__agent-tasks__task_finish",
          { taskId: "task-uuid-abc" },
          { ok: true, task: { id: "task-uuid-abc", status: "done" } },
        ),
      ),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.claimCleared).toBe(true);
    expect(result.claimWritten).toBe(false);
    expect(readActiveClaim(generatedDir)).toBeNull();
    expect(stderr.read()).toMatch(
      /cleared active-claim after mcp__agent-tasks__task_finish/,
    );
  });

  it("keeps the active-claim file on task_finish whose resulting status is review", async () => {
    // Pins the fix for task c86e3c4a: a finish that lands the task in
    // review keeps the work claim per v2 semantics (task_finish docs),
    // so the marker must stay so `harness approve understanding` can
    // still auto-resolve the (still-claimed) task on the recovery path.
    const generatedDir = path.join(tmp, "harness.generated");
    writeActiveClaim(generatedDir, "task-uuid-abc");

    const stderr = bufferStream();
    const result = await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        eventBodyWithResponse(
          "mcp__agent-tasks__task_finish",
          { taskId: "task-uuid-abc" },
          { ok: true, task: { id: "task-uuid-abc", status: "review" } },
        ),
      ),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.claimCleared).toBe(false);
    expect(result.claimWritten).toBe(false);
    expect(readActiveClaim(generatedDir)).toBe("task-uuid-abc");
    expect(stderr.read()).toMatch(
      /kept active-claim after mcp__agent-tasks__task_finish \(resulting status=review\)/,
    );
  });

  it("fails safe (clears) when task_finish carries no tool_response at all", async () => {
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
    expect(stderr.read()).toMatch(
      /cleared active-claim after mcp__agent-tasks__task_finish/,
    );
  });

  it("fails safe (clears) when task_finish's tool_response is malformed (status not a string)", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeActiveClaim(generatedDir, "task-uuid-abc");

    const stderr = bufferStream();
    const result = await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        eventBodyWithResponse(
          "mcp__agent-tasks__task_finish",
          { taskId: "task-uuid-abc" },
          { ok: true, task: { id: "task-uuid-abc", status: 42 } },
        ),
      ),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.claimCleared).toBe(true);
    expect(readActiveClaim(generatedDir)).toBeNull();
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

  it("clears the active-claim file on task_merge", async () => {
    // AC-002 item 2: merge clears it, same as done/abandon.
    const generatedDir = path.join(tmp, "harness.generated");
    writeActiveClaim(generatedDir, "task-uuid-abc");

    const stderr = bufferStream();
    const result = await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        eventBody("mcp__agent-tasks__task_merge", { taskId: "task-uuid-abc" }),
      ),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.claimCleared).toBe(true);
    expect(readActiveClaim(generatedDir)).toBeNull();
    expect(stderr.read()).toMatch(/cleared active-claim after mcp__agent-tasks__task_merge/);
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

  it("recovery path: task_start on the SAME review-state task rewrites the marker (no 409 handling needed here)", async () => {
    // After a finish-to-review keeps the marker, the documented recovery
    // is `task_start` on that same task id, which this hook already
    // handles as an ordinary claim acquisition (overwrite-on-write,
    // pinned above by the task_start describe block); this case pins
    // the concrete review -> re-start sequence end to end.
    const generatedDir = path.join(tmp, "harness.generated");
    writeActiveClaim(generatedDir, "task-uuid-abc");
    await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        eventBodyWithResponse(
          "mcp__agent-tasks__task_finish",
          { taskId: "task-uuid-abc" },
          { ok: true, task: { id: "task-uuid-abc", status: "review" } },
        ),
      ),
      stderr: bufferStream().stream,
      generatedDir,
    });
    expect(readActiveClaim(generatedDir)).toBe("task-uuid-abc");

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
    expect(readActiveClaim(generatedDir)).toBe("task-uuid-abc");
  });
});

describe("pack hook track-active-claim: golden fixture, real Claude Code 2.1.280 PostToolUse tool_response (task c86e3c4a round 2, HIGH)", () => {
  // Round-1 review found the fix inert in production: Claude Code's real
  // PostToolUse tool_response for an MCP tool is a content-block array,
  // `[{ type: "text", text: "<json>" }]`, not the plain
  // `{ ok, task: { status } }` object the round-1 fixtures assumed.
  // Verbatim (redacted session id / paths / transcript path / prompt id)
  // live capture, claude 2.1.280.
  const fixturePath = path.join(
    __dirname,
    "..",
    "fixtures",
    "track-active-claim",
    "real-posttooluse-task-finish-2.1.280.json",
  );

  function loadFixture(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(fixturePath, "utf8")) as Record<string, unknown>;
  }

  it("the real payload's tool_response is a content-block array, first block type=text, JSON-parses to the mcp-server receipt shape", () => {
    const raw = loadFixture();
    const blocks = raw["tool_response"];
    expect(Array.isArray(blocks)).toBe(true);
    const first = (blocks as unknown[])[0] as Record<string, unknown>;
    expect(first["type"]).toBe("text");
    expect(JSON.parse(first["text"] as string)).toEqual({
      ok: true,
      task: { id: "abc-123", status: "review" },
    });
  });

  it("finish-to-review (marker KEPT): the real content-block payload, replayed verbatim, keeps the marker end to end", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeActiveClaim(generatedDir, "abc-123");
    const stderr = bufferStream();

    const result = await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(JSON.stringify(loadFixture())),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.claimCleared).toBe(false);
    expect(readActiveClaim(generatedDir)).toBe("abc-123");
    expect(stderr.read()).toMatch(/kept active-claim after mcp__agent-tasks__task_finish \(resulting status=review\)/);
  });

  it("finish-to-done (marker CLEARED): the same content-block shape with only the status changed to done", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeActiveClaim(generatedDir, "abc-123");
    const raw = loadFixture();
    const receiptText = (raw["tool_response"] as Array<Record<string, unknown>>)[0]!["text"] as string;
    const receipt = JSON.parse(receiptText) as { ok: boolean; task: { id: string; status: string } };
    const doneReceipt = { ...receipt, task: { ...receipt.task, status: "done" } };
    const doneEvent = {
      ...raw,
      tool_response: [{ type: "text", text: JSON.stringify(doneReceipt) }],
    };
    const stderr = bufferStream();

    const result = await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(JSON.stringify(doneEvent)),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.claimCleared).toBe(true);
    expect(readActiveClaim(generatedDir)).toBeNull();
    expect(stderr.read()).toMatch(/cleared active-claim after mcp__agent-tasks__task_finish/);
  });

  it("also unwraps an include:[\"task\"] full-object receipt inside the same content-block envelope", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeActiveClaim(generatedDir, "abc-123");
    const raw = loadFixture();
    const fullTaskReceipt = {
      ok: true,
      task: {
        id: "abc-123",
        status: "review",
        title: "Some task",
        description: "Full task object as returned by include:[\"task\"]",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    };
    const event = {
      ...raw,
      tool_response: [{ type: "text", text: JSON.stringify(fullTaskReceipt) }],
    };

    const result = await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(JSON.stringify(event)),
      stderr: bufferStream().stream,
      generatedDir,
    });

    expect(result.claimCleared).toBe(false);
    expect(readActiveClaim(generatedDir)).toBe("abc-123");
  });
});

describe("pack hook track-active-claim: defensive tool_response shapes beyond the measured Claude one (task c86e3c4a round 2)", () => {
  // Shapes (c) and (d) from `unwrapToolResponseEnvelope`'s doc comment.
  // Shape (c), the MCP CallToolResult object `{ content: [...] }`, is
  // plausible on Codex but UNMEASURED here (no Codex capture exists in
  // this run) -- handled defensively, same as the measured Claude shape.

  it("unwraps an MCP CallToolResult object shape ({ content: [{ type: text, text }] }) -- plausible Codex shape, unmeasured", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeActiveClaim(generatedDir, "task-uuid-abc");

    const result = await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        eventBodyWithResponse(
          "mcp__agent-tasks__task_finish",
          { taskId: "task-uuid-abc" },
          {
            content: [
              { type: "text", text: JSON.stringify({ ok: true, task: { id: "task-uuid-abc", status: "review" } }) },
            ],
          },
        ),
      ),
      stderr: bufferStream().stream,
      generatedDir,
    });

    expect(result.claimCleared).toBe(false);
    expect(readActiveClaim(generatedDir)).toBe("task-uuid-abc");
  });

  it("unwraps a bare JSON string tool_response", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeActiveClaim(generatedDir, "task-uuid-abc");

    const result = await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        eventBodyWithResponse(
          "mcp__agent-tasks__task_finish",
          { taskId: "task-uuid-abc" },
          JSON.stringify({ ok: true, task: { id: "task-uuid-abc", status: "review" } }),
        ),
      ),
      stderr: bufferStream().stream,
      generatedDir,
    });

    expect(result.claimCleared).toBe(false);
    expect(readActiveClaim(generatedDir)).toBe("task-uuid-abc");
  });
});

describe("pack hook track-active-claim: the unreadable-result clear names the tool_response shape (task c86e3c4a round 2, MEDIUM)", () => {
  // Round-1 review: the fail-safe clear (classifier could not read a
  // resulting status) looked byte-identical in stderr to an intentional
  // `done` release. Now it names the shape it fell back from, so an
  // operator or future incident triage can tell the two apart.

  it("names shape=object when tool_response is an unparseable plain object", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeActiveClaim(generatedDir, "task-uuid-abc");
    const stderr = bufferStream();

    const result = await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        eventBodyWithResponse(
          "mcp__agent-tasks__task_finish",
          { taskId: "task-uuid-abc" },
          { ok: true, task: { id: "task-uuid-abc", status: 42 } },
        ),
      ),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.claimCleared).toBe(true);
    expect(stderr.read()).toMatch(/unreadable tool_response, shape=object, fail-safe release/);
  });

  it("names shape=array when tool_response is a content-block array with no text block", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeActiveClaim(generatedDir, "task-uuid-abc");
    const stderr = bufferStream();

    const result = await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        eventBodyWithResponse(
          "mcp__agent-tasks__task_finish",
          { taskId: "task-uuid-abc" },
          [{ type: "image", data: "base64…" }],
        ),
      ),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.claimCleared).toBe(true);
    expect(stderr.read()).toMatch(/unreadable tool_response, shape=array, fail-safe release/);
  });

  it("names shape=string when tool_response is a string that is not valid JSON", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeActiveClaim(generatedDir, "task-uuid-abc");
    const stderr = bufferStream();

    const result = await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        eventBodyWithResponse(
          "mcp__agent-tasks__task_finish",
          { taskId: "task-uuid-abc" },
          "not json",
        ),
      ),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.claimCleared).toBe(true);
    expect(stderr.read()).toMatch(/unreadable tool_response, shape=string, fail-safe release/);
  });

  it("names shape=absent when task_finish carries no tool_response at all", async () => {
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
    expect(stderr.read()).toMatch(/unreadable tool_response, shape=absent, fail-safe release/);
  });

  it("does NOT name a shape when the resulting status is readable and simply not review (normal done release)", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeActiveClaim(generatedDir, "task-uuid-abc");
    const stderr = bufferStream();

    const result = await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        eventBodyWithResponse(
          "mcp__agent-tasks__task_finish",
          { taskId: "task-uuid-abc" },
          { ok: true, task: { id: "task-uuid-abc", status: "done" } },
        ),
      ),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.claimCleared).toBe(true);
    expect(stderr.read()).not.toMatch(/unreadable tool_response/);
  });
});

describe("pack hook track-active-claim: release verbs only clear the marker for the matching task id (task c86e3c4a round 2, MEDIUM)", () => {
  it("keeps active-claim B when task_merge fires for a different task A, and reports the near-miss", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeActiveClaim(generatedDir, "task-B");
    const stderr = bufferStream();

    const result = await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        eventBody("mcp__agent-tasks__task_merge", { taskId: "task-A" }),
      ),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.claimCleared).toBe(false);
    expect(readActiveClaim(generatedDir)).toBe("task-B");
    expect(stderr.read()).toMatch(
      /kept active-claim task-B: mcp__agent-tasks__task_merge on task-A/,
    );
  });

  it("clears active-claim when task_merge fires for the SAME task id", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeActiveClaim(generatedDir, "task-A");

    const result = await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        eventBody("mcp__agent-tasks__task_merge", { taskId: "task-A" }),
      ),
      stderr: bufferStream().stream,
      generatedDir,
    });

    expect(result.claimCleared).toBe(true);
    expect(readActiveClaim(generatedDir)).toBeNull();
  });

  it("keeps active-claim B when task_abandon fires for a different task A", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeActiveClaim(generatedDir, "task-B");
    const stderr = bufferStream();

    const result = await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        eventBody("mcp__agent-tasks__task_abandon", { taskId: "task-A" }),
      ),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.claimCleared).toBe(false);
    expect(readActiveClaim(generatedDir)).toBe("task-B");
    expect(stderr.read()).toMatch(
      /kept active-claim task-B: mcp__agent-tasks__task_abandon on task-A/,
    );
  });

  it("does not clear the work-claim marker B when a REVIEW claim of another task A is finished to done", async () => {
    // The caller holds a work-claim marker for B. Finishing A's review
    // claim to done is a task_finish, resulting status "done" (release
    // effect), for a DIFFERENT task than the one the marker names -- B
    // must survive.
    const generatedDir = path.join(tmp, "harness.generated");
    writeActiveClaim(generatedDir, "task-B");
    const stderr = bufferStream();

    const result = await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        eventBodyWithResponse(
          "mcp__agent-tasks__task_finish",
          { taskId: "task-A" },
          { ok: true, task: { id: "task-A", status: "done" } },
        ),
      ),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.claimCleared).toBe(false);
    expect(readActiveClaim(generatedDir)).toBe("task-B");
    expect(stderr.read()).toMatch(
      /kept active-claim task-B: mcp__agent-tasks__task_finish on task-A/,
    );
  });

  it("falls back to the tool RESULT's task.id for the comparison when tool_input carries none", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeActiveClaim(generatedDir, "task-B");
    const stderr = bufferStream();

    const result = await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        eventBodyWithResponse(
          "mcp__agent-tasks__task_finish",
          undefined,
          { ok: true, task: { id: "task-A", status: "done" } },
        ),
      ),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.claimCleared).toBe(false);
    expect(readActiveClaim(generatedDir)).toBe("task-B");
  });

  it("clears (fail-safe direction) when a marker exists but the acted-on task id is unresolvable", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    fs.mkdirSync(generatedDir, { recursive: true });
    writeActiveClaim(generatedDir, "task-B");

    const result = await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(eventBody("mcp__agent-tasks__task_merge", {})),
      stderr: bufferStream().stream,
      generatedDir,
    });

    expect(result.claimCleared).toBe(true);
    expect(readActiveClaim(generatedDir)).toBeNull();
  });

  it("still clears (fail-safe direction) when no current marker exists and the call names a task id", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    fs.mkdirSync(generatedDir, { recursive: true });

    const result = await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        eventBody("mcp__agent-tasks__task_merge", { taskId: "task-A" }),
      ),
      stderr: bufferStream().stream,
      generatedDir,
    });

    expect(result.claimCleared).toBe(true);
    expect(readActiveClaim(generatedDir)).toBeNull();
  });
});

describe("pack hook track-active-claim — tasks_transition v1 verb (PR #200)", () => {
  const TASKS_TRANSITION = "mcp__agent-tasks__tasks_transition";

  it("clears active-claim when tasks_transition fires with status=done", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    fs.mkdirSync(generatedDir, { recursive: true });
    writeActiveClaim(generatedDir, "task-uuid-abc");

    const stderr = bufferStream();
    const result = await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        eventBody(TASKS_TRANSITION, { taskId: "task-uuid-abc", status: "done" }),
      ),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.claimCleared).toBe(true);
    expect(readActiveClaim(generatedDir)).toBeNull();
    expect(stderr.read()).toMatch(/cleared active-claim after tasks_transition status=done/);
  });

  it("is a no-op when tasks_transition fires with status=in_progress (claim verb)", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    fs.mkdirSync(generatedDir, { recursive: true });
    writeActiveClaim(generatedDir, "task-uuid-abc");

    const stderr = bufferStream();
    const result = await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        eventBody(TASKS_TRANSITION, { taskId: "task-uuid-abc", status: "in_progress" }),
      ),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.claimCleared).toBe(false);
    expect(result.claimWritten).toBe(false);
    expect(readActiveClaim(generatedDir)).toBe("task-uuid-abc");
    expect(stderr.read()).toMatch(/status=in_progress keeps claim/);
  });

  it("is a no-op when tasks_transition fires with status=review (work claim kept per v2 docs)", async () => {
    // Pins the v2 contract: task_finish→review keeps the work claim, so
    // tasks_transition→review must mirror that.
    const generatedDir = path.join(tmp, "harness.generated");
    fs.mkdirSync(generatedDir, { recursive: true });
    writeActiveClaim(generatedDir, "task-uuid-abc");

    const stderr = bufferStream();
    const result = await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        eventBody(TASKS_TRANSITION, { taskId: "task-uuid-abc", status: "review" }),
      ),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.claimCleared).toBe(false);
    expect(readActiveClaim(generatedDir)).toBe("task-uuid-abc");
    expect(stderr.read()).toMatch(/status=review keeps claim/);
  });

  it("is a no-op when tasks_transition fires with missing status (defensive)", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    fs.mkdirSync(generatedDir, { recursive: true });
    writeActiveClaim(generatedDir, "task-uuid-abc");

    const stderr = bufferStream();
    const result = await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        eventBody(TASKS_TRANSITION, { taskId: "task-uuid-abc" }),
      ),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.claimCleared).toBe(false);
    expect(readActiveClaim(generatedDir)).toBe("task-uuid-abc");
    expect(stderr.read()).toMatch(/status=\(missing\) keeps claim/);
  });

  it("is a no-op when tasks_transition fires with status as a non-string type (defensive)", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    fs.mkdirSync(generatedDir, { recursive: true });
    writeActiveClaim(generatedDir, "task-uuid-abc");

    const stderr = bufferStream();
    const result = await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        eventBody(TASKS_TRANSITION, { taskId: "task-uuid-abc", status: 42 }),
      ),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.claimCleared).toBe(false);
    expect(readActiveClaim(generatedDir)).toBe("task-uuid-abc");
  });
});

describe("pack hook track-active-claim — Codex MCP tool-name alias variants (task cf4cdc93 parity)", () => {
  // Codex can emit an MCP tool name in a variant form for the identical
  // tool (server hyphen/underscore swap, the `mcp__server__.tool`
  // dotted form) — the same class of variance task a1348c89 fixed for
  // the marker-expiry PostToolUse hook. The generator's
  // `expandCodexHookMatchPattern` already widens the emitted Codex
  // matcher to include these variants, so Codex's own dispatcher DOES
  // invoke this hook for them; these tests pin that the hook BODY
  // recognizes them too (toolNameMatchesAny), not just the dispatcher.
  it("writes active-claim on task_start with an underscore-server tool_name variant", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const stderr = bufferStream();

    const result = await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        eventBody("mcp__agent_tasks__task_start", { taskId: "task-uuid-abc" }),
      ),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.claimWritten).toBe(true);
    expect(readActiveClaim(generatedDir)).toBe("task-uuid-abc");
  });

  it("writes active-claim on task_start with the dotted mcp__server__.tool form", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const stderr = bufferStream();

    const result = await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        eventBody("mcp__agent-tasks__.task_start", { taskId: "task-uuid-abc" }),
      ),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.claimWritten).toBe(true);
    expect(readActiveClaim(generatedDir)).toBe("task-uuid-abc");
  });

  it("clears active-claim on an alias-variant task_finish tool_name", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeActiveClaim(generatedDir, "task-uuid-abc");
    const stderr = bufferStream();

    const result = await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        eventBody("mcp__agent_tasks__task_finish", { taskId: "task-uuid-abc" }),
      ),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.claimCleared).toBe(true);
    expect(readActiveClaim(generatedDir)).toBeNull();
  });

  it("clears active-claim on an alias-variant tasks_transition status=done", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeActiveClaim(generatedDir, "task-uuid-abc");
    const stderr = bufferStream();

    const result = await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        eventBody("mcp__agent-tasks__.tasks_transition", {
          taskId: "task-uuid-abc",
          status: "done",
        }),
      ),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.claimCleared).toBe(true);
    expect(readActiveClaim(generatedDir)).toBeNull();
  });

  it("negative control: an alias-variant tasks_transition with status=in_progress still keeps the claim", async () => {
    // Mirrors the a1348c89 review finding: an alias-aware general match
    // that is NOT also alias-aware on the status-filter path would clear
    // the marker on ANY status. Pin that this hook's status filter
    // applies regardless of which alias form triggered it.
    const generatedDir = path.join(tmp, "harness.generated");
    writeActiveClaim(generatedDir, "task-uuid-abc");
    const stderr = bufferStream();

    const result = await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        eventBody("mcp__agent_tasks__tasks_transition", {
          taskId: "task-uuid-abc",
          status: "in_progress",
        }),
      ),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.claimCleared).toBe(false);
    expect(readActiveClaim(generatedDir)).toBe("task-uuid-abc");
  });
});

describe("pack hook track-active-claim — Codex wire-format synonyms (task cf4cdc93 review fix, MEDIUM)", () => {
  // Reviewer probe (empirically confirmed): a Codex-shaped payload using
  // the `raw_input` field (instead of `tool_input`) or the `tool` field
  // (instead of `tool_name`) used to silently no-op here, even though
  // the sibling `codex-post-tool-use` hook already tolerated both
  // synonyms via its own `pickString` / `resolveToolInput`. These pin
  // the fix via the shared `hook-bootstrap.ts` helpers.
  it("writes active-claim on task_start when the taskId arrives under raw_input instead of tool_input", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const stderr = bufferStream();

    const result = await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        JSON.stringify({
          session_id: "sess-1",
          tool_name: "mcp__agent-tasks__task_start",
          raw_input: { taskId: "task-uuid-abc" },
        }),
      ),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.claimWritten).toBe(true);
    expect(readActiveClaim(generatedDir)).toBe("task-uuid-abc");
  });

  it("writes active-claim on task_start when the tool name arrives under `tool` instead of `tool_name`", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const stderr = bufferStream();

    const result = await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        JSON.stringify({
          session_id: "sess-1",
          tool: "mcp__agent-tasks__task_start",
          tool_input: { taskId: "task-uuid-abc" },
        }),
      ),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.claimWritten).toBe(true);
    expect(readActiveClaim(generatedDir)).toBe("task-uuid-abc");
  });

  it("clears active-claim on task_finish when both synonyms (`tool` + `raw_input`) are used together", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeActiveClaim(generatedDir, "task-uuid-abc");
    const stderr = bufferStream();

    const result = await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        JSON.stringify({
          session_id: "sess-1",
          tool: "mcp__agent-tasks__task_finish",
          raw_input: { taskId: "task-uuid-abc" },
        }),
      ),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.claimCleared).toBe(true);
    expect(readActiveClaim(generatedDir)).toBeNull();
  });

  it("prefers tool_input over raw_input when both are present (matches the sibling codex-post-tool-use precedence)", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const stderr = bufferStream();

    const result = await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        JSON.stringify({
          session_id: "sess-1",
          tool_name: "mcp__agent-tasks__task_start",
          tool_input: { taskId: "from-tool-input" },
          raw_input: { taskId: "from-raw-input" },
        }),
      ),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.claimWritten).toBe(true);
    expect(readActiveClaim(generatedDir)).toBe("from-tool-input");
  });

  it("negative control: missing both tool_name and tool still skips (no false-positive synonym resolution)", async () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const stderr = bufferStream();

    const result = await runPackHookTrackActiveClaimCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        JSON.stringify({
          session_id: "sess-1",
          raw_input: { taskId: "task-uuid-abc" },
        }),
      ),
      stderr: stderr.stream,
      generatedDir,
    });

    expect(result.claimWritten).toBe(false);
    expect(readActiveClaim(generatedDir)).toBeNull();
    expect(stderr.read()).toMatch(/missing tool_name/);
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

  it("readActiveClaim returns null on an empty file (no false-positive resolution to empty string)", () => {
    const generatedDir = path.join(tmp, "harness.generated");
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.writeFileSync(activeClaimPathFor(generatedDir), "\n");
    expect(readActiveClaim(generatedDir)).toBeNull();
  });

  it("readActiveClaim rejects a poisoned file (defense-in-depth on read)", () => {
    const generatedDir = path.join(tmp, "harness.generated");
    fs.mkdirSync(generatedDir, { recursive: true });
    // Hand-planted file with a path-traversal id — write-side guard
    // would never let this happen, but the read-side check stops a
    // downstream forged marker if it slipped through somehow.
    fs.writeFileSync(activeClaimPathFor(generatedDir), "../escape\n");
    expect(readActiveClaim(generatedDir)).toBeNull();
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
