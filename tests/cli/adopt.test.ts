import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { adopt, type AdoptOptions } from "../../src/cli/adopt/index.js";
import {
  computeDrift,
  computeMcpDrift,
  manifestMcpProjection,
  manifestProjection,
  parseSettingsHooks,
  parseSettingsMcpServers,
  synthesizeName,
} from "../../src/cli/adopt/derive.js";
import {
  SOLUTION_VERDICT_SIGNING_KEY_ENV,
  generateSettingsWithWarnings,
} from "../../src/cli/apply/generate-settings.js";
import { signingKeyPathFor } from "../../src/runtime/approval-signing.js";
import { init } from "../../src/cli/init/index.js";
import { parseManifest } from "../../src/schema/index.js";
import { STUB_NPM_BIN_EXEC_WARN } from "../_helpers/npm-bin-exec.js";

let tmpHome: string;
let manifestPath: string;
let settingsPath: string;
// task 83d8d03a (D-101): MCP drift now comes from the effective Claude
// Code registry (read-only top-level `mcpServers` of ~/.claude.json),
// NEVER from settingsPath. `registryPath` is a per-test tmp fixture that
// does not exist until a test writes to it via `writeRegistry` — never
// the real machine's ~/.claude.json — so every `runAdopt()` call below
// stays hermetic even when a test doesn't care about MCP servers at all.
let registryPath: string;

// Every test's `beforeEach` calls `init()` once to seed a minimal manifest,
// which — since task 7f8fb4bc — runs a post-write bin-resolution check that
// spawns a real `npm prefix -g` unless a fake exec is injected (init/index.ts
// InitOptions.npmBinExec, threaded to checkBinResolution/checkNpmBinPath).
// The minimal template declares zero `tools.mcp[]` / `tools.cli[]` entries,
// so STUB_NPM_BIN_EXEC_WARN's return value is never actually consulted by
// checkBinResolution's per-binary loop in this file; the stub exists for
// hermeticity, not realism (review finding F4, task T-007; variants
// documented in tests/_helpers/npm-bin-exec.ts).

beforeEach(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "harness-adopt-"));
  manifestPath = path.join(tmpHome, "harness.yaml");
  settingsPath = path.join(tmpHome, "settings.json");
  registryPath = path.join(tmpHome, ".claude.json");
  await init({ homeDir: tmpHome, npmBinExec: STUB_NPM_BIN_EXEC_WARN }); // minimal — empty hooks
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function writeSettings(hooks: unknown): void {
  fs.writeFileSync(settingsPath, JSON.stringify({ hooks }, null, 2));
}

/** Writes the effective Claude Code user-scope registry fixture (~/.claude.json shape). */
function writeRegistry(mcpServers: unknown): void {
  fs.writeFileSync(registryPath, JSON.stringify({ mcpServers }, null, 2));
}

function readManifest(): unknown {
  return parseYaml(fs.readFileSync(manifestPath, "utf8"));
}

/**
 * Hermetic wrapper around `adopt()`: defaults `registryPath` to this
 * test's tmp fixture (see `registryPath` above) so no call ever falls
 * through to `resolveClaudeUserRegistryPath()`'s real-machine default —
 * a bare `adopt()` call without this would read the ACTUAL developer/CI
 * machine's `~/.claude.json` for MCP drift, which is exactly what task
 * 83d8d03a's "hermetic tests" acceptance criterion forbids. Individual
 * tests can still override `registryPath` (or `env`) via `opts`.
 */
function runAdopt(file: string, opts: AdoptOptions = {}): ReturnType<typeof adopt> {
  return adopt(file, { registryPath, ...opts });
}

describe("derive — pure functions", () => {
  it("parseSettingsHooks flattens the nested hooks tree", () => {
    const flat = parseSettingsHooks({
      hooks: {
        SessionStart: [
          { matcher: "", hooks: [{ type: "command", command: "/a/x.sh" }] },
        ],
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "/a/y.sh" }],
          },
        ],
      },
    });
    expect(flat).toEqual([
      { event: "SessionStart", command: "/a/x.sh" },
      { event: "PreToolUse", command: "/a/y.sh", match: "Bash" },
    ]);
  });

  it("parseSettingsHooks ignores unknown event keys and malformed entries", () => {
    const flat = parseSettingsHooks({
      hooks: {
        Bogus: [{ matcher: "", hooks: [{ type: "command", command: "/x" }] }],
        SessionStart: [{ matcher: "", hooks: [{ type: "command" }] }, "not-an-object"],
      },
    });
    expect(flat).toEqual([]);
  });

  it("manifestProjection mirrors hook entries into the flat shape", () => {
    const m = parseManifest({
      version: 1,
      hooks: [
        { name: "h1", event: "SessionStart", command: "/a", blocking: false },
        { name: "h2", event: "PreToolUse", command: "/b", match: "Bash", blocking: false },
      ],
    });
    expect(manifestProjection(m)).toEqual([
      { event: "SessionStart", command: "/a" },
      { event: "PreToolUse", command: "/b", match: "Bash" },
    ]);
  });

  it("computeDrift returns settings hooks not present in the manifest", () => {
    const settings = [
      { event: "SessionStart", command: "/a" },
      { event: "PreToolUse", command: "/b", match: "Bash" },
      { event: "PreToolUse", command: "/c", match: "Bash" },
    ];
    const manifest = [
      { event: "SessionStart", command: "/a" },
      { event: "PreToolUse", command: "/b", match: "Bash" },
    ];
    expect(computeDrift(settings, manifest)).toEqual([
      { event: "PreToolUse", command: "/c", match: "Bash" },
    ]);
  });

  it("synthesizeName uses the command basename without extension", () => {
    expect(synthesizeName({ event: "SessionStart", command: "/a/git-preflight.sh" }, new Set())).toBe(
      "git-preflight",
    );
    expect(synthesizeName({ event: "SessionStart", command: "memory-router-foo" }, new Set())).toBe(
      "memory-router-foo",
    );
  });

  it("synthesizeName disambiguates against existing names", () => {
    const taken = new Set(["foo", "foo-2"]);
    expect(synthesizeName({ event: "SessionStart", command: "/a/foo.sh" }, taken)).toBe("foo-3");
  });
});

describe("adopt — drift-and-accept (write-and-confirm y)", () => {
  it("captures the missing hook and writes the manifest on `y`", async () => {
    writeSettings({
      SessionStart: [
        { matcher: "", hooks: [{ type: "command", command: "/tmp/extra.sh" }] },
      ],
    });
    const result = await runAdopt(settingsPath, {
      configPath: manifestPath,
      prompt: async () => "y",
    });
    expect(result.outcome).toBe("applied");
    expect(result.applied).toBe(true);
    expect(result.driftCount).toBe(1);
    expect(result.adoptedNames).toEqual(["extra"]);
    const m = readManifest() as { hooks?: { name: string; command: string }[] };
    expect(m.hooks?.[0]).toMatchObject({ name: "extra", command: "/tmp/extra.sh" });
  });
});

describe("adopt — non-TTY guard", () => {
  it("refuses with a clear error when a confirmation is needed and stdin is not a TTY", async () => {
    writeSettings({
      SessionStart: [
        { matcher: "", hooks: [{ type: "command", command: "/tmp/extra.sh" }] },
      ],
    });
    const before = fs.readFileSync(manifestPath, "utf8");
    await expect(
      runAdopt(settingsPath, { configPath: manifestPath, stdinIsTTY: false }),
    ).rejects.toThrow(/stdin is not a TTY.*--yes/);
    expect(fs.readFileSync(manifestPath, "utf8")).toBe(before);
  });
});

describe("adopt — drift-and-decline", () => {
  it("on `N`: file is unchanged, outcome is declined", async () => {
    writeSettings({
      SessionStart: [
        { matcher: "", hooks: [{ type: "command", command: "/tmp/extra.sh" }] },
      ],
    });
    const before = fs.readFileSync(manifestPath, "utf8");
    const result = await runAdopt(settingsPath, {
      configPath: manifestPath,
      prompt: async () => "N",
    });
    expect(result.outcome).toBe("declined");
    expect(result.applied).toBe(false);
    expect(fs.readFileSync(manifestPath, "utf8")).toBe(before);
  });

  it("on empty answer: declined", async () => {
    writeSettings({
      SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "/tmp/x" }] }],
    });
    const result = await runAdopt(settingsPath, {
      configPath: manifestPath,
      prompt: async () => "",
    });
    expect(result.outcome).toBe("declined");
  });
});

describe("adopt — no-drift", () => {
  it("exits 0 with `no-drift` outcome and writes nothing", async () => {
    // Empty hooks in settings AND empty hooks in minimal-template manifest = no drift.
    writeSettings({});
    const before = fs.readFileSync(manifestPath, "utf8");
    const result = await runAdopt(settingsPath, { configPath: manifestPath });
    expect(result.outcome).toBe("no-drift");
    expect(result.driftCount).toBe(0);
    expect(result.applied).toBe(false);
    expect(result.diff).toBe("");
    expect(fs.readFileSync(manifestPath, "utf8")).toBe(before);
  });
});

describe("adopt — --yes", () => {
  it("commits unconditionally without prompting", async () => {
    writeSettings({
      SessionStart: [
        { matcher: "", hooks: [{ type: "command", command: "/tmp/yes.sh" }] },
      ],
    });
    const result = await runAdopt(settingsPath, {
      configPath: manifestPath,
      yes: true,
      // prompt MUST NOT be called when --yes is set; throw to verify.
      prompt: async () => {
        throw new Error("prompt should not be called when --yes is set");
      },
    });
    expect(result.applied).toBe(true);
    expect(result.outcome).toBe("applied");
  });
});

describe("adopt — input validation", () => {
  it("refuses to operate on a malformed input manifest (parseManifest throws)", async () => {
    // Note: this exercises the parseManifest gate at the start of adopt, not
    // the validate-before-write gate on the synthesised output. The latter is
    // defensively unreachable from a well-formed manifest + well-formed
    // settings.json — see the comment in src/cli/adopt/index.ts above the
    // validation block.
    writeSettings({
      SessionStart: [
        { matcher: "", hooks: [{ type: "command", command: "/tmp/a.sh" }] },
      ],
    });
    fs.writeFileSync(manifestPath, "version: 99\n");
    await expect(runAdopt(settingsPath, { configPath: manifestPath })).rejects.toBeDefined();
  });
});

describe("adopt — manifest must exist", () => {
  it("EX_NOINPUT (66) when manifest is missing", async () => {
    fs.unlinkSync(manifestPath);
    writeSettings({});
    await expect(
      runAdopt(settingsPath, { configPath: manifestPath }),
    ).rejects.toMatchObject({ name: "HarnessExitError", exitCode: 66 });
  });

  it("EX_NOINPUT (66) when settings file is missing", async () => {
    await expect(
      runAdopt(path.join(tmpHome, "no-such.json"), { configPath: manifestPath }),
    ).rejects.toMatchObject({ name: "HarnessExitError", exitCode: 66 });
  });
});

describe("adopt — invalid JSON", () => {
  it("EX_FAIL on malformed settings.json", async () => {
    fs.writeFileSync(settingsPath, "not json {{");
    await expect(
      runAdopt(settingsPath, { configPath: manifestPath }),
    ).rejects.toMatchObject({
      name: "HarnessExitError",
      exitCode: 1,
      message: expect.stringMatching(/not valid JSON/),
    });
  });
});

describe("derive — MCP servers", () => {
  it("parseSettingsMcpServers translates the mcpServers map into a flat list", async () => {
    const { parseSettingsMcpServers } = await import("../../src/cli/adopt/derive.js");
    const flat = parseSettingsMcpServers({
      mcpServers: {
        "grounding-mcp": { command: "node", args: ["/opt/server.js"] },
        "no-args": { command: "/usr/bin/lone" },
        "with-env": {
          command: "python",
          args: ["-m", "x"],
          env: { TOKEN: "abc" },
        },
      },
    });
    expect(flat).toEqual([
      { name: "grounding-mcp", command: ["node", "/opt/server.js"] },
      { name: "no-args", command: ["/usr/bin/lone"] },
      { name: "with-env", command: ["python", "-m", "x"], env: { TOKEN: "abc" } },
    ]);
  });

  it("parseSettingsMcpServers ignores entries without a command", async () => {
    const { parseSettingsMcpServers } = await import("../../src/cli/adopt/derive.js");
    const flat = parseSettingsMcpServers({
      mcpServers: {
        ok: { command: "node", args: ["x"] },
        broken: { args: ["x"] }, // no command
        empty: { command: "" },
        notobj: "string",
      },
    });
    expect(flat).toEqual([{ name: "ok", command: ["node", "x"] }]);
  });

  it("manifestMcpProjection normalises string commands to arrays", async () => {
    const { manifestMcpProjection } = await import("../../src/cli/adopt/derive.js");
    const m = parseManifest({
      version: 1,
      tools: {
        mcp: [
          { name: "a", command: "node /opt/a.js" },
          { name: "b", command: ["python", "-m", "b"], env: { K: "v" } },
        ],
        cli: [],
        skills: { enabled: [], source_dirs: [] },
        builtin: { known: [] },
      },
      hooks: [],
      policies: [],
    });
    expect(manifestMcpProjection(m)).toEqual([
      { name: "a", command: ["node", "/opt/a.js"] },
      { name: "b", command: ["python", "-m", "b"], env: { K: "v" } },
    ]);
  });

  it("computeMcpDrift returns 'new' for entries missing in the manifest", async () => {
    const { computeMcpDrift } = await import("../../src/cli/adopt/derive.js");
    const drift = computeMcpDrift(
      [
        { name: "a", command: ["node", "x"] },
        { name: "b", command: ["python", "y"] },
      ],
      [{ name: "a", command: ["node", "x"] }],
    );
    expect(drift).toEqual([{ entry: { name: "b", command: ["python", "y"] }, reason: "new" }]);
  });

  it("computeMcpDrift returns 'modified' for same-name entries with different command/env", async () => {
    const { computeMcpDrift } = await import("../../src/cli/adopt/derive.js");
    const drift = computeMcpDrift(
      [{ name: "a", command: ["node", "/new.js"] }],
      [{ name: "a", command: ["node", "/old.js"] }],
    );
    expect(drift).toEqual([
      { entry: { name: "a", command: ["node", "/new.js"] }, reason: "modified" },
    ]);
  });

  it("computeMcpDrift returns no drift for identical entries (env-equal too)", async () => {
    const { computeMcpDrift } = await import("../../src/cli/adopt/derive.js");
    const drift = computeMcpDrift(
      [{ name: "a", command: ["node", "x"], env: { A: "1", B: "2" } }],
      [{ name: "a", command: ["node", "x"], env: { B: "2", A: "1" } }],
    );
    expect(drift).toEqual([]);
  });

  it("mcpEqual rejects entries with different command lengths", async () => {
    const { mcpEqual } = await import("../../src/cli/adopt/derive.js");
    expect(mcpEqual({ name: "a", command: ["node"] }, { name: "a", command: ["node", "x"] })).toBe(false);
  });

  it("mcpEqual rejects entries with mismatched env keys or values", async () => {
    const { mcpEqual } = await import("../../src/cli/adopt/derive.js");
    expect(
      mcpEqual(
        { name: "a", command: ["x"], env: { A: "1" } },
        { name: "a", command: ["x"], env: { B: "1" } },
      ),
    ).toBe(false);
    expect(
      mcpEqual(
        { name: "a", command: ["x"], env: { A: "1" } },
        { name: "a", command: ["x"], env: { A: "2" } },
      ),
    ).toBe(false);
  });

  it("parseSettingsMcpServers silently filters non-string args (locked-in behavior)", async () => {
    // Documents current behavior: non-string args entries are dropped from
    // the array without warning. If we later decide to surface a warning
    // channel, this test will break and force the contract to be revisited.
    const { parseSettingsMcpServers } = await import("../../src/cli/adopt/derive.js");
    const flat = parseSettingsMcpServers({
      mcpServers: {
        a: { command: "node", args: ["/x", 42, "--port", true, "/y"] },
      },
    });
    expect(flat).toEqual([{ name: "a", command: ["node", "/x", "--port", "/y"] }]);
  });

  // task 83d8d03a (D-101): the same per-entry projection, but fed from the
  // registry's already-extracted `mcpServers` record (as returned by
  // `readTopLevelMcpServers`) rather than a whole settings.json-shaped
  // object — this is the function `adopt` now uses for the actual drift
  // source.
  it("projectRegistryMcpServers translates a registry mcpServers record into a flat list", async () => {
    const { projectRegistryMcpServers } = await import("../../src/cli/adopt/derive.js");
    const flat = projectRegistryMcpServers({
      "grounding-mcp": { command: "node", args: ["/opt/server.js"] },
      "no-args": { command: "/usr/bin/lone" },
      "with-env": { command: "python", args: ["-m", "x"], env: { TOKEN: "abc" } },
    });
    expect(flat).toEqual([
      { name: "grounding-mcp", command: ["node", "/opt/server.js"] },
      { name: "no-args", command: ["/usr/bin/lone"] },
      { name: "with-env", command: ["python", "-m", "x"], env: { TOKEN: "abc" } },
    ]);
  });

  it("projectRegistryMcpServers ignores entries without a command, same as parseSettingsMcpServers", async () => {
    const { projectRegistryMcpServers } = await import("../../src/cli/adopt/derive.js");
    const flat = projectRegistryMcpServers({
      ok: { command: "node", args: ["x"] },
      broken: { args: ["x"] },
      empty: { command: "" },
      notobj: "string",
    });
    expect(flat).toEqual([{ name: "ok", command: ["node", "x"] }]);
  });
});

describe("adopt — MCP server adoption", () => {
  it("captures a new mcpServers entry into tools.mcp[]", async () => {
    // task 83d8d03a (D-101): MCP drift is read from the effective Claude
    // Code registry, not settingsPath.
    writeSettings({});
    writeRegistry({ "grounding-mcp": { command: "node", args: ["/opt/server.js"] } });
    const r = await runAdopt(settingsPath, { configPath: manifestPath, yes: true });
    expect(r.outcome).toBe("applied");
    expect(r.driftCount).toBe(1);
    expect(r.hookDriftCount).toBe(0);
    expect(r.mcpDriftCount).toBe(1);
    expect(r.adoptedMcpNames).toEqual(["grounding-mcp"]);
    expect(r.replacedMcpNames).toEqual([]);
    const m = readManifest() as {
      tools: { mcp: { name: string; command: unknown }[] };
    };
    expect(m.tools.mcp).toContainEqual({
      name: "grounding-mcp",
      command: ["node", "/opt/server.js"],
    });
  });

  it("replaces an existing tools.mcp entry when the registry content differs", async () => {
    // Hand-write a manifest with one MCP entry; the effective registry then
    // describes the same name with different command tokens.
    fs.writeFileSync(
      manifestPath,
      `version: 1
tools:
  mcp:
    - name: grounding-mcp
      command: ["node", "/opt/old.js"]
  cli: []
  skills: { enabled: [], source_dirs: [] }
  builtin: { known: [] }
memory: { directories: [] }
hooks: []
policies: []
`,
    );
    writeSettings({});
    writeRegistry({ "grounding-mcp": { command: "node", args: ["/opt/new.js"] } });
    const r = await runAdopt(settingsPath, { configPath: manifestPath, yes: true });
    expect(r.outcome).toBe("applied");
    expect(r.mcpDriftCount).toBe(1);
    expect(r.replacedMcpNames).toEqual(["grounding-mcp"]);
    const m = readManifest() as {
      tools: { mcp: { name: string; command: unknown }[] };
    };
    const entry = m.tools.mcp.find((e) => e.name === "grounding-mcp");
    expect(entry?.command).toEqual(["node", "/opt/new.js"]);
    expect(m.tools.mcp.filter((e) => e.name === "grounding-mcp")).toHaveLength(1);
  });

  it("preserves env across adopt", async () => {
    writeSettings({});
    writeRegistry({ a: { command: "node", args: ["/x.js"], env: { TOK: "xyz" } } });
    const r = await runAdopt(settingsPath, { configPath: manifestPath, yes: true });
    expect(r.outcome).toBe("applied");
    const m = readManifest() as {
      tools: { mcp: { name: string; env?: Record<string, string> }[] };
    };
    expect(m.tools.mcp.find((e) => e.name === "a")?.env).toEqual({ TOK: "xyz" });
  });

  it("re-adopting after no further hand-edits is a no-op (idempotent)", async () => {
    writeSettings({});
    writeRegistry({ a: { command: "node", args: ["/x.js"] } });
    await runAdopt(settingsPath, { configPath: manifestPath, yes: true });
    const r2 = await runAdopt(settingsPath, { configPath: manifestPath, yes: true });
    expect(r2.outcome).toBe("no-drift");
    expect(r2.mcpDriftCount).toBe(0);
  });

  it("round-trip: full apply → registry hand-edit → adopt captures the manifest change from the registry, NOT a dead settings.json mcpServers block (T-002 / D-101)", async () => {
    // Seed a manifest with one MCP entry.
    fs.writeFileSync(
      manifestPath,
      `version: 1
tools:
  mcp:
    - name: a
      command: ["node", "/orig.js"]
  cli: []
  skills: { enabled: [], source_dirs: [] }
  builtin: { known: [] }
memory: { directories: [] }
hooks: []
policies: []
`,
    );
    const { apply } = await import("../../src/cli/apply/index.js");
    // First apply seeds the canonical settings.json bytes.
    await apply({ homeDir: tmpHome });
    const generatedPath = path.join(tmpHome, "harness.generated", "settings.json");

    // Hand-edit settings.json: an operator revives the dead `mcpServers`
    // block by hand, pointing at yet ANOTHER command path. Per D-101 this
    // must be surfaced only as a warning (`deadSettingsMcpNames`) and must
    // NOT drive drift — the effective registry is the only drift source.
    const handEdited = {
      hooks: {},
      mcpServers: { a: { command: "node", args: ["/dead-block-edit.js"] } },
    };
    fs.writeFileSync(generatedPath, `${JSON.stringify(handEdited, null, 2)}\n`);

    // The REAL out-of-band change lives in the effective Claude Code
    // registry, with yet a third command path, so the test can tell the
    // three sources (manifest / dead settings.json block / registry) apart.
    writeRegistry({ a: { command: "node", args: ["/registry-edited.js"] } });

    // Adopt: hooks source is generatedPath (none here); MCP drift source
    // is ALWAYS the registry.
    const r = await runAdopt(generatedPath, { configPath: manifestPath, yes: true });
    expect(r.outcome).toBe("applied");
    expect(r.replacedMcpNames).toEqual(["a"]);
    expect(r.deadSettingsMcpNames).toEqual(["a"]);
    const adoptedManifest = readManifest() as {
      tools: { mcp: { name: string; command: unknown }[] };
    };
    // Captured from the REGISTRY, not the dead settings.json block.
    expect(adoptedManifest.tools.mcp.find((e) => e.name === "a")?.command).toEqual([
      "node",
      "/registry-edited.js",
    ]);

    // Re-apply (using --overwrite-drift since the on-disk settings.json
    // is the user's hand-edit which apply would refuse to touch by default).
    await apply({ homeDir: tmpHome, overwriteDrift: true, prompt: async () => "yes" });

    // T-002 (init-mcp-wiring-claude-code): settings.json's mcpServers key
    // is no longer part of the generated projection at all — Claude Code
    // never read it at runtime (see io/claude-mcp.ts). adopt still
    // correctly captured the registry hand-edit into the MANIFEST
    // (asserted above), but the regenerated settings.json can no longer be
    // byte-identical to a hand-edit that included an mcpServers block:
    // hooks still round-trip; mcpServers is intentionally dropped.
    expect(JSON.parse(fs.readFileSync(generatedPath, "utf8"))).toEqual({ hooks: {} });
  });

  it("preserves manifest-only `health` field on replace-modified", async () => {
    fs.writeFileSync(
      manifestPath,
      `version: 1
tools:
  mcp:
    - name: a
      command: ["node", "/old.js"]
      health: { verb: "ping" }
  cli: []
  skills: { enabled: [], source_dirs: [] }
  builtin: { known: [] }
memory: { directories: [] }
hooks: []
policies: []
`,
    );
    writeSettings({});
    writeRegistry({ a: { command: "node", args: ["/new.js"] } });
    const r = await runAdopt(settingsPath, { configPath: manifestPath, yes: true });
    expect(r.outcome).toBe("applied");
    const m = readManifest() as {
      tools: { mcp: { name: string; health?: { verb: string } }[] };
    };
    const entry = m.tools.mcp.find((e) => e.name === "a");
    expect(entry?.health?.verb).toBe("ping");
  });

  it("preserves explicit `enabled: false` on replace-modified", async () => {
    fs.writeFileSync(
      manifestPath,
      `version: 1
tools:
  mcp:
    - name: a
      command: ["node", "/old.js"]
      enabled: false
  cli: []
  skills: { enabled: [], source_dirs: [] }
  builtin: { known: [] }
memory: { directories: [] }
hooks: []
policies: []
`,
    );
    // Note: the registry wouldn't normally contain a disabled server (apply
    // skips them), but the user could re-register one by hand via the
    // `claude mcp` CLI. The replace path must keep the user's prior
    // `enabled: false` intent rather than silently re-enabling it.
    writeSettings({});
    writeRegistry({ a: { command: "node", args: ["/new.js"] } });
    const r = await runAdopt(settingsPath, { configPath: manifestPath, yes: true });
    expect(r.outcome).toBe("applied");
    const m = readManifest() as {
      tools: { mcp: { name: string; enabled?: boolean }[] };
    };
    expect(m.tools.mcp.find((e) => e.name === "a")?.enabled).toBe(false);
  });

  it("hooks + mcp drift in the same run both adopted", async () => {
    writeSettings({
      SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "/h.sh" }] }],
    });
    writeRegistry({ a: { command: "node", args: ["/x.js"] } });
    const r = await runAdopt(settingsPath, { configPath: manifestPath, yes: true });
    expect(r.outcome).toBe("applied");
    expect(r.hookDriftCount).toBe(1);
    expect(r.mcpDriftCount).toBe(1);
    expect(r.driftCount).toBe(2);
  });

  it("declined: nothing written even when both hook + mcp drift", async () => {
    writeSettings({
      SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "/h.sh" }] }],
    });
    writeRegistry({ a: { command: "node", args: ["/x.js"] } });
    const before = fs.readFileSync(manifestPath, "utf8");
    const r = await runAdopt(settingsPath, {
      configPath: manifestPath,
      prompt: async () => "N",
    });
    expect(r.outcome).toBe("declined");
    expect(fs.readFileSync(manifestPath, "utf8")).toBe(before);
  });
});

// task 83d8d03a (D-101): MCP drift is computed EXCLUSIVELY against the
// effective Claude Code registry; a dead `mcpServers` block inside
// settingsPath is surfaced only as a warning (`deadSettingsMcpNames`),
// never as a drift source.
describe("adopt — dead settings.json mcpServers block (D-101)", () => {
  it("surfaces a dead settings.json mcpServers block as a warning even when there is no other drift", async () => {
    writeSettings({});
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ hooks: {}, mcpServers: { stale: { command: "old-binary" } } }),
    );
    // No registry file at all: the effective registry is empty, so there
    // is genuinely nothing to adopt — but the dead block must still be
    // reported.
    const r = await runAdopt(settingsPath, { configPath: manifestPath, yes: true });
    expect(r.outcome).toBe("no-drift");
    expect(r.mcpDriftCount).toBe(0);
    expect(r.deadSettingsMcpNames).toEqual(["stale"]);
  });

  it("does NOT let a dead settings.json mcpServers block satisfy or suppress registry-sourced drift", async () => {
    // The dead block claims `a` is already `/dead.js` — if it were
    // (wrongly) consulted for drift, this would look like a match and no
    // drift would be reported. The registry says otherwise.
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ hooks: {}, mcpServers: { a: { command: "node", args: ["/dead.js"] } } }),
    );
    writeRegistry({ a: { command: "node", args: ["/registry.js"] } });
    const r = await runAdopt(settingsPath, { configPath: manifestPath, yes: true });
    expect(r.outcome).toBe("applied");
    expect(r.mcpDriftCount).toBe(1);
    expect(r.deadSettingsMcpNames).toEqual(["a"]);
    const m = readManifest() as { tools: { mcp: { name: string; command: unknown }[] } };
    expect(m.tools.mcp.find((e) => e.name === "a")?.command).toEqual(["node", "/registry.js"]);
  });

  it("reports an empty deadSettingsMcpNames when settingsPath has no mcpServers block", async () => {
    writeSettings({});
    writeRegistry({ a: { command: "node", args: ["/x.js"] } });
    const r = await runAdopt(settingsPath, { configPath: manifestPath, yes: true });
    expect(r.deadSettingsMcpNames).toEqual([]);
    expect(r.mcpDriftCount).toBe(1);
  });
});

describe("adopt — CLAUDE_CONFIG_DIR precedence for the MCP registry (D-102)", () => {
  it("reads the registry from $CLAUDE_CONFIG_DIR/.claude.json when set, ignoring the default ~/.claude.json fixture", async () => {
    writeSettings({});
    // Default-location fixture that must be ignored once CLAUDE_CONFIG_DIR
    // is set: if it fed drift, this would come back as "should-be-ignored".
    writeRegistry({ "should-be-ignored": { command: "/bin/wrong" } });
    const customConfigDir = path.join(tmpHome, "custom-config-dir");
    fs.mkdirSync(customConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(customConfigDir, ".claude.json"),
      JSON.stringify({ mcpServers: { a: { command: "node", args: ["/from-custom-dir.js"] } } }),
    );
    const r = await runAdopt(settingsPath, {
      configPath: manifestPath,
      yes: true,
      // Explicit `undefined` overrides `runAdopt`'s default fixture
      // registryPath, forcing `adopt()`'s own CLAUDE_CONFIG_DIR-aware
      // default resolution (resolveClaudeUserRegistryPath) below.
      registryPath: undefined,
      env: { CLAUDE_CONFIG_DIR: customConfigDir },
    });
    expect(r.outcome).toBe("applied");
    expect(r.adoptedMcpNames).toEqual(["a"]);
    const m = readManifest() as { tools: { mcp: { name: string; command: unknown }[] } };
    expect(m.tools.mcp.find((e) => e.name === "a")?.command).toEqual([
      "node",
      "/from-custom-dir.js",
    ]);
  });
});

describe("adopt — malformed effective registry (defensive, D-101)", () => {
  it("reports registryReadError and treats MCP drift as empty rather than guessing", async () => {
    writeSettings({});
    fs.writeFileSync(registryPath, "{not json");
    const r = await runAdopt(settingsPath, { configPath: manifestPath, yes: true });
    expect(r.outcome).toBe("no-drift");
    expect(r.mcpDriftCount).toBe(0);
    expect(r.registryReadError).toMatch(/not valid JSON/);
  });
});

describe("adopt — multi-hook drift", () => {
  it("captures multiple drifted hooks in one run with disambiguated names", async () => {
    writeSettings({
      SessionStart: [
        { matcher: "", hooks: [{ type: "command", command: "/a/foo.sh" }] },
      ],
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            { type: "command", command: "/b/foo.sh" },
            { type: "command", command: "/c/bar.sh" },
          ],
        },
      ],
    });
    const result = await runAdopt(settingsPath, {
      configPath: manifestPath,
      yes: true,
    });
    expect(result.applied).toBe(true);
    expect(result.driftCount).toBe(3);
    expect(result.adoptedNames).toEqual(["foo", "foo-2", "bar"]);
    const m = readManifest() as { hooks: { name: string }[] };
    expect(m.hooks.map((h) => h.name).sort()).toEqual(["bar", "foo", "foo-2"]);
  });
});

// task 129e1b94 review (MED): apply projects EVIDENCE_LEDGER_DB onto the
// grounding-mcp settings entry; the manifest-side projection must mirror it
// or every apply->adopt cycle reports phantom drift and, if applied, bakes
// a machine-specific absolute path into the shared manifest.
describe("apply -> adopt round-trip for the grounding projection", () => {
  const GROUNDING_MANIFEST = parseManifest({
    version: 1,
    tools: {
      mcp: [
        { name: "grounding-mcp", command: ["node", "/opt/g/server.js"], enabled: true },
      ],
      cli: [],
      skills: { enabled: [], source_dirs: [] },
      builtin: { known: [] },
    },
    memory: { directories: [] },
    hooks: [],
    policies: [],
  });

  // T-002 (init-mcp-wiring-claude-code): settings.json's `mcpServers` key
  // is no longer part of the generated projection at all (Claude Code
  // never read it — see io/claude-mcp.ts). `generateSettingsWithWarnings`
  // still computes the equivalent server-spec map (INCLUDING the
  // EVIDENCE_LEDGER_DB projection) on its sibling `mcpServers` field, now
  // feeding the `claude mcp` CLI Ensure path instead of settings.json. The
  // two tests below simulate a settings.json that independently carries a
  // (foreign, hand-authored, or pre-T-002-generated) `mcpServers` block by
  // wrapping that sibling field into a raw settings object, so
  // `parseSettingsMcpServers`/`computeMcpDrift` — which still operate on
  // whatever live settings.json content adopt reads — stay covered.
  it("reports zero MCP drift for a settings.json mcpServers block matching the grounding projection", () => {
    const { mcpServers } = generateSettingsWithWarnings(GROUNDING_MANIFEST, {
      homeDir: "/home/op",
    });
    const settings = { hooks: {}, mcpServers };
    const settingsMcp = parseSettingsMcpServers(settings);
    const projection = manifestMcpProjection(GROUNDING_MANIFEST, "/home/op");
    expect(computeMcpDrift(settingsMcp, projection)).toEqual([]);
  });

  it("still reports drift for a genuinely different env value", () => {
    const { mcpServers } = generateSettingsWithWarnings(GROUNDING_MANIFEST, {
      homeDir: "/home/op",
    });
    const settings = { hooks: {}, mcpServers };
    // Simulate an out-of-band edit to a live settings.json.
    settings.mcpServers["grounding-mcp"]!.env!.EVIDENCE_LEDGER_DB = "/elsewhere/l.db";
    const settingsMcp = parseSettingsMcpServers(settings);
    const projection = manifestMcpProjection(GROUNDING_MANIFEST, "/home/op");
    const drift = computeMcpDrift(settingsMcp, projection);
    expect(drift).toHaveLength(1);
    expect(drift[0]?.reason).toBe("modified");
  });
});

// task 03a917fd/H1b: exact same round-trip requirement as above, for
// apply's SOLUTION_VERDICT_SIGNING_KEY projection (generate-settings.ts,
// projectSigningKeyEnv): the manifest-side mirror in derive.ts's
// manifestMcpProjection must carry the same key or every apply->adopt
// cycle reports phantom "modified" drift on grounding-mcp for it.
describe("apply -> adopt round-trip for the signing-key projection (task 03a917fd/H1b)", () => {
  const GROUNDING_MANIFEST = parseManifest({
    version: 1,
    tools: {
      mcp: [
        { name: "grounding-mcp", command: ["node", "/opt/g/server.js"], enabled: true },
      ],
      cli: [],
      skills: { enabled: [], source_dirs: [] },
      builtin: { known: [] },
    },
    memory: { directories: [] },
    hooks: [],
    policies: [],
  });
  const GENERATED_DIR = "/home/op/harness.generated";

  it("reports zero MCP drift for a registry entry matching the signing-key projection", () => {
    const { mcpServers } = generateSettingsWithWarnings(GROUNDING_MANIFEST, {
      homeDir: "/home/op",
      generatedDir: GENERATED_DIR,
    });
    const settings = { hooks: {}, mcpServers };
    const settingsMcp = parseSettingsMcpServers(settings);
    const projection = manifestMcpProjection(GROUNDING_MANIFEST, "/home/op", GENERATED_DIR);
    expect(computeMcpDrift(settingsMcp, projection)).toEqual([]);
    // Sanity: the key really is present and absolute, not just absent on
    // both sides (which would also compute zero drift vacuously).
    expect(mcpServers["grounding-mcp"]?.env?.[SOLUTION_VERDICT_SIGNING_KEY_ENV]).toBe(
      signingKeyPathFor(GENERATED_DIR),
    );
  });

  it("still reports drift when the operator value diverges from the signing-key projection", () => {
    const { mcpServers } = generateSettingsWithWarnings(GROUNDING_MANIFEST, {
      homeDir: "/home/op",
      generatedDir: GENERATED_DIR,
    });
    const settings = { hooks: {}, mcpServers };
    // Simulate an out-of-band edit to a live registry entry.
    settings.mcpServers["grounding-mcp"]!.env!.SOLUTION_VERDICT_SIGNING_KEY = "/elsewhere/other.key";
    const settingsMcp = parseSettingsMcpServers(settings);
    const projection = manifestMcpProjection(GROUNDING_MANIFEST, "/home/op", GENERATED_DIR);
    const drift = computeMcpDrift(settingsMcp, projection);
    expect(drift).toHaveLength(1);
    expect(drift[0]?.reason).toBe("modified");
  });
});

// Review round H1, Finding 3: the two round-trip describe blocks above call
// `manifestMcpProjection` / `computeMcpDrift` / `parseSettingsMcpServers`
// directly, bypassing `adopt()` (and therefore adopt/index.ts's own
// `resolveGeneratedDir({homeDir: opts.homeDir, manifestPath})` call)
// entirely. A regression that drops the `generatedDir` argument at that
// real call site would not be caught by them. This is the missing real
// e2e: a bare grounding-mcp manifest entry (no env declared at all), an
// effective registry carrying BOTH projected envs, run through the actual
// `adopt()` function end to end.
describe("adopt — real e2e for the grounding + signing-key round-trip (review round H1, Finding 3)", () => {
  // Absolute, no leading `~`, so EVIDENCE_LEDGER_DB's expansion is
  // independent of `os.homedir()` on whatever machine runs this test
  // (adopt/index.ts threads `homeDir: undefined` into the EVIDENCE_LEDGER_DB
  // mirror, out of this task's scope to change — see the comment at that
  // call site).
  const LEDGER_PATH = "/var/tmp/h1-finding3-ledger.db";

  it("adopt() sees zero MCP drift and leaves the manifest untouched", async () => {
    fs.writeFileSync(
      manifestPath,
      `version: 1
grounding:
  evidence_ledger:
    path: "${LEDGER_PATH}"
tools:
  mcp:
    - name: grounding-mcp
      command: [node, /opt/g/server.js]
      enabled: true
  cli: []
  skills: { enabled: [], source_dirs: [] }
  builtin: { known: [] }
memory: { directories: [] }
hooks: []
policies: []
`,
    );
    writeSettings({});
    // No explicit homeDir passed to runAdopt below, so adopt/index.ts
    // resolves generatedDir the same way apply.ts / interactive.ts do
    // without an explicit homeDir: `<dirname(manifestPath)>/harness.generated`.
    const generatedDir = path.join(tmpHome, "harness.generated");
    writeRegistry({
      "grounding-mcp": {
        command: "node",
        args: ["/opt/g/server.js"],
        env: {
          EVIDENCE_LEDGER_DB: LEDGER_PATH,
          SOLUTION_VERDICT_SIGNING_KEY: signingKeyPathFor(generatedDir),
        },
      },
    });
    const before = fs.readFileSync(manifestPath, "utf8");
    const r = await runAdopt(settingsPath, { configPath: manifestPath });
    expect(r.outcome).toBe("no-drift");
    expect(r.mcpDriftCount).toBe(0);
    // "no-drift" never writes the manifest -- assert it byte-for-byte, not
    // just via the outcome enum.
    expect(fs.readFileSync(manifestPath, "utf8")).toBe(before);
  });
});

describe("adopt — round-trip fidelity (task 059b669c)", () => {
  it("captures a settings hook `timeout` (seconds) into budget_ms (ms) and apply round-trips it (task 7bf47554 unit fix)", async () => {
    // settings.json `timeout` is Claude Code's own unit: SECONDS. adopt
    // must multiply by 1000 to land in the manifest's `budget_ms`
    // (milliseconds); apply's `hookTimeoutSeconds` divides back
    // (ceil(budget_ms/1000)) for the round-trip.
    writeSettings({
      SessionStart: [
        {
          matcher: "",
          hooks: [{ type: "command", command: "/tmp/extra.sh", timeout: 45 }],
        },
      ],
    });
    const r = await runAdopt(settingsPath, { configPath: manifestPath, yes: true });
    expect(r.outcome).toBe("applied");
    const raw = readManifest() as { hooks: { name: string; budget_ms?: number }[] };
    expect(raw.hooks[0]).toMatchObject({ name: "extra", budget_ms: 45_000 });
    // Full circle: re-projecting the adopted manifest emits the same
    // seconds value back out (apply's hookTimeoutSeconds is the exact
    // inverse of adopt's `* 1000` for a budget_ms that is itself a clean
    // multiple of 1000 and already respects apply's floor), so the
    // adopt→apply round-trip is lossless for this field.
    const manifest = parseManifest(raw);
    const { root } = generateSettingsWithWarnings(manifest);
    expect(root.hooks["SessionStart"]?.[0]?.hooks[0]).toMatchObject({
      command: "/tmp/extra.sh",
      timeout: 45,
    });
  });

  it("apply→adopt round-trip: a budget_ms that rounds asymmetrically (1500 -> 2s -> 2000ms) produces NO phantom drift (task 7bf47554)", async () => {
    // Simulates a real `harness apply` followed by `harness adopt`: a
    // manifest hook with budget_ms=1500 is NOT a clean multiple of 1000,
    // so apply's `hookTimeoutSeconds` rounds it UP to timeout=2 (a 2000ms
    // equivalent). `timeout` deliberately stays outside the drift key
    // (`keyOf`), so re-adopting that generated settings.json must NOT
    // misread the 1500-vs-2000 asymmetry as a "different" hook and
    // duplicate-adopt it acceptance criterion 2).
    fs.writeFileSync(
      manifestPath,
      `version: 1
tools:
  mcp: []
  cli: []
  skills: { enabled: [], source_dirs: [] }
  builtin: { known: [] }
memory: { directories: [] }
hooks:
  - { name: declared, event: SessionStart, command: /tmp/declared.sh, blocking: false, budget_ms: 1500 }
policies: []
`,
    );
    const manifest = parseManifest(readManifest());
    const { root } = generateSettingsWithWarnings(manifest);
    expect(root.hooks["SessionStart"]?.[0]?.hooks[0]?.timeout).toBe(2);
    writeSettings(root.hooks);
    const before = fs.readFileSync(manifestPath, "utf8");
    const r = await runAdopt(settingsPath, { configPath: manifestPath, yes: true });
    expect(r.outcome).toBe("no-drift");
    expect(r.hookDriftCount).toBe(0);
    expect(fs.readFileSync(manifestPath, "utf8")).toBe(before);
  });

  it("ignores a malformed settings `timeout` (must-pass control: no budget_ms captured)", async () => {
    writeSettings({
      SessionStart: [
        {
          matcher: "",
          hooks: [{ type: "command", command: "/tmp/extra.sh", timeout: -5 }],
        },
      ],
    });
    const r = await runAdopt(settingsPath, { configPath: manifestPath, yes: true });
    expect(r.outcome).toBe("applied");
    expect(fs.readFileSync(manifestPath, "utf8")).not.toContain("budget_ms");
  });

  it("a timeout-only difference on a declared hook is NOT drift (no duplicate adoption)", async () => {
    // Pins the deliberate keyOf exclusion: hooks adopt add-only, so if
    // `timeout` ever joined the drift key, a timeout-only hand-edit
    // would adopt a DUPLICATE hook entry. This test fails if that
    // regression is introduced.
    fs.writeFileSync(
      manifestPath,
      `version: 1
tools:
  mcp: []
  cli: []
  skills: { enabled: [], source_dirs: [] }
  builtin: { known: [] }
memory: { directories: [] }
hooks:
  - { name: declared, event: SessionStart, command: /tmp/declared.sh, blocking: false, budget_ms: 30000 }
policies: []
`,
    );
    writeSettings({
      SessionStart: [
        {
          matcher: "",
          hooks: [{ type: "command", command: "/tmp/declared.sh", timeout: 99 }],
        },
      ],
    });
    const before = fs.readFileSync(manifestPath, "utf8");
    const r = await runAdopt(settingsPath, { configPath: manifestPath, yes: true });
    expect(r.outcome).toBe("no-drift");
    expect(r.hookDriftCount).toBe(0);
    expect(fs.readFileSync(manifestPath, "utf8")).toBe(before);
  });

  it("preserves manifest-only min_version + version_command on replace-modified", async () => {
    fs.writeFileSync(
      manifestPath,
      `version: 1
tools:
  mcp:
    - name: a
      command: ["node", "/old.js"]
      min_version: "1.2.0"
      version_command: ["node", "/old.js", "--version"]
  cli: []
  skills: { enabled: [], source_dirs: [] }
  builtin: { known: [] }
memory: { directories: [] }
hooks: []
policies: []
`,
    );
    writeSettings({});
    writeRegistry({ a: { command: "node", args: ["/new.js"] } });
    const r = await runAdopt(settingsPath, { configPath: manifestPath, yes: true });
    expect(r.outcome).toBe("applied");
    const m = readManifest() as {
      tools: {
        mcp: {
          name: string;
          command: string[];
          min_version?: string;
          version_command?: string[];
        }[];
      };
    };
    const entry = m.tools.mcp.find((e) => e.name === "a");
    expect(entry?.command).toEqual(["node", "/new.js"]);
    expect(entry?.min_version).toBe("1.2.0");
    expect(entry?.version_command).toEqual(["node", "/old.js", "--version"]);
  });
});
