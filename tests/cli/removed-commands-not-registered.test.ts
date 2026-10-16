// Guard (task 7890cd34): a command listed in REMOVED_COMMANDS must not be
// registered in the CLI any more. Data-driven over the table, so every
// removal inherits it. Walks the commander tree built by `buildProgram`
// along the words after `harness` and fails when the full path resolves.
import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import { buildProgram, run } from "../../src/cli/index.js";
import { REMOVED_COMMANDS } from "../../src/schema/index.js";

function resolves(program: Command, words: string[]): boolean {
  let node: Command | undefined = program;
  for (const word of words) {
    node = node?.commands.find((c) => c.name() === word || c.aliases().includes(word));
    if (!node) return false;
  }
  return true;
}

describe.each(REMOVED_COMMANDS)("removed command $command", (removed) => {
  it("is not registered in the CLI", () => {
    const words = removed.command.split(/\s+/).slice(1);
    expect(words.length).toBeGreaterThan(0);
    expect(resolves(buildProgram(), words)).toBe(false);
  });
});

describe("the registration walk itself", () => {
  it("resolves commands that are still registered", () => {
    const program = buildProgram();
    expect(resolves(program, ["pack", "hook", "branch-protection"])).toBe(true);
    expect(resolves(program, ["gate"])).toBe(true);
    // The deleted tests/cli/pause-command-registration.test.ts was the only
    // test asserting `harness migrate-home` is registered (task 973163a4);
    // this control carries that assertion on.
    expect(resolves(program, ["migrate-home"])).toBe(true);
  });

  // CLI-level case: running the built program must accept `migrate-home
  // --help` and exit 0 (the dry-run action must not run, the help text
  // must reach the injected stdout).
  it("migrate-home --help runs the CLI program and exits 0", async () => {
    let stdout = "";
    let stderr = "";
    const code = await run({
      argv: ["migrate-home", "--help"],
      stdout: (s) => {
        stdout += s;
      },
      stderr: (s) => {
        stderr += s;
      },
    });
    expect(code).toBe(0);
    expect(stdout).toContain("migrate-home");
    expect(stderr).toBe("");
  });
});
