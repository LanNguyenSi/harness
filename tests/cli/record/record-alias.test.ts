import { describe, expect, it } from "vitest";
import { buildProgram } from "../../../src/cli/index.js";
import { HarnessExitError } from "../../../src/cli/exit-codes.js";

// Registration tests for `harness record` (task T-001): the group plus
// its three subcommands (review, review-subagent, dogfood) must be
// wired into the top-level program with the options their runners
// consume. Mirrors tests/cli/preflight-alias.test.ts's pattern.
describe("harness record (command group registration)", () => {
  it("registers `record` as a top-level command", () => {
    const program = buildProgram();
    const record = program.commands.find((c) => c.name() === "record");
    expect(record, "harness record command should be registered").toBeDefined();
  });

  it("registers `review`, `review-subagent`, and `dogfood` as subcommands of `record`", () => {
    const program = buildProgram();
    const record = program.commands.find((c) => c.name() === "record");
    const subNames = record?.commands.map((c) => c.name()) ?? [];
    expect(subNames).toEqual(expect.arrayContaining(["review", "review-subagent", "dogfood"]));
  });

  it("`record review` declares --pr (required) plus --base/--branch/--session/--config/--project/--ledger-timeout", () => {
    const program = buildProgram();
    const record = program.commands.find((c) => c.name() === "record");
    const review = record?.commands.find((c) => c.name() === "review");
    expect(review).toBeDefined();
    const optionNames = review?.options.map((o) => o.long) ?? [];
    expect(optionNames).toEqual(
      expect.arrayContaining([
        "--config",
        "--project",
        "--pr",
        "--base",
        "--branch",
        "--session",
        "--ledger-timeout",
      ]),
    );
    const prOption = review?.options.find((o) => o.long === "--pr");
    expect(prOption?.mandatory).toBe(true);
    // Positional <summary> argument.
    expect(review?.registeredArguments.map((a) => a.name())).toEqual(["summary"]);
    expect(review?.registeredArguments[0]?.required).toBe(true);
  });

  it("`record review-subagent` declares --task/--verdict (required) plus an optional summary argument", () => {
    const program = buildProgram();
    const record = program.commands.find((c) => c.name() === "record");
    const reviewSubagent = record?.commands.find((c) => c.name() === "review-subagent");
    expect(reviewSubagent).toBeDefined();
    const optionNames = reviewSubagent?.options.map((o) => o.long) ?? [];
    expect(optionNames).toEqual(
      expect.arrayContaining(["--task", "--verdict", "--branch", "--session"]),
    );
    expect(reviewSubagent?.options.find((o) => o.long === "--task")?.mandatory).toBe(true);
    expect(reviewSubagent?.options.find((o) => o.long === "--verdict")?.mandatory).toBe(true);
    expect(reviewSubagent?.registeredArguments.map((a) => a.name())).toEqual(["summary"]);
    expect(reviewSubagent?.registeredArguments[0]?.required).toBe(false);
  });

  it("`record dogfood` declares a required summary argument plus --session/--config/--project/--ledger-timeout", () => {
    const program = buildProgram();
    const record = program.commands.find((c) => c.name() === "record");
    const dogfood = record?.commands.find((c) => c.name() === "dogfood");
    expect(dogfood).toBeDefined();
    const optionNames = dogfood?.options.map((o) => o.long) ?? [];
    expect(optionNames).toEqual(
      expect.arrayContaining(["--config", "--project", "--session", "--ledger-timeout"]),
    );
    expect(dogfood?.registeredArguments.map((a) => a.name())).toEqual(["summary"]);
    expect(dogfood?.registeredArguments[0]?.required).toBe(true);
  });
});

// `applyLedgerTimeout` (task T-004 review fix) lives as a closure inside
// `buildProgram()`, not exported — it is CLI-wiring behavior, not part of
// the runner API record/index.ts exposes, so it is exercised here through
// the real command the same way tests/cli/gc.test.ts's "CLI wiring" block
// exercises its own option-validation warnings. `--branch` and a
// nonexistent `--config` keep the scenario hermetic (no dependency on the
// real cwd's git state or a real manifest) and force a deterministic
// downstream failure so the command settles quickly after the warning we
// care about has already been written.
describe("harness record — --ledger-timeout validation (task T-004)", () => {
  it("warns once on stderr and falls back to the default when --ledger-timeout is not a positive integer", async () => {
    let err = "";
    const program = buildProgram({
      stdout: () => {},
      stderr: (s: string) => {
        err += s;
      },
    });
    await expect(
      program.parseAsync(
        [
          "record",
          "review",
          "--pr",
          "1",
          "--branch",
          "test-branch",
          "--ledger-timeout",
          "abc",
          "--config",
          "/definitely/does/not/exist.yaml",
          "a summary",
        ],
        { from: "user" },
      ),
    ).rejects.toThrow(HarnessExitError);
    expect(err).toContain(
      'harness record: --ledger-timeout "abc" is not a positive integer; using the default timeout.',
    );
  });

  it("does not warn for a valid --ledger-timeout", async () => {
    let err = "";
    const program = buildProgram({
      stdout: () => {},
      stderr: (s: string) => {
        err += s;
      },
    });
    await expect(
      program.parseAsync(
        [
          "record",
          "review",
          "--pr",
          "1",
          "--branch",
          "test-branch",
          "--ledger-timeout",
          "5000",
          "--config",
          "/definitely/does/not/exist.yaml",
          "a summary",
        ],
        { from: "user" },
      ),
    ).rejects.toThrow(HarnessExitError);
    expect(err).not.toContain("is not a positive integer");
  });
});
