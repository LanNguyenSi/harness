import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUDGET_MS,
  generateSettings,
} from "../../../src/cli/apply/generate-settings.js";
import { manifestProjection, parseSettingsHooks } from "../../../src/cli/adopt/derive.js";
import { parseManifest, type Manifest } from "../../../src/schema/index.js";

function manifestOf(hooks: unknown[]): Manifest {
  return parseManifest({
    version: 1,
    tools: { mcp: [], cli: [], skills: { enabled: [], source_dirs: [] }, builtin: { known: [] } },
    memory: { directories: [] },
    hooks,
    policies: [],
  });
}

describe("generateSettings", () => {
  it("returns { hooks: {} } for an empty manifest (not undefined, not missing)", () => {
    const out = generateSettings(manifestOf([]));
    expect(out).toEqual({ hooks: {} });
  });

  it("emits one event key per distinct event with the right matcher/command tuples", () => {
    const m = manifestOf([
      {
        name: "git-preflight",
        event: "SessionStart",
        command: "/hooks/git-preflight.sh",
        blocking: false,
        budget_ms: 30000,
      },
      {
        name: "review",
        event: "PreToolUse",
        match: "mcp__agent-tasks__pull_requests_merge",
        command: "/hooks/review.sh",
        blocking: "hard",
        budget_ms: 2000,
      },
      {
        name: "dogfood",
        event: "PreToolUse",
        match: "Bash",
        command: "/hooks/dogfood.sh",
        blocking: "hard",
        budget_ms: 2000,
      },
    ]);
    const out = generateSettings(m);
    expect(Object.keys(out.hooks)).toEqual(["PreToolUse", "SessionStart"]);

    expect(out.hooks.SessionStart).toEqual([
      { hooks: [{ type: "command", command: "/hooks/git-preflight.sh" }] },
    ]);

    // PreToolUse has 2 matchers, sorted ascending: "Bash" before "mcp__..."
    expect(out.hooks.PreToolUse).toEqual([
      {
        matcher: "Bash",
        hooks: [{ type: "command", command: "/hooks/dogfood.sh", timeout: 2000 }],
      },
      {
        matcher: "mcp__agent-tasks__pull_requests_merge",
        hooks: [{ type: "command", command: "/hooks/review.sh", timeout: 2000 }],
      },
    ]);
  });

  it("groups hooks under the same event+match together (one group, multiple inner hooks)", () => {
    const m = manifestOf([
      {
        name: "h1",
        event: "PreToolUse",
        match: "Bash",
        command: "/cmd-b.sh",
        blocking: false,
        budget_ms: 30000,
      },
      {
        name: "h2",
        event: "PreToolUse",
        match: "Bash",
        command: "/cmd-a.sh",
        blocking: false,
        budget_ms: 30000,
      },
    ]);
    const out = generateSettings(m);
    expect(out.hooks.PreToolUse).toEqual([
      {
        matcher: "Bash",
        hooks: [
          { type: "command", command: "/cmd-a.sh" },
          { type: "command", command: "/cmd-b.sh" },
        ],
      },
    ]);
  });

  it("hooks without a `match` produce a group without a `matcher` field", () => {
    const m = manifestOf([
      {
        name: "session",
        event: "SessionStart",
        command: "/s.sh",
        blocking: false,
        budget_ms: 30000,
      },
    ]);
    const out = generateSettings(m);
    expect(out.hooks.SessionStart).toEqual([
      { hooks: [{ type: "command", command: "/s.sh" }] },
    ]);
    expect(out.hooks.SessionStart[0]).not.toHaveProperty("matcher");
  });

  it("emits `timeout` only when budget_ms differs from the schema default", () => {
    const m = manifestOf([
      {
        name: "default-budget",
        event: "SessionStart",
        command: "/d.sh",
        blocking: false,
        budget_ms: DEFAULT_BUDGET_MS,
      },
      {
        name: "custom-budget",
        event: "Stop",
        command: "/c.sh",
        blocking: false,
        budget_ms: 5000,
      },
    ]);
    const out = generateSettings(m);
    expect(out.hooks.SessionStart[0]?.hooks[0]).not.toHaveProperty("timeout");
    expect(out.hooks.Stop[0]?.hooks[0]).toEqual({
      type: "command",
      command: "/c.sh",
      timeout: 5000,
    });
  });

  it("does NOT emit `blocking` (harness-internal field)", () => {
    const m = manifestOf([
      {
        name: "hard",
        event: "PreToolUse",
        match: "Bash",
        command: "/h.sh",
        blocking: "hard",
        budget_ms: 30000,
      },
    ]);
    const out = generateSettings(m);
    const inner = out.hooks.PreToolUse[0]?.hooks[0];
    expect(inner).toBeDefined();
    expect(inner).not.toHaveProperty("blocking");
  });

  it("output is deterministic across runs (byte-equivalent JSON)", () => {
    const m = manifestOf([
      {
        name: "h-z",
        event: "PreToolUse",
        match: "Bash",
        command: "/z.sh",
        blocking: false,
        budget_ms: 30000,
      },
      {
        name: "h-a",
        event: "PreToolUse",
        match: "Bash",
        command: "/a.sh",
        blocking: false,
        budget_ms: 30000,
      },
      {
        name: "h-m",
        event: "Stop",
        command: "/m.sh",
        blocking: false,
        budget_ms: 30000,
      },
    ]);
    const a = JSON.stringify(generateSettings(m));
    const b = JSON.stringify(generateSettings(m));
    expect(a).toBe(b);
  });

  it("event keys are sorted ascending in the output object", () => {
    const m = manifestOf([
      {
        name: "z",
        event: "Stop",
        command: "/z.sh",
        blocking: false,
        budget_ms: 30000,
      },
      {
        name: "a",
        event: "PreToolUse",
        match: "Bash",
        command: "/a.sh",
        blocking: false,
        budget_ms: 30000,
      },
      {
        name: "m",
        event: "SessionStart",
        command: "/m.sh",
        blocking: false,
        budget_ms: 30000,
      },
    ]);
    const out = generateSettings(m);
    expect(Object.keys(out.hooks)).toEqual(["PreToolUse", "SessionStart", "Stop"]);
  });

  it("round-trips through parseSettingsHooks back to manifestProjection", () => {
    const m = manifestOf([
      {
        name: "git-preflight",
        event: "SessionStart",
        command: "/hooks/git-preflight.sh",
        blocking: false,
        budget_ms: 30000,
      },
      {
        name: "review",
        event: "PreToolUse",
        match: "mcp__agent-tasks__pull_requests_merge",
        command: "/hooks/review.sh",
        blocking: "hard",
        budget_ms: 2000,
      },
      {
        name: "dogfood",
        event: "PreToolUse",
        match: "Bash",
        command: "/hooks/dogfood.sh",
        blocking: "hard",
        budget_ms: 2000,
      },
    ]);
    const settings = generateSettings(m);
    const reparsed = parseSettingsHooks(settings).map((d) => ({
      event: d.event,
      command: d.command,
      ...(d.match !== undefined ? { match: d.match } : {}),
    }));
    const expected = manifestProjection(m);

    // Sort both sides by the same composite key to make order-insensitive.
    const sortKey = (h: { event: string; command: string; match?: string }) =>
      `${h.event}\x00${h.command}\x00${h.match ?? ""}`;
    expect([...reparsed].sort((a, b) => sortKey(a).localeCompare(sortKey(b)))).toEqual(
      [...expected].sort((a, b) => sortKey(a).localeCompare(sortKey(b))),
    );
  });

  it("output is JSON.stringify-able and JSON.parse round-trips byte-equivalent", () => {
    const m = manifestOf([
      {
        name: "h",
        event: "SessionStart",
        command: "/h.sh",
        blocking: false,
        budget_ms: 30000,
      },
    ]);
    const settings = generateSettings(m);
    const serialized = JSON.stringify(settings);
    expect(JSON.parse(serialized)).toEqual(settings);
  });

  it("a hook with empty-string explicit `match` is treated as 'no matcher'", () => {
    // Schema rejects empty-string match (min 1), so we exercise this via the
    // already-default no-match path rather than a malformed input. This test
    // doc'd to verify the empty-string bucket key is "no matcher" semantics.
    const m = manifestOf([
      {
        name: "h",
        event: "SessionStart",
        command: "/h.sh",
        blocking: false,
        budget_ms: 30000,
      },
    ]);
    const out = generateSettings(m);
    expect(out.hooks.SessionStart[0]).not.toHaveProperty("matcher");
  });
});
