import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { adopt } from "../../src/cli/adopt/index.js";
import {
  computeDrift,
  manifestProjection,
  parseSettingsHooks,
  synthesizeName,
} from "../../src/cli/adopt/derive.js";
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
