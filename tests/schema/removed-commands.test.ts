// Removed CLI command table + matcher (task f3f15290). The install surface no
// longer offers `harness session-start *` or the `harness preflight` alias, and
// the matcher is the guard a hook or producer command is checked against. Pin
// the table's shape and the exact matching semantics so a future edit can
// neither drop an entry silently nor widen the prefix match into a false
// positive.
import { describe, expect, it } from "vitest";
import {
  REMOVED_COMMANDS,
  invokesRemovedCommand,
  type RemovedCommand,
} from "../../src/schema/index.js";

const sessionStart = REMOVED_COMMANDS.find((c) => c.command === "harness session-start");
const preflightAlias = REMOVED_COMMANDS.find((c) => c.command === "harness preflight");

describe("REMOVED_COMMANDS table (task f3f15290)", () => {
  it("lists the removed session-start producer command and its alias", () => {
    expect(sessionStart).toBeDefined();
    expect(preflightAlias).toBeDefined();
  });

  it("every entry carries a semver version and a non-empty reason", () => {
    expect(REMOVED_COMMANDS.length).toBeGreaterThan(0);
    for (const entry of REMOVED_COMMANDS) {
      expect(entry.command.length).toBeGreaterThan(0);
      expect(entry.removedIn).toMatch(/^\d+\.\d+\.\d+$/);
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("invokesRemovedCommand", () => {
  const table: readonly RemovedCommand[] = [
    { command: "harness session-start", removedIn: "1.0.0", reason: "test" },
    { command: "harness preflight", removedIn: "1.0.0", reason: "test" },
  ];

  it("matches the bare command, a spaced subcommand, and a hyphen-suffixed form", () => {
    expect(invokesRemovedCommand("harness session-start", table)?.command).toBe("harness session-start");
    expect(invokesRemovedCommand("harness session-start preflight", table)?.command).toBe("harness session-start");
    expect(invokesRemovedCommand("  harness preflight  ", table)?.command).toBe("harness preflight");
    expect(invokesRemovedCommand("harness preflight-run", table)?.command).toBe("harness preflight");
  });

  it("does not match a superstring that only shares the prefix without a boundary", () => {
    // "harness preflighting" is a different verb, not `harness preflight` plus
    // a boundary (space or hyphen); it must not be flagged.
    expect(invokesRemovedCommand("harness preflighting", table)).toBeUndefined();
    expect(invokesRemovedCommand("harness session-startup", table)).toBeUndefined();
  });

  it("leaves live commands alone", () => {
    expect(invokesRemovedCommand("harness pause", table)).toBeUndefined();
    expect(invokesRemovedCommand("harness policy intercept", table)).toBeUndefined();
    expect(invokesRemovedCommand("", table)).toBeUndefined();
  });
});
