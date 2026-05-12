import { describe, expect, it } from "vitest";
import { parseStreamJsonl } from "../../../src/cli/smoke/stream-parser.js";

const INIT_LINE = JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "sess-1",
  cwd: "/tmp/x",
  model: "claude-opus-4-7[1m]",
});

const HOOK_STARTED = (id: string, name = "PreToolUse"): string =>
  JSON.stringify({
    type: "system",
    subtype: "hook_started",
    hook_id: id,
    hook_name: name,
    hook_event: name,
    session_id: "sess-1",
  });

const HOOK_RESPONSE = (
  id: string,
  fields: { stdout?: string; stderr?: string; exit_code?: number; outcome?: string; hook_name?: string } = {},
): string =>
  JSON.stringify({
    type: "system",
    subtype: "hook_response",
    hook_id: id,
    hook_name: fields.hook_name ?? "PreToolUse",
    hook_event: "PreToolUse",
    output: "",
    stdout: fields.stdout ?? "",
    stderr: fields.stderr ?? "",
    exit_code: fields.exit_code ?? 0,
    outcome: fields.outcome ?? "success",
    session_id: "sess-1",
  });

const RESULT_LINE = (isError: boolean): string =>
  JSON.stringify({
    type: "result",
    subtype: isError ? "error" : "success",
    is_error: isError,
    duration_ms: 1234,
    session_id: "sess-1",
  });

describe("parseStreamJsonl", () => {
  it("returns an empty summary for an empty input", () => {
    const s = parseStreamJsonl("");
    expect(s.init).toBeNull();
    expect(s.hooks).toEqual([]);
    expect(s.result).toBeNull();
    expect(s.totalLines).toBe(0);
    expect(s.malformedLines).toBe(0);
  });

  it("captures init, hook pair, result in order", () => {
    const text = [
      INIT_LINE,
      HOOK_STARTED("h1"),
      HOOK_RESPONSE("h1", { stdout: '{"decision":"block"}', exit_code: 0 }),
      RESULT_LINE(true),
    ].join("\n");
    const s = parseStreamJsonl(text);
    expect(s.init?.session_id).toBe("sess-1");
    expect(s.hooks).toHaveLength(1);
    expect(s.hooks[0]?.hookId).toBe("h1");
    expect(s.hooks[0]?.stdout).toBe('{"decision":"block"}');
    expect(s.hooks[0]?.response).not.toBeNull();
    expect(s.result?.is_error).toBe(true);
    expect(s.totalLines).toBe(4);
  });

  it("pairs hook_started and hook_response by hook_id even when interleaved", () => {
    const text = [
      HOOK_STARTED("a"),
      HOOK_STARTED("b"),
      HOOK_RESPONSE("b", { outcome: "success" }),
      HOOK_RESPONSE("a", { outcome: "success" }),
      RESULT_LINE(false),
    ].join("\n");
    const s = parseStreamJsonl(text);
    expect(s.hooks).toHaveLength(2);
    const ids = s.hooks.map((h) => h.hookId).sort();
    expect(ids).toEqual(["a", "b"]);
    for (const h of s.hooks) {
      expect(h.response).not.toBeNull();
      expect(h.outcome).toBe("success");
    }
  });

  it("emits a response=null entry for a hook_started without a matching response", () => {
    const text = [INIT_LINE, HOOK_STARTED("orphan"), RESULT_LINE(true)].join("\n");
    const s = parseStreamJsonl(text);
    expect(s.hooks).toHaveLength(1);
    expect(s.hooks[0]?.response).toBeNull();
    expect(s.hooks[0]?.hookId).toBe("orphan");
  });

  it("synthesises a started entry when only a response is observed", () => {
    const text = [HOOK_RESPONSE("late", { outcome: "success" }), RESULT_LINE(false)].join("\n");
    const s = parseStreamJsonl(text);
    expect(s.hooks).toHaveLength(1);
    expect(s.hooks[0]?.response).not.toBeNull();
    expect(s.hooks[0]?.started.hook_id).toBe("late");
  });

  it("counts malformed lines without throwing", () => {
    const text = ["not json", INIT_LINE, "{partial", RESULT_LINE(false)].join("\n");
    const s = parseStreamJsonl(text);
    expect(s.malformedLines).toBe(2);
    expect(s.init?.session_id).toBe("sess-1");
    expect(s.result?.is_error).toBe(false);
  });

  it("ignores assistant / rate_limit_event chatter from the summary", () => {
    const text = [
      INIT_LINE,
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }),
      JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } }),
      RESULT_LINE(false),
    ].join("\n");
    const s = parseStreamJsonl(text);
    expect(s.unrecognised).toEqual([]);
    expect(s.hooks).toEqual([]);
    expect(s.init).not.toBeNull();
    expect(s.result).not.toBeNull();
  });

  it("caps unrecognised event shapes at 20 entries", () => {
    const lines: string[] = [];
    for (let i = 0; i < 50; i++) {
      lines.push(JSON.stringify({ type: `weird_${i}`, subtype: `s_${i}` }));
    }
    const s = parseStreamJsonl(lines.join("\n"));
    expect(s.unrecognised).toHaveLength(20);
    expect(s.totalLines).toBe(50);
  });
});
