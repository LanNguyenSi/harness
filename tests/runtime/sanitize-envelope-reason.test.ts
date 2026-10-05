import { describe, expect, it } from "vitest";
import { sanitizeEnvelopeReason } from "../../src/runtime/index.js";

const cp = (n: number): string => String.fromCodePoint(n);
const esc = (n: number): string => `\\u{${n.toString(16).padStart(4, "0")}}`;

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let n = from; n <= to; n++) out.push(n);
  return out;
}

// Each class is tested on its own so removing one class from the sanitiser
// fails exactly one describe block.
const CLASSES: Record<string, number[]> = {
  "C1 controls (U+0080-U+009F)": range(0x80, 0x9f),
  "line and paragraph separators (U+2028, U+2029)": [0x2028, 0x2029],
  "bidi embedding and override controls (U+202A-U+202E)": range(0x202a, 0x202e),
  "bidi isolates (U+2066-U+2069)": range(0x2066, 0x2069),
  "bidi marks (U+200E, U+200F, U+061C)": [0x200e, 0x200f, 0x061c],
};

describe("sanitizeEnvelopeReason: escaped character classes", () => {
  for (const [name, points] of Object.entries(CLASSES)) {
    describe(name, () => {
      for (const n of points) {
        it(`escapes U+${n.toString(16).toUpperCase().padStart(4, "0")}`, () => {
          const out = sanitizeEnvelopeReason(`a${cp(n)}b`);
          expect(out).toBe(`a${esc(n)}b`);
          expect(out).not.toContain(cp(n));
        });
      }
    });
  }

  it("leaves no character of any class in a combined hostile string", () => {
    const all = Object.values(CLASSES).flat();
    // 20 escapes of 8 characters stay under the 200-character bound.
    for (let i = 0; i < all.length; i += 20) {
      const chunk = all.slice(i, i + 20);
      const out = sanitizeEnvelopeReason(`x${chunk.map(cp).join("")}y`);
      for (const n of chunk) expect(out).not.toContain(cp(n));
      expect(out.startsWith("x")).toBe(true);
      expect(out.endsWith("y")).toBe(true);
    }
  });
});

describe("sanitizeEnvelopeReason: unchanged behaviour", () => {
  it("collapses a run of C0 and DEL characters to one space", () => {
    const run = `${String.fromCharCode(0)}${String.fromCharCode(27)}${String.fromCharCode(127)}`;
    expect(sanitizeEnvelopeReason(`a${run}b`)).toBe("a b");
  });

  it("keeps printable non-ASCII text", () => {
    const text = "München 中文 \u{1F600} café  ¡ ÿ Ā ​";
    expect(sanitizeEnvelopeReason(text)).toBe(text);
  });

  it("keeps the characters just outside each escaped range", () => {
    for (const n of [0x7f + 0x21, 0xa0, 0x2027, 0x202f, 0x2065, 0x206a, 0x200d, 0x0610]) {
      expect(sanitizeEnvelopeReason(`a${cp(n)}b`)).toBe(`a${cp(n)}b`);
    }
  });
});

describe("sanitizeEnvelopeReason: truncation", () => {
  it("returns a string of exactly 200 characters untouched", () => {
    const s = "a".repeat(200);
    expect(sanitizeEnvelopeReason(s)).toBe(s);
  });

  it("truncates a longer string to 200 characters plus an ellipsis", () => {
    expect(sanitizeEnvelopeReason("a".repeat(201))).toBe(`${"a".repeat(200)}...`);
  });

  it("never cuts an escape sequence in half", () => {
    const e = esc(0x202e);
    // Fill so that the escape would straddle the 200 boundary at every offset.
    for (let pad = 190; pad <= 200; pad++) {
      const out = sanitizeEnvelopeReason(`${"a".repeat(pad)}${cp(0x202e)}${"b".repeat(50)}`);
      expect(out.endsWith("...")).toBe(true);
      const body = out.slice(0, -3);
      expect(body.length).toBeLessThanOrEqual(200);
      // Every backslash in the body belongs to a whole escape.
      const stripped = body.split(e).join("");
      expect(stripped).not.toContain("\\");
      expect(stripped).not.toContain("{");
    }
  });

  it("counts the expanded escape toward the 200 bound", () => {
    const out = sanitizeEnvelopeReason(cp(0x2028).repeat(100));
    expect(out.slice(0, -3).length).toBeLessThanOrEqual(200);
    expect(out.endsWith("...")).toBe(true);
    expect(out.slice(0, -3)).toBe(esc(0x2028).repeat(Math.floor(200 / esc(0x2028).length)));
  });

  it("never splits a surrogate pair at the boundary", () => {
    const emoji = cp(0x1f600);
    for (const pad of [197, 198, 199, 200]) {
      const out = sanitizeEnvelopeReason(`${"a".repeat(pad)}${emoji}${emoji}`);
      const body = out.slice(0, -3);
      expect(body.length).toBeLessThanOrEqual(200);
      // A well-formed string round-trips through UTF-16 encoding unchanged.
      expect(Buffer.from(body, "utf8").toString("utf8")).toBe(body);
    }
  });
});
