import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectTestSourceFiles, findOnlyViolations } from "../../scripts/check-no-only.mjs";

describe("findOnlyViolations", () => {
  it("flags describe.only(...)", () => {
    const violations = findOnlyViolations(`describe.only("suite", () => {});`);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.holder).toBe("describe");
  });

  it("flags it.only(...)", () => {
    const violations = findOnlyViolations(`it.only("case", () => {});`);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.holder).toBe("it");
  });

  it("flags test.only(...)", () => {
    const violations = findOnlyViolations(`test.only("case", () => {});`);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.holder).toBe("test");
  });

  it("flags the .each variants: it.only.each / describe.only.each / test.only.each", () => {
    expect(findOnlyViolations(`it.only.each([1, 2])("case %i", (n) => {});`)).toHaveLength(1);
    expect(findOnlyViolations(`describe.only.each([1, 2])("suite %i", (n) => {});`)).toHaveLength(1);
    expect(findOnlyViolations(`test.only.each([1, 2])("case %i", (n) => {});`)).toHaveLength(1);
  });

  it("flags a whitespace variant before the call parens (it.only (...))", () => {
    const violations = findOnlyViolations(`it.only ("case", () => {});`);
    expect(violations).toHaveLength(1);
  });

  it("flags .only reached through a chained modifier (describe.concurrent.only)", () => {
    const violations = findOnlyViolations(`describe.concurrent.only("suite", () => {});`);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.holder).toBe("describe");
  });

  it("flags a nested it.only inside a describe block, with a plausible line number", () => {
    const source = ['describe("outer", () => {', '  it.only("inner", () => {});', "});"].join("\n");
    const violations = findOnlyViolations(source);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(2);
  });

  it("does NOT flag .only occurring inside a double- or single-quoted string literal", () => {
    expect(findOnlyViolations(`const msg = "call it.only(...) to isolate";`)).toHaveLength(0);
    expect(findOnlyViolations(`const msg = 'call it.only(...) to isolate';`)).toHaveLength(0);
  });

  it("does NOT flag .only occurring inside a template literal", () => {
    const violations = findOnlyViolations("const msg = `see it.only(...) in the docs`;");
    expect(violations).toHaveLength(0);
  });

  it("does NOT flag .only occurring inside a line or block comment", () => {
    expect(
      findOnlyViolations(
        ["// TODO: do not use it.only(...) here", 'it("case", () => {});'].join("\n"),
      ),
    ).toHaveLength(0);
    expect(
      findOnlyViolations(["/* reminder: describe.only(...) is banned */", 'it("case", () => {});'].join("\n")),
    ).toHaveLength(0);
  });

  it("does NOT flag a test NAME string that happens to contain the literal text it.only(", () => {
    const violations = findOnlyViolations(
      `it("regex matches the literal text it.only( in source", () => { expect(true).toBe(true); });`,
    );
    expect(violations).toHaveLength(0);
  });

  it("does NOT flag .only on an identifier that is not describe/it/test", () => {
    expect(findOnlyViolations(`foo.only();`)).toHaveLength(0);
    expect(findOnlyViolations(`config.only = true;`)).toHaveLength(0);
  });

  it("does NOT flag .only reached from a call result rather than a bare identifier", () => {
    // e.g. some unrelated builder API — not a describe/it/test chain at all.
    expect(findOnlyViolations(`getSuite().only();`)).toHaveLength(0);
  });
});

describe("collectTestSourceFiles", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "harness-check-no-only-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("recurses into subdirectories and filters to .ts/.mts/.cts files", () => {
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(join(dir, "top.test.ts"), 'it("x", () => {});');
    writeFileSync(join(dir, "nested", "inner.test.ts"), 'it("y", () => {});');
    writeFileSync(join(dir, "nested", "helper.mts"), "export {};");
    writeFileSync(join(dir, "notes.md"), "not a source file");
    writeFileSync(join(dir, "fixture.json"), "{}");

    const files = collectTestSourceFiles(dir).sort();

    expect(files).toEqual(
      [join(dir, "nested", "helper.mts"), join(dir, "nested", "inner.test.ts"), join(dir, "top.test.ts")].sort(),
    );
  });
});
