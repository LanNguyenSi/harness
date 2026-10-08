// Removed CLI command table + matcher (task f3f15290). The install surface no
// longer offers `harness session-start *` or the `harness preflight` alias, and
// the matcher is the guard a hook or producer command is checked against. Pin
// the table's shape and the exact matching semantics so a future edit can
// neither drop an entry silently nor widen the prefix match into a false
// positive.
import { describe, expect, it } from "vitest";
import {
  REMOVED_COMMANDS,
  findRemovedCommandUses,
  invokesRemovedCommand,
  type RemovedCommand,
  type RemovedPackName,
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

describe("invokesRemovedCommand: leading assignments", () => {
  const table: readonly RemovedCommand[] = [{ command: "harness preflight", removedIn: "1.0.0", reason: "test" }];

  it("skips plain NAME=value assignments in front of the command word", () => {
    expect(invokesRemovedCommand("FOO=1 harness preflight", table)?.command).toBe("harness preflight");
    expect(invokesRemovedCommand("A=1 B_2=x/y:z harness preflight --json", table)?.command).toBe("harness preflight");
    expect(invokesRemovedCommand("EMPTY= harness preflight", table)?.command).toBe("harness preflight");
  });

  it("does not guess past a quoted, escaped or expanded value (a miss, never a false hit)", () => {
    // The shell reads `A='x harness preflight y'` as one assignment and no
    // command; a naive split would flag it.
    expect(invokesRemovedCommand("A='x harness preflight y'", table)).toBeUndefined();
    expect(invokesRemovedCommand('A="x" harness preflight', table)).toBeUndefined();
    expect(invokesRemovedCommand("A=$HOME harness preflight", table)).toBeUndefined();
    expect(invokesRemovedCommand("A=\\ harness preflight", table)).toBeUndefined();
  });

  it("does not treat a non-assignment word as an assignment", () => {
    expect(invokesRemovedCommand("1A=x harness preflight", table)).toBeUndefined();
    expect(invokesRemovedCommand("echo X=1 harness preflight", table)).toBeUndefined();
  });

  it("does not match a wrapper, a path or a compound command", () => {
    expect(invokesRemovedCommand("npx harness preflight", table)).toBeUndefined();
    expect(invokesRemovedCommand("/usr/local/bin/harness preflight", table)).toBeUndefined();
    expect(invokesRemovedCommand("cd /x && harness preflight", table)).toBeUndefined();
  });
});

describe("findRemovedCommandUses", () => {
  const commands: readonly RemovedCommand[] = [
    { command: "harness session-start", removedIn: "1.0.0", reason: "gone" },
    { command: "harness preflight", removedIn: "1.0.0", reason: "alias gone" },
  ];
  const removedPacks: readonly RemovedPackName[] = [{ name: "old-pack", removedIn: "1.0.0", reason: "gone" }];
  const paths = (raw: unknown) => findRemovedCommandUses(raw, commands, removedPacks).map((w) => w.path);

  it("reports hook commands, bash and ask producers, and ux.run lines of policies and packs, one per site", () => {
    const raw = {
      hooks: [
        { name: "live", command: "harness policy intercept" },
        { name: "gone", command: "harness session-start preflight" },
      ],
      policies: [
        {
          name: "p",
          hook: "live",
          producers: [
            { kind: "mcp", verb: "harness preflight", example: "harness preflight", description: "x" },
            { kind: "bash", command: "harness preflight" },
            { kind: "ask", command: "harness session-start x" },
          ],
          ux: { run: ["harness record review", "harness preflight"], required: ["run `harness preflight` first"] },
        },
      ],
      policy_packs: [
        {
          name: "branch-protection",
          config: {
            ux: { run: ["git checkout -b x", "harness session-start branch-check"] },
            producers: [{ kind: "bash", command: "harness preflight" }],
          },
        },
      ],
    };
    expect(paths(raw)).toEqual([
      "hooks[1].command",
      "policies[0].producers[1].command",
      "policies[0].producers[2].command",
      "policies[0].ux.run[1]",
      "policy_packs[0].config.producers[0].command",
      "policy_packs[0].config.ux.run[1]",
    ]);
  });

  it("names the hook, the policy and its hook, or the pack in the remedy", () => {
    const raw = {
      hooks: [{ name: "gone", command: "harness preflight" }],
      policies: [{ name: "p", hook: "h", ux: { run: ["harness preflight"] } }],
      policy_packs: [{ name: "bp", config: { ux: { run: ["harness preflight"] } } }],
    };
    const [hook, policy, pack] = findRemovedCommandUses(raw, commands, removedPacks).map((w) => w.message);
    expect(hook).toBe(
      'calls "harness preflight", removed in 1.0.0 (alias gone), so it fails with "unknown command"; delete hook "gone" from the manifest (and every policy that names it), then re-run `harness apply`',
    );
    expect(policy).toContain('delete policy "p" from the manifest (and its hook "h" when no other policy names it), then re-run `harness apply`');
    expect(pack).toContain("remove the line from the pack's config, or run `harness pack reseed bp` when the pack ships a default");
  });

  it("skips an entry of a removed pack (the pack itself already warns)", () => {
    const raw = { policy_packs: [{ name: "old-pack", config: { ux: { run: ["harness preflight"] } } }] };
    expect(paths(raw)).toEqual([]);
  });

  it("tolerates shapes the strict parse rejects, and reports nothing for them", () => {
    expect(paths(null)).toEqual([]);
    expect(paths("text")).toEqual([]);
    expect(paths({ hooks: "x", policies: { a: 1 }, policy_packs: [null, 3, { config: "x" }] })).toEqual([]);
    expect(paths({ hooks: [null, { command: 7 }], policies: [{ producers: "x", ux: { run: "harness preflight" } }] })).toEqual([]);
  });

  it("reports nothing for a manifest that calls only live commands", () => {
    expect(
      paths({
        hooks: [{ name: "a", command: "harness policy intercept" }, { name: "b", command: "harness pack hook branch-protection" }],
        policies: [{ name: "p", hook: "a", producers: [{ kind: "bash", command: "harness record review" }], ux: { run: ["harness record review"] } }],
      }),
    ).toEqual([]);
  });

  it("uses the shipped table by default", () => {
    const warnings = findRemovedCommandUses({ hooks: [{ name: "g", command: "harness session-start toolchain-parity" }] });
    expect(warnings.map((w) => w.path)).toEqual(["hooks[0].command"]);
    expect(warnings[0]?.message).toContain('calls "harness session-start", removed in 1.0.0');
  });
});
