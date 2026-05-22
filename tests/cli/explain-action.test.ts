import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { explainAction } from "../../src/cli/explain-action.js";
import { HarnessExitError } from "../../src/cli/exit-codes.js";
import type { GitRepoContext } from "../../src/runtime/git-context.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function writeEvent(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-explain-action-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "event.json");
  fs.writeFileSync(file, contents, "utf8");
  return file;
}

const FIXED_GIT: GitRepoContext = {
  repo: "customer-platform",
  branch: "main",
  sha: "a".repeat(40),
};

// Deterministic seams so output is stable regardless of host / clock / cwd.
const SEAMS = {
  now: new Date("2026-05-22T12:00:00.000Z"),
  host: "runner-01",
  user: "agent",
  resolveGit: (): GitRepoContext => FIXED_GIT,
  cwdFallback: "/fallback/cwd",
};

describe("explainAction — happy path", () => {
  it("renders the envelope as YAML for a full PreToolUse event", () => {
    const file = writeEvent(
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "terraform destroy" },
        session_id: "sess-1",
        cwd: "/work/customer-platform",
      }),
    );
    const result = explainAction({ eventPath: file, ...SEAMS });
    expect(result.envelope.event).toBe("PreToolUse");
    expect(result.envelope.tool).toBe("Bash");
    expect(result.envelope.session.repo).toBe("customer-platform");
    expect(result.envelope.runtime.host).toBe("runner-01");
    expect(result.envelope.timestamp).toBe("2026-05-22T12:00:00.000Z");
    // YAML output round-trips to the same envelope.
    expect(parseYaml(result.output)).toEqual(result.envelope);
  });

  it("emits valid JSON with --json", () => {
    const file = writeEvent(
      JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash" }),
    );
    const result = explainAction({ eventPath: file, json: true, ...SEAMS });
    expect(JSON.parse(result.output)).toEqual(result.envelope);
    expect(result.output.endsWith("\n")).toBe(true);
  });

  it("accepts a sparse event and fills absent fields", () => {
    const file = writeEvent("{}");
    const result = explainAction({ eventPath: file, ...SEAMS });
    expect(result.envelope.event).toBe("");
    expect(result.envelope.tool).toBe("");
    expect(result.envelope.raw_input).toBeNull();
  });

  it("resolves git against the event's cwd, falling back when absent", () => {
    const seen: string[] = [];
    const resolveGit = (cwd: string): GitRepoContext => {
      seen.push(cwd);
      return FIXED_GIT;
    };
    const withCwd = writeEvent(JSON.stringify({ cwd: "/work/explicit" }));
    explainAction({ ...SEAMS, resolveGit, eventPath: withCwd });
    const withoutCwd = writeEvent("{}");
    const r = explainAction({ ...SEAMS, resolveGit, eventPath: withoutCwd });
    expect(seen).toEqual(["/work/explicit", "/fallback/cwd"]);
    expect(r.envelope.runtime.cwd).toBe("/fallback/cwd");
  });
});

describe("explainAction — input errors", () => {
  it("throws EX_NOINPUT when the file is missing", () => {
    let caught: unknown;
    try {
      explainAction({ eventPath: "/nonexistent/event.json", ...SEAMS });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    expect((caught as HarnessExitError).exitCode).toBe(66);
    expect((caught as HarnessExitError).message).toMatch(/not found/);
  });

  it("throws EX_NOINPUT on malformed JSON", () => {
    const file = writeEvent("{ not json");
    let caught: unknown;
    try {
      explainAction({ eventPath: file, ...SEAMS });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    expect((caught as HarnessExitError).exitCode).toBe(66);
    expect((caught as HarnessExitError).message).toMatch(/malformed/);
  });

  it("throws EX_NOINPUT when the JSON is not an object", () => {
    for (const body of ["[1,2,3]", '"a string"', "42", "null"]) {
      const file = writeEvent(body);
      let caught: unknown;
      try {
        explainAction({ eventPath: file, ...SEAMS });
      } catch (e) {
        caught = e;
      }
      expect(caught, `body ${body}`).toBeInstanceOf(HarnessExitError);
      expect((caught as HarnessExitError).exitCode).toBe(66);
      expect((caught as HarnessExitError).message).toMatch(/must be an object/);
    }
  });
});
