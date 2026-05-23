import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  diffKeys,
  extractUpstreamSectionKeys,
  labelToCamelKey,
  loadHarnessMirror,
} from "../../scripts/check-ug-schema-drift.mjs";

describe("labelToCamelKey", () => {
  it("strips a trailing (kind) hint and camel-cases the rest", () => {
    expect(labelToCamelKey("Current Understanding (paragraph)")).toBe("currentUnderstanding");
    expect(labelToCamelKey("Verification Plan (list)")).toBe("verificationPlan");
    expect(labelToCamelKey("Out Of Scope (list)")).toBe("outOfScope");
  });

  it("handles labels without a kind annotation", () => {
    expect(labelToCamelKey("Assumptions")).toBe("assumptions");
    expect(labelToCamelKey("Open Questions")).toBe("openQuestions");
  });
});

describe("extractUpstreamSectionKeys", () => {
  it("returns the keys inside `const SECTIONS = [...]` in declaration order", () => {
    const fixture = `
const SECTIONS = [
  { key: "currentUnderstanding", kind: "paragraph", aliases: ["my current understanding"] },
  { key: "intendedOutcome", kind: "paragraph", aliases: ["intended outcome"] },
  { key: "derivedTodos", kind: "list", aliases: ["todos"] },
];
const BULLET_TABLE = [
  { prefix: /^x/, key: "shouldBeIgnored" },
];
`;
    expect(extractUpstreamSectionKeys(fixture)).toEqual([
      "currentUnderstanding",
      "intendedOutcome",
      "derivedTodos",
    ]);
  });

  it("does NOT pick up `key: \"...\"` matches outside the SECTIONS array", () => {
    // The real parser.js has a fast_confirm bullet-prefix table further
    // down the file with its own `key: "..."` entries. Without bracket-
    // balanced slicing the extractor would over-count.
    const fixture = `
const SECTIONS = [
  { key: "currentUnderstanding", kind: "paragraph" },
];
const FAST_CONFIRM_PREFIXES = [
  { prefix: /^a/, key: "extraKey1" },
  { prefix: /^b/, key: "extraKey2" },
];
`;
    expect(extractUpstreamSectionKeys(fixture)).toEqual(["currentUnderstanding"]);
  });

  it("throws when SECTIONS declaration is missing (layout drift signal)", () => {
    expect(() => extractUpstreamSectionKeys("// no SECTIONS here")).toThrow(/parser.js layout changed/);
  });

  it("handles nested arrays inside SECTIONS entries (aliases: [...])", () => {
    const fixture = `const SECTIONS = [
  { key: "a", aliases: ["x", "y"] },
  { key: "b", aliases: ["z"] },
];`;
    expect(extractUpstreamSectionKeys(fixture)).toEqual(["a", "b"]);
  });

  it("does NOT truncate on a `]` inside a string literal (task 6f9c56b3)", () => {
    // Subagent on PR #153 reproduced this case: a SECTIONS alias
    // containing `]` made the naive bracket walker close the array
    // early, producing false-positive drift. The string-aware walker
    // skips brackets inside string literals.
    const fixture = `const SECTIONS = [
  { key: "a", aliases: ["foo ] bar"] },
  { key: "b", aliases: ["clean"] },
];`;
    expect(extractUpstreamSectionKeys(fixture)).toEqual(["a", "b"]);
  });

  it("honors `\\` escapes inside string literals so an escaped quote does not exit string mode", () => {
    const fixture = `const SECTIONS = [
  { key: "a", aliases: ["foo \\"] still string"] },
  { key: "b" },
];`;
    expect(extractUpstreamSectionKeys(fixture)).toEqual(["a", "b"]);
  });

  it("treats a doubled backslash as an escaped backslash, so the next quote closes the string", () => {
    // "trailing \\" — the `\\` is an escaped backslash, NOT an escape of
    // the following quote, so the string closes and `]` outside it is
    // honored as the array terminator.
    const fixture = `const SECTIONS = [
  { key: "a", aliases: ["trailing \\\\"] },
  { key: "b" },
];`;
    expect(extractUpstreamSectionKeys(fixture)).toEqual(["a", "b"]);
  });

  it("throws (does not loop) when an unclosed string runs to end-of-source", () => {
    // Defensive: if upstream parser.js is truncated mid-string, the
    // walker must exit cleanly with the "SECTIONS array not closed"
    // signal rather than spin forever.
    const fixture = `const SECTIONS = [
  { key: "a", aliases: ["unterminated
];`;
    expect(() => extractUpstreamSectionKeys(fixture)).toThrow(/SECTIONS array not closed/);
  });

  it("handles all three string-delimiter styles (single, double, template)", () => {
    const fixture = `const SECTIONS = [
  { key: "a", aliases: ['single ] quote'] },
  { key: "b", aliases: [\`template ] backtick\`] },
  { key: "c" },
];`;
    expect(extractUpstreamSectionKeys(fixture)).toEqual(["a", "b", "c"]);
  });

  it("does NOT mistake an apostrophe in a // line comment for a string opener (task 798d7173)", () => {
    // Regression: the published 0.4.0 parser.js carries a JSDoc-ish //
    // comment inside the SECTIONS slice with the apostrophe in "Section
    // 10's numbering". A walker that did not honor JS comments treated
    // the apostrophe as a single-quoted string opener, swallowed the
    // closing `]`, and reported a false "layout changed" error,
    // blocking the harness-side bump PR until the walker was fixed.
    const fixture = `const SECTIONS = [
  // Section 10's numbering aligns with the prompt's structure.
  { key: "a", aliases: ["foo"] },
  { key: "b" },
];`;
    expect(extractUpstreamSectionKeys(fixture)).toEqual(["a", "b"]);
  });

  it("does NOT mistake a backtick in a // line comment for a template-literal opener", () => {
    // Companion to the apostrophe case: the upstream comment also uses
    // backticks around code spans (e.g. `# Understanding Report`). Same
    // class of failure as the apostrophe case.
    const fixture = `const SECTIONS = [
  // The \`# Understanding Report\` heading is required.
  { key: "a" },
  { key: "b" },
];`;
    expect(extractUpstreamSectionKeys(fixture)).toEqual(["a", "b"]);
  });

  it("does NOT mistake a quote in a /* block comment */ for a string opener", () => {
    const fixture = `const SECTIONS = [
  /* The agent's report should be precise. */
  { key: "a" },
  { key: "b" },
];`;
    expect(extractUpstreamSectionKeys(fixture)).toEqual(["a", "b"]);
  });

  it("does NOT treat a `]` inside a // line comment as the array closer", () => {
    // Generalised bug class: a walker-significant token (`]`) inside a
    // comment must be opaque. The apostrophe / backtick cases above pin
    // the string-opener side; this pins the bracket-depth side.
    const fixture = `const SECTIONS = [
  // aliases would close here: ] (but they shouldn't)
  { key: "a", aliases: ["foo"] },
  { key: "b" },
];`;
    expect(extractUpstreamSectionKeys(fixture)).toEqual(["a", "b"]);
  });

  it("does NOT treat a `]` inside a /* block comment */ as the array closer", () => {
    const fixture = `const SECTIONS = [
  /* a stray ] in here would be ignored */
  { key: "a" },
  { key: "b" },
];`;
    expect(extractUpstreamSectionKeys(fixture)).toEqual(["a", "b"]);
  });
});

describe("diffKeys", () => {
  it("returns null on identical lists in identical order", () => {
    expect(diffKeys(["a", "b", "c"], ["a", "b", "c"])).toBeNull();
  });

  it("flags an order mismatch when sets are equal but sequence differs", () => {
    const diff = diffKeys(["a", "b", "c"], ["c", "b", "a"]);
    expect(diff).not.toBeNull();
    expect(diff!.orderMismatch).toBe(true);
    expect(diff!.onlyLocal).toEqual([]);
    expect(diff!.onlyUpstream).toEqual([]);
  });

  it("reports upstream additions (local missing)", () => {
    const diff = diffKeys(["a", "b"], ["a", "b", "c"]);
    expect(diff!.onlyUpstream).toEqual(["c"]);
    expect(diff!.onlyLocal).toEqual([]);
    expect(diff!.orderMismatch).toBe(false);
  });

  it("reports upstream removals (local stale)", () => {
    const diff = diffKeys(["a", "b", "x"], ["a", "b"]);
    expect(diff!.onlyLocal).toEqual(["x"]);
    expect(diff!.onlyUpstream).toEqual([]);
    expect(diff!.orderMismatch).toBe(false);
  });

  it("reports both additions and removals in the same drift", () => {
    const diff = diffKeys(["a", "stale"], ["a", "new"]);
    expect(diff!.onlyLocal).toEqual(["stale"]);
    expect(diff!.onlyUpstream).toEqual(["new"]);
  });
});

describe("loadHarnessMirror", () => {
  // The mirror loader resolves against `process.cwd()`. We point cwd at
  // an empty tmpdir so the precheck fires and emits the build-hint
  // instead of falling through to a generic ESM import error.
  let originalCwd: string;
  let tmpDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), "ug-drift-mirror-"));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("throws an actionable build-hint when the dist mirror module is missing (task a7e9a9e8)", async () => {
    await expect(loadHarnessMirror()).rejects.toThrow(/npm run build/);
  });

  it("names the expected dist path in the build-hint so the operator can see what was missed", async () => {
    await expect(loadHarnessMirror()).rejects.toThrow(
      /dist\/cli\/pack\/understanding-report-schema-hint\.js/,
    );
  });
});
