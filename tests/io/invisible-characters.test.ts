import { describe, expect, it } from "vitest";
import { escapeForDisplay } from "../../src/io/display-path.js";

const cp = (n: number): string => String.fromCodePoint(n);

// The display escaper builds its pattern from the shared invisible-character
// rule (src/io/invisible-characters.ts), so a drift in the rule fails here.
// [name, code point, display escape]
const SHARED: Array<[string, number, string]> = [
  ["variation selector 16", 0xfe0f, "\\ufe0f"],
  ["Hangul filler U+3164", 0x3164, "\\u3164"],
  ["Hangul choseong filler U+115F", 0x115f, "\\u115f"],
  ["tag latin capital A", 0xe0041, "\\udb40\\udc41"],
  ["variation selector 17 U+E0100 (Default_Ignorable, not Cf)", 0xe0100, "\\udb40\\udd00"],
  ["right-to-left override", 0x202e, "\\u202e"],
];

describe("shared invisible-character rule", () => {
  for (const [name, n, displayEscape] of SHARED) {
    it(`escapeForDisplay escapes ${name}`, () => {
      const original = `a${cp(n)}b`;
      const out = escapeForDisplay(original);
      expect(out).toBe(`"a${displayEscape}b"`);
      expect(JSON.parse(out)).toBe(original);
    });
  }

  it("escapeForDisplay escapes the zero width joiner (file-name identity)", () => {
    expect(escapeForDisplay(`a${cp(0x200d)}b`)).toBe('"a\\u200db"');
  });
});
