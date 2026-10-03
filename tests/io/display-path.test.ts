import { describe, expect, it } from "vitest";
import { escapeForDisplay } from "../../src/io/display-path.js";

function unsafeCodes(text: string): number[] {
  return [...text]
    .map((ch) => ch.charCodeAt(0))
    .filter((c) => c < 0x20 || (c >= 0x7f && c <= 0x9f));
}

describe("escapeForDisplay", () => {
  it("quotes a plain path and leaves it readable", () => {
    expect(escapeForDisplay("/tmp/reports/r1.json")).toBe('"/tmp/reports/r1.json"');
  });

  it("escapes C0 controls, DEL and every C1 control instead of stripping them", () => {
    const hostile = "a\u001b]52;c;Zm9v\u0007\r\nb\u007fc\u0080d\u009be\u009ff";
    const out = escapeForDisplay(hostile);
    expect(unsafeCodes(out)).toEqual([]);
    expect(out).toContain("\\u001b]52;c;Zm9v\\u0007\\r\\n");
    expect(out).toContain("\\u007f");
    expect(out).toContain("\\u0080");
    expect(out).toContain("\\u009b");
    expect(out).toContain("\\u009f");
    // Escaped, not stripped: the literal parses back to the original.
    expect(JSON.parse(out)).toBe(hostile);
  });

  it("escapes the quote and the backslash so the literal stays one token", () => {
    expect(escapeForDisplay('a"b\\c')).toBe('"a\\"b\\\\c"');
  });

  it("covers the full control range, byte by byte", () => {
    for (let code = 0; code < 0xa0; code++) {
      if (code >= 0x20 && code < 0x7f) continue;
      expect(unsafeCodes(escapeForDisplay(`x${String.fromCharCode(code)}y`)), `U+${code.toString(16)}`).toEqual([]);
    }
  });

  it.each([
    ["bidi override", "\u202e", "\\u202e"],
    ["zero-width space", "\u200b", "\\u200b"],
    ["byte-order mark", "\ufeff", "\\ufeff"],
    ["line separator", "\u2028", "\\u2028"],
    ["paragraph separator", "\u2029", "\\u2029"],
    ["supplementary language tag", "\u{e0001}", "\\udb40\\udc01"],
  ])("escapes %s as UTF-16 JSON escapes", (_name, character, escaped) => {
    const original = `before${character}after`;
    const output = escapeForDisplay(original);
    expect(output).toBe(`"before${escaped}after"`);
    expect(output).not.toMatch(/[\p{Cf}\u2028\u2029]/u);
    expect(JSON.parse(output)).toBe(original);
  });
});
