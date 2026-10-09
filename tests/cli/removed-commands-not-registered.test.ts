// Guard (task 7890cd34): a command listed in REMOVED_COMMANDS must not be
// registered in the CLI any more. Data-driven over the table, so every
// removal inherits it. Walks the commander tree built by `buildProgram`
// along the words after `harness` and fails when the full path resolves.
import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import { buildProgram } from "../../src/cli/index.js";
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
    expect(resolves(program, ["pause"])).toBe(true);
  });
});
