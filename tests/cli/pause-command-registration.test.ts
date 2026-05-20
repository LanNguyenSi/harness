import { describe, expect, it } from "vitest";
import { buildProgram, run } from "../../src/cli/index.js";

// Regression guard for the `harness pause` mis-registration. `pause` was
// chained directly onto the `migrate-home` command's `.action()` instead
// of starting its own `program.command(...)` statement. Because
// Commander's `.command()` returns the newly created subcommand (and
// `.description()/.option()/.action()` return `this`), that chain
// registered `pause` as `harness migrate-home pause` and dropped it from
// top-level `harness --help`. `resume`, its sibling top-level command,
// was always registered correctly; the pause/resume asymmetry is the
// tell. The existing tests/cli/pause.test.ts exercises the `pause()`
// function directly and never drives the CLI, so it could not catch a
// command-registration bug. This file closes that gap.
describe("harness pause (top-level operator command)", () => {
  it("registers `pause` as a top-level command, a sibling of `resume`", () => {
    const program = buildProgram();
    const names = program.commands.map((c) => c.name());
    expect(names, "pause must be a top-level command").toContain("pause");
    expect(names, "resume must be a top-level command").toContain("resume");
  });

  it("does NOT register `pause` as a subcommand of `migrate-home`", () => {
    const program = buildProgram();
    const migrateHome = program.commands.find((c) => c.name() === "migrate-home");
    expect(migrateHome, "migrate-home command should exist").toBeDefined();
    const subNames = migrateHome?.commands.map((c) => c.name()) ?? [];
    expect(subNames, "migrate-home must not own a `pause` subcommand").not.toContain("pause");
  });

  it("declares the operator-facing options the pause runner consumes", () => {
    const program = buildProgram();
    const pause = program.commands.find((c) => c.name() === "pause");
    const optionNames = pause?.options.map((o) => o.long) ?? [];
    expect(optionNames).toEqual(
      expect.arrayContaining([
        "--config",
        "--project",
        "--for",
        "--indefinite",
        "--reason",
        "--i-am-the-operator",
      ]),
    );
  });

  it("lists `pause` in top-level `harness --help`", async () => {
    let stdout = "";
    const code = await run({
      argv: ["--help"],
      stdout: (s) => {
        stdout += s;
      },
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(stdout).toMatch(/\bpause\b/);
    expect(stdout).toMatch(/\bresume\b/);
  });
});
