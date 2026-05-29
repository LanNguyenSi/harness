import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { testRisk } from "../../src/cli/test-risk.js";
import { HarnessExitError } from "../../src/cli/exit-codes.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";
import type { GitRepoContext } from "../../src/runtime/git-context.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function writeEvent(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-test-risk-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "event.json");
  fs.writeFileSync(file, contents, "utf8");
  return file;
}

function bashEvent(command: string): string {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
  });
}

const MANIFEST: Manifest = parseManifest({
  version: 1,
  risk: {
    classifiers: [
      {
        name: "dangerous-shell",
        tool: "Bash",
        patterns: [
          {
            pattern: "rm\\s+-rf\\s+/",
            categories: ["destructive", "data_loss"],
            severity: "critical",
          },
        ],
      },
    ],
  },
});

const EMPTY_MANIFEST: Manifest = parseManifest({ version: 1 });

// Deterministic seams so the envelope build never touches the real
// clock / host / filesystem.
const SEAMS = {
  now: new Date("2026-05-22T12:00:00.000Z"),
  host: "runner-01",
  user: "agent",
  resolveGit: (): GitRepoContext => ({ repo: "r", branch: "main", sha: "" }),
  cwdFallback: "/fallback",
};

describe("testRisk — classification", () => {
  it("classifies a matching action against the injected manifest", () => {
    const file = writeEvent(bashEvent("rm -rf /var/data"));
    const result = testRisk({ ...SEAMS, eventPath: file, manifest: MANIFEST });
    expect(result.profile.classified).toBe(true);
    expect(result.profile.severity).toBe("critical");
    expect(result.profile.reversible).toBe(false);
    expect(parseYaml(result.output)).toEqual(result.profile);
  });

  it("emits valid JSON with --json", () => {
    const file = writeEvent(bashEvent("rm -rf /"));
    const result = testRisk({
      ...SEAMS,
      eventPath: file,
      manifest: MANIFEST,
      json: true,
    });
    expect(JSON.parse(result.output)).toEqual(result.profile);
    expect(result.output.endsWith("\n")).toBe(true);
  });

  it("reports an unmatched action as unclassified, not safe", () => {
    const file = writeEvent(bashEvent("ls -la"));
    const result = testRisk({ ...SEAMS, eventPath: file, manifest: MANIFEST });
    expect(result.profile.classified).toBe(false);
    expect(result.profile.severity).toBeNull();
  });

  it("surfaces the built-in benign-harness floor (consistent with the runtime)", () => {
    // The debug verb must report the same classification the gate uses,
    // including the built-in floor for harness's own meta-commands —
    // even when the manifest declares no classifiers.
    const file = writeEvent(bashEvent("harness preflight"));
    const result = testRisk({ ...SEAMS, eventPath: file, manifest: EMPTY_MANIFEST });
    expect(result.profile.classified).toBe(true);
    expect(result.profile.severity).toBe("low");
    expect(result.profile.reasons[0]).toMatch(/built-in: benign harness meta-command/);
  });

  it("treats every action as unclassified when the manifest has no classifiers", () => {
    const file = writeEvent(bashEvent("rm -rf /"));
    const result = testRisk({
      ...SEAMS,
      eventPath: file,
      manifest: EMPTY_MANIFEST,
    });
    expect(result.profile.classified).toBe(false);
    expect(result.profile.reasons[0]).toMatch(/no risk classifier is declared/);
  });
});

describe("testRisk — input errors", () => {
  it("throws EX_NOINPUT when the event file is missing", () => {
    let caught: unknown;
    try {
      testRisk({ ...SEAMS, eventPath: "/nonexistent.json", manifest: MANIFEST });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    expect((caught as HarnessExitError).exitCode).toBe(66);
    expect((caught as HarnessExitError).message).toMatch(/test-risk:/);
  });
});
