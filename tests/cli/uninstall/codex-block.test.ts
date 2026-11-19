import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "../../../src/cli/index.js";
import {
  CODEX_MANAGED_BEGIN,
  CODEX_MANAGED_END,
  CODEX_MANAGED_SOURCE_PREFIX,
} from "../../../src/cli/apply/install-codex-config.js";
import { uninstall } from "../../../src/cli/uninstall/index.js";
import type { ClaudeMcpExec } from "../../../src/io/claude-mcp.js";

// Keeps the real-homedir fallback inside `tmp` for the cases that
// deliberately omit every override (same indirection as uninstall.test.ts).
// No test here ever reads or writes the developer's real ~/.codex.
const homedirOverride = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => homedirOverride.value ?? actual.homedir() };
});

const BLOCK = [
  `${CODEX_MANAGED_SOURCE_PREFIX} Generated source: /tmp/gen/codex.toml`,
  CODEX_MANAGED_BEGIN,
  "[[hooks.PreToolUse]]",
  'matcher = "apply_patch"',
  CODEX_MANAGED_END,
  "",
].join("\n");

let tmp: string;
let homeDir: string;
let settingsPath: string;
let derivedCodex: string;
let savedEnv: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-uninstall-blk-"));
  homeDir = path.join(tmp, ".claude");
  fs.mkdirSync(homeDir, { recursive: true });
  settingsPath = path.join(homeDir, "settings.json");
  derivedCodex = path.join(tmp, ".codex", "config.toml");
  savedEnv = process.env["HARNESS_ALLOW_REAL_GENERATED_DIR"];
  delete process.env["HARNESS_ALLOW_REAL_GENERATED_DIR"];
});

afterEach(() => {
  homedirOverride.value = undefined;
  if (savedEnv === undefined) delete process.env["HARNESS_ALLOW_REAL_GENERATED_DIR"];
  else process.env["HARNESS_ALLOW_REAL_GENERATED_DIR"] = savedEnv;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function noExec(): ClaudeMcpExec {
  return async () => {
    throw new Error("claude mcp remove must not be spawned in this test");
  };
}

async function inventoryOf(opts: Parameters<typeof uninstall>[0]) {
  const r = await uninstall({ settingsPath, mcpExec: noExec(), ...opts });
  if (r.mode !== "list") throw new Error("expected list");
  return r.inventory;
}

describe("uninstall codex hook block: path precedence", () => {
  it("explicit codexConfigPath alone (with a state root, no homeDir)", async () => {
    const stateDir = path.join(tmp, ".harness-state");
    fs.mkdirSync(stateDir, { recursive: true });
    const explicit = path.join(tmp, "elsewhere", "codex.toml");
    write(explicit, BLOCK);
    const inv = await inventoryOf({ stateDir, codexConfigPath: explicit });
    expect(inv.codexConfigPath).toBe(explicit);
    expect(inv.codexBlockPresent).toBe(true);
  });

  it("derives the path from an explicit homeDir when no option is set", async () => {
    write(derivedCodex, BLOCK);
    const inv = await inventoryOf({ homeDir });
    expect(inv.codexConfigPath).toBe(derivedCodex);
    expect(inv.codexBlockPresent).toBe(true);
  });

  it("the option wins over the path derived from homeDir (block only at the derived path)", async () => {
    write(derivedCodex, BLOCK);
    const explicit = path.join(tmp, "elsewhere", "codex.toml");
    write(explicit, 'model = "x"\n');
    const inv = await inventoryOf({ homeDir, codexConfigPath: explicit });
    expect(inv.codexConfigPath).toBe(explicit);
    expect(inv.codexBlockPresent).toBe(false);
  });

  it("the option wins over the path derived from homeDir (block only at the option path)", async () => {
    write(derivedCodex, 'model = "x"\n');
    const explicit = path.join(tmp, "elsewhere", "codex.toml");
    write(explicit, BLOCK);
    const inv = await inventoryOf({ homeDir, codexConfigPath: explicit });
    expect(inv.codexConfigPath).toBe(explicit);
    expect(inv.codexBlockPresent).toBe(true);
  });

  it("the option wins over the real default when HARNESS_ALLOW_REAL_GENERATED_DIR=1", async () => {
    process.env["HARNESS_ALLOW_REAL_GENERATED_DIR"] = "1";
    homedirOverride.value = tmp;
    const stateDir = path.join(tmp, ".harness-state");
    fs.mkdirSync(stateDir, { recursive: true });
    write(derivedCodex, BLOCK);
    const explicit = path.join(tmp, "elsewhere", "codex.toml");
    write(explicit, 'model = "x"\n');
    const inv = await inventoryOf({ stateDir, codexConfigPath: explicit });
    expect(inv.codexConfigPath).toBe(explicit);
    expect(inv.codexBlockPresent).toBe(false);
  });

  it("an explicit homeDir wins over the real default when HARNESS_ALLOW_REAL_GENERATED_DIR=1", async () => {
    process.env["HARNESS_ALLOW_REAL_GENERATED_DIR"] = "1";
    const fakeHome = path.join(tmp, "fake-home");
    homedirOverride.value = fakeHome;
    write(path.join(fakeHome, ".codex", "config.toml"), BLOCK);
    write(derivedCodex, 'model = "x"\n');
    const inv = await inventoryOf({ homeDir });
    expect(inv.codexConfigPath).toBe(derivedCodex);
    expect(inv.codexBlockPresent).toBe(false);
  });

  it("falls back to the default ~/.codex/config.toml only under HARNESS_ALLOW_REAL_GENERATED_DIR=1", async () => {
    process.env["HARNESS_ALLOW_REAL_GENERATED_DIR"] = "1";
    homedirOverride.value = tmp;
    const stateDir = path.join(tmp, ".harness-state");
    fs.mkdirSync(stateDir, { recursive: true });
    write(derivedCodex, BLOCK);
    const inv = await inventoryOf({ stateDir });
    expect(inv.codexConfigPath).toBe(derivedCodex);
    expect(inv.codexBlockPresent).toBe(true);
  });

  it("skips the probe with a warning and never reads the default path without an override or the env flag", async () => {
    homedirOverride.value = tmp;
    const stateDir = path.join(tmp, ".harness-state");
    fs.mkdirSync(stateDir, { recursive: true });
    write(derivedCodex, BLOCK);
    const inv = await inventoryOf({ stateDir });
    expect(inv.codexConfigPath).toBeNull();
    expect(inv.codexBlockPresent).toBe(false);
    expect(inv.warnings.join("\n")).toMatch(/skipped the Codex hook block check/);
  });

  it("an empty codexConfigPath counts as unset", async () => {
    write(derivedCodex, BLOCK);
    const inv = await inventoryOf({ homeDir, codexConfigPath: "" });
    expect(inv.codexConfigPath).toBe(derivedCodex);
  });
});

describe("uninstall codex hook block: file states", () => {
  it("missing file: no block, no warning", async () => {
    const inv = await inventoryOf({ homeDir });
    expect(inv.codexBlockPresent).toBe(false);
    expect(inv.warnings.filter((w) => /codex/i.test(w))).toEqual([]);
  });

  it("file without the block: no block, no warning", async () => {
    write(derivedCodex, 'model = "x"\n[features]\nhooks = true\n');
    const inv = await inventoryOf({ homeDir });
    expect(inv.codexBlockPresent).toBe(false);
    expect(inv.warnings.filter((w) => /codex/i.test(w))).toEqual([]);
  });

  it("file with the BEGIN/END block", async () => {
    write(derivedCodex, `model = "x"\n\n${CODEX_MANAGED_BEGIN}\n${CODEX_MANAGED_END}\n`);
    const inv = await inventoryOf({ homeDir });
    expect(inv.codexBlockPresent).toBe(true);
  });

  it("file with only the source-prefix line", async () => {
    write(derivedCodex, `${CODEX_MANAGED_SOURCE_PREFIX} Generated source: /x.toml\n`);
    const inv = await inventoryOf({ homeDir });
    expect(inv.codexBlockPresent).toBe(true);
  });

  it("matches a BEGIN line that carries trailing text (prefix match, not equality)", async () => {
    write(derivedCodex, `${CODEX_MANAGED_BEGIN} (edited)\n`);
    const inv = await inventoryOf({ homeDir });
    expect(inv.codexBlockPresent).toBe(true);
    expect(inv.codexBlockFenced).toBe(true);
  });

  it("a regular file where the .codex directory should be (ENOTDIR): no block, no warning", async () => {
    write(path.join(tmp, ".codex"), "not a directory\n");
    const inv = await inventoryOf({ homeDir });
    expect(inv.codexBlockPresent).toBe(false);
    expect(inv.warnings.filter((w) => /codex/i.test(w))).toEqual([]);
  });

  it("reports the layout: fenced with a BEGIN line, not fenced with only the source line", async () => {
    write(derivedCodex, BLOCK);
    expect((await inventoryOf({ homeDir })).codexBlockFenced).toBe(true);
    write(derivedCodex, `${CODEX_MANAGED_SOURCE_PREFIX} Generated source: /x.toml\n`);
    const inv = await inventoryOf({ homeDir });
    expect(inv.codexBlockPresent).toBe(true);
    expect(inv.codexBlockFenced).toBe(false);
  });

  it("matches an indented marker line and CRLF line endings", async () => {
    write(derivedCodex, `model = "x"\r\n   ${CODEX_MANAGED_BEGIN}  \r\n`);
    const inv = await inventoryOf({ homeDir });
    expect(inv.codexBlockPresent).toBe(true);
  });

  it("does not match a marker that is only part of a longer line", async () => {
    write(derivedCodex, `note = "${CODEX_MANAGED_BEGIN}"\n# see ${CODEX_MANAGED_SOURCE_PREFIX}\n`);
    const inv = await inventoryOf({ homeDir });
    expect(inv.codexBlockPresent).toBe(false);
  });

  it("unreadable file (EACCES): warns with the path and a by-hand hint, never throws", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    write(derivedCodex, BLOCK);
    fs.chmodSync(derivedCodex, 0o000);
    try {
      const inv = await inventoryOf({ homeDir });
      expect(inv.codexBlockPresent).toBe(false);
      const warning = inv.warnings.find((w) => w.startsWith(`could not read ${derivedCodex}`));
      expect(warning).toBeDefined();
      expect(warning).toContain("check it for a harness-managed block by hand");
    } finally {
      fs.chmodSync(derivedCodex, 0o600);
    }
  });

  it("a directory at the config path is a read warning, not a throw", async () => {
    fs.mkdirSync(derivedCodex, { recursive: true });
    const inv = await inventoryOf({ homeDir });
    expect(inv.codexBlockPresent).toBe(false);
    expect(inv.warnings.some((w) => w.startsWith(`could not read ${derivedCodex}`))).toBe(true);
  });

  it("reads a symlinked config through and never writes it, in --apply", async () => {
    const target = path.join(tmp, "dotfiles", "codex.toml");
    write(target, BLOCK);
    fs.mkdirSync(path.dirname(derivedCodex), { recursive: true });
    fs.symlinkSync(target, derivedCodex);
    const before = fs.statSync(target);

    const r = await uninstall({ homeDir, settingsPath, apply: true, mcpExec: noExec() });
    expect(r.inventory.codexBlockPresent).toBe(true);
    expect(fs.lstatSync(derivedCodex).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe(BLOCK);
    expect(fs.statSync(target).mtimeMs).toBe(before.mtimeMs);
  });

  it("leaves the config byte-identical in dry-run, apply and restore", async () => {
    write(derivedCodex, BLOCK);
    const mtime = fs.statSync(derivedCodex).mtimeMs;
    const backup = path.join(homeDir, "settings.json.pre-harness-2026-05-11");
    fs.writeFileSync(backup, "{}\n");
    fs.writeFileSync(settingsPath, "{}\n");
    await uninstall({ homeDir, settingsPath, mcpExec: noExec() });
    await uninstall({ homeDir, settingsPath, apply: true, mcpExec: noExec() });
    await uninstall({ homeDir, settingsPath, restoreFrom: backup, mcpExec: noExec() });
    expect(fs.readFileSync(derivedCodex, "utf8")).toBe(BLOCK);
    expect(fs.statSync(derivedCodex).mtimeMs).toBe(mtime);
  });
});

interface CliRun {
  out: string;
  err: string;
}

async function runCli(args: string[]): Promise<CliRun> {
  const run: CliRun = { out: "", err: "" };
  const program = buildProgram({
    stdout: (s: string) => {
      run.out += s;
    },
    stderr: (s: string) => {
      run.err += s;
    },
  });
  await program.parseAsync(["uninstall", ...args], { from: "user" });
  return run;
}

describe("uninstall codex hook block: CLI output", () => {
  const warningLine = (p: string): string => `warning: ${p} still holds a harness-managed Codex hook block`;

  it("dry-run names the path and the removal step next to the other findings", async () => {
    write(derivedCodex, BLOCK);
    fs.writeFileSync(path.join(homeDir, "harness.yaml"), "version: 1\n");
    const { out } = await runCli(["--home", homeDir, "--settings", settingsPath]);
    expect(out).toContain(`Codex: ${derivedCodex} still holds the harness-managed hook block`);
    expect(out).toContain(`delete the \`${CODEX_MANAGED_SOURCE_PREFIX} Generated source: ...\` line`);
    expect(out).toContain(`\`${CODEX_MANAGED_BEGIN}\` through \`${CODEX_MANAGED_END}\``);
    expect(out).toContain("then restart Codex");
    expect(out).toContain("Pass --apply to remove the above. This is a dry-run.");
    expect(out).toContain("harness install under");
    expect(out).toContain("through");
    expect(out).toContain(CODEX_MANAGED_END);
  });

  it("dry-run with only the source line words the step for that layout, without the BEGIN-through-END range", async () => {
    write(derivedCodex, `${CODEX_MANAGED_SOURCE_PREFIX} Generated source: /x.toml\n`);
    const { out } = await runCli(["--home", homeDir, "--settings", settingsPath]);
    expect(out).toContain(`Only the \`${CODEX_MANAGED_SOURCE_PREFIX} Generated source: ...\` line was found`);
    expect(out).toContain("keep any hook tables you wrote yourself");
    expect(out).not.toContain(CODEX_MANAGED_END);
    expect(out).not.toContain("through");
  });

  it("--apply with only the source line and nothing else installed uses the unfenced wording", async () => {
    write(derivedCodex, `${CODEX_MANAGED_SOURCE_PREFIX} Generated source: /x.toml\n`);
    const { out } = await runCli(["--apply", "--home", homeDir, "--settings", settingsPath]);
    expect(out).toContain("nothing to remove");
    expect(out).toContain("keep any hook tables you wrote yourself");
    expect(out).not.toContain(CODEX_MANAGED_END);
  });

  it("--restore-from with only the source line uses the unfenced wording", async () => {
    write(derivedCodex, `${CODEX_MANAGED_SOURCE_PREFIX} Generated source: /x.toml\n`);
    const backup = path.join(homeDir, "settings.json.pre-harness-2026-05-11");
    fs.writeFileSync(backup, "{}\n");
    fs.writeFileSync(settingsPath, "{}\n");
    const { out } = await runCli(["--restore-from", backup, "--home", homeDir, "--settings", settingsPath]);
    expect(out).toContain("keep any hook tables you wrote yourself");
    expect(out).not.toContain(CODEX_MANAGED_END);
  });

  it("--apply with only the source line uses the same wording", async () => {
    write(derivedCodex, `${CODEX_MANAGED_SOURCE_PREFIX} Generated source: /x.toml\n`);
    fs.writeFileSync(path.join(homeDir, "harness.yaml"), "version: 1\n");
    const { out } = await runCli(["--apply", "--home", homeDir, "--settings", settingsPath]);
    expect(out).toContain("keep any hook tables you wrote yourself");
    expect(out).not.toContain(CODEX_MANAGED_END);
  });

  it("dry-run shows the block even when nothing else is installed", async () => {
    write(derivedCodex, BLOCK);
    const { out } = await runCli(["--home", homeDir, "--settings", settingsPath]);
    expect(out).not.toContain("nothing to do");
    expect(out).toContain("no harness install found under");
    expect(out).toContain("; Codex residue:");
    expect(out).not.toMatch(/^harness install under/m);
    expect(out).toContain(`Codex: ${derivedCodex} still holds the harness-managed hook block`);
    expect(out).toContain("This is a dry-run.");
    expect(out).not.toContain("Pass --apply to remove the above");
  });

  it("dry-run without a block and nothing installed keeps the old message and no Codex text", async () => {
    const { out, err } = await runCli(["--home", homeDir, "--settings", settingsPath]);
    expect(out).toContain("no harness install found under");
    expect(out).toContain("nothing to do");
    expect(out).not.toMatch(/codex/i);
    expect(err).not.toMatch(/codex/i);
  });

  it("--codex-config points the probe at another file", async () => {
    const explicit = path.join(tmp, "elsewhere", "codex.toml");
    write(explicit, BLOCK);
    const { out } = await runCli([
      "--home",
      homeDir,
      "--settings",
      settingsPath,
      "--codex-config",
      explicit,
    ]);
    expect(out).toContain(`Codex: ${explicit} still holds`);
  });

  it("--apply prints the Codex step before the npm uninstall hint and warns on stderr", async () => {
    write(derivedCodex, BLOCK);
    fs.writeFileSync(path.join(homeDir, "harness.yaml"), "version: 1\n");
    const { out, err } = await runCli(["--apply", "--home", homeDir, "--settings", settingsPath]);
    const step = out.indexOf("Before `npm uninstall -g @lannguyensi/harness`");
    const finish = out.indexOf("To finish: `npm uninstall -g @lannguyensi/harness`");
    expect(step).toBeGreaterThan(-1);
    expect(finish).toBeGreaterThan(step);
    expect(err).toContain(warningLine(derivedCodex));
    expect(fs.readFileSync(derivedCodex, "utf8")).toBe(BLOCK);
  });

  it("--apply with nothing else installed still prints the step and the warning", async () => {
    write(derivedCodex, BLOCK);
    const { out, err } = await runCli(["--apply", "--home", homeDir, "--settings", settingsPath]);
    expect(out).toContain("nothing to remove");
    expect(out).toContain(`Codex: ${derivedCodex} still holds the harness-managed hook block`);
    expect(err).toContain(warningLine(derivedCodex));
  });

  it("--apply without a block has no Codex text and no warning", async () => {
    fs.writeFileSync(path.join(homeDir, "harness.yaml"), "version: 1\n");
    const { out, err } = await runCli(["--apply", "--home", homeDir, "--settings", settingsPath]);
    expect(out).toContain("To finish:");
    expect(out).not.toMatch(/codex/i);
    expect(err).not.toMatch(/codex/i);
  });

  it("--restore-from prints the Codex step before the npm uninstall hint and warns on stderr", async () => {
    write(derivedCodex, BLOCK);
    const backup = path.join(homeDir, "settings.json.pre-harness-2026-05-11");
    fs.writeFileSync(backup, "{}\n");
    fs.writeFileSync(settingsPath, "{}\n");
    const { out, err } = await runCli(["--restore-from", backup, "--home", homeDir, "--settings", settingsPath]);
    const step = out.indexOf("Before `npm uninstall -g @lannguyensi/harness`");
    const finish = out.indexOf("To finish: `npm uninstall -g @lannguyensi/harness`");
    expect(step).toBeGreaterThan(-1);
    expect(finish).toBeGreaterThan(step);
    expect(err).toContain(warningLine(derivedCodex));
  });

  it("a read failure is a stderr warning in every mode and exit stays 0", async () => {
    fs.mkdirSync(derivedCodex, { recursive: true });
    const dry = await runCli(["--home", homeDir, "--settings", settingsPath]);
    expect(dry.err).toContain(`warning: could not read ${derivedCodex}`);
    const applied = await runCli(["--apply", "--home", homeDir, "--settings", settingsPath]);
    expect(applied.err).toContain(`warning: could not read ${derivedCodex}`);
  });
});
