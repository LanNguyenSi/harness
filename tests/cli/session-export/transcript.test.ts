import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  locateTranscript,
  parseTranscript,
} from "../../../src/cli/session-export/transcript.js";

const __filename = fileURLToPath(import.meta.url);
const FIXTURE = path.resolve(
  path.dirname(__filename),
  "..",
  "..",
  "fixtures",
  "transcripts",
  "sample.jsonl",
);

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

describe("parseTranscript", () => {
  it("walks the assistant content arrays for tool_use and text blocks", () => {
    const raw = fs.readFileSync(FIXTURE, "utf8");
    const r = parseTranscript(raw);

    const kinds = r.events.map((e) => e.kind);
    expect(kinds).toEqual([
      "permission_mode",
      "user_prompt",
      "assistant_thinking",
      "assistant_text",
      "assistant_tool_use",
      "user_tool_result",
      "assistant_text",
      "file_history_snapshot",
      "attachment",
    ]);
    expect(r.startedAt).toBe("2026-05-06T08:00:00.000Z");
    expect(r.endedAt).toBe("2026-05-06T08:00:05.000Z");
    expect(r.cwd).toBe("/repo");
    expect(r.malformedLines).toBe(0);

    const toolUse = r.events.find((e) => e.kind === "assistant_tool_use");
    expect(toolUse?.data).toMatchObject({ id: "tu1", name: "Bash" });
    expect((toolUse?.data as { input: { command: string } }).input.command).toBe("ls");

    const toolResult = r.events.find((e) => e.kind === "user_tool_result");
    expect(toolResult?.data).toMatchObject({ tool_use_id: "tu1", is_error: false });
  });

  it("counts malformed lines without throwing", () => {
    const raw = ['{"type":"user","message":{"content":"hi"}}', "not-json", ""].join("\n");
    const r = parseTranscript(raw);
    expect(r.malformedLines).toBe(1);
    expect(r.events).toHaveLength(1);
  });

  it("skips unknown record types instead of erroring", () => {
    const raw = '{"type":"future-record-kind","timestamp":"2026-05-06T00:00:00Z"}';
    const r = parseTranscript(raw);
    expect(r.events).toHaveLength(0);
  });
});

describe("locateTranscript", () => {
  it("scans projects/* for the matching <sessionId>.jsonl", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-transcript-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const projectDir = path.join(root, ".claude", "projects", "-some-repo");
    fs.mkdirSync(projectDir, { recursive: true });
    const sid = "abc123";
    const file = path.join(projectDir, `${sid}.jsonl`);
    fs.writeFileSync(file, "{}\n");

    const found = locateTranscript(sid, { homeDir: root });
    expect(found).toBe(file);
  });

  it("returns null when the projects root does not exist", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-transcript-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    expect(locateTranscript("nope", { homeDir: root })).toBeNull();
  });

  it("returns null when the sessionId does not match any file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-transcript-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, ".claude", "projects", "x"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude", "projects", "x", "other.jsonl"), "");
    expect(locateTranscript("missing", { homeDir: root })).toBeNull();
  });
});

describe("locateTranscript sessionId validation", () => {
  it("throws on a traversal-shaped sessionId before any filesystem access", () => {
    expect(() => locateTranscript("../evil", { projectsRoot: "/nonexistent/path/zzz" })).toThrow();
  });

  it("returns null for a valid sessionId when the projects root does not exist", () => {
    expect(
      locateTranscript("0f8e1c2a-1111-2222-3333-444455556666", {
        projectsRoot: "/nonexistent/path/zzz",
      }),
    ).toBeNull();
  });
});
