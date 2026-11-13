// `harness doctor` and the guarded branch-protection hook line: with the hook
// wired and `harness` not resolvable on the PATH, the hook refuses every
// guarded tool call, so the npm-global-bin PATH finding is an error. Without
// the hook, or with harness resolvable elsewhere, it stays the warning it
// always was. Every path is a temp dir; nothing reads the real HOME or PATH.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apply } from "../../src/cli/apply/index.js";
import { doctor, format } from "../../src/cli/doctor/index.js";
import { checkClaudeLiveHooks, checkCodexLiveHooks } from "../../src/cli/doctor/hook-liveness.js";
import {
  escalateForGuardedHook,
  type NpmBinReport,
} from "../../src/cli/doctor/npm-bin-path.js";
import { runCodexTargetChecks } from "../../src/cli/doctor/codex.js";
import { gateDisable } from "../../src/cli/gate/disable.js";
import { gateEnable } from "../../src/cli/gate/enable.js";
import { codexGateDisable } from "../../src/cli/gate/codex-disable.js";
import { generateCodexConfig } from "../../src/cli/apply/generate-codex-config.js";
import { planCodexConfigInstall, writeCodexConfigInstall } from "../../src/cli/apply/install-codex-config.js";
import { generateSettings } from "../../src/cli/apply/generate-settings.js";
import { expandPolicyPacks } from "../../src/policy-packs/index.js";
import { guardedHarnessCommand } from "../../src/policy-packs/builtin/guarded-harness-command.js";
import { loadManifest } from "../../src/cli/loader.js";
import type { McpProbe, McpProbeResult } from "../../src/probes/mcp.js";
import type { McpServer } from "../../src/schema/index.js";

const NVM_PREFIX = "/home/lan/.nvm/versions/node/v22.22.0";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "harness-doctor-guard-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

class NoMcp implements McpProbe {
  async call(server: McpServer): Promise<McpProbeResult> {
    return { name: server.name, outcome: { kind: "missing-verb" } };
  }
}

function manifestYaml(extra: string): string {
  return `version: 1\nhooks: []\npolicies: []\ntools:\n  builtin:\n    known: [Read, Edit]\n${extra}`;
}

const WITH_PACK = manifestYaml("policy_packs:\n  - name: branch-protection\n");
const PACK_OFF = manifestYaml("policy_packs:\n  - name: branch-protection\n    enabled: false\n");
const NO_PACK = manifestYaml("");

/** Doctor against a manifest, an npm prefix off the PATH and a PATH of `pathDirs`. */
async function runDoctor(yaml: string, pathDirs: string[], prefix: string = NVM_PREFIX) {
  const configPath = path.join(tmp, "harness.yaml");
  fs.writeFileSync(configPath, yaml);
  return doctor({
    configPath,
    homeOverride: tmp,
    mcpProbe: new NoMcp(),
    versionProbe: () => null,
    pathEnv: pathDirs.join(path.delimiter),
    npmBinExec: async () => ({ code: 0, stdout: `${prefix}\n`, stderr: "" }),
  });
}

function emptyDir(name: string): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function dirWithHarness(name: string): string {
  const dir = emptyDir(name);
  const bin = path.join(dir, "harness");
  fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(bin, 0o755);
  return dir;
}

describe("doctor: the npm-global-bin PATH finding when branch-protection is installed", () => {
  it("is an error when the bin dir is off the PATH and harness does not resolve", async () => {
    const report = await runDoctor(WITH_PACK, [emptyDir("elsewhere")]);
    expect(report.npmGlobalBin?.status).toBe("error");
    expect(report.npmGlobalBin?.binDir).toBe(`${NVM_PREFIX}/bin`);
    expect(report.npmGlobalBin?.pathPatchSuggestion).toBe(`export PATH="${NVM_PREFIX}/bin:$PATH"`);
    const text = format(report);
    expect(text).toContain(`✗ npm global bin (${NVM_PREFIX}/bin) is not on PATH`);
    expect(text).toContain("edits stay blocked");
    expect(text).toContain(`export PATH="${NVM_PREFIX}/bin:$PATH"`);
    expect(text).not.toContain("⚠ npm global bin");
  });

  it("counts as an error in the summary, not as a warning", async () => {
    const guarded = await runDoctor(WITH_PACK, [emptyDir("elsewhere")]);
    // Same manifest, harness resolvable through another directory: the PATH
    // finding is the only difference between the two reports.
    const unescalated = await runDoctor(WITH_PACK, [dirWithHarness("other-bin")]);
    expect(unescalated.npmGlobalBin?.status).toBe("warn");
    // One problem, one error: the escalated npm-bin line is detail of the
    // harness-binary error and is not counted again.
    expect(guarded.errorCount).toBe(unescalated.errorCount + 1);
    expect(guarded.warningCount).toBe(unescalated.warningCount - 1);
  });

  it("stays a warning when the pack is not installed", async () => {
    const report = await runDoctor(NO_PACK, [emptyDir("elsewhere")]);
    expect(report.npmGlobalBin?.status).toBe("warn");
    expect(format(report)).toContain("⚠ npm global bin");
  });

  it("stays a warning when the pack is declared with enabled: false", async () => {
    const report = await runDoctor(PACK_OFF, [emptyDir("elsewhere")]);
    expect(report.npmGlobalBin?.status).toBe("warn");
  });

  it("stays a warning when harness resolves through another PATH directory", async () => {
    const report = await runDoctor(WITH_PACK, [dirWithHarness("other-bin")]);
    expect(report.npmGlobalBin?.status).toBe("warn");
    expect(report.npmGlobalBin?.consequence).toBeUndefined();
  });

  it("is ok when the bin dir is on the PATH and harness is in it", async () => {
    const prefix = path.join(tmp, "prefix");
    const bin = dirWithHarness("prefix/bin");
    const report = await runDoctor(WITH_PACK, [bin], prefix);
    expect(report.npmGlobalBin?.status).toBe("ok");
    expect(report.harnessBinary).toEqual({ status: "ok", resolved: path.join(bin, "harness"), message: `resolved: ${path.join(bin, "harness")}` });
    expect(format(report)).not.toContain("npm global bin");
    expect(format(report)).not.toContain("harness binary");
  });

  // The nvm switch the guard exists for: the active Node's npm bin directory is
  // on the PATH, so the npm-bin check is ok, while harness was installed under
  // another prefix and does not resolve.
  it("is an error when the npm bin dir IS on the PATH but harness does not resolve", async () => {
    const prefix = path.join(tmp, "prefix");
    const bin = emptyDir("prefix/bin");
    const report = await runDoctor(WITH_PACK, [bin], prefix);
    expect(report.npmGlobalBin?.status).toBe("ok");
    expect(report.harnessBinary?.status).toBe("error");
    expect(report.harnessBinary?.message).toContain("edits stay blocked");
    expect(report.harnessBinary?.message).toContain("doctor's own PATH");
    const text = format(report);
    expect(text).toContain("✗ harness binary: `harness` not found on the PATH doctor sees");
    const resolving = await runDoctor(WITH_PACK, [dirWithHarness("prefix2/bin")], path.join(tmp, "prefix2"));
    expect(report.errorCount).toBe(resolving.errorCount + 1);
  });

  it("is an error when npm itself is unavailable (unknown) and harness does not resolve", async () => {
    const configPath = path.join(tmp, "harness.yaml");
    fs.writeFileSync(configPath, WITH_PACK);
    const report = await doctor({
      configPath,
      homeOverride: tmp,
      mcpProbe: new NoMcp(),
      versionProbe: () => null,
      pathEnv: emptyDir("elsewhere"),
      npmBinExec: async () => ({ code: 127, stdout: "", stderr: "npm: not found" }),
    });
    expect(report.npmGlobalBin?.status).toBe("unknown");
    expect(report.harnessBinary?.status).toBe("error");
  });

  it("is also an error under --shallow, which skips only the npm spawn", async () => {
    const configPath = path.join(tmp, "harness.yaml");
    fs.writeFileSync(configPath, WITH_PACK);
    const report = await doctor({ configPath, homeOverride: tmp, shallow: true, mcpProbe: new NoMcp(), versionProbe: () => null, pathEnv: emptyDir("elsewhere") });
    expect(report.npmGlobalBin).toBeUndefined();
    expect(report.harnessBinary?.status).toBe("error");
  });

  it("reports no harness binary entry when the pack is not installed or is disabled", async () => {
    expect((await runDoctor(NO_PACK, [emptyDir("elsewhere")])).harnessBinary).toBeUndefined();
    expect((await runDoctor(PACK_OFF, [emptyDir("elsewhere")])).harnessBinary).toBeUndefined();
  });

  it("is an error for a hand-declared guarded blocking hook too", async () => {
    const yaml = NO_PACK.replace(
      "hooks: []",
      `hooks:\n  - name: my-guard\n    event: PreToolUse\n    match: "Write|Edit"\n    command: ${JSON.stringify(guardedHarnessCommand("pack hook branch-protection"))}\n    blocking: hard\n`,
    );
    const report = await runDoctor(yaml, [emptyDir("elsewhere")]);
    expect(report.npmGlobalBin?.status).toBe("error");
  });

  it.each([
    { runtime: "codex" as const, expected: "error" },
    { runtime: "claude-code" as const, expected: "error" },
    // opencode wires no hooks, so no guard line stands between a tool call and the tool.
    { runtime: "opencode" as const, expected: "warn" },
  ])("follows the runtime the last apply recorded: $runtime -> $expected", async ({ runtime, expected }) => {
    const configPath = path.join(tmp, "harness.yaml");
    fs.writeFileSync(configPath, WITH_PACK);
    await apply({ homeDir: tmp, configPath, runtime });
    const report = await runDoctor(WITH_PACK, [emptyDir("elsewhere")]);
    expect(report.npmGlobalBin?.status).toBe(expected);
    expect(report.harnessBinary?.status).toBe(expected === "error" ? "error" : undefined);
  });

  it("an unknown npm result is not escalated (npm itself is missing; nothing to say about the bin dir)", () => {
    const unknown: NpmBinReport = { status: "unknown", binDir: "", pathPatchSuggestion: "", reason: "npm: not found" };
    expect(escalateForGuardedHook(unknown, { guardedHookInstalled: true, harnessResolves: false })).toBe(unknown);
  });
});

describe("escalateForGuardedHook: each input on its own", () => {
  const warn: NpmBinReport = { status: "warn", binDir: "/x/bin", pathPatchSuggestion: 'export PATH="/x/bin:$PATH"', reason: "" };
  const ok: NpmBinReport = { status: "ok", binDir: "/x/bin", pathPatchSuggestion: "", reason: "" };

  it.each([
    { guardedHookInstalled: true, harnessResolves: false, expected: "error" },
    { guardedHookInstalled: true, harnessResolves: true, expected: "warn" },
    { guardedHookInstalled: false, harnessResolves: false, expected: "warn" },
    { guardedHookInstalled: false, harnessResolves: true, expected: "warn" },
  ])("warn + $guardedHookInstalled/$harnessResolves -> $expected", ({ expected, ...ctx }) => {
    expect(escalateForGuardedHook(warn, ctx).status).toBe(expected);
  });

  it("an ok report is never touched", () => {
    expect(escalateForGuardedHook(ok, { guardedHookInstalled: true, harnessResolves: false })).toBe(ok);
  });
});

describe("doctor: a settings.json that still holds the bare line", () => {
  it("is reported as differing from the guarded line apply would write, not as a second entry", () => {
    const configPath = path.join(tmp, "harness.yaml");
    fs.writeFileSync(configPath, WITH_PACK);
    const { manifest } = loadManifest({ configPath });
    const settingsPath = path.join(tmp, "settings.json");

    // What an earlier release installed.
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "command", command: "harness pack hook branch-protection", timeout: 5 }] }],
        },
      }),
    );
    const old = checkClaudeLiveHooks(manifest, settingsPath);
    expect(old.entries.map((e) => `${e.kind}:${e.status}`)).toEqual(["differing:error"]);
    expect(old.entries[0]?.message).toContain("harness pack hook branch-protection");

    // What apply writes now.
    const withPack = { ...manifest, hooks: [...manifest.hooks, ...expandPolicyPacks(manifest, "claude-code").hooks] };
    fs.writeFileSync(settingsPath, JSON.stringify(generateSettings(withPack)));
    const fresh = checkClaudeLiveHooks(manifest, settingsPath);
    expect(fresh.entries.map((e) => `${e.kind}:${e.status}`)).toEqual(["present:ok"]);
  });
});

describe("doctor: a gate-disabled bare line after an upgrade", () => {
  it("is reported as disabled via the gate, not as missing (applying would re-arm a gate the operator turned off)", () => {
    const configPath = path.join(tmp, "harness.yaml");
    fs.writeFileSync(configPath, WITH_PACK);
    const { manifest } = loadManifest({ configPath });
    const settingsPath = path.join(tmp, "settings.json");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "command", command: "harness pack hook branch-protection", timeout: 5 }] }],
        },
      }),
    );
    gateDisable({ settingsPath, matcher: "Write|Edit" });
    const r = checkClaudeLiveHooks(manifest, settingsPath);
    expect(r.entries.map((e) => `${e.kind}:${e.status}`)).toEqual(["disabled:warn"]);
    expect(r.entries[0]?.message).toContain("harness gate enable");
    expect(r.entries[0]?.message).not.toContain("harness apply");
  });

  it("a disabled guarded line (the normal state after an upgrade) is reported as disabled too", () => {
    const configPath = path.join(tmp, "harness.yaml");
    fs.writeFileSync(configPath, WITH_PACK);
    const { manifest } = loadManifest({ configPath });
    const withPack = { ...manifest, hooks: [...manifest.hooks, ...expandPolicyPacks(manifest, "claude-code").hooks] };
    const settingsPath = path.join(tmp, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify(generateSettings(withPack)));
    gateDisable({ settingsPath, matcher: "Write|Edit" });
    const r = checkClaudeLiveHooks(manifest, settingsPath);
    expect(r.entries.map((e) => `${e.kind}:${e.status}`)).toEqual(["disabled:warn"]);
  });

  it("Codex: a gate-disabled unit whose snapshot holds the bare line is reported as disabled, not missing", () => {
    const configPath = path.join(tmp, "harness.yaml");
    fs.writeFileSync(configPath, WITH_PACK);
    const { manifest } = loadManifest({ configPath });
    const withPack = { ...manifest, hooks: [...manifest.hooks, ...expandPolicyPacks(manifest, "codex").hooks] };
    const bare = generateCodexConfig(withPack)
      .content.split(JSON.stringify(guardedHarnessCommand("pack hook branch-protection --runtime codex")))
      .join(JSON.stringify("harness pack hook branch-protection --runtime codex"));
    const codexPath = path.join(tmp, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(codexPath), { recursive: true });
    writeCodexConfigInstall(planCodexConfigInstall({ configPath: codexPath, generatedPath: path.join(tmp, "g.toml"), generatedContent: bare }));
    expect(fs.readFileSync(codexPath, "utf8")).toContain("harness pack hook branch-protection --runtime codex");
    codexGateDisable({ configPath: codexPath, matcher: "apply_patch" });
    const r = checkCodexLiveHooks(manifest, codexPath);
    expect(r.entries.map((e) => `${e.kind}:${e.status}`)).toEqual(["disabled:warn"]);
  });

  // The --force advice is keyed by the same plain command as the disabled
  // check: a snapshot holding the bare line and an expected guarded line must
  // still get the advice the gate itself would need.
  it.each([
    { name: "settings.json edited since the disable", edit: (s: Record<string, unknown>) => { s["theme"] = "dark"; } },
    {
      name: "a changed group in the slot of the removed one",
      edit: (s: Record<string, unknown>) => {
        s["hooks"] = {
          PreToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "command", command: "other-guard check" }] }],
        };
      },
    },
  ])("a gate-disabled bare line with a guarded line expected, $name: the warning names --force", ({ edit }) => {
    const configPath = path.join(tmp, "harness.yaml");
    fs.writeFileSync(configPath, WITH_PACK);
    const { manifest } = loadManifest({ configPath });
    const settingsPath = path.join(tmp, "settings.json");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "command", command: "harness pack hook branch-protection", timeout: 5 }] }] },
      }),
    );
    gateDisable({ settingsPath, matcher: "Write|Edit" });
    const edited = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    edit(edited);
    fs.writeFileSync(settingsPath, `${JSON.stringify(edited, null, 2)}\n`);
    const r = checkClaudeLiveHooks(manifest, settingsPath, { gateDefaultPath: settingsPath });
    const disabled = r.entries.find((e) => e.kind === "disabled");
    expect(disabled?.message).toContain("run `harness gate enable --force` to put it back");
    // The gate agrees: the plain call refuses.
    expect(() => gateEnable({ settingsPath })).toThrow();
  });

  it("a not-yet-reapplied bare line that is live (gate not disabled) still reports as differing", () => {
    const configPath = path.join(tmp, "harness.yaml");
    fs.writeFileSync(configPath, WITH_PACK);
    const { manifest } = loadManifest({ configPath });
    const settingsPath = path.join(tmp, "settings.json");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "command", command: "harness pack hook branch-protection", timeout: 5 }] }] },
      }),
    );
    expect(checkClaudeLiveHooks(manifest, settingsPath).entries.map((e) => `${e.kind}:${e.status}`)).toEqual(["differing:error"]);
  });
});

describe("doctor --target codex: the guarded line is a harness subcommand", () => {
  it("passes as a subcommand of harness once the harness binary resolves, naming the plain command", () => {
    const configPath = path.join(tmp, "harness.yaml");
    fs.writeFileSync(configPath, WITH_PACK);
    const { manifest } = loadManifest({ configPath });
    const harnessDir = dirWithHarness("harness-bin");
    // The Codex artefact doctor reads next to the manifest.
    const codexDir = path.join(tmp, "harness.generated", "codex");
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, "config.toml"), "# Generated by harness apply --runtime codex.\n");

    const report = runCodexTargetChecks(manifest, { manifestDir: tmp, pathEnv: harnessDir });
    const hook = report.checks.find((c) => c.name.startsWith("hook policy-pack:branch-protection"));
    expect(hook?.status).toBe("ok");
    expect(hook?.message).toBe("subcommand of harness: harness pack hook branch-protection --runtime codex");
  });
});
