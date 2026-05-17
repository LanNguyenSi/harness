import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInteractive, type InteractivePrompts } from "../../src/cli/init/interactive.js";

// Helper: build a mock prompts pack that returns queued answers in order
// the wizard asks them. This is intentionally dumb — we match by prompt
// kind (select / confirm / input / checkbox), not by message string,
// because tying tests to copy means every wording tweak breaks them.
// The wizard's prompt order is documented in src/cli/init/interactive.ts.
function mockPrompts(queue: {
  select?: string[];
  confirm?: boolean[];
  input?: string[];
  checkbox?: string[][];
}): InteractivePrompts {
  const selectQ = [...(queue.select ?? [])];
  const confirmQ = [...(queue.confirm ?? [])];
  const inputQ = [...(queue.input ?? [])];
  const checkboxQ = [...(queue.checkbox ?? [])];
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
    checkbox: (async () => {
      const v = checkboxQ.shift();
      if (v === undefined) throw new Error("mockPrompts: checkbox queue empty");
      return v;
    }) as unknown as InteractivePrompts["checkbox"],
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

// `fakeDepsPath` points at a tmp directory containing executable stubs
// for every binary `dependenciesForProfile("full")` looks for. Tests
// that do not exercise the dependency-install flow pass
// `dependencyPathEnv: fakeDepsPath` to short-circuit the dep check
// (every dep reads as "already installed"), so the wizard never tries
// to run `npm i -g`.
//
// Without this, tests on CI (where the @lannguyensi/* binaries are NOT
// globally installed by `npm ci`) would fall through into the install
// prompt, consume a queued confirm meant for a later step, and spawn a
// real `npm i -g` that times out under the 5s vitest budget. See
// agent-tasks/69ef84cd for the regression incident.
let tmpHome: string;
let fakeDepsPath: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "harness-wizard-"));
  fakeDepsPath = fs.mkdtempSync(path.join(os.tmpdir(), "harness-wizard-deps-"));
  for (const bin of [
    "memory-router-user-prompt-submit",
    "understanding-gate-claude-hook",
    "understanding-gate-claude-stop",
    "agent-tasks-mcp-bridge",
    "grounding-mcp",
    "preflight",
  ]) {
    const p = path.join(fakeDepsPath, bin);
    fs.writeFileSync(p, "#!/bin/sh\n");
    fs.chmodSync(p, 0o755);
  }
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(fakeDepsPath, { recursive: true, force: true });
});

describe("interactive wizard — Solo path", () => {
  it("writes a solo manifest, runs validate, returns validateClean (skip wiring)", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      prompts: mockPrompts({
        select: ["solo"],
        input: ["~/.claude/projects/{project}/memory"],
        confirm: [
          true, // write manifest
        ],
        checkbox: [
          [], // uncheck every runtime → skip wiring
        ],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(result.profile).toBe("solo");
    expect(result.validateClean).toBe(true);
    expect(result.apply).toBeUndefined();
    expect(result.applies).toEqual([]);
    expect(fs.existsSync(path.join(tmpHome, ".claude", "harness.yaml"))).toBe(true);
    expect(cap.stderr()).toMatch(/Environment probe/);
    expect(cap.stderr()).toMatch(/harness validate: 0 error/);
    // When the operator unchecks all runtimes, the manifest-only
    // follow-up command MUST be the merge-into-settings.json incantation
    // (not the bare `apply --runtime claude-code` that only writes to
    // harness.generated/ and confuses fresh users).
    expect(cap.stderr()).toContain("harness apply --target");
    expect(cap.stderr()).toContain("--merge");
    // The skip-fallback must also surface the codex manual path so a
    // Codex-only operator who reads the skip message knows how to wire.
    expect(cap.stderr()).toContain("harness apply --runtime codex");
    // Hallucination regression guard from the original test: the wizard
    // must NOT suggest `--runtime claude` shorthand (the real flag value
    // is `claude-code`; the bare `claude` shorthand falls back at runtime
    // with a warning and reads as wrong to operators).
    expect(cap.stderr()).not.toContain("--runtime claude\n");
    expect(cap.stderr()).not.toContain("--runtime claude ");
  });

  it("auto-runs the merge-apply when the operator selects claude-code", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      prompts: mockPrompts({
        select: ["solo"],
        input: ["~/.claude/projects/{project}/memory"],
        confirm: [
          true, // write manifest
        ],
        checkbox: [
          ["claude-code"],
        ],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(result.validateClean).toBe(true);
    expect(result.applies).toHaveLength(1);
    expect(result.applies?.[0]?.runtime).toBe("claude-code");
    expect(result.applies?.[0]?.apply?.targetWritten).toBe(true);
    // Legacy `apply` shorthand still set for claude-code wiring.
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

  it("wire-now bypasses stale-snapshot drift (agent-tasks/df68b3e6 regression)", async () => {
    // The bug this guards: a pre-existing `~/.claude/harness.generated/settings.json`
    // (from a prior harness version, or any state where the .last-apply
    // snapshot is missing/stale) caused the wire-now apply to return
    // drift-refuse silently. targetWritten stayed false, no "wired into"
    // message printed, no error thrown — the operator saw the codex
    // section of the wire output and concluded everything was fine,
    // while settings.json never received the new pack hooks (this was
    // the v0.17.2 dogfood incident: branch-protection landed in
    // FULL_TEMPLATE but never wired into the operator's settings.json).
    //
    // Fix: init's wireRuntime passes overwriteDrift + auto-confirm so
    // the canonical "wire this freshly written manifest" intent always
    // lands, regardless of pre-existing harness.generated state. Drift
    // safeguards are appropriate for ad-hoc `harness apply`, not for
    // init's start-from-scratch path.
    fs.mkdirSync(path.join(tmpHome, ".claude", "harness.generated"), { recursive: true });
    // Seed a stale generated/settings.json with content that won't
    // match the about-to-be-written manifest. Without the fix, the
    // missing .last-apply snapshot makes this look like full-file
    // drift and apply refuses to overwrite.
    fs.writeFileSync(
      path.join(tmpHome, ".claude", "harness.generated", "settings.json"),
      JSON.stringify({ hooks: { Stale: [{ hooks: [] }] } }, null, 2),
    );
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      prompts: mockPrompts({
        select: ["solo"],
        input: ["~/.claude/projects/{project}/memory"],
        confirm: [true],
        checkbox: [["claude-code"]],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(result.validateClean).toBe(true);
    expect(result.applies?.[0]?.runtime).toBe("claude-code");
    // The load-bearing assertion: targetWritten is true even though
    // there was pre-existing drift in harness.generated/settings.json.
    expect(result.applies?.[0]?.apply?.targetWritten).toBe(true);
    const settingsPath = path.join(tmpHome, ".claude", "settings.json");
    expect(fs.existsSync(settingsPath)).toBe(true);
    const wired = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    expect(wired.hooks).toBeDefined();
    // And no "Stale" hooks survive — the merge used the freshly-applied
    // generated/settings.json, not the stale one we seeded.
    expect(JSON.stringify(wired.hooks)).not.toContain("Stale");
    expect(cap.stderr()).toContain("wired into");
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
      dependencyPathEnv: fakeDepsPath,
      prompts: mockPrompts({
        select: ["solo"],
        input: ["~/.claude/projects/{project}/memory"],
        confirm: [
          true, // write manifest
        ],
        checkbox: [
          ["claude-code"], // wire-now will fail inside apply
        ],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(result.validateClean).toBe(true);
    expect(result.applies).toHaveLength(1);
    expect(result.applies?.[0]?.runtime).toBe("claude-code");
    expect(result.applies?.[0]?.apply).toBeUndefined();
    expect(result.applies?.[0]?.recoveryHint).toMatch(/harness apply --target .* --merge/);
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
      dependencyPathEnv: fakeDepsPath,
      prompts: mockPrompts({
        select: ["team"],
        confirm: [
          true, // proceed despite missing agent-tasks
          true, // confirm write
        ],
        checkbox: [[]],
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
      dependencyPathEnv: fakeDepsPath,
      prompts: mockPrompts({
        select: ["team"],
        confirm: [
          true, // write (no agent-tasks warning prompt)
        ],
        checkbox: [[]],
        input: ["~/.claude/projects/{project}/memory"],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(result.profile).toBe("team");
  });
});

describe("interactive wizard — Custom path (task 31d2fbb5)", () => {
  it("aborts cleanly with no write when every checkbox is empty", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      prompts: mockPrompts({
        select: ["custom"],
        // packs / mcps / policies all empty.
        checkbox: [[], [], []],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(true);
    expect(result.profile).toBe("custom");
    expect(cap.stderr()).toMatch(/no components selected/);
    // Crucially: NO manifest landed on disk for an empty selection.
    expect(fs.existsSync(path.join(tmpHome, ".claude", "harness.yaml"))).toBe(false);
  });

  it("composes a minimal-pick manifest that harness validate accepts (just the understanding pack)", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      prompts: mockPrompts({
        select: ["custom"],
        // packs: just understanding-before-execution; mcps: none; policies: none.
        checkbox: [
          ["understanding-before-execution"],
          [],
          [],
          [], // wire-now multiselect — skip wiring
        ],
        input: ["~/.claude/projects/{project}/memory"],
        confirm: [true], // confirm write
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(result.profile).toBe("custom");
    expect(result.init?.template).toBe("custom");
    expect(result.validateClean).toBe(true);
    const manifestPath = path.join(tmpHome, ".claude", "harness.yaml");
    expect(fs.existsSync(manifestPath)).toBe(true);
    const content = fs.readFileSync(manifestPath, "utf8");
    expect(content).toContain("Custom profile");
    expect(content).toContain("understanding-before-execution");
    // Minimal-pick manifest must NOT carry policies/MCPs the operator didn't tick.
    expect(content).not.toContain("agent-tasks");
    expect(content).not.toContain("review-before-merge");
  });

  it("composes a full-equivalent pick (every checkbox, with the three reference policies)", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      prompts: mockPrompts({
        select: ["custom"],
        checkbox: [
          ["understanding-before-execution"],
          ["agent-tasks", "grounding-mcp", "memory-router"],
          [
            "review-before-merge",
            "preflight-before-investigation",
            "review-subagent-before-pr-create",
          ],
          [], // wire-now skip
        ],
        input: ["~/.claude/projects/{project}/memory"],
        confirm: [true],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(result.validateClean).toBe(true);
    const content = fs.readFileSync(
      path.join(tmpHome, ".claude", "harness.yaml"),
      "utf8",
    );
    expect(content).toContain("agent-tasks");
    expect(content).toContain("grounding-mcp");
    // memory-router is wired under memory.router, not tools.mcp[]; the
    // composer must NOT emit it as an MCP entry.
    expect(content).toContain("memory-router-user-prompt-submit");
    expect(content).toMatch(/router:\s*\n\s+command:\s*\n?\s*-\s+memory-router-user-prompt-submit/);
    expect(content).toContain("review-before-merge");
    expect(content).toContain("preflight-before-investigation");
    expect(content).toContain("review-subagent-before-pr-create");
    // No producer-coupling warnings since agent-tasks + grounding-mcp + pack are all selected.
    expect(cap.stderr()).not.toMatch(/composer warning/);
  });

  it("pre-checks MCPs whose names are already wired in detected settings.json", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    // Pre-wire agent-tasks in settings.json so detect() surfaces it.
    fs.writeFileSync(
      path.join(tmpHome, ".claude", "settings.json"),
      JSON.stringify({ mcpServers: { "agent-tasks": { command: "node", args: ["x.js"] } } }),
    );
    let capturedMcpChoices: { value: string; checked: boolean }[] = [];
    const cap = captureStreams();
    const recordingCheckbox = (async (args: { choices: { value: string; checked?: boolean }[] }) => {
      // Capture the second checkbox call (MCPs); first is packs, third is policies.
      if (args.choices.some((c) => c.value === "agent-tasks")) {
        capturedMcpChoices = args.choices.map((c) => ({
          value: c.value,
          checked: c.checked === true,
        }));
      }
      // Empty selection for every checkbox keeps the wizard from proceeding past the abort guard.
      return [];
    }) as unknown as InteractivePrompts["checkbox"];
    const prompts: InteractivePrompts = {
      select: (async () => "custom") as unknown as InteractivePrompts["select"],
      confirm: (async () => false) as unknown as InteractivePrompts["confirm"],
      input: (async () => "~/.claude/projects/{project}/memory") as unknown as InteractivePrompts["input"],
      checkbox: recordingCheckbox,
    };
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      prompts,
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(true); // Empty selection → abort
    const at = capturedMcpChoices.find((c) => c.value === "agent-tasks");
    const gm = capturedMcpChoices.find((c) => c.value === "grounding-mcp");
    expect(at?.checked).toBe(true);
    expect(gm?.checked).toBe(false);
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
      dependencyPathEnv: fakeDepsPath,
      prompts: mockPrompts({
        select: ["solo"],
        confirm: [
          true, // overwrite
          true, // write
        ],
        checkbox: [[]],
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
      dependencyPathEnv: fakeDepsPath,
      prompts: mockPrompts({
        select: ["solo"],
        confirm: [
          true, // write
        ],
        checkbox: [[]],
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

describe("interactive wizard — dependency install", () => {
  it("offers to install missing packages and continues on success", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    const spawnCalls: string[][] = [];
    const result = await runInteractive({
      homeDir: tmpHome,
      // Empty PATH forces every dep to look missing.
      dependencyPathEnv: "/nonexistent-bin-dir-for-tests",
      installSpawn: async (_cmd: string, args: string[]) => {
        spawnCalls.push(args);
        return { code: 0, stderr: "" };
      },
      prompts: mockPrompts({
        select: ["solo"],
        input: ["~/.claude/projects/{project}/memory"],
        confirm: [
          true, // accept the install prompt
          true, // write manifest
        ],
        checkbox: [[]],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(result.profile).toBe("solo");
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.slice(0, 2)).toEqual(["i", "-g"]);
    // The two missing solo packages must show up in the install args.
    expect(spawnCalls[0]).toContain("@lannguyensi/memory-router");
    expect(spawnCalls[0]).toContain("@lannguyensi/understanding-gate");
    expect(cap.stderr()).toMatch(/Installed 2 package\(s\) successfully/);
  });

  it("aborts and does NOT write the manifest when npm install fails", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: "/nonexistent-bin-dir-for-tests",
      installSpawn: async () => ({ code: 1, stderr: "npm ERR! EACCES\n" }),
      prompts: mockPrompts({
        select: ["solo"],
        input: ["~/.claude/projects/{project}/memory"],
        confirm: [
          true, // accept install
        ],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(true);
    expect(result.profile).toBe("solo");
    expect(cap.stderr()).toMatch(/npm install exited 1/);
    expect(cap.stderr()).toMatch(/Manifest NOT written/);
    expect(fs.existsSync(path.join(tmpHome, ".claude", "harness.yaml"))).toBe(false);
  });

  it("aborts when the operator declines the install offer", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    let spawned = false;
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: "/nonexistent-bin-dir-for-tests",
      installSpawn: async () => {
        spawned = true;
        return { code: 0, stderr: "" };
      },
      prompts: mockPrompts({
        select: ["solo"],
        input: ["~/.claude/projects/{project}/memory"],
        confirm: [
          false, // decline install
        ],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(true);
    expect(spawned).toBe(false);
    expect(cap.stderr()).toMatch(/dependencies missing and install declined/);
    expect(cap.stderr()).toMatch(/To install manually: npm i -g/);
    expect(fs.existsSync(path.join(tmpHome, ".claude", "harness.yaml"))).toBe(false);
  });
});

describe("interactive wizard — Full profile", () => {
  it("writes a self-contained full manifest with no external hook scripts", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      prompts: mockPrompts({
        select: ["full"],
        input: ["~/.claude/projects/{project}/memory"],
        confirm: [
          true, // proceed despite missing agent-tasks in settings.json
          true, // write manifest
        ],
        checkbox: [[]],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(result.profile).toBe("full");
    expect(fs.existsSync(path.join(tmpHome, ".claude", "harness.yaml"))).toBe(true);
    const content = fs.readFileSync(path.join(tmpHome, ".claude", "harness.yaml"), "utf8");
    // Full template carries the additional reference policies that
    // Team does not ship.
    expect(content).toContain("review-before-merge");
    expect(content).toContain("dogfood-before-release");
    expect(content).toContain("preflight-before-investigation");
    // Regression guard: every hook in Full now uses the bundled
    // `harness policy intercept` engine. No hook's `command:` field
    // may reference an external .sh script.
    expect(content).not.toMatch(/^\s*command:.*\.sh\b/m);
    // The Glob + Grep builtins should be listed so doctor stops
    // emitting the spurious "runtime advertises X but manifest does not
    // list it" warnings.
    expect(content).toContain("Glob");
    expect(content).toContain("Grep");
  });
});

describe("interactive wizard — runtime multiselect (task 696f7560)", () => {
  it("wires only codex when the operator picks codex", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      prompts: mockPrompts({
        select: ["solo"],
        input: ["~/.claude/projects/{project}/memory"],
        confirm: [true],
        checkbox: [["codex"]],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(result.validateClean).toBe(true);
    expect(result.applies).toHaveLength(1);
    expect(result.applies?.[0]?.runtime).toBe("codex");
    expect(result.applies?.[0]?.apply).toBeDefined();
    // Codex apply emits harness.generated/codex/config.toml — the
    // operator-owned ~/.codex/config.toml is NEVER touched by the
    // wizard (apply.ts rejects --target+codex).
    const codexGenerated = path.join(
      tmpHome,
      ".claude",
      "harness.generated",
      "codex",
      "config.toml",
    );
    expect(fs.existsSync(codexGenerated)).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, ".codex", "config.toml"))).toBe(false);
    // Legacy `apply` field stays undefined when only codex is wired.
    expect(result.apply).toBeUndefined();
    expect(cap.stderr()).toContain("codex config generated at");
    expect(cap.stderr()).toMatch(/copy or include those \[\[hooks\.\*\]\] entries/);
    // Claude Code's settings.json must NOT be touched when only codex is selected.
    expect(fs.existsSync(path.join(tmpHome, ".claude", "settings.json"))).toBe(false);
  });

  it("wires both runtimes in one run when the operator picks both", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      prompts: mockPrompts({
        select: ["solo"],
        input: ["~/.claude/projects/{project}/memory"],
        confirm: [true],
        checkbox: [["claude-code", "codex"]],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(result.applies).toHaveLength(2);
    expect(result.applies?.map((a) => a.runtime).sort()).toEqual(["claude-code", "codex"]);
    // Claude settings.json was wired AND the codex generated artefact exists.
    expect(fs.existsSync(path.join(tmpHome, ".claude", "settings.json"))).toBe(true);
    expect(
      fs.existsSync(path.join(tmpHome, ".claude", "harness.generated", "codex", "config.toml")),
    ).toBe(true);
    expect(result.apply).toBeDefined();
    expect(result.apply?.targetWritten).toBe(true);
    // Operator gets the lock-drift caveat (documented in apply.ts).
    expect(cap.stderr()).toMatch(/harness\.lock will reflect the last-applied runtime/);
  });

  it("uncheck-all skips wiring entirely and surfaces both manual fallback commands", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      prompts: mockPrompts({
        select: ["solo"],
        input: ["~/.claude/projects/{project}/memory"],
        confirm: [true],
        checkbox: [[]],
      }),
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(false);
    expect(result.validateClean).toBe(true);
    expect(result.applies).toEqual([]);
    expect(result.apply).toBeUndefined();
    expect(fs.existsSync(path.join(tmpHome, ".claude", "harness.yaml"))).toBe(true);
    // No runtime file landed.
    expect(fs.existsSync(path.join(tmpHome, ".claude", "settings.json"))).toBe(false);
    expect(
      fs.existsSync(path.join(tmpHome, ".claude", "harness.generated", "codex", "config.toml")),
    ).toBe(false);
    expect(cap.stderr()).toContain("no runtimes selected");
    expect(cap.stderr()).toMatch(/harness apply --target .* --merge/);
    expect(cap.stderr()).toContain("harness apply --runtime codex");
  });

  it("Ctrl-C at the runtime checkbox aborts without touching wiring (manifest stays)", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const cap = captureStreams();
    const exitErr = new Error("User force closed the prompt with 0 null");
    exitErr.name = "ExitPromptError";
    const result = await runInteractive({
      homeDir: tmpHome,
      dependencyPathEnv: fakeDepsPath,
      prompts: {
        select: (async () => "solo") as unknown as InteractivePrompts["select"],
        confirm: (async () => true) as unknown as InteractivePrompts["confirm"],
        input: (async () => "~/.claude/projects/{project}/memory") as unknown as InteractivePrompts["input"],
        checkbox: (async () => {
          throw exitErr;
        }) as unknown as InteractivePrompts["checkbox"],
      },
      stdout: cap.out,
      stderr: cap.err,
    });
    expect(result.aborted).toBe(true);
    expect(cap.stderr()).toMatch(/Ctrl-C received/);
    // Manifest was already written before the runtime prompt — the
    // wizard does not roll it back; the abort contract is "no NEW
    // side effects after this prompt", and the manifest is the prior
    // step's output. Settings.json must NOT have been touched, though.
    expect(fs.existsSync(path.join(tmpHome, ".claude", "harness.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, ".claude", "settings.json"))).toBe(false);
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
      checkbox: (async () => []) as unknown as InteractivePrompts["checkbox"],
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
