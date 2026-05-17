import { describe, expect, it } from "vitest";
import { buildProgram } from "../../src/cli/index.js";

// The top-level `harness preflight` alias is the surface the policy
// `ux.run` field points agents at on a preflight block. Test that it
// is actually registered as a top-level command and lives next to
// `session-start` (not nested under it).
describe("harness preflight (top-level alias for session-start preflight)", () => {
  it("registers `preflight` as a top-level command", () => {
    const program = buildProgram();
    const preflight = program.commands.find((c) => c.name() === "preflight");
    expect(preflight, "harness preflight command should be registered").toBeDefined();
  });

  it("describes itself as an alias for session-start preflight", () => {
    const program = buildProgram();
    const preflight = program.commands.find((c) => c.name() === "preflight");
    expect(preflight?.description()).toContain("session-start preflight");
  });

  it("declares the same options the underlying runner consumes", () => {
    const program = buildProgram();
    const preflight = program.commands.find((c) => c.name() === "preflight");
    const optionNames = preflight?.options.map((o) => o.long) ?? [];
    expect(optionNames).toEqual(
      expect.arrayContaining([
        "--config",
        "--project",
        "--session",
        "--timeout",
        "--ledger-timeout",
      ]),
    );
  });
});
