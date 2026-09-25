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
  OPENCODE_CONFIG_BASENAME,
  SETTINGS_BASENAME,
  apply,
} from "../../../src/cli/apply/index.js";
import { buildProgram } from "../../../src/cli/index.js";
import { HarnessExitError } from "../../../src/cli/exit-codes.js";
import {
  buildLastApply,
  lastApplyPath,
  readLastApply,
  writeLastApply,
} from "../../../src/io/last-apply.js";

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

async function cli(
  args: string[],
  { quiet = true }: { quiet?: boolean } = {},
): Promise<{ out: string; err: string; exit: number }> {
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
    const base = ["apply", "--config", manifestPath, ...(quiet ? ["--quiet"] : [])];
    await program.parseAsync([...base, ...args], {
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
const INFERRED_CODEX_LINE =
  "runtime: codex (inferred from the last apply's generated files; pass --runtime to change)\n";
const UNRECORDED_LINE =
  "runtime: claude-code (default; the last apply did not record a runtime, pass --runtime to choose)\n";

// Write a `.last-apply` holding exactly these files (no runtime field).
function writeRecord(files: Record<string, string>): void {
  fs.mkdirSync(generatedDir(), { recursive: true });
  writeLastApply(generatedDir(), buildLastApply(files));
}

// The shape a harness 0.58.2 install writes after `harness apply` and then
// `harness apply --runtime codex --install`: no runtime field, both adapter
// keys (the merge keeps the settings.json entry), and every policy-pack
// instructions.md entry regenerated for codex. Contents are truncated
// around each entry's `## Runtime` section.
const MERGED_FIXTURE = path.join(
  __dirname,
  "..",
  "..",
  "fixtures",
  "last-apply",
  "merged-claude-code-then-codex.json",
);

function writeMergedFixture(edit?: (files: Record<string, string>) => void): void {
  const rec = JSON.parse(fs.readFileSync(MERGED_FIXTURE, "utf8")) as {
    files: Record<string, { content: string }>;
  };
  const files = Object.fromEntries(
    Object.entries(rec.files).map(([key, entry]) => [key, entry.content]),
  );
  edit?.(files);
  writeRecord(files);
  // The generated files on disk match the record, as on a real machine.
  for (const [key, content] of Object.entries(files)) {
    const onDisk = path.join(generatedDir(), key);
    fs.mkdirSync(path.dirname(onDisk), { recursive: true });
    fs.writeFileSync(onDisk, content);
  }
}

function editLastApply(edit: (rec: Record<string, unknown>) => void): void {
  const p = lastApplyPath(generatedDir());
  const rec = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
  edit(rec);
  fs.writeFileSync(p, `${JSON.stringify(rec, null, 2)}\n`);
}

// Simulate a `.last-apply` written by a release before the runtime field.
function stripRuntime(): void {
  editLastApply((rec) => {
    delete rec["runtime"];
  });
}

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

  it("--target without --runtime implies claude-code and names the switch in dry-run and apply", async () => {
    await apply({ homeDir: tmpHome, runtime: "codex" });
    const target = path.join(tmpHome, "settings.local.json");
    const switchLine = "runtime: codex -> claude-code (--target implies claude-code)\n";

    const dry = await cli(["--target", target, "--dry-run"]);
    expect(dry.exit).toBe(0);
    expect(dry.out.startsWith(`${switchLine}would apply `)).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
    expect(readLastApply(generatedDir())?.runtime).toBe("codex");

    const real = await cli(["--target", target]);
    expect(real.exit).toBe(0);
    expect(real.out.startsWith(`${switchLine}applied `)).toBe(true);
    expect(fs.existsSync(target)).toBe(true);
    expect(readLastApply(generatedDir())?.runtime).toBe("claude-code");
  });

  it("--target without --runtime on a claude-code history names the implied runtime", async () => {
    await apply({ homeDir: tmpHome });
    const target = path.join(tmpHome, "settings.local.json");
    const { out, exit } = await cli(["--target", target]);
    expect(exit).toBe(0);
    expect(out.startsWith("runtime: claude-code (implied by --target)\napplied ")).toBe(true);
    const again = await apply({ homeDir: tmpHome, target, merge: true });
    expect(again.runtime).toBe("claude-code");
    expect(again.runtimeSource).toBe("target");
  });

  it("an explicit --runtime codex with --target is still refused", async () => {
    const { err, exit } = await cli([
      "--runtime",
      "codex",
      "--target",
      path.join(tmpHome, "settings.local.json"),
    ]);
    expect(exit).not.toBe(0);
    expect(err).toContain(
      "--target is incompatible with --runtime codex (target wires Claude Code's settings.json)",
    );
  });

  it("a plain apply without --quiet prints the codex next steps for a reused codex", async () => {
    expect((await cli(["--runtime", "codex"])).exit).toBe(0);
    // Drop the pack so the plain apply writes and prints its next steps.
    const raw = fs.readFileSync(manifestPath, "utf8");
    fs.writeFileSync(manifestPath, raw.replace(/policy_packs:[\s\S]*$/, "policy_packs: []\n"));
    const { out, exit } = await cli([], { quiet: false });
    expect(exit).toBe(0);
    expect(out.startsWith(REUSE_LINE)).toBe(true);
    expect(out).toContain("harness apply --runtime codex --install");
    expect(out).not.toContain("harness apply --target ~/.claude/settings.json --merge");
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

  it("an unknown recorded runtime is ignored and read like a record without one", async () => {
    await apply({ homeDir: tmpHome, runtime: "codex" });
    editLastApply((rec) => {
      rec["runtime"] = "vim";
    });
    const result = await apply({ homeDir: tmpHome, dryRun: true });
    expect(result.runtime).toBe("codex");
    expect(result.runtimeSource).toBe("inferred");
  });

  it("a non-string recorded runtime is ignored instead of failing the read", async () => {
    await apply({ homeDir: tmpHome, runtime: "codex" });
    editLastApply((rec) => {
      rec["runtime"] = 5;
    });
    expect(readLastApply(generatedDir())?.runtime).toBeUndefined();
    const { out, exit } = await cli(["--dry-run"]);
    expect(exit).toBe(0);
    expect(out).toBe(`${INFERRED_CODEX_LINE}no changes\n`);
  });
});

describe("a .last-apply written before the runtime field existed", () => {
  it("only codex/config.toml in the files map: reuses codex and says it was inferred", async () => {
    await apply({ homeDir: tmpHome, runtime: "codex" });
    stripRuntime();
    const instructionsBefore = readInstructions();

    const dry = await cli(["--dry-run"]);
    expect(dry.exit).toBe(0);
    expect(dry.out).toBe(`${INFERRED_CODEX_LINE}no changes\n`);

    const result = await apply({ homeDir: tmpHome });
    expect(result.runtime).toBe("codex");
    expect(result.runtimeSource).toBe("inferred");
    expect(result.previousRuntime).toBe("codex");
    expect(readInstructions()).toBe(instructionsBefore);
    // The no-op apply stamps the inferred runtime so later applies read it.
    expect(readLastApply(generatedDir())?.runtime).toBe("codex");
  });

  it("only opencode/opencode.json in the files map: reuses opencode", async () => {
    await apply({ homeDir: tmpHome, runtime: "opencode" });
    stripRuntime();
    const result = await apply({ homeDir: tmpHome, dryRun: true });
    expect(result.runtime).toBe("opencode");
    expect(result.runtimeSource).toBe("inferred");
    expect(Object.keys(readLastApply(generatedDir())?.files ?? {})).toContain(
      OPENCODE_CONFIG_BASENAME,
    );
  });

  it("only settings.json in the files map: reuses claude-code", async () => {
    await apply({ homeDir: tmpHome, runtime: "claude-code" });
    stripRuntime();
    const { out, exit } = await cli(["--dry-run"]);
    expect(exit).toBe(0);
    expect(out).toBe(
      "runtime: claude-code (inferred from the last apply's generated files; pass --runtime to change)\nno changes\n",
    );
  });

  it("an explicit --runtime different from the inferred one names the switch", async () => {
    await apply({ homeDir: tmpHome, runtime: "codex" });
    stripRuntime();
    const { out } = await cli(["--runtime", "claude-code", "--dry-run"]);
    expect(
      out.startsWith("runtime: codex -> claude-code (switching from the last apply's runtime)\n"),
    ).toBe(true);
  });

  it("claude-code then codex (both adapter keys): the recorded pack instructions.md settle it on codex", async () => {
    await apply({ homeDir: tmpHome, runtime: "claude-code" });
    await apply({ homeDir: tmpHome, runtime: "codex" });
    stripRuntime();
    const keys = Object.keys(readLastApply(generatedDir())?.files ?? {});
    expect(keys).toContain(SETTINGS_BASENAME);
    expect(keys).toContain(CODEX_CONFIG_BASENAME);
    const instructionsBefore = readInstructions();

    const result = await apply({ homeDir: tmpHome, dryRun: true });
    expect(result.runtime).toBe("codex");
    expect(result.runtimeSource).toBe("inferred");
    expect(result.previousRuntime).toBe("codex");
    const { out } = await cli(["--dry-run"]);
    expect(out).toBe(`${INFERRED_CODEX_LINE}no changes\n`);
    await apply({ homeDir: tmpHome });
    expect(readInstructions()).toBe(instructionsBefore);
  });

  it("only codex/config.toml and no pack entries: the adapter key alone decides", async () => {
    fs.mkdirSync(generatedDir(), { recursive: true });
    writeRecord({ [CODEX_CONFIG_BASENAME]: "# codex\n" });
    const result = await apply({ homeDir: tmpHome, dryRun: true });
    expect(result.runtime).toBe("codex");
    expect(result.runtimeSource).toBe("inferred");
  });

  it("an empty files map: uses the default and says the runtime was not recorded", async () => {
    fs.mkdirSync(generatedDir(), { recursive: true });
    fs.writeFileSync(lastApplyPath(generatedDir()), `${JSON.stringify({ files: {} })}\n`);
    const { out, err, exit } = await cli(["--dry-run"]);
    expect(err).toBe("");
    expect(exit).toBe(0);
    expect(out.startsWith(UNRECORDED_LINE)).toBe(true);
  });

  it("an explicit runtime that only changes the --target stamps the runtime", async () => {
    await apply({ homeDir: tmpHome, runtime: "claude-code" });
    stripRuntime();
    const target = path.join(tmpHome, "settings.local.json");
    const result = await apply({ homeDir: tmpHome, runtime: "claude-code", target });
    expect(result.outcome).toBe("applied");
    expect(result.files.some((f) => f.changed)).toBe(false);
    expect(result.targetWritten).toBe(true);
    expect(readLastApply(generatedDir())?.runtime).toBe("claude-code");
  });

  it("an explicit runtime that only changes the codex install stamps the runtime", async () => {
    await apply({ homeDir: tmpHome, runtime: "codex" });
    stripRuntime();
    const codexConfig = path.join(tmpHome, ".codex", "config.toml");
    const result = await apply({
      homeDir: tmpHome,
      runtime: "codex",
      installCodex: true,
      codexConfigPath: codexConfig,
    });
    expect(result.outcome).toBe("applied");
    expect(result.files.some((f) => f.changed)).toBe(false);
    expect(result.codexConfigInstall?.written).toBe(true);
    expect(readLastApply(generatedDir())?.runtime).toBe("codex");
  });
});

describe("a merged pre-field record from a claude-code then codex history", () => {
  const MIXED_LINE =
    "runtime: claude-code (default; the last apply did not record a runtime and generated files for claude-code and codex; pass --runtime codex to keep codex)\n";

  it("the fixture has both adapter keys and no runtime field", () => {
    writeMergedFixture();
    const rec = readLastApply(generatedDir());
    expect(rec?.runtime).toBeUndefined();
    expect(Object.keys(rec?.files ?? {})).toEqual(
      expect.arrayContaining([SETTINGS_BASENAME, CODEX_CONFIG_BASENAME]),
    );
  });

  it("codex in every pack instructions.md: reuses codex and says it was inferred", async () => {
    writeMergedFixture();
    const { out, exit } = await cli(["--dry-run"]);
    expect(exit).toBe(0);
    expect(out.startsWith(INFERRED_CODEX_LINE)).toBe(true);

    const result = await apply({ homeDir: tmpHome });
    expect(result.runtime).toBe("codex");
    expect(result.runtimeSource).toBe("inferred");
    expect(readInstructions()).toContain("## Runtime\n\ncodex");
    expect(readLastApply(generatedDir())?.runtime).toBe("codex");
  });

  it("pack entries that disagree: default runtime, and the line names the candidates", async () => {
    writeMergedFixture((files) => {
      const key = "policy-packs/branch-protection/instructions.md";
      files[key] = files[key]!.replace("## Runtime\n\ncodex", "## Runtime\n\nclaude-code");
    });
    const result = await apply({ homeDir: tmpHome, dryRun: true });
    expect(result.runtime).toBe("claude-code");
    expect(result.runtimeSource).toBe("unrecorded");
    expect(result.runtimeCandidates).toEqual(["claude-code", "codex"]);
    const { out } = await cli(["--dry-run"]);
    expect(out.startsWith(MIXED_LINE)).toBe(true);
  });

  it("a pack entry without a readable runtime: default runtime, and the line names the candidates", async () => {
    writeMergedFixture((files) => {
      const key = "policy-packs/solution-acceptance/instructions.md";
      files[key] = files[key]!.replace("## Runtime\n\ncodex", "## Runtime\n\ngemini");
    });
    const { out, exit } = await cli(["--dry-run"]);
    expect(exit).toBe(0);
    expect(out.startsWith(MIXED_LINE)).toBe(true);
  });

  it("pack entries naming a runtime no adapter key names: default runtime, every candidate named", async () => {
    writeMergedFixture((files) => {
      for (const key of Object.keys(files)) {
        if (key.endsWith("/instructions.md")) {
          files[key] = files[key]!.replace(/## Runtime\n\ncodex/, "## Runtime\n\nopencode");
        }
      }
    });
    const { out } = await cli(["--dry-run"]);
    expect(
      out.startsWith(
        "runtime: claude-code (default; the last apply did not record a runtime and generated files for claude-code, codex and opencode; pass --runtime codex or --runtime opencode to keep one of them)\n",
      ),
    ).toBe(true);
  });

  it("an explicit --runtime claude-code names the switch away from the inferred codex", async () => {
    writeMergedFixture();
    const { out } = await cli(["--runtime", "claude-code", "--dry-run"]);
    expect(
      out.startsWith("runtime: codex -> claude-code (switching from the last apply's runtime)\n"),
    ).toBe(true);
  });
});

describe("--install without --runtime on a claude-code record", () => {
  it("a legacy settings.json-only record: the refusal says the runtime was inferred", async () => {
    await apply({ homeDir: tmpHome, runtime: "claude-code" });
    stripRuntime();
    const { err, exit } = await cli(["--install"]);
    expect(exit).not.toBe(0);
    expect(err).toContain(
      "--install requires --runtime codex (runtime claude-code inferred from the last apply's generated files; pass --runtime codex to change)",
    );
  });

  it("a recorded claude-code runtime: the refusal says it was reused", async () => {
    await apply({ homeDir: tmpHome, runtime: "claude-code" });
    const { err, exit } = await cli(["--install"]);
    expect(exit).not.toBe(0);
    expect(err).toContain(
      "--install requires --runtime codex (runtime claude-code reused from the last apply; pass --runtime codex to change)",
    );
  });
});

describe("preserveRecordedRuntime (the harness smoke apply)", () => {
  it("keeps a recorded codex runtime while generating claude-code files", async () => {
    await apply({ homeDir: tmpHome, runtime: "codex" });
    const result = await apply({
      homeDir: tmpHome,
      runtime: "claude-code",
      preserveRecordedRuntime: true,
    });
    expect(result.outcome).toBe("applied");
    expect(result.runtime).toBe("claude-code");
    expect(result.previousRuntime).toBe("codex");
    expect(readInstructions()).toContain("## Runtime\n\nclaude-code");
    const rec = readLastApply(generatedDir());
    expect(rec?.runtime).toBe("codex");
    expect(Object.keys(rec?.files ?? {})).toContain(SETTINGS_BASENAME);

    const next = await apply({ homeDir: tmpHome, dryRun: true });
    expect(next.runtime).toBe("codex");
    expect(next.runtimeSource).toBe("last-apply");
    expect(next.files.filter((f) => f.changed).map((f) => f.basename)).toContain(
      "policy-packs/understanding-before-execution/instructions.md",
    );
  });

  it("stamps the runtime inferred from a pre-field record, not its own", async () => {
    await apply({ homeDir: tmpHome, runtime: "codex" });
    stripRuntime();
    await apply({ homeDir: tmpHome, runtime: "claude-code", preserveRecordedRuntime: true });
    expect(readLastApply(generatedDir())?.runtime).toBe("codex");
  });

  it("a no-op apply over a pre-field record stamps the inferred runtime", async () => {
    await apply({ homeDir: tmpHome, runtime: "codex" });
    stripRuntime();
    const result = await apply({
      homeDir: tmpHome,
      runtime: "codex",
      preserveRecordedRuntime: true,
    });
    expect(result.files.some((f) => f.changed)).toBe(false);
    expect(readLastApply(generatedDir())?.runtime).toBe("codex");
  });

  it("leaves the field absent when nothing was recorded or inferable", async () => {
    await apply({ homeDir: tmpHome, runtime: "claude-code", preserveRecordedRuntime: true });
    const rec = readLastApply(generatedDir());
    expect(rec).not.toBeNull();
    expect(rec?.runtime).toBeUndefined();
  });

  it("without the option the same apply records claude-code", async () => {
    await apply({ homeDir: tmpHome, runtime: "codex" });
    await apply({ homeDir: tmpHome, runtime: "claude-code" });
    expect(readLastApply(generatedDir())?.runtime).toBe("claude-code");
  });
});
