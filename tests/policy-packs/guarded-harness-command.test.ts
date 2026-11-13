import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateCodexConfig } from "../../src/cli/apply/generate-codex-config.js";
import { generateSettings } from "../../src/cli/apply/generate-settings.js";
import { expandPolicyPacks } from "../../src/policy-packs/expand.js";
import {
  asPlainHarnessCommand,
  COULD_NOT_RUN_REASON,
  guardedHarnessCommand,
  isGuardedHarnessCommand,
  MISSING_BINARY_REASON,
  unwrapGuardedHarnessCommand,
} from "../../src/policy-packs/builtin/guarded-harness-command.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-guarded-cmd-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** The manifest as `harness apply` sees it: the pack's hooks added to the declared ones. */
function manifestWithPack(runtime: "claude-code" | "codex"): Manifest {
  const base = parseManifest({ version: 1, policy_packs: [{ name: "branch-protection" }] });
  return { ...base, hooks: [...base.hooks, ...expandPolicyPacks(base, runtime).hooks] };
}

function claudeBlockerCommand(): string {
  const root = generateSettings(manifestWithPack("claude-code"));
  const command = root.hooks["PreToolUse"]?.[0]?.hooks[0]?.command;
  if (command === undefined) throw new Error("no PreToolUse command generated");
  return command;
}

function codexBlockerCommand(): string {
  const doc = parseToml(generateCodexConfig(manifestWithPack("codex")).content) as {
    hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
  };
  const command = doc.hooks.PreToolUse[0]?.hooks[0]?.command;
  if (command === undefined) throw new Error("no Codex PreToolUse command generated");
  return command;
}

/**
 * Run a generated hook line the way a runtime does: one string through `sh -c`.
 * The PATH is `dirs` plus a directory holding only a link to the system `sh`
 * (the suite's spawn guard resolves `sh` through the call's own PATH), so no
 * `harness` of the developer's machine can be found.
 */
function runLine(line: string, dirs: string[], input = ""): { status: number | null; stdout: string; stderr: string } {
  const shOnly = path.join(tmp, "sh-only");
  if (!fs.existsSync(shOnly)) {
    fs.mkdirSync(shOnly);
    fs.symlinkSync("/bin/sh", path.join(shOnly, "sh"));
  }
  const pathEnv = [...dirs, shOnly].join(path.delimiter);
  const r = spawnSync("/bin/sh", ["-c", line], { env: { PATH: pathEnv }, input, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** A directory holding an executable `harness` with the given script body (shebang included). */
function stubDir(name: string, script: string): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  const stub = path.join(dir, "harness");
  fs.writeFileSync(stub, script);
  fs.chmodSync(stub, 0o755);
  return dir;
}

/** A `harness` that records its argv and stdin, then exits with `exitCode`. */
function stubHarnessDir(exitCode: number): string {
  return stubDir(`bin-${exitCode}`, `#!/bin/sh\necho "argv: $*"\n/bin/cat\nexit ${exitCode}\n`);
}

describe("generated hook commands carry the missing-binary guard", () => {
  it("claude-code settings hold the guarded line for the branch-protection blocker", () => {
    expect(claudeBlockerCommand()).toBe(guardedHarnessCommand("pack hook branch-protection"));
    expect(claudeBlockerCommand()).toMatch(/^\/bin\/sh -c 'command -v harness >\/dev\/null 2>&1 \|\| \{ echo ".*" >&2; exit 2; \}; harness pack hook branch-protection; rc=\$\?; .*; exit "\$rc"'$/);
  });

  it("the Codex config holds the guarded line with the codex runtime flag", () => {
    expect(codexBlockerCommand()).toBe(guardedHarnessCommand("pack hook branch-protection --runtime codex"));
  });

  it("no blocking hook the packs generate is a bare harness command", () => {
    for (const runtime of ["claude-code", "codex"] as const) {
      const packs = parseManifest({ version: 1, policy_packs: [{ name: "branch-protection" }] });
      const blocking = expandPolicyPacks(packs, runtime).hooks.filter((h) => h.blocking === "hard");
      expect(blocking.length, runtime).toBe(1);
      for (const h of blocking) expect(isGuardedHarnessCommand(h.command), `${runtime}: ${h.command}`).toBe(true);
    }
  });
});

describe("the guarded line, executed with sh -c", () => {
  it("claude-code line: with no harness on PATH it exits 2 with the reason on stderr and runs nothing", () => {
    const empty = path.join(tmp, "empty");
    fs.mkdirSync(empty);
    const r = runLine(claudeBlockerCommand(), [empty], "{}");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(MISSING_BINARY_REASON);
    expect(r.stderr).toContain("harness not found on PATH");
    expect(r.stdout).toBe("");
  });

  it("codex line: with no harness on PATH it exits 2 with the reason on stderr (Codex needs the reason to read a block)", () => {
    const empty = path.join(tmp, "empty");
    fs.mkdirSync(empty);
    const r = runLine(codexBlockerCommand(), [empty], "{}");
    expect(r.status).toBe(2);
    expect(r.stderr.trim()).not.toBe("");
    expect(r.stderr).toContain(MISSING_BINARY_REASON);
  });

  it("a PATH directory that holds no executable named harness counts as missing", () => {
    const dir = path.join(tmp, "plain");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "harness"), "#!/bin/sh\nexit 0\n"); // not executable
    expect(runLine(claudeBlockerCommand(), [dir]).status).toBe(2);
  });

  it("with harness on PATH it runs it with the subcommand, passes stdin through and keeps its stdout and exit 0", () => {
    const r = runLine(claudeBlockerCommand(), [stubHarnessDir(0)], '{"tool_name":"Write"}');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("argv: pack hook branch-protection\n");
    expect(r.stdout).toContain('{"tool_name":"Write"}');
    expect(r.stderr).toBe("");
  });

  it("stdout is byte-identical to the hook's, including a missing trailing newline", () => {
    const dir = stubDir("envelope", `#!/bin/sh\n/bin/cat >/dev/null\nprintf '{"decision":"block"}'\nexit 0\n`);
    const r = runLine(claudeBlockerCommand(), [dir], "{}");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('{"decision":"block"}');
  });

  it("with harness on PATH the codex line passes the runtime flag", () => {
    const r = runLine(codexBlockerCommand(), [stubHarnessDir(0)], "{}");
    expect(r.stdout).toContain("argv: pack hook branch-protection --runtime codex\n");
  });

  it("exit 2 from the hook is the hook's own block: it passes through with the hook's stderr and no extra reason", () => {
    const dir = stubDir("blocker", `#!/bin/sh\n/bin/cat >/dev/null\necho "hook says no" >&2\nexit 2\n`);
    const r = runLine(claudeBlockerCommand(), [dir], "{}");
    expect(r.status).toBe(2);
    expect(r.stderr).toBe("hook says no\n");
  });

  it.each([1, 3, 70, 126, 127, 255])("an exit code %i from a harness that was found is not a block by itself, so the line turns it into exit 2 with a reason", (code) => {
    const r = runLine(claudeBlockerCommand(), [stubHarnessDir(code)]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(`harness hook could not run (exit ${code})`);
    expect(r.stderr).toContain(COULD_NOT_RUN_REASON.slice(COULD_NOT_RUN_REASON.indexOf(", so this")));
  });

  it("a harness whose interpreter is not on the PATH (#!/usr/bin/env node, node missing) ends in exit 2 with a reason", () => {
    const dir = stubDir("envmissing", "#!/usr/bin/env definitely-not-installed-node\nconsole.log(1)\n");
    for (const line of [claudeBlockerCommand(), codexBlockerCommand()]) {
      const r = runLine(line, [dir], "{}");
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/harness hook could not run \(exit \d+\)/);
    }
  });

  it("a harness with an absolute interpreter that does not exist ends in exit 2 with a reason", () => {
    const dir = stubDir("badinterp", "#!/nonexistent/path/to/node\nconsole.log(1)\n");
    const r = runLine(claudeBlockerCommand(), [dir], "{}");
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/harness hook could not run \(exit \d+\)/);
  });

  it("a harness killed by a signal ends in exit 2 with a reason", () => {
    const dir = stubDir("crash", "#!/bin/sh\nkill -9 $$\n");
    const r = runLine(claudeBlockerCommand(), [dir], "{}");
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/harness hook could not run \(exit \d+\)/);
  });

  it("a dangling symlink named harness counts as missing", () => {
    const dir = path.join(tmp, "dangling");
    fs.mkdirSync(dir);
    fs.symlinkSync(path.join(tmp, "no-such-target"), path.join(dir, "harness"));
    const r = runLine(claudeBlockerCommand(), [dir], "{}");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(MISSING_BINARY_REASON);
  });
});

describe("the reasons shown to the guarded agent", () => {
  // They are the block reason the agent reads. They must send it to the
  // operator and never explain how to switch the gate off.
  it.each([
    ["missing binary", MISSING_BINARY_REASON],
    ["could not run", COULD_NOT_RUN_REASON],
  ])("%s: names the diagnosis and the operator, and does not mention editing, removing or disabling hook settings", (_name, reason) => {
    expect(reason).toContain("Ask the operator");
    const withoutProhibition = reason.replace("do not edit hook settings yourself", "");
    expect(withoutProhibition).not.toMatch(/\b(edit|remove|delete|disable|rm|settings\.json|config\.toml|by hand)\b/i);
    expect(withoutProhibition).not.toMatch(/\bsettings\b/i);
  });

  it("the stderr of a real run carries those reasons, not a recovery recipe", () => {
    const empty = path.join(tmp, "empty");
    fs.mkdirSync(empty);
    const missing = runLine(claudeBlockerCommand(), [empty], "{}");
    expect(missing.stderr).toContain("Ask the operator to fix the harness install or PATH; do not edit hook settings yourself.");
    const broken = runLine(claudeBlockerCommand(), [stubHarnessDir(127)], "{}");
    expect(broken.stderr).toContain("Ask the operator to fix the harness install or PATH; do not edit hook settings yourself.");
    expect(broken.stderr).not.toMatch(/remove|by hand/i);
  });
});

describe("recognising the guarded line and the bare line", () => {
  const bare = "harness pack hook branch-protection";

  it("unwraps the guarded line to the bare invocation and leaves anything else alone", () => {
    const guarded = guardedHarnessCommand("pack hook branch-protection");
    expect(unwrapGuardedHarnessCommand(guarded)).toBe(bare);
    expect(asPlainHarnessCommand(guarded)).toBe(bare);
    expect(asPlainHarnessCommand(`  ${bare}  `)).toBe(bare);
    expect(unwrapGuardedHarnessCommand(bare)).toBeNull();
    expect(unwrapGuardedHarnessCommand("/usr/local/bin/foreign-hook")).toBeNull();
    expect(isGuardedHarnessCommand(guarded)).toBe(true);
    expect(isGuardedHarnessCommand(bare)).toBe(false);
  });

  it("recognises a line whose reason text differs (an older or newer release wrote it)", () => {
    const other = guardedHarnessCommand("pack hook branch-protection").replace(MISSING_BINARY_REASON, "some other reason");
    expect(unwrapGuardedHarnessCommand(other)).toBe(bare);
  });

  it("does not recognise a line that merely contains the guard or runs something else after it", () => {
    const guarded = guardedHarnessCommand("pack hook branch-protection");
    expect(unwrapGuardedHarnessCommand(`${guarded}; rm -rf x`)).toBeNull();
    expect(unwrapGuardedHarnessCommand(`echo hi; ${guarded}`)).toBeNull();
    expect(unwrapGuardedHarnessCommand(guarded.replace("; harness pack", "; other-bin pack"))).toBeNull();
    expect(unwrapGuardedHarnessCommand(guarded.replace("exit 2", "exit 0"))).toBeNull();
    expect(unwrapGuardedHarnessCommand(guarded.replace('exit "$rc"', "exit 0"))).toBeNull();
    expect(unwrapGuardedHarnessCommand(guarded.replace("pack hook branch-protection", "pack hook x; rm y"))).toBeNull();
  });

  it("does not recognise the unreleased exec form (only the bare line and the current guarded line exist in the field)", () => {
    const execForm = `/bin/sh -c 'command -v harness >/dev/null 2>&1 || { echo "x" >&2; exit 2; }; exec harness pack hook branch-protection'`;
    expect(unwrapGuardedHarnessCommand(execForm)).toBeNull();
  });

  it("refuses to build a line from a subcommand with a single quote or a semicolon", () => {
    expect(() => guardedHarnessCommand("pack hook x'; evil")).toThrow(/single quote/);
    expect(() => guardedHarnessCommand("pack hook x; evil")).toThrow(/semicolon/);
  });
});
