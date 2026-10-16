import { describe, expect, it } from "vitest";
import { BLOCK_TEXT_MAX_BYTES, boundUtf8 } from "../../src/runtime/bounded-text.js";

describe("boundUtf8", () => {
  it("returns a text that fits unchanged, at the limit included", () => {
    expect(boundUtf8("short", 10)).toBe("short");
    expect(boundUtf8("0123456789", 10)).toBe("0123456789");
    expect(boundUtf8("")).toBe("");
  });

  it("cuts an ASCII text at the limit and names the exact dropped byte count", () => {
    const out = boundUtf8("a".repeat(30), 10);
    expect(out).toBe(`${"a".repeat(10)}\n[truncated 20 bytes]`);
  });

  it("counts UTF-8 bytes, not UTF-16 units", () => {
    // 100 two-byte characters are 200 bytes but 100 UTF-16 units.
    const out = boundUtf8("é".repeat(100), 50);
    expect(out).toBe(`${"é".repeat(25)}\n[truncated 150 bytes]`);
  });

  it("never splits a multi-byte character: it drops the straddling character whole", () => {
    // Limit 11 falls inside the sixth two-byte character after ten ASCII-width bytes.
    const text = "é".repeat(20);
    const out = boundUtf8(text, 11);
    const [kept] = out.split("\n[truncated");
    expect(kept).toBe("é".repeat(5));
    expect(kept).not.toContain("�");
    expect(out).toMatch(/\[truncated 30 bytes\]$/);
  });

  it("never splits a four-byte character or a surrogate pair", () => {
    const text = "a\u{1f600}\u{1f600}\u{1f600}";
    for (let limit = 1; limit < 13; limit += 1) {
      const out = boundUtf8(text, limit);
      const kept = out.split("\n[truncated")[0]!;
      expect(kept).not.toContain("�");
      expect(Buffer.byteLength(kept)).toBeLessThanOrEqual(limit);
      const dropped = Number(/\[truncated (\d+) bytes\]/.exec(out)![1]);
      expect(Buffer.byteLength(kept) + dropped).toBe(Buffer.byteLength(text));
    }
  });

  it("uses a fixed default cap", () => {
    expect(BLOCK_TEXT_MAX_BYTES).toBe(4096);
    const out = boundUtf8("b".repeat(BLOCK_TEXT_MAX_BYTES + 7));
    expect(out).toBe(`${"b".repeat(BLOCK_TEXT_MAX_BYTES)}\n[truncated 7 bytes]`);
  });
});
