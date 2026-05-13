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
        confirm: [true], // write
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(result.profile).toBe("solo");
    expect(result.validateClean).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, ".claude", "harness.yaml"))).toBe(true);
    expect(cap.stderr()).toMatch(/Environment probe/);
    expect(cap.stderr()).toMatch(/harness validate: 0 error/);
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
        confirm: [true], // single confirm: write (no agent-tasks warning prompt)
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
        confirm: [true], // write
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
