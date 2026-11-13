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
import { checkClaudeLiveHooks } from "../../src/cli/doctor/hook-liveness.js";
import {
  escalateForGuardedHook,
  type NpmBinReport,
} from "../../src/cli/doctor/npm-bin-path.js";
import { runCodexTargetChecks } from "../../src/cli/doctor/codex.js";
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

  it("is ok when the bin dir is on the PATH", async () => {
    const prefix = path.join(tmp, "prefix");
    const report = await runDoctor(WITH_PACK, [path.join(prefix, "bin")], prefix);
    expect(report.npmGlobalBin?.status).toBe("ok");
    expect(format(report)).not.toContain("npm global bin");
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
