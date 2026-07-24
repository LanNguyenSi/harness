import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectTestSourceFiles, findOnlyViolations, main } from "../../scripts/check-no-only.mjs";

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

  // vitest's documented TestOptions second-positional-argument form
  // (`it(name, { only: true }, fn)`) is an independent way to activate
  // only-mode — it does not go through a `.only` PropertyAccessExpression
  // at all, so shape (1) above cannot see it. Empirically confirmed (task
  // b4845053 review) to defeat the hermetic-spawn backstop the same way
  // `it.only(...)` does.
  it("flags the options-object form { only: true } for describe/it/test", () => {
    expect(findOnlyViolations(`it("case", { only: true }, () => {});`)).toHaveLength(1);
    expect(findOnlyViolations(`test("case", { only: true }, () => {});`)).toHaveLength(1);
    expect(findOnlyViolations(`describe("suite", { only: true }, () => {});`)).toHaveLength(1);
    const violations = findOnlyViolations(`it("case", { only: true }, () => {});`);
    expect(violations[0]?.holder).toBe("it");
    expect(violations[0]?.kind).toBe("options-object");
  });

  it("does NOT flag the options-object form when only is false", () => {
    expect(findOnlyViolations(`it("case", { only: false }, () => {});`)).toHaveLength(0);
  });

  it("does NOT flag only:true in a non-options (3rd+) argument position", () => {
    expect(findOnlyViolations(`it("case", () => {}, { only: true });`)).toHaveLength(0);
  });

  it("does NOT flag only:true in the 2nd-arg options object of a non-test call", () => {
    expect(findOnlyViolations(`configure("case", { only: true });`)).toHaveLength(0);
  });

  it("does NOT flag only:true nested inside another 2nd-arg property (no nested-object scan)", () => {
    expect(findOnlyViolations(`it("case", { retry: { only: true } }, () => {});`)).toHaveLength(0);
  });

  it("does NOT flag only bound to a non-literal value (only: someVar)", () => {
    expect(findOnlyViolations(`const someVar = true; it("case", { only: someVar }, () => {});`)).toHaveLength(0);
  });

  it("does NOT flag a shorthand { only } property (value not statically true)", () => {
    expect(findOnlyViolations(`const only = true; it("case", { only }, () => {});`)).toHaveLength(0);
  });

  it("does NOT flag a computed-key { [only]: true } property", () => {
    expect(findOnlyViolations(`const only = "only"; it("case", { [only]: true }, () => {});`)).toHaveLength(0);
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

// CLI-level coverage of main(): calls it in-process against a temp fixture
// directory (no subprocess spawn — the hermetic-spawn allowlist backstop
// this gate exists to protect is deliberately not exercised or touched
// here) and inspects console output + process.exitCode instead of
// shelling out to `node scripts/check-no-only.mjs` a second time.
describe("main", () => {
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "harness-check-no-only-main-"));
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    logSpy.mockRestore();
    errorSpy.mockRestore();
    // main() communicates failure via process.exitCode (not process.exit)
    // precisely so it stays testable in-process; reset it here so a
    // failure-path test does not leak a non-zero exit code into the real
    // vitest process running this suite.
    process.exitCode = undefined;
  });

  it("on a clean directory: does not set exitCode and logs an OK summary", () => {
    writeFileSync(join(dir, "clean.test.ts"), 'import { it } from "vitest";\nit("case", () => {});\n');

    main(dir);

    expect(process.exitCode).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("check-no-only: OK"));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("on a directory with a committed .only: sets exitCode 1 and prints file:line:col — committed ...", () => {
    const file = join(dir, "bad.test.ts");
    writeFileSync(file, 'import { it } from "vitest";\n\nit.only("case", () => {});\n');

    main(dir);

    expect(process.exitCode).toBe(1);
    const errorOutput = errorSpy.mock.calls.map((callArgs: unknown[]) => callArgs.join(" ")).join("\n");
    expect(errorOutput).toContain(`${file}:3:4 — committed \`it.only\``);
    expect(errorOutput).toContain("check-no-only: FAIL");
  });
});
