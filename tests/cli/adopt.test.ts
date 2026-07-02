import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { adopt } from "../../src/cli/adopt/index.js";
import {
  computeDrift,
  computeMcpDrift,
  manifestMcpProjection,
  manifestProjection,
  parseSettingsHooks,
  parseSettingsMcpServers,
  synthesizeName,
} from "../../src/cli/adopt/derive.js";
import { generateSettingsWithWarnings } from "../../src/cli/apply/generate-settings.js";
import { init } from "../../src/cli/init/index.js";
import { parseManifest } from "../../src/schema/index.js";

let tmpHome: string;
let manifestPath: string;
let settingsPath: string;

beforeEach(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "harness-adopt-"));
  manifestPath = path.join(tmpHome, "harness.yaml");
  settingsPath = path.join(tmpHome, "settings.json");
  await init({ homeDir: tmpHome }); // minimal — empty hooks
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function writeSettings(hooks: unknown): void {
  fs.writeFileSync(settingsPath, JSON.stringify({ hooks }, null, 2));
}

function readManifest(): unknown {
  return parseYaml(fs.readFileSync(manifestPath, "utf8"));
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
    const result = await adopt(settingsPath, {
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
      adopt(settingsPath, { configPath: manifestPath, stdinIsTTY: false }),
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
    const result = await adopt(settingsPath, {
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
    const result = await adopt(settingsPath, {
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
    const result = await adopt(settingsPath, { configPath: manifestPath });
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
    const result = await adopt(settingsPath, {
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
    await expect(adopt(settingsPath, { configPath: manifestPath })).rejects.toBeDefined();
  });
});

describe("adopt — manifest must exist", () => {
  it("EX_NOINPUT (66) when manifest is missing", async () => {
    fs.unlinkSync(manifestPath);
    writeSettings({});
    await expect(
      adopt(settingsPath, { configPath: manifestPath }),
    ).rejects.toMatchObject({ name: "HarnessExitError", exitCode: 66 });
  });

  it("EX_NOINPUT (66) when settings file is missing", async () => {
    await expect(
      adopt(path.join(tmpHome, "no-such.json"), { configPath: manifestPath }),
    ).rejects.toMatchObject({ name: "HarnessExitError", exitCode: 66 });
  });
});

describe("adopt — invalid JSON", () => {
  it("EX_FAIL on malformed settings.json", async () => {
    fs.writeFileSync(settingsPath, "not json {{");
    await expect(
      adopt(settingsPath, { configPath: manifestPath }),
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
});

describe("adopt — MCP server adoption", () => {
  it("captures a new mcpServers entry into tools.mcp[]", async () => {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {},
        mcpServers: {
          "grounding-mcp": { command: "node", args: ["/opt/server.js"] },
        },
      }),
    );
    const r = await adopt(settingsPath, { configPath: manifestPath, yes: true });
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

  it("replaces an existing tools.mcp entry when settings.json content differs", async () => {
    // Hand-write a manifest with one MCP entry; we'll then have settings.json
    // describe the same name with different command tokens.
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
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {},
        mcpServers: {
          "grounding-mcp": { command: "node", args: ["/opt/new.js"] },
        },
      }),
    );
    const r = await adopt(settingsPath, { configPath: manifestPath, yes: true });
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
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {},
        mcpServers: {
          a: { command: "node", args: ["/x.js"], env: { TOK: "xyz" } },
        },
      }),
    );
    const r = await adopt(settingsPath, { configPath: manifestPath, yes: true });
    expect(r.outcome).toBe("applied");
    const m = readManifest() as {
      tools: { mcp: { name: string; env?: Record<string, string> }[] };
    };
    expect(m.tools.mcp.find((e) => e.name === "a")?.env).toEqual({ TOK: "xyz" });
  });

  it("re-adopting after no further hand-edits is a no-op (idempotent)", async () => {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {},
        mcpServers: { a: { command: "node", args: ["/x.js"] } },
      }),
    );
    await adopt(settingsPath, { configPath: manifestPath, yes: true });
    const r2 = await adopt(settingsPath, { configPath: manifestPath, yes: true });
    expect(r2.outcome).toBe("no-drift");
    expect(r2.mcpDriftCount).toBe(0);
  });

  it("round-trip: full apply → hand-edit → adopt → apply produces byte-identical settings.json", async () => {
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

    // Hand-edit settings.json: change the command path.
    const handEdited = {
      hooks: {},
      mcpServers: { a: { command: "node", args: ["/edited.js"] } },
    };
    const handEditedBytes = `${JSON.stringify(handEdited, null, 2)}\n`;
    fs.writeFileSync(generatedPath, handEditedBytes);

    // Adopt the hand-edit back into the manifest.
    const r = await adopt(generatedPath, { configPath: manifestPath, yes: true });
    expect(r.outcome).toBe("applied");
    expect(r.replacedMcpNames).toEqual(["a"]);

    // Re-apply (using --overwrite-drift since the on-disk settings.json
    // is the user's hand-edit which apply would refuse to touch by default).
    await apply({ homeDir: tmpHome, overwriteDrift: true, prompt: async () => "yes" });

    // Bytes must match the hand-edited input verbatim (the canonical AC).
    expect(fs.readFileSync(generatedPath, "utf8")).toBe(handEditedBytes);
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
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {},
        mcpServers: { a: { command: "node", args: ["/new.js"] } },
      }),
    );
    const r = await adopt(settingsPath, { configPath: manifestPath, yes: true });
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
    // Note: settings.json wouldn't normally contain a disabled server (apply
    // skips them), but the user could re-add one by hand. The replace path
    // must keep the user's prior `enabled: false` intent rather than silently
    // re-enabling it.
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {},
        mcpServers: { a: { command: "node", args: ["/new.js"] } },
      }),
    );
    const r = await adopt(settingsPath, { configPath: manifestPath, yes: true });
    expect(r.outcome).toBe("applied");
    const m = readManifest() as {
      tools: { mcp: { name: string; enabled?: boolean }[] };
    };
    expect(m.tools.mcp.find((e) => e.name === "a")?.enabled).toBe(false);
  });

  it("hooks + mcp drift in the same run both adopted", async () => {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          SessionStart: [
            { matcher: "", hooks: [{ type: "command", command: "/h.sh" }] },
          ],
        },
        mcpServers: { a: { command: "node", args: ["/x.js"] } },
      }),
    );
    const r = await adopt(settingsPath, { configPath: manifestPath, yes: true });
    expect(r.outcome).toBe("applied");
    expect(r.hookDriftCount).toBe(1);
    expect(r.mcpDriftCount).toBe(1);
    expect(r.driftCount).toBe(2);
  });

  it("declined: nothing written even when both hook + mcp drift", async () => {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          SessionStart: [
            { matcher: "", hooks: [{ type: "command", command: "/h.sh" }] },
          ],
        },
        mcpServers: { a: { command: "node", args: ["/x.js"] } },
      }),
    );
    const before = fs.readFileSync(manifestPath, "utf8");
    const r = await adopt(settingsPath, {
      configPath: manifestPath,
      prompt: async () => "N",
    });
    expect(r.outcome).toBe("declined");
    expect(fs.readFileSync(manifestPath, "utf8")).toBe(before);
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
    const result = await adopt(settingsPath, {
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

  it("reports zero MCP drift after an apply-generated settings.json", () => {
    const settings = generateSettingsWithWarnings(GROUNDING_MANIFEST, {
      homeDir: "/home/op",
    }).root;
    const settingsMcp = parseSettingsMcpServers(settings);
    const projection = manifestMcpProjection(GROUNDING_MANIFEST, "/home/op");
    expect(computeMcpDrift(settingsMcp, projection)).toEqual([]);
  });

  it("still reports drift for a genuinely different env value", () => {
    const settings = generateSettingsWithWarnings(GROUNDING_MANIFEST, {
      homeDir: "/home/op",
    }).root;
    // Simulate an out-of-band edit to the generated settings.
    settings.mcpServers!["grounding-mcp"]!.env!.EVIDENCE_LEDGER_DB = "/elsewhere/l.db";
    const settingsMcp = parseSettingsMcpServers(settings);
    const projection = manifestMcpProjection(GROUNDING_MANIFEST, "/home/op");
    const drift = computeMcpDrift(settingsMcp, projection);
    expect(drift).toHaveLength(1);
    expect(drift[0]?.reason).toBe("modified");
  });
});

describe("adopt — round-trip fidelity (task 059b669c)", () => {
  it("captures a settings hook `timeout` into budget_ms and apply round-trips it", async () => {
    writeSettings({
      SessionStart: [
        {
          matcher: "",
          hooks: [{ type: "command", command: "/tmp/extra.sh", timeout: 45000 }],
        },
      ],
    });
    const r = await adopt(settingsPath, { configPath: manifestPath, yes: true });
    expect(r.outcome).toBe("applied");
    const raw = readManifest() as { hooks: { name: string; budget_ms?: number }[] };
    expect(raw.hooks[0]).toMatchObject({ name: "extra", budget_ms: 45000 });
    // Full circle: re-projecting the adopted manifest emits the same
    // timeout (apply's toSettingsCommand is 1:1 with budget_ms), so the
    // adopt→apply round-trip is lossless for this field.
    const manifest = parseManifest(raw);
    const { root } = generateSettingsWithWarnings(manifest);
    expect(root.hooks["SessionStart"]?.[0]?.hooks[0]).toMatchObject({
      command: "/tmp/extra.sh",
      timeout: 45000,
    });
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
    const r = await adopt(settingsPath, { configPath: manifestPath, yes: true });
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
          hooks: [{ type: "command", command: "/tmp/declared.sh", timeout: 99000 }],
        },
      ],
    });
    const before = fs.readFileSync(manifestPath, "utf8");
    const r = await adopt(settingsPath, { configPath: manifestPath, yes: true });
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
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {},
        mcpServers: { a: { command: "node", args: ["/new.js"] } },
      }),
    );
    const r = await adopt(settingsPath, { configPath: manifestPath, yes: true });
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
