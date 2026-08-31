import { describe, expect, it } from "vitest";
import {
  ExtractGrammarError,
  evaluateExtract,
  firstInputMatchMismatch,
  parseExtractExpression,
  resolveExtractPathValue,
  substituteTemplate,
  validateExtractGrammar,
  type ExtractBuiltins,
  // Deliberately imported via the policies barrel, not src/io/extract.js:
  // the barrel re-export IS the public surface of the extract DSL, so this
  // suite doubles as a guard that the re-export keeps working.
} from "../../src/policies/index.js";

const BUILTINS: ExtractBuiltins = {
  SESSION_ID: "sess-1",
  REPO: "harness",
  BRANCH: "master",
  TOOL_NAME: "Bash",
  CWD: "/home/lan/git/pandora/harness",
};

describe("validateExtractGrammar — happy path", () => {
  it.each([
    "toolArgs.prNumber",
    "toolArgs.foo.bar.baz",
    'toolArgs.foo["bar baz"]',
    "toolArgs.foo['bar baz']",
    "event.payload.repository.full_name",
    "session.id",
    "git.branch",
    'toolArgs.foo.bar["weird key"].leaf',
  ])("accepts %s", (expr) => {
    expect(() => validateExtractGrammar(expr)).not.toThrow();
  });
});

describe("validateExtractGrammar — rejection", () => {
  it("rejects function calls with the documented message", () => {
    expect(() => validateExtractGrammar("toolArgs.foo()")).toThrow(
      /function calls not allowed/,
    );
  });

  it("rejects array indices with the documented message", () => {
    expect(() => validateExtractGrammar("toolArgs.foo[0]")).toThrow(
      /array indices not allowed/,
    );
  });

  it("rejects unknown namespaces with the documented message", () => {
    expect(() => validateExtractGrammar("foo.bar")).toThrow(
      /unknown namespace `foo`/,
    );
  });

  it("rejects bracket expressions that are not quoted strings", () => {
    expect(() => validateExtractGrammar("toolArgs.foo[bar]")).toThrow(
      /bracket accessor must be a quoted string key/,
    );
  });

  it.each([
    ["", /non-empty string/],
    ["toolArgs", /at least one segment/],
    ["toolArgs.", /expected identifier after '\.'/],
    ["toolArgs..foo", /expected identifier after '\.'/],
    ["toolArgs.foo[", /unterminated bracket accessor/],
    ['toolArgs.foo["x', /unterminated quoted bracket key/],
    ['toolArgs.foo[""]', /empty bracket key/],
    ['toolArgs.foo["x"', /expected '\]' after bracket key/],
    ["toolArgs.foo+bar", /unexpected character '\+'/],
    ["toolArgs(", /function calls not allowed/],
    ["123abc", /must begin with one of toolArgs/],
  ])("rejects %s", (expr, pattern) => {
    expect(() => validateExtractGrammar(expr)).toThrow(pattern);
    try {
      validateExtractGrammar(expr);
    } catch (e) {
      expect(e).toBeInstanceOf(ExtractGrammarError);
    }
  });
});

describe("parseExtractExpression", () => {
  it("returns a typed path", () => {
    const path = parseExtractExpression('toolArgs.foo["bar baz"].leaf');
    expect(path.namespace).toBe("toolArgs");
    expect(path.segments).toEqual([
      { kind: "identifier", key: "foo" },
      { kind: "bracket", key: "bar baz" },
      { kind: "identifier", key: "leaf" },
    ]);
  });
});

describe("evaluateExtract", () => {
  it("substitutes a simple toolArgs path", () => {
    const result = evaluateExtract(
      { PR_NUMBER: "toolArgs.prNumber" },
      { toolArgs: { prNumber: 42 } },
      BUILTINS,
    );
    expect(result.values.PR_NUMBER).toBe("42");
    expect(result.values.REPO).toBe("harness");
    const trace = result.traceData.find((t) => t.var === "PR_NUMBER");
    expect(trace).toMatchObject({
      var: "PR_NUMBER",
      expression: "toolArgs.prNumber",
      resolved: "42",
      source: "extract",
    });
  });

  it("supports the canonical Appendix A review-before-merge policy", () => {
    const result = evaluateExtract(
      {
        PR_NUMBER: "toolArgs.prNumber",
        REPO: "toolArgs.repo",
      },
      { toolArgs: { prNumber: 42, repo: "harness" } },
      BUILTINS,
    );
    expect(result.values.PR_NUMBER).toBe("42");
    expect(result.values.REPO).toBe("harness");
    const sub = substituteTemplate("review:${REPO}:${PR_NUMBER}", result.values);
    expect(sub.result).toBe("review:harness:42");
    expect(sub.missing).toEqual([]);
  });

  it("provides built-in vars when extracts is empty", () => {
    const result = evaluateExtract({}, {}, BUILTINS);
    expect(result.values).toMatchObject(BUILTINS);
    expect(
      result.traceData.every((t) => t.source === "builtin"),
    ).toBe(true);
  });

  it("extracts override builtins with a single trace row per variable", () => {
    const result = evaluateExtract(
      { REPO: "toolArgs.targetRepo" },
      { toolArgs: { targetRepo: "other" } },
      BUILTINS,
    );
    expect(result.values.REPO).toBe("other");
    const repoRows = result.traceData.filter((t) => t.var === "REPO");
    expect(repoRows).toHaveLength(1);
    expect(repoRows[0]).toMatchObject({ source: "extract", resolved: "other" });
  });

  it("treats arrays as a leaf, not a navigable path", () => {
    const result = evaluateExtract(
      { N: "event.items.length" },
      { event: { items: ["a", "b"] } },
      BUILTINS,
    );
    expect(result.values.N).toBe("${N}");
  });

  it("flags missing extract-context values", () => {
    const result = evaluateExtract(
      { PR_NUMBER: "toolArgs.prNumber" },
      {},
      BUILTINS,
    );
    expect(result.values.PR_NUMBER).toBe("${PR_NUMBER}");
    const trace = result.traceData.find((t) => t.var === "PR_NUMBER");
    expect(trace?.source).toBe("missing");
    expect(trace?.resolved).toBe("${PR_NUMBER}");
  });

  it("walks bracket-quoted keys", () => {
    const result = evaluateExtract(
      { WEIRD: 'toolArgs["spaced key"]' },
      { toolArgs: { "spaced key": "ok" } },
      BUILTINS,
    );
    expect(result.values.WEIRD).toBe("ok");
  });

  it("stringifies numbers/booleans verbatim and JSON-encodes objects", () => {
    const result = evaluateExtract(
      {
        N: "toolArgs.n",
        B: "toolArgs.b",
        O: "toolArgs.o",
      },
      { toolArgs: { n: 7, b: true, o: { x: 1 } } },
      BUILTINS,
    );
    expect(result.values.N).toBe("7");
    expect(result.values.B).toBe("true");
    expect(result.values.O).toBe('{"x":1}');
  });

  it("treats null/undefined intermediate segments as missing", () => {
    const result = evaluateExtract(
      { X: "toolArgs.deeply.nested.value" },
      { toolArgs: { deeply: null } },
      BUILTINS,
    );
    expect(result.values.X).toBe("${X}");
  });

  it("propagates grammar errors from extract entries", () => {
    expect(() =>
      evaluateExtract(
        { BAD: "foo.bar" },
        {},
        BUILTINS,
      ),
    ).toThrow(/unknown namespace `foo`/);
  });
});

describe("substituteTemplate", () => {
  it("replaces every known ${VAR}", () => {
    const r = substituteTemplate("a:${X}/b:${Y}", { X: "1", Y: "2" });
    expect(r.result).toBe("a:1/b:2");
    expect(r.missing).toEqual([]);
  });

  it("leaves unknown vars in place and reports them once", () => {
    const r = substituteTemplate("${X}/${X}/${Y}", { Y: "ok" });
    expect(r.result).toBe("${X}/${X}/ok");
    expect(r.missing).toEqual(["X"]);
  });
});

// Task 2699b476: the `trigger.input_match` evaluator both
// `policyMatchesEvent` (src/runtime/intercept.ts) and dry-run's
// `policyMatchesTool` (src/cli/dry-run.ts) call, so the two cannot
// disagree about what a predicate means.
describe("resolveExtractPathValue", () => {
  it("returns the RAW value, not the stringified one evaluateExtract produces", () => {
    const ctx = { toolArgs: { autoMerge: true, retries: 0, name: "x" } };
    expect(resolveExtractPathValue("toolArgs.autoMerge", ctx)).toBe(true);
    expect(resolveExtractPathValue("toolArgs.retries", ctx)).toBe(0);
    expect(resolveExtractPathValue("toolArgs.name", ctx)).toBe("x");
  });

  it("returns undefined for a path the payload does not carry", () => {
    expect(resolveExtractPathValue("toolArgs.missing", { toolArgs: {} })).toBeUndefined();
  });
});

describe("firstInputMatchMismatch", () => {
  const ctx = { toolArgs: { autoMerge: true, mergeMethod: "squash", retries: 2, nulled: null } };

  it("returns null when every entry holds", () => {
    expect(
      firstInputMatchMismatch({ "toolArgs.autoMerge": true, "toolArgs.retries": 2 }, ctx),
    ).toBeNull();
  });

  it("reports a value mismatch with both sides", () => {
    expect(firstInputMatchMismatch({ "toolArgs.autoMerge": false }, ctx)).toEqual({
      expression: "toolArgs.autoMerge",
      expected: false,
      actual: true,
      missing: false,
    });
  });

  it("compares by strict equality: a string never equals a boolean or a number", () => {
    expect(firstInputMatchMismatch({ "toolArgs.autoMerge": "true" }, ctx)).not.toBeNull();
    expect(firstInputMatchMismatch({ "toolArgs.retries": "2" }, ctx)).not.toBeNull();
    expect(firstInputMatchMismatch({ "toolArgs.mergeMethod": "squash" }, ctx)).toBeNull();
  });

  it("treats an absent path as a mismatch flagged `missing`, never as a match", () => {
    expect(firstInputMatchMismatch({ "toolArgs.autoMerge": true }, { toolArgs: {} })).toEqual({
      expression: "toolArgs.autoMerge",
      expected: true,
      actual: undefined,
      missing: true,
    });
  });

  it("treats an explicit null the same way as an absent path", () => {
    expect(firstInputMatchMismatch({ "toolArgs.nulled": "x" }, ctx)?.missing).toBe(true);
  });

  it("ANDs the entries: one failing entry is enough, and it is the one reported", () => {
    const mismatch = firstInputMatchMismatch(
      { "toolArgs.autoMerge": true, "toolArgs.mergeMethod": "rebase" },
      ctx,
    );
    expect(mismatch?.expression).toBe("toolArgs.mergeMethod");
  });

  it("fails CLOSED on an unparseable expression: the entry holds, so the gate stays armed", () => {
    // The schema rejects this shape at parse time; this only guards
    // hand-built Manifest objects. Treating it as "does not match" would
    // silently excuse the tool call from a block gate.
    expect(firstInputMatchMismatch({ "not a path": true }, ctx)).toBeNull();
  });
});
