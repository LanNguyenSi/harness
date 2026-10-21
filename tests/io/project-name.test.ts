import { describe, expect, it } from "vitest";
import { isValidProjectName, sanitizeProjectForDisplay } from "../../src/io/project-name.js";

describe("sanitizeProjectForDisplay (task e904f25a)", () => {
  it("strips control characters a project name can legally carry into rendered output", () => {
    // Both of these are REJECTED by isValidProjectName (the first for its
    // newline, the second for its separator and its escape) and are still
    // echoed back to the operator, which is the case this helper exists
    // for.
    expect(sanitizeProjectForDisplay("ok\n  ⚠ forged")).toBe("ok  ⚠ forged");
    expect(sanitizeProjectForDisplay("a/b\u001b[31m")).toBe("a/b[31m");
    // C0, DEL and C1 alike; a bare carriage return would overwrite the
    // line it was rendered on.
    expect(sanitizeProjectForDisplay("a\rb\u0000c\u007fd\u0085e")).toBe("abcde");
  });

  it("passes an ordinary name through byte-identically", () => {
    for (const name of ["myproj", "..", ".", "a/b", "a\\b", "with space", "ümläut"]) {
      expect(sanitizeProjectForDisplay(name)).toBe(name);
    }
  });
});

describe("isValidProjectName: control characters (task e904f25a)", () => {
  it("rejects a name carrying a control character, so no sink and no renderer downstream ever sees one", () => {
    // Rejecting at the SOURCE, rather than escaping at each rendering
    // site, is what makes this a property of the value: it also covers
    // the surfaces that render the SUBSTITUTED memory directory path
    // rather than the name itself (doctor's "memory directory missing"
    // line, list memories' `path` row field).
    expect(isValidProjectName("proj\n  ⚠ forged line")).toBe(false);
    expect(isValidProjectName("proj\u001b[31m")).toBe(false);
    expect(isValidProjectName("proj\u007f")).toBe(false);
    expect(isValidProjectName("proj\u0085junk")).toBe(false);
    // NUL is inside the same C0 range, so the screen covers it too.
    expect(isValidProjectName("proj\u0000x")).toBe(false);
    // A bare carriage return would overwrite the line it landed on.
    expect(isValidProjectName("proj\rforged")).toBe(false);
  });

  it("still accepts an ordinary name, including a space and non-ASCII letters", () => {
    for (const name of ["myproj", "with space", "ümläut", "my.proj", "a-b_c"]) {
      expect(isValidProjectName(name), name).toBe(true);
    }
  });

  it("keeps rejecting the path-escape shapes it always rejected", () => {
    for (const name of ["", ".", "..", "a/b", "a\\b"]) {
      expect(isValidProjectName(name), JSON.stringify(name)).toBe(false);
    }
  });

  it("is not stateful across calls (the validator and the display stripper are separate regex objects)", () => {
    // A single `g`-flagged regex shared by `test` and `replace` would
    // carry `lastIndex` between calls and alternate between hits and
    // misses on the same input.
    expect(isValidProjectName("proj\n  ⚠ forged line")).toBe(false);
    expect(isValidProjectName("proj\n  ⚠ forged line")).toBe(false);
    expect(sanitizeProjectForDisplay("a\nb")).toBe("ab");
    expect(sanitizeProjectForDisplay("a\nb")).toBe("ab");
  });
});
