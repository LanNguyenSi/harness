import { describe, expect, it } from "vitest";
import { escapeForDisplay } from "../../src/io/display-path.js";
import { sanitizeEnvelopeReason } from "../../src/runtime/index.js";

const cp = (n: number): string => String.fromCodePoint(n);

// Both callers are pinned on the same characters, so a drift between the
// display escaper and the envelope sanitiser fails here.
// [name, code point, display escape, envelope escape]
const SHARED: Array<[string, number, string, string]> = [
  ["variation selector 16", 0xfe0f, "\\ufe0f", "\\u{fe0f}"],
  ["Hangul filler U+3164", 0x3164, "\\u3164", "\\u{3164}"],
  ["Hangul choseong filler U+115F", 0x115f, "\\u115f", "\\u{115f}"],
  ["tag latin capital A", 0xe0041, "\\udb40\\udc41", "\\u{e0041}"],
  ["right-to-left override", 0x202e, "\\u202e", "\\u{202e}"],
];

describe("shared invisible-character rule", () => {
  for (const [name, n, displayEscape, envelopeEscape] of SHARED) {
    it(`escapeForDisplay escapes ${name}`, () => {
      const original = `a${cp(n)}b`;
      const out = escapeForDisplay(original);
      expect(out).toBe(`"a${displayEscape}b"`);
      expect(JSON.parse(out)).toBe(original);
    });

    it(`sanitizeEnvelopeReason escapes ${name}`, () => {
      expect(sanitizeEnvelopeReason(`a${cp(n)}b`)).toBe(`a${envelopeEscape}b`);
    });
  }

  it("escapeForDisplay escapes the zero width joiner (file-name identity)", () => {
    expect(escapeForDisplay(`a${cp(0x200d)}b`)).toBe('"a\\u200db"');
  });

  it("sanitizeEnvelopeReason keeps the zero width joiner (emoji sequences)", () => {
    expect(sanitizeEnvelopeReason(`a${cp(0x200d)}b`)).toBe(`a${cp(0x200d)}b`);
  });
});
