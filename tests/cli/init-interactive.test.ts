import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInteractive, type InteractivePrompts } from "../../src/cli/init/interactive.js";

// Helper: build a mock prompts pack that returns queued answers in order
// the wizard asks them. This is intentionally dumb — we match by prompt
// kind (select / confirm / input), not by message string, because tying
// tests to copy means every wording tweak breaks them. The wizard's
// prompt order is documented in src/cli/init/interactive.ts.
function mockPrompts(queue: { select?: string[]; confirm?: boolean[]; input?: string[] }): InteractivePrompts {
  const selectQ = [...(queue.select ?? [])];
  const confirmQ = [...(queue.confirm ?? [])];
  const inputQ = [...(queue.input ?? [])];
  return {
    select: (async () => {
      const v = selectQ.shift();
      if (v === undefined) throw new Error("mockPrompts: select queue empty");
      return v;
    }) as unknown as InteractivePrompts["select"],
    confirm: (async () => {
      const v = confirmQ.shift();
      if (v === undefined) throw new Error("mockPrompts: confirm queue empty");
      return v;
    }) as unknown as InteractivePrompts["confirm"],
    input: (async () => {
      const v = inputQ.shift();
      if (v === undefined) throw new Error("mockPrompts: input queue empty");
      return v;
    }) as unknown as InteractivePrompts["input"],
  };
}

function captureStreams(): { stdout: () => string; stderr: () => string; out: (s: string) => void; err: (s: string) => void } {
  let out = "";
  let err = "";
  return {
    stdout: () => out,
    stderr: () => err,
    out: (s: string) => {
      out += s;
    },
    err: (s: string) => {
      err += s;
    },
  };
}

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "harness-wizard-"));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("interactive wizard — Solo path", () => {
  it("writes a solo manifest, runs validate, returns validateClean", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      prompts: mockPrompts({
        select: ["solo"],
        input: ["~/.claude/projects/{project}/memory"],
        confirm: [
          true, // write manifest
          false, // decline wire-now (test the manifest-only path)
        ],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(result.profile).toBe("solo");
    expect(result.validateClean).toBe(true);
    expect(result.apply).toBeUndefined();
    expect(fs.existsSync(path.join(tmpHome, ".claude", "harness.yaml"))).toBe(true);
    expect(cap.stderr()).toMatch(/Environment probe/);
    expect(cap.stderr()).toMatch(/harness validate: 0 error/);
    // When the operator declines the wire-now offer, the manifest-only
    // follow-up command MUST be the merge-into-settings.json incantation
    // (not the bare `apply --runtime claude-code` that only writes to
    // harness.generated/ and confuses fresh users).
    expect(cap.stderr()).toContain("harness apply --target");
    expect(cap.stderr()).toContain("--merge");
    // Hallucination regression guard from the original test: the wizard
    // must NOT suggest `--runtime claude` shorthand (the real flag value
    // is `claude-code`; the bare `claude` shorthand falls back at runtime
    // with a warning and reads as wrong to operators).
    expect(cap.stderr()).not.toContain("--runtime claude\n");
    expect(cap.stderr()).not.toContain("--runtime claude ");
  });

  it("auto-runs the merge-apply when the operator accepts the wire-now offer", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      prompts: mockPrompts({
        select: ["solo"],
        input: ["~/.claude/projects/{project}/memory"],
        confirm: [
          true, // write manifest
          true, // accept wire-now
        ],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(result.validateClean).toBe(true);
    expect(result.apply).toBeDefined();
    expect(result.apply?.targetWritten).toBe(true);
    const settingsPath = path.join(tmpHome, ".claude", "settings.json");
    expect(result.apply?.targetPath).toBe(settingsPath);
    expect(fs.existsSync(settingsPath)).toBe(true);
    // Verify the merge actually projected the harness-owned shape — not
    // just that a file exists at the path. Future refactors that break
    // the projection without breaking the existence check still trip
    // this assertion.
    const wired = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    expect(wired.hooks).toBeDefined();
    expect(cap.stderr()).toContain("wired into");
    expect(cap.stderr()).toContain("verify: claude -p");
    expect(cap.stderr()).not.toContain("--runtime claude\n");
  });

  it("recovers gracefully when the wire-now merge throws (permission denied / malformed target)", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    // Pre-create the target as unreadable JSON: apply --merge throws
    // when the existing file is not valid JSON. The wizard must catch
    // that, print a recovery hint, and still return validateClean.
    fs.writeFileSync(path.join(tmpHome, ".claude", "settings.json"), "not-json{");
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      prompts: mockPrompts({
        select: ["solo"],
        input: ["~/.claude/projects/{project}/memory"],
        confirm: [
          true, // write manifest
          true, // accept wire-now (will fail inside apply)
        ],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(result.validateClean).toBe(true);
    expect(result.apply).toBeUndefined();
    expect(cap.stderr()).toMatch(/Failed to wire/);
    expect(cap.stderr()).toMatch(/harness apply --target .* --merge/);
  });
});

describe("interactive wizard — Team path", () => {
  it("warns when agent-tasks is not detected but proceeds when operator confirms", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      prompts: mockPrompts({
        select: ["team"],
        confirm: [
          true, // proceed despite missing agent-tasks
          true, // confirm write
          false, // decline wire-now
        ],
        input: ["~/.claude/projects/{project}/memory"],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(result.profile).toBe("team");
    expect(result.validateClean).toBe(true);
  });

  it("does NOT warn about agent-tasks when it is already wired in settings.json", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    fs.writeFileSync(
      path.join(tmpHome, ".claude", "settings.json"),
      JSON.stringify({ mcpServers: { "agent-tasks": { command: "node", args: ["x.js"] } } }),
    );
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      prompts: mockPrompts({
        select: ["team"],
        confirm: [
          true, // write (no agent-tasks warning prompt)
          false, // decline wire-now
        ],
        input: ["~/.claude/projects/{project}/memory"],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(result.profile).toBe("team");
  });
});

describe("interactive wizard — Custom path", () => {
  it("bails out with a hint about --template full, writes nothing", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      prompts: mockPrompts({ select: ["custom"] }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(true);
    expect(result.profile).toBe("custom");
    expect(cap.stderr()).toMatch(/harness init --template full/);
    expect(fs.existsSync(path.join(tmpHome, ".claude", "harness.yaml"))).toBe(false);
  });
});

describe("interactive wizard — overwrite guard", () => {
  it("aborts when an existing manifest is found and operator declines overwrite", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    fs.writeFileSync(path.join(tmpHome, ".claude", "harness.yaml"), "version: 1\n# preserved\n");
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      prompts: mockPrompts({ confirm: [false] }), // decline overwrite
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(true);
    expect(cap.stderr()).toMatch(/existing manifest left untouched/);
    // File untouched.
    expect(fs.readFileSync(path.join(tmpHome, ".claude", "harness.yaml"), "utf8")).toContain("preserved");
  });

  it("proceeds when operator approves overwrite", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    fs.writeFileSync(path.join(tmpHome, ".claude", "harness.yaml"), "version: 1\n# old\n");
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      prompts: mockPrompts({
        select: ["solo"],
        confirm: [
          true, // overwrite
          true, // write
          false, // decline wire-now
        ],
        input: ["~/.claude/projects/{project}/memory"],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(result.profile).toBe("solo");
    const content = fs.readFileSync(path.join(tmpHome, ".claude", "harness.yaml"), "utf8");
    expect(content).not.toContain("# old");
    expect(content).toContain("understanding-before-execution");
  });
});

describe("interactive wizard — no-detection path", () => {
  it("runs cleanly when no runtime config exists at all", async () => {
    // tmpHome is brand-new; neither .claude nor .codex exist.
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      prompts: mockPrompts({
        select: ["solo"],
        confirm: [
          true, // write
          false, // decline wire-now
        ],
        input: ["~/.claude/projects/{project}/memory"],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(result.validateClean).toBe(true);
    expect(cap.stderr()).toMatch(/claude-code\s+not found/);
    expect(cap.stderr()).toMatch(/codex\s+not found/);
  });
});

describe("interactive wizard — Ctrl-C", () => {
  it("treats an ExitPromptError from the prompt library as an abort, writes nothing", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    const exitErr = new Error("User force closed the prompt with 0 null");
    exitErr.name = "ExitPromptError";
    const prompts: InteractivePrompts = {
      select: (async () => {
        throw exitErr;
      }) as unknown as InteractivePrompts["select"],
      confirm: (async () => true) as unknown as InteractivePrompts["confirm"],
      input: (async () => "ignored") as unknown as InteractivePrompts["input"],
    };
    const result = await runInteractive({
      homeDir: tmpHome,
      prompts,
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(true);
    expect(cap.stderr()).toMatch(/Ctrl-C received/);
    expect(fs.existsSync(path.join(tmpHome, ".claude", "harness.yaml"))).toBe(false);
  });
});
