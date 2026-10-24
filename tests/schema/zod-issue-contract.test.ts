// Zod-issue contract for the manifest schema (zod 3 -> 4 migration guard).
//
// Pins what the zod 4 migration must not change: the issue PATHS and CODES
// every custom check produces (CLI diagnostics and `ManifestParseError.issues`
// are published API), the opaque round-trip of the two `z.record` fields, and
// the JSON-encodability of the issues array (zod 4's ZodError keeps `issues`
// unenumerable on the error object itself, which is why callers must only
// ever see `ManifestParseError.issues`, a plain array). Default zod MESSAGE
// text changed in zod 4 for a few built-in checks (invalid_type,
// invalid_enum_value -> invalid_value, ...); nothing in the CLI pins that
// text, so only paths, codes and the custom messages are asserted here.
import { describe, expect, expectTypeOf, it } from "vitest";
import { validateBeforeWrite } from "../../src/io/validate-before-write.js";
import {
  ManifestParseError,
  parseManifest,
  type ManifestIssue,
} from "../../src/schema/index.js";

function issuesOf(raw: unknown): ManifestIssue[] {
  try {
    parseManifest(raw);
  } catch (err) {
    if (err instanceof ManifestParseError) {
      return err.issues.map((i) => ({
        path: [...i.path],
        code: i.code,
        message: i.message,
      }));
    }
    throw err;
  }
  throw new Error("expected parseManifest to throw");
}

const HOOK = { name: "h", event: "PreToolUse", command: "/bin/true", blocking: false };

describe("custom superRefine/refine issues - path, code and message", () => {
  it("duplicate hook name", () => {
    const issues = issuesOf({ version: 1, hooks: [HOOK, { ...HOOK, event: "Stop" }] });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      path: ["hooks", 1, "name"],
      code: "custom",
      message: "duplicate hook name: h",
    });
  });

  it("reserved `memory:` hook name prefix", () => {
    const issues = issuesOf({ version: 1, hooks: [{ ...HOOK, name: "memory:x" }] });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      path: ["hooks", 0, "name"],
      code: "custom",
      message:
        'hook name "memory:x" uses reserved prefix "memory:" ' +
        "(claimed by harness apply's synthetic projection for the " +
        "corresponding manifest section, e.g. memory.router → " +
        '"memory:router"). Rename your hook to a non-reserved prefix.',
    });
  });

  it("hooks[].min_version without version_command", () => {
    const issues = issuesOf({
      version: 1,
      hooks: [{ ...HOOK, min_version: "1.0.0" }],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      path: ["hooks", 0, "version_command"],
      message: "hooks[].min_version requires hooks[].version_command",
    });
  });

  it("duplicate tools.mcp name", () => {
    const issues = issuesOf({
      version: 1,
      tools: { mcp: [{ name: "x", command: "a" }, { name: "x", command: "b" }] },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      path: ["tools", "mcp", 1, "name"],
      code: "custom",
      message: "duplicate mcp entry name: x",
    });
  });

  it("duplicate tools.cli name", () => {
    const issues = issuesOf({
      version: 1,
      tools: { cli: [{ name: "x", binary: "a" }, { name: "x", binary: "b" }] },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      path: ["tools", "cli", 1, "name"],
      code: "custom",
      message: "duplicate cli entry name: x",
    });
  });

  it("tools.skills.required must be a subset of enabled", () => {
    const issues = issuesOf({
      version: 1,
      tools: { skills: { enabled: ["a"], required: ["z"] } },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      path: ["tools", "skills"],
      message: "tools.skills.required must be a subset of tools.skills.enabled",
    });
  });

  it("memory.scopes.default must appear in allowed", () => {
    const issues = issuesOf({
      version: 1,
      memory: { scopes: { default: "user", allowed: ["project"] } },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      path: ["memory", "scopes"],
      message: "memory.scopes.default must appear in memory.scopes.allowed",
    });
  });

  it("duplicate policy_pack name", () => {
    const issues = issuesOf({ version: 1, policy_packs: [{ name: "p" }, { name: "p" }] });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      path: ["policy_packs", 1, "name"],
      code: "custom",
      message: "duplicate policy_pack name: p",
    });
  });
});

describe("z.record fields - accept-set and opaque round-trip", () => {
  it("tools.mcp[].env accepts string values and keeps them verbatim", () => {
    const m = parseManifest({
      version: 1,
      tools: { mcp: [{ name: "x", command: "a", env: { K: "v", EMPTY: "" } }] },
    });
    expect(m.tools.mcp[0]?.env).toEqual({ K: "v", EMPTY: "" });
  });

  it("tools.mcp[].env rejects a non-string value at the entry's path", () => {
    const issues = issuesOf({
      version: 1,
      tools: { mcp: [{ name: "x", command: "a", env: { K: 1 } }] },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["tools", "mcp", 0, "env", "K"]);
    expect(issues[0]?.code).toBe("invalid_type");
  });

  it("policy_packs[].config accepts any value type and round-trips it unchanged", () => {
    const config = {
      protected_branches: ["main"],
      nested: { deep: [1, null, true] },
      nul: null,
      num: 3,
    };
    const m = parseManifest({ version: 1, policy_packs: [{ name: "p", config }] });
    expect(m.policy_packs[0]?.config).toEqual(config);
  });

  it("policy_packs[].config rejects an empty key (key schema has min 1)", () => {
    const issues = issuesOf({ version: 1, policy_packs: [{ name: "p", config: { "": 1 } }] });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["policy_packs", 0, "config", ""]);
  });
});

describe("int-typed budgets - safe-integer boundary", () => {
  it("accepts the largest safe integer", () => {
    const m = parseManifest({
      version: 1,
      hooks: [{ ...HOOK, budget_ms: Number.MAX_SAFE_INTEGER }],
    });
    expect(m.hooks[0]?.budget_ms).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("rejects a value past the safe-integer range (zod 4 narrowed .int(); zod 3 accepted 2^53)", () => {
    expect(() =>
      parseManifest({
        version: 1,
        hooks: [{ ...HOOK, budget_ms: 2 ** 53 }],
      }),
    ).toThrow(ManifestParseError);
  });

  it("rejects Infinity and non-integers", () => {
    for (const bad of [Number.POSITIVE_INFINITY, 1.5, 0, -1]) {
      expect(() =>
        parseManifest({ version: 1, hooks: [{ ...HOOK, budget_ms: bad }] }),
      ).toThrow(ManifestParseError);
    }
  });
});

describe("ManifestParseError.issues - JSON wire shape", () => {
  it("the issues array survives JSON encoding with path/message/code keys", () => {
    const issues = issuesOf({ version: 1, bogus_key: true });
    const body = JSON.parse(JSON.stringify({ issues })) as {
      issues: Array<Record<string, unknown>>;
    };
    expect(body.issues).toHaveLength(1);
    expect(Object.keys(body.issues[0]!).sort()).toEqual(["code", "message", "path"]);
    expect(body.issues[0]?.path).toEqual([]);
    expect(body.issues[0]?.code).toBe("unrecognized_keys");
  });

  it("validateBeforeWrite projects the issue into { path, message } with <root> for empty paths", () => {
    const r = validateBeforeWrite({ version: 1, bogus_key: true });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toHaveLength(1);
      expect(Object.keys(r.errors[0]!).sort()).toEqual(["message", "path"]);
      expect(r.errors[0]?.path).toBe("<root>");
      expect(typeof r.errors[0]?.message).toBe("string");
    }
  });

  it("err.issues items carry exactly path/message/code (zod extras dropped at the boundary)", () => {
    // Each input produces a zod 4 issue that carries an extra field on the
    // raw issue object (unrecognized_keys: `keys`; invalid_type: `expected`;
    // invalid_value from the version literal: `values`); parseManifestWith-
    // Warnings must project them onto the published { path, message, code }.
    const inputs = [
      { version: 1, bogus_key: true },
      { version: 1, memory: { retention: { staleness_days: "x" } } },
      { version: 2 },
    ];
    let checked = 0;
    for (const raw of inputs) {
      try {
        parseManifest(raw);
        expect.unreachable(`expected parseManifest to reject ${JSON.stringify(raw)}`);
      } catch (err) {
        if (!(err instanceof ManifestParseError)) throw err;
        expect(err.issues.length).toBeGreaterThan(0);
        for (const issue of err.issues) {
          expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
          expect(Array.isArray(issue.path)).toBe(true);
          checked += 1;
        }
      }
    }
    expect(checked).toBe(inputs.length);
  });

  it("ManifestParseError.issues is the harness-owned ManifestIssue type (type-level)", () => {
    let issues: ManifestIssue[] = [];
    try {
      parseManifest({ version: 1, bogus_key: true });
    } catch (err) {
      if (err instanceof ManifestParseError) issues = err.issues;
      else throw err;
    }
    // Static assertions (checked by `npm run typecheck:tests`, not at
    // runtime): the published type is harness-owned, `path` is narrowed to
    // what remapIssuePath returns (zod 4 declares `PropertyKey[]`), and
    // `code` is an opaque string, not a zod issue-code union.
    expectTypeOf(issues).toEqualTypeOf<ManifestIssue[]>();
    expectTypeOf(issues[0]!.path).toEqualTypeOf<(string | number)[]>();
    expectTypeOf(issues[0]!.message).toEqualTypeOf<string>();
    expectTypeOf(issues[0]!.code).toEqualTypeOf<string>();
    expect(issues).toHaveLength(1);
  });
});
