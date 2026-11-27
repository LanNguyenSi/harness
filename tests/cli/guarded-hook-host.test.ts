// The guarded branch-protection hook line runs `/bin/sh -c '...'`. On a host
// whose runtime starts hooks without a POSIX sh (native Windows) the line may
// not run and the gate would fail open, so `harness apply` and `harness
// doctor` say so there. The line, its recognisers and every generated file
// stay as they are; only a warning is added. The platform is injected, so no
// test needs a Windows host.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as yamlStringify } from "yaml";
import { GENERATED_DIRNAME, apply } from "../../src/cli/apply/index.js";
import { doctor, format } from "../../src/cli/doctor/index.js";
import { run } from "../../src/cli/index.js";
import {
  GUARDED_HOOK_HOST_WARNING,
  guardedHarnessCommand,
  guardedHookHostWarning,
} from "../../src/policy-packs/builtin/guarded-harness-command.js";
import type { McpProbe, McpProbeResult } from "../../src/probes/mcp.js";
import type { McpServer } from "../../src/schema/index.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "harness-guarded-host-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeHome(name: string): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

interface Seed {
  packs?: unknown[];
  hooks?: unknown[];
}

function writeManifest(home: string, seed: Seed = {}): string {
  const manifest: Record<string, unknown> = {
    version: 1,
    tools: { mcp: [], cli: [], skills: { enabled: [], source_dirs: [] }, builtin: { known: [] } },
    memory: { directories: [] },
    hooks: seed.hooks ?? [],
    policies: [],
    ...(seed.packs !== undefined ? { policy_packs: seed.packs } : {}),
  };
  const target = path.join(home, "harness.yaml");
  fs.writeFileSync(target, yamlStringify(manifest));
  return target;
}

const PACK = [{ name: "branch-protection" }];
const PACK_OFF = [{ name: "branch-protection", enabled: false }];

function countOf(warnings: string[]): number {
  return warnings.filter((w) => w === GUARDED_HOOK_HOST_WARNING).length;
}

describe("guardedHookHostWarning", () => {
  it("names the host limit on win32", () => {
    expect(guardedHookHostWarning("win32")).toBe(GUARDED_HOOK_HOST_WARNING);
    expect(GUARDED_HOOK_HOST_WARNING).toContain("POSIX sh (/bin/sh)");
    expect(GUARDED_HOOK_HOST_WARNING).toContain("WSL2");
  });

  it("is silent on linux, darwin and another unix", () => {
    expect(guardedHookHostWarning("linux")).toBeNull();
    expect(guardedHookHostWarning("darwin")).toBeNull();
    expect(guardedHookHostWarning("freebsd")).toBeNull();
  });
});

describe("apply: the native-Windows warning for a guarded hook line", () => {
  it("claude-code on win32 with the pack: exactly one warning", async () => {
    const home = makeHome("h");
    writeManifest(home, { packs: PACK });
    const r = await apply({ homeDir: home, platform: "win32" });
    expect(r.outcome).toBe("applied");
    expect(r.runtime).toBe("claude-code");
    expect(countOf(r.warnings)).toBe(1);
  });

  it("codex on win32 with the pack: exactly one warning", async () => {
    const home = makeHome("h");
    writeManifest(home, { packs: PACK });
    const r = await apply({ homeDir: home, platform: "win32", runtime: "codex" });
    expect(r.runtime).toBe("codex");
    expect(countOf(r.warnings)).toBe(1);
  });

  it("opencode on win32 with the pack: none (no hook is wired)", async () => {
    const home = makeHome("h");
    writeManifest(home, { packs: PACK });
    const r = await apply({ homeDir: home, platform: "win32", runtime: "opencode" });
    expect(r.runtime).toBe("opencode");
    expect(countOf(r.warnings)).toBe(0);
  });

  it("win32 with the pack disabled: none", async () => {
    const home = makeHome("h");
    writeManifest(home, { packs: PACK_OFF });
    const r = await apply({ homeDir: home, platform: "win32" });
    expect(countOf(r.warnings)).toBe(0);
  });

  it("win32 without the pack: none", async () => {
    const home = makeHome("h");
    writeManifest(home);
    const r = await apply({ homeDir: home, platform: "win32" });
    expect(countOf(r.warnings)).toBe(0);
  });

  it("win32 with a hand-written guarded hook and no pack: one warning", async () => {
    const home = makeHome("h");
    writeManifest(home, {
      hooks: [
        {
          name: "own-gate",
          event: "PreToolUse",
          match: "Write|Edit",
          command: guardedHarnessCommand("pack hook branch-protection"),
          blocking: "hard",
          budget_ms: 5000,
        },
      ],
    });
    const r = await apply({ homeDir: home, platform: "win32" });
    expect(countOf(r.warnings)).toBe(1);
  });

  it("linux with the pack: none", async () => {
    const home = makeHome("h");
    writeManifest(home, { packs: PACK });
    const r = await apply({ homeDir: home, platform: "linux" });
    expect(countOf(r.warnings)).toBe(0);
  });

  it("darwin with the pack: none", async () => {
    const home = makeHome("h");
    writeManifest(home, { packs: PACK });
    const r = await apply({ homeDir: home, platform: "darwin" });
    expect(countOf(r.warnings)).toBe(0);
  });

  it("an injected platform wins over process.platform; unset falls back to it", async () => {
    const homeA = makeHome("a");
    writeManifest(homeA, { packs: PACK });
    const injected = await apply({ homeDir: homeA, platform: "win32" });
    expect(countOf(injected.warnings)).toBe(1);

    const homeB = makeHome("b");
    writeManifest(homeB, { packs: PACK });
    const fallback = await apply({ homeDir: homeB });
    expect(countOf(fallback.warnings)).toBe(process.platform === "win32" ? 1 : 0);
  });

  it("--dry-run shows the warning too and writes nothing", async () => {
    const home = makeHome("h");
    writeManifest(home, { packs: PACK });
    const r = await apply({ homeDir: home, platform: "win32", dryRun: true });
    expect(r.outcome).toBe("would-apply");
    expect(countOf(r.warnings)).toBe(1);
    expect(fs.existsSync(path.join(home, GENERATED_DIRNAME))).toBe(false);
  });

  it("an idempotent re-apply carries the warning once, not doubled", async () => {
    const home = makeHome("h");
    writeManifest(home, { packs: PACK });
    await apply({ homeDir: home, platform: "win32" });
    const second = await apply({ homeDir: home, platform: "win32" });
    expect(second.outcome).toBe("no-changes");
    expect(countOf(second.warnings)).toBe(1);
  });

  it("the generated files are byte-identical to the linux run", async () => {
    const winHome = makeHome("win");
    const linHome = makeHome("lin");
    writeManifest(winHome, { packs: PACK });
    writeManifest(linHome, { packs: PACK });
    await apply({ homeDir: winHome, platform: "win32" });
    await apply({ homeDir: linHome, platform: "linux" });

    const listFiles = (root: string): string[] => {
      const out: string[] = [];
      const walk = (dir: string): void => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else out.push(path.relative(root, p));
        }
      };
      walk(root);
      return out.sort();
    };
    const winRoot = path.join(winHome, GENERATED_DIRNAME);
    const linRoot = path.join(linHome, GENERATED_DIRNAME);
    const files = listFiles(winRoot);
    expect(files).toEqual(listFiles(linRoot));
    expect(files).toContain("settings.json");
    // .last-apply records the home it ran under; every other file must match.
    for (const rel of files.filter((f) => f !== ".last-apply")) {
      expect(fs.readFileSync(path.join(winRoot, rel), "utf8")).toBe(
        fs.readFileSync(path.join(linRoot, rel), "utf8"),
      );
    }
    const settings = fs.readFileSync(path.join(winRoot, "settings.json"), "utf8");
    expect(settings).not.toContain("WSL2");
    expect(settings).toContain("/bin/sh -c 'command -v harness");
  });

  it("run() apply: exit 0, a `warning:` line on stderr and the warning in --json", async () => {
    // The CLI reads process.platform, so this one only runs the check on win32;
    // elsewhere it pins the silent side through the same entry point.
    const home = makeHome("h");
    const manifestPath = writeManifest(home, { packs: PACK });
    let err = "";
    const code = await run({
      argv: ["apply", "--config", manifestPath, "--dry-run"],
      stdout: () => {},
      stderr: (s) => {
        err += s;
      },
    });
    expect(code).toBe(0);
    expect(err.includes(`warning: ${GUARDED_HOOK_HOST_WARNING}`)).toBe(process.platform === "win32");
  });
});

class NoMcp implements McpProbe {
  async call(server: McpServer): Promise<McpProbeResult> {
    return { name: server.name, outcome: { kind: "missing-verb" } };
  }
}

async function runDoctor(home: string, platform: NodeJS.Platform | undefined) {
  const dir = makeHome("bin");
  const bin = path.join(dir, "harness");
  fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(bin, 0o755);
  return doctor({
    configPath: path.join(home, "harness.yaml"),
    homeOverride: home,
    mcpProbe: new NoMcp(),
    versionProbe: () => null,
    pathEnv: dir,
    npmBinExec: async () => ({ code: 0, stdout: `${dir}\n`, stderr: "" }),
    ...(platform !== undefined ? { platform } : {}),
  });
}

describe("doctor: the native-Windows finding for a guarded hook line", () => {
  it("win32 with the pack: a warning finding in the report, the prose and the JSON", async () => {
    const home = makeHome("h");
    writeManifest(home, { packs: PACK });
    const report = await runDoctor(home, "win32");
    expect(report.guardedHookHost).toEqual({ status: "warn", message: GUARDED_HOOK_HOST_WARNING });
    const text = format(report);
    expect(text).toContain("Environment");
    expect(text).toContain(`⚠ branch-protection hook host: ${GUARDED_HOOK_HOST_WARNING}`);
    const json = JSON.parse(JSON.stringify(report)) as { guardedHookHost?: { status: string } };
    expect(json.guardedHookHost?.status).toBe("warn");
  });

  it("counts as one warning and no error, so the exit code stays as it was", async () => {
    const home = makeHome("h");
    writeManifest(home, { packs: PACK });
    const win = await runDoctor(home, "win32");
    const lin = await runDoctor(home, "linux");
    expect(win.warningCount).toBe(lin.warningCount + 1);
    expect(win.errorCount).toBe(lin.errorCount);
  });

  it("the harnessBinary check is unchanged on win32", async () => {
    const home = makeHome("h");
    writeManifest(home, { packs: PACK });
    const win = await runDoctor(home, "win32");
    const lin = await runDoctor(home, "linux");
    expect(win.harnessBinary).toEqual(lin.harnessBinary);
    expect(win.harnessBinary?.status).toBe("ok");
  });

  it("linux and darwin with the pack: none", async () => {
    const home = makeHome("h");
    writeManifest(home, { packs: PACK });
    for (const platform of ["linux", "darwin"] as const) {
      const report = await runDoctor(home, platform);
      expect(report.guardedHookHost).toBeUndefined();
      expect(format(report)).not.toContain("hook host");
    }
  });

  it("win32 without a guarded hook (no pack, or pack disabled): none", async () => {
    const none = makeHome("none");
    writeManifest(none);
    expect((await runDoctor(none, "win32")).guardedHookHost).toBeUndefined();
    const off = makeHome("off");
    writeManifest(off, { packs: PACK_OFF });
    expect((await runDoctor(off, "win32")).guardedHookHost).toBeUndefined();
  });

  it("win32 when the recorded runtime is opencode (no hook is wired): none", async () => {
    const home = makeHome("h");
    writeManifest(home, { packs: PACK });
    await apply({ homeDir: home, runtime: "opencode", platform: "linux" });
    expect((await runDoctor(home, "win32")).guardedHookHost).toBeUndefined();
  });

  it("an injected platform wins over process.platform; unset falls back to it", async () => {
    const home = makeHome("h");
    writeManifest(home, { packs: PACK });
    expect((await runDoctor(home, "win32")).guardedHookHost).toBeDefined();
    const fallback = await runDoctor(home, undefined);
    expect(fallback.guardedHookHost !== undefined).toBe(process.platform === "win32");
  });
});
