// `harness apply` without `--runtime` reuses the runtime the previous apply
// recorded in `.last-apply` (agent-tasks b9e6d63c). Before this, a plain
// `harness apply` after `harness apply --runtime codex` silently rewrote the
// runtime-specific generated files (policy-pack instructions.md, settings.json
// vs codex/config.toml) to the claude-code variant, and neither the dry-run
// nor the apply output said the runtime had changed.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as yamlStringify } from "yaml";
import {
  CODEX_CONFIG_BASENAME,
  GENERATED_DIRNAME,
  SETTINGS_BASENAME,
  apply,
} from "../../../src/cli/apply/index.js";
import { buildProgram } from "../../../src/cli/index.js";
import { HarnessExitError } from "../../../src/cli/exit-codes.js";
import { lastApplyPath, readLastApply } from "../../../src/io/last-apply.js";

let tmpHome: string;
let manifestPath: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "harness-apply-runtime-reuse-"));
  const manifest = {
    version: 1,
    tools: {
      mcp: [],
      cli: [],
      skills: { enabled: [], source_dirs: [] },
      builtin: { known: [] },
    },
    memory: { directories: [] },
    hooks: [],
    policies: [],
    policy_packs: [{ name: "understanding-before-execution" }],
  };
  manifestPath = path.join(tmpHome, "harness.yaml");
  fs.writeFileSync(manifestPath, yamlStringify(manifest));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const generatedDir = (): string => path.join(tmpHome, GENERATED_DIRNAME);

function readInstructions(): string {
  return fs.readFileSync(
    path.join(
      generatedDir(),
      "policy-packs",
      "understanding-before-execution",
      "instructions.md",
    ),
    "utf8",
  );
}

async function cli(args: string[]): Promise<{ out: string; err: string; exit: number }> {
  let out = "";
  let err = "";
  const program = buildProgram({
    stdout: (s: string) => {
      out += s;
    },
    stderr: (s: string) => {
      err += s;
    },
  });
  try {
    await program.parseAsync(["apply", "--config", manifestPath, "--quiet", ...args], {
      from: "user",
    });
    return { out, err, exit: 0 };
  } catch (e) {
    if (e instanceof HarnessExitError) {
      return { out, err: err + e.message, exit: e.exitCode };
    }
    throw e;
  }
}

const REUSE_LINE = "runtime: codex (from last apply; pass --runtime to change)\n";

describe("apply without --runtime after a codex apply", () => {
  it("records the runtime in .last-apply", async () => {
    await apply({ homeDir: tmpHome, runtime: "codex" });
    expect(readLastApply(generatedDir())?.runtime).toBe("codex");
  });

  it("plain apply keeps the codex variant and says so (library result)", async () => {
    await apply({ homeDir: tmpHome, runtime: "codex" });
    const instructionsBefore = readInstructions();
    const lastApplyBefore = fs.readFileSync(lastApplyPath(generatedDir()), "utf8");

    const result = await apply({ homeDir: tmpHome });
    expect(result.runtime).toBe("codex");
    expect(result.runtimeSource).toBe("last-apply");
    expect(result.previousRuntime).toBe("codex");
    expect(result.outcome).toBe("no-changes");
    expect(readInstructions()).toBe(instructionsBefore);
    expect(readInstructions()).toContain("Runtime\n\ncodex");
    expect(fs.readFileSync(lastApplyPath(generatedDir()), "utf8")).toBe(lastApplyBefore);
    expect(fs.existsSync(path.join(generatedDir(), SETTINGS_BASENAME))).toBe(false);
  });

  it("plain apply --dry-run names the reused runtime and would change nothing (CLI)", async () => {
    expect((await cli(["--runtime", "codex"])).exit).toBe(0);
    const { out, exit } = await cli(["--dry-run"]);
    expect(exit).toBe(0);
    expect(out).toBe(`${REUSE_LINE}no changes\n`);
  });

  it("plain apply names the reused runtime and rewrites nothing (CLI)", async () => {
    expect((await cli(["--runtime", "codex"])).exit).toBe(0);
    const instructionsBefore = readInstructions();
    const { out, exit } = await cli([]);
    expect(exit).toBe(0);
    expect(out).toBe(`${REUSE_LINE}no changes\n`);
    expect(readInstructions()).toBe(instructionsBefore);
    expect(readLastApply(generatedDir())?.runtime).toBe("codex");
  });

  it("plain apply after a manifest change regenerates the codex variant, not claude-code", async () => {
    await apply({ homeDir: tmpHome, runtime: "codex" });
    // Drop the pack: the generated set changes, so apply must write.
    const raw = fs.readFileSync(manifestPath, "utf8");
    fs.writeFileSync(manifestPath, raw.replace(/policy_packs:[\s\S]*$/, "policy_packs: []\n"));
    const { out, exit } = await cli([]);
    expect(exit).toBe(0);
    expect(out.startsWith(`${REUSE_LINE}applied `)).toBe(true);
    const codex = fs.readFileSync(path.join(generatedDir(), CODEX_CONFIG_BASENAME), "utf8");
    expect(codex).toContain("Generated by harness apply --runtime codex");
    expect(fs.existsSync(path.join(generatedDir(), SETTINGS_BASENAME))).toBe(false);
    expect(readLastApply(generatedDir())?.runtime).toBe("codex");
  });

  it("--target without --runtime refuses and names the reused runtime", async () => {
    await apply({ homeDir: tmpHome, runtime: "codex" });
    const { err, exit } = await cli(["--target", path.join(tmpHome, "settings.local.json")]);
    expect(exit).not.toBe(0);
    expect(err).toContain(
      "--target is incompatible with --runtime codex (target wires Claude Code's settings.json) (runtime codex reused from the last apply; pass --runtime claude-code to change)",
    );
  });

  it("--install without --runtime reuses codex", async () => {
    await apply({ homeDir: tmpHome, runtime: "codex" });
    const codexConfig = path.join(tmpHome, ".codex", "config.toml");
    const result = await apply({
      homeDir: tmpHome,
      installCodex: true,
      codexConfigPath: codexConfig,
    });
    expect(result.runtime).toBe("codex");
    expect(result.codexConfigInstall?.written).toBe(true);
  });
});

describe("apply with an explicit --runtime different from the last apply", () => {
  it("dry-run and apply both name the switch, and the switch is honoured", async () => {
    expect((await cli(["--runtime", "codex"])).exit).toBe(0);
    const instructionsCodex = readInstructions();

    const dry = await cli(["--runtime", "claude-code", "--dry-run"]);
    expect(dry.exit).toBe(0);
    expect(
      dry.out.startsWith(
        "runtime: codex -> claude-code (switching from the last apply's runtime)\nwould apply ",
      ),
    ).toBe(true);
    // Dry run wrote nothing.
    expect(readInstructions()).toBe(instructionsCodex);
    expect(readLastApply(generatedDir())?.runtime).toBe("codex");

    const real = await cli(["--runtime", "claude-code"]);
    expect(real.exit).toBe(0);
    expect(
      real.out.startsWith(
        "runtime: codex -> claude-code (switching from the last apply's runtime)\napplied ",
      ),
    ).toBe(true);
    expect(readInstructions()).not.toBe(instructionsCodex);
    expect(readInstructions()).not.toContain("Runtime\n\ncodex");
    expect(fs.existsSync(path.join(generatedDir(), SETTINGS_BASENAME))).toBe(true);
    expect(readLastApply(generatedDir())?.runtime).toBe("claude-code");

    // The next plain apply now reuses claude-code.
    const plain = await cli([]);
    expect(plain.out).toBe(
      "runtime: claude-code (from last apply; pass --runtime to change)\nno changes\n",
    );
  });

  it("an explicit --runtime equal to the recorded one prints no runtime line", async () => {
    expect((await cli(["--runtime", "codex"])).exit).toBe(0);
    const { out } = await cli(["--runtime", "codex"]);
    expect(out).toBe("no changes\n");
  });
});

describe("apply with no recorded runtime keeps the default", () => {
  it("first apply (no .last-apply) uses claude-code, prints no runtime line, and records it", async () => {
    const { out, exit } = await cli([]);
    expect(exit).toBe(0);
    expect(out.startsWith("applied ")).toBe(true);
    expect(fs.existsSync(path.join(generatedDir(), SETTINGS_BASENAME))).toBe(true);
    expect(readLastApply(generatedDir())?.runtime).toBe("claude-code");
  });

  it("a .last-apply written before the runtime field existed falls back to claude-code", async () => {
    await apply({ homeDir: tmpHome, runtime: "codex" });
    const p = lastApplyPath(generatedDir());
    const legacy = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
    delete legacy["runtime"];
    fs.writeFileSync(p, `${JSON.stringify(legacy, null, 2)}\n`);

    const result = await apply({ homeDir: tmpHome, dryRun: true });
    expect(result.runtime).toBe("claude-code");
    expect(result.runtimeSource).toBe("default");
    expect(result.previousRuntime).toBeUndefined();
  });

  it("a no-op explicit apply stamps the runtime into a legacy .last-apply", async () => {
    await apply({ homeDir: tmpHome, runtime: "codex" });
    const p = lastApplyPath(generatedDir());
    const legacy = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
    delete legacy["runtime"];
    fs.writeFileSync(p, `${JSON.stringify(legacy, null, 2)}\n`);

    const result = await apply({ homeDir: tmpHome, runtime: "codex" });
    expect(result.outcome).toBe("no-changes");
    expect(readLastApply(generatedDir())?.runtime).toBe("codex");
    // ...so the next plain apply reuses it.
    expect((await apply({ homeDir: tmpHome, dryRun: true })).runtime).toBe("codex");
  });

  it("an unknown recorded runtime is ignored and falls back to claude-code", async () => {
    await apply({ homeDir: tmpHome, runtime: "codex" });
    const p = lastApplyPath(generatedDir());
    const rec = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
    rec["runtime"] = "vim";
    fs.writeFileSync(p, `${JSON.stringify(rec, null, 2)}\n`);
    const result = await apply({ homeDir: tmpHome, dryRun: true });
    expect(result.runtime).toBe("claude-code");
    expect(result.runtimeSource).toBe("default");
  });
});
