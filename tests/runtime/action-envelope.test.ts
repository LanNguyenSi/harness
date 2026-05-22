import { describe, expect, it } from "vitest";
import {
  buildActionEnvelope,
  type EnvelopeContext,
} from "../../src/runtime/action-envelope.js";
import type { ToolEvent } from "../../src/runtime/intercept.js";

const NOW = new Date("2026-05-22T12:00:00.000Z");

const CTX: EnvelopeContext = {
  cwd: "/work/customer-platform",
  git: { repo: "customer-platform", branch: "main", sha: "f".repeat(40) },
  user: "agent",
  host: "runner-01",
  now: NOW,
};

describe("buildActionEnvelope — full event", () => {
  it("maps every field from a complete PreToolUse event", () => {
    const event: ToolEvent = {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "psql $PROD_DB -c 'DROP TABLE users;'" },
      session_id: "sess-123",
      cwd: "/work/customer-platform",
    };
    const env = buildActionEnvelope(event, CTX);
    expect(env.event).toBe("PreToolUse");
    expect(env.tool).toBe("Bash");
    expect(env.raw_input).toEqual({
      command: "psql $PROD_DB -c 'DROP TABLE users;'",
    });
    expect(env.session).toEqual({
      id: "sess-123",
      repo: "customer-platform",
      branch: "main",
      task_id: "",
    });
    expect(env.runtime).toEqual({
      cwd: "/work/customer-platform",
      user: "agent",
      host: "runner-01",
    });
    expect(env.timestamp).toBe("2026-05-22T12:00:00.000Z");
  });

  it("carries task_id when the event supplies one", () => {
    const event = {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      task_id: "TASK-42",
    } as ToolEvent;
    expect(buildActionEnvelope(event, CTX).session.task_id).toBe("TASK-42");
  });
});

describe("buildActionEnvelope — sparse / malformed event", () => {
  it("never throws on an empty event; absent fields become empty", () => {
    const env = buildActionEnvelope({}, CTX);
    expect(env.event).toBe("");
    expect(env.tool).toBe("");
    expect(env.raw_input).toBeNull();
    expect(env.session.id).toBe("");
    expect(env.session.task_id).toBe("");
  });

  it("coerces non-string event fields to empty strings", () => {
    const event = {
      hook_event_name: 7,
      tool_name: { nested: true },
      session_id: null,
    } as unknown as ToolEvent;
    const env = buildActionEnvelope(event, CTX);
    expect(env.event).toBe("");
    expect(env.tool).toBe("");
    expect(env.session.id).toBe("");
  });

  it("preserves a falsy-but-present raw_input rather than nulling it", () => {
    const event = { tool_input: { command: "" } } as ToolEvent;
    expect(buildActionEnvelope(event, CTX).raw_input).toEqual({ command: "" });
  });
});

describe("buildActionEnvelope — context-derived fields", () => {
  it("takes repo/branch from the resolved git context, not the event", () => {
    const event = {
      hook_event_name: "PreToolUse",
      session: { repo: "spoofed" },
    } as unknown as ToolEvent;
    const env = buildActionEnvelope(event, CTX);
    expect(env.session.repo).toBe("customer-platform");
    expect(env.session.branch).toBe("main");
  });

  it("reflects an empty git context (cwd not in a repo)", () => {
    const env = buildActionEnvelope(
      { hook_event_name: "PreToolUse" },
      { ...CTX, git: { repo: "", branch: "", sha: "" } },
    );
    expect(env.session.repo).toBe("");
    expect(env.session.branch).toBe("");
  });
});
