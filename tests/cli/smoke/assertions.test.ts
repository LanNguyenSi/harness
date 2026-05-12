import { describe, expect, it } from "vitest";
import {
  classifyDecision,
  evaluateExpectations,
  formatFailures,
} from "../../../src/cli/smoke/assertions.js";
import type {
  HookPair,
  StreamSummary,
} from "../../../src/cli/smoke/stream-parser.js";

function hookPair(opts: Partial<HookPair> & { hookId?: string; hookName?: string; hookEvent?: string }): HookPair {
  return {
    hookId: opts.hookId ?? "h",
    hookName: opts.hookName ?? "PreToolUse",
    hookEvent: opts.hookEvent ?? "PreToolUse",
    started: { type: "system", subtype: "hook_started", hook_id: opts.hookId ?? "h" },
    response: opts.response ?? null,
    stdout: opts.stdout ?? "",
    stderr: opts.stderr ?? "",
    exitCode: opts.exitCode ?? null,
    outcome: opts.outcome ?? null,
  };
}

function summary(hooks: HookPair[], isError: boolean | null = null): StreamSummary {
  return {
    init: null,
    hooks,
    result: isError === null ? null : { type: "result", is_error: isError },
    totalLines: 0,
    malformedLines: 0,
    unrecognised: [],
  };
}

describe("classifyDecision", () => {
  it("returns 'deny' when any hook stdout has the PR #81 envelope", () => {
    const h = hookPair({
      stdout: '{"decision":"block","hookSpecificOutput":{"permissionDecision":"deny"}}',
    });
    expect(classifyDecision([h])).toBe("deny");
  });

  it("returns 'warn' when stderr carries the diagnostic block", () => {
    const h = hookPair({
      stderr: "harness policy intercept: x: warn-degraded (ledger unreachable)\n",
    });
    expect(classifyDecision([h])).toBe("warn");
  });

  it("returns 'allow' when a PreToolUse hook fired with no deny stdout", () => {
    const h = hookPair({ outcome: "success" });
    expect(classifyDecision([h])).toBe("allow");
  });

  it("returns null when no PreToolUse hook is in the stream", () => {
    const h = hookPair({ hookName: "UserPromptSubmit", hookEvent: "UserPromptSubmit" });
    expect(classifyDecision([h])).toBeNull();
  });

  it("deny shape wins over warn diagnostic on the same hook", () => {
    const h = hookPair({
      stdout: '{"decision":"block","hookSpecificOutput":{"permissionDecision":"deny"}}',
      stderr: "warn-degraded",
    });
    expect(classifyDecision([h])).toBe("deny");
  });
});

describe("evaluateExpectations: --expect-hook", () => {
  it("passes when the named hook fired", () => {
    const s = summary([hookPair({ hookName: "PreToolUse" })]);
    const fails = evaluateExpectations(s, { expectHooks: ["PreToolUse"] });
    expect(fails).toEqual([]);
  });

  it("fails when the named hook is absent", () => {
    const s = summary([]);
    const fails = evaluateExpectations(s, { expectHooks: ["PreToolUse"] });
    expect(fails).toHaveLength(1);
    expect(fails[0]?.kind).toBe("expect-hook");
    expect(fails[0]?.actual).toContain("no hook events observed");
  });

  it("matches against hook_event when hook_name does not equal it", () => {
    const s = summary([hookPair({ hookName: "policy-intercept-pretooluse", hookEvent: "PreToolUse" })]);
    const fails = evaluateExpectations(s, { expectHooks: ["PreToolUse"] });
    expect(fails).toEqual([]);
  });
});

describe("evaluateExpectations: --expect-no-hook", () => {
  it("passes when the forbidden hook is absent", () => {
    const s = summary([hookPair({ hookName: "PreToolUse" })]);
    const fails = evaluateExpectations(s, { expectNoHooks: ["PostToolUse"] });
    expect(fails).toEqual([]);
  });

  it("fails when the forbidden hook fired", () => {
    const s = summary([hookPair({ hookName: "PreToolUse" })]);
    const fails = evaluateExpectations(s, { expectNoHooks: ["PreToolUse"] });
    expect(fails).toHaveLength(1);
    expect(fails[0]?.kind).toBe("expect-no-hook");
  });
});

describe("evaluateExpectations: --expect-exit", () => {
  it("expectExit=0 passes when is_error is false", () => {
    const s = summary([], false);
    const fails = evaluateExpectations(s, { expectExit: 0 });
    expect(fails).toEqual([]);
  });

  it("expectExit=2 passes when is_error is true", () => {
    const s = summary([], true);
    const fails = evaluateExpectations(s, { expectExit: 2 });
    expect(fails).toEqual([]);
  });

  it("expectExit=0 fails when is_error is true", () => {
    const s = summary([], true);
    const fails = evaluateExpectations(s, { expectExit: 0 });
    expect(fails).toHaveLength(1);
    expect(fails[0]?.detail).toContain("is_error=true");
  });

  it("missing terminal result event produces an explicit miss, not a silent pass", () => {
    const s = summary([], null);
    const fails = evaluateExpectations(s, { expectExit: 0 });
    expect(fails).toHaveLength(1);
    expect(fails[0]?.detail).toContain("stream ended without a terminal");
  });
});

describe("evaluateExpectations: --expect-decision", () => {
  it("passes when classified decision matches", () => {
    const s = summary([
      hookPair({ stdout: '{"decision":"block","hookSpecificOutput":{"permissionDecision":"deny"}}' }),
    ]);
    const fails = evaluateExpectations(s, { expectDecision: "deny" });
    expect(fails).toEqual([]);
  });

  it("fails when no PreToolUse hook fired at all", () => {
    const s = summary([]);
    const fails = evaluateExpectations(s, { expectDecision: "allow" });
    expect(fails).toHaveLength(1);
    expect(fails[0]?.actual).toContain("no PreToolUse hook fired");
  });

  it("fails when classified decision diverges from expected", () => {
    const s = summary([hookPair({ outcome: "success" })]);
    const fails = evaluateExpectations(s, { expectDecision: "deny" });
    expect(fails).toHaveLength(1);
    expect(fails[0]?.expected).toContain("deny");
    expect(fails[0]?.actual).toContain("allow");
  });
});

describe("evaluateExpectations: combined", () => {
  it("collects every failure rather than short-circuiting on the first miss", () => {
    const s = summary([], true);
    const fails = evaluateExpectations(s, {
      expectHooks: ["PreToolUse"],
      expectExit: 0,
      expectDecision: "allow",
    });
    expect(fails).toHaveLength(3);
    expect(fails.map((f) => f.kind).sort()).toEqual([
      "expect-decision",
      "expect-exit",
      "expect-hook",
    ]);
  });
});

describe("formatFailures", () => {
  it("returns an empty string when there are no failures", () => {
    expect(formatFailures([])).toBe("");
  });

  it("formats one line per failure plus a header", () => {
    const out = formatFailures([
      {
        kind: "expect-hook",
        expected: "hook fires",
        actual: "no hooks",
        detail: "x",
      },
    ]);
    const lines = out.trim().split("\n");
    expect(lines[0]).toContain("1 assertion(s) failed");
    expect(lines[1]).toContain("[expect-hook]");
  });
});
