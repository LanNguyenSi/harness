import { describe, expect, it } from "vitest";
import { buildProgram } from "../../../src/cli/index.js";

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
