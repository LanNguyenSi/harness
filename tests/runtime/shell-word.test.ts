import { describe, expect, it } from "vitest";
import { decodeShellWord, hasAnsiCNulEscape } from "../../src/runtime/shell-word.js";

// Task fdee7d0f. Every expectation below is bash's own answer, obtained by
// running `printf '%s' <word>` in a real shell (through `od -c` where the
// result contains non-printing bytes) — not by reading the implementation
// back to itself.
//
// That claim has failed twice on escape edges, both times because I asserted
// what I expected bash to do instead of running it: `$'\0144elete'` (octal
// digit count) and `$'\xz'` (whether the backslash survives). Both are now
// the measured values and carry their od -c evidence inline. Treat any new
// escape case here as unverified until it has been run.

describe("decodeShellWord — literal words pass through", () => {
  it.each(["-delete", "--output=out.txt", "data.txt", "", "-o", "sort"])(
    "leaves %s unchanged",
    (w) => {
      expect(decodeShellWord(w)).toBe(w);
    },
  );
});

describe("decodeShellWord — the measured bypass spellings", () => {
  // The five `find` spellings that really deleted while classifying
  // read-only, plus the two long-flag spellings found on sort/file.
  it.each([
    ['-"delete"', "-delete"],
    ["-'delete'", "-delete"],
    ["-\\delete", "-delete"],
    ["-$'delete'", "-delete"],
    ['-de"lete"', "-delete"],
    ['--"output"=out.txt', "--output=out.txt"],
    ['--outp"ut"=out.txt', "--output=out.txt"],
    ['--"compile"', "--compile"],
  ])("decodes %s to %s", (raw, expected) => {
    expect(decodeShellWord(raw)).toBe(expected);
  });
});

describe("decodeShellWord — ANSI-C escapes", () => {
  it.each([
    ["$'\\x64elete'", "delete"], // \xHH
    ["$'\\144elete'", "delete"], // \NNN octal
    // At most THREE octal digits are consumed, the leading zero being one
    // of them: `\0144` is `\014` (form feed) followed by a literal `4`.
    // Measured against bash (`printf '%s' $'\0144elete'` → `^L4elete`);
    // an earlier version of this case asserted "delete" and was wrong
    // about bash, not about the implementation.
    ["$'\\0144elete'", "\f4elete"],
    ["$'a\\tb'", "a\tb"],
    ["$'a\\nb'", "a\nb"],
    ["$'\\\\'", "\\"],
    ["$'\\''", "'"],
    ["$'\\u0064'", "d"],
    ["$'\\U00000064'", "d"],
  ])("decodes %s", (raw, expected) => {
    expect(decodeShellWord(raw)).toBe(expected);
  });

  it("keeps an unrecognised ANSI-C escape's backslash, as bash does", () => {
    expect(decodeShellWord("$'\\q'")).toBe("\\q");
  });

  it("keeps the backslash on a hex escape with no digits, as bash does", () => {
    // `printf '%s' $'\xz' | od -c` -> `\  x  z` (3 chars). An earlier
    // version of this case asserted "xz" and was wrong about bash, which is
    // the second time this file's provenance claim failed on an escape edge.
    expect(decodeShellWord("$'\\xz'")).toBe("\\xz");
  });
});

describe("decodeShellWord — double quotes escape only a small set", () => {
  it.each([
    ['"a\\$b"', "a$b"],
    ['"a\\`b"', "a`b"],
    ['"a\\"b"', 'a"b'],
    ['"a\\\\b"', "a\\b"],
  ])("decodes %s", (raw, expected) => {
    expect(decodeShellWord(raw)).toBe(expected);
  });

  it("keeps a backslash that does not precede an escapable character", () => {
    // Inside double quotes bash leaves `\d` as a literal backslash + d.
    expect(decodeShellWord('"a\\db"')).toBe("a\\db");
  });
});

describe("decodeShellWord — concatenation of runs within one word", () => {
  it.each([
    ["a'b'c", "abc"],
    ["'a'\"b\"c", "abc"],
    ["$'a'\"b\"'c'", "abc"],
    ["-'de'\"le\"$'te'", "-delete"],
  ])("decodes %s", (raw, expected) => {
    expect(decodeShellWord(raw)).toBe(expected);
  });
});

// The fallback is what makes the module-header direction rule mechanical
// rather than aspirational: an unresolvable word decodes to itself, so a
// caller comparing against a reject-set reproduces today's behaviour
// instead of inventing one.
describe("decodeShellWord — unresolvable words fall back to the raw token", () => {
  it.each([
    "'unterminated",
    '"unterminated',
    "$'unterminated",
    "trailing\\",
  ])("returns %s unchanged", (raw) => {
    expect(decodeShellWord(raw)).toBe(raw);
  });

  it("never throws on hostile input", () => {
    for (const w of ["\\", "'", '"', "$'", "$", "''", '""', "$''"]) {
      expect(() => decodeShellWord(w)).not.toThrow();
    }
  });
});

describe("decodeShellWord — $\"...\" locale quoting", () => {
  // With no translation catalog bash returns the contents unchanged with the
  // quotes removed, so it decodes exactly like a double-quoted run.
  // Measured: `printf '%s' -$"delete"` -> `-delete`.
  it.each([
    ['$"delete"', "delete"],
    ['-$"delete"', "-delete"],
    ['--$"compile"', "--compile"],
    ['--outp$"ut"=o.txt', "--output=o.txt"],
  ])("decodes %s to %s", (raw, expected) => {
    expect(decodeShellWord(raw)).toBe(expected);
  });

  it("falls back to the raw word on an unterminated locale quote", () => {
    expect(decodeShellWord('$"unterminated')).toBe('$"unterminated');
  });
});

describe("decodeShellWord — the catch path keeps the never-throws guarantee", () => {
  // String.fromCodePoint throws RangeError above U+10FFFF, so the guarantee
  // must hold through the THROW, not only through the null-return path.
  // Without this the `catch` could be replaced by `return ""` unnoticed.
  it.each(["$'\\UFFFFFFFF'", "$'\\U110000'"])(
    "returns %s unchanged instead of throwing",
    (raw) => {
      expect(() => decodeShellWord(raw)).not.toThrow();
      expect(decodeShellWord(raw)).toBe(raw);
    },
  );
});

describe("decodeShellWord — expansions are deliberately NOT performed", () => {
  // Their values are not derivable from the command text, so the honest
  // answer keeps them verbatim. A caller must not read a decoded word as
  // "this is what the process will see" when it contains one of these.
  it.each(["$VAR", "$(date)", "`date`", "~/x", "*.txt", "{a,b}"])(
    "leaves %s untouched",
    (w) => {
      expect(decodeShellWord(w)).toBe(w);
    },
  );
});

// Task 241d9e9e. NUL-decoding escapes inside `$'...'` are NOT modelled: bash
// (GNU bash 3.2.57 on this machine, `printf '[%s]' <word> | od -c`) truncates
// a run at a NUL, and this module deliberately does not rebuild that rule.
// `decodeShellWord` keeps decoding such a word the way it always did (a
// literal U+0000 where the escape stands), because the deny-side callers
// match prefixes and short-flag clusters of that value. `hasAnsiCNulEscape`
// lets a caller refuse the whole command text; the read-only classifier does.

// One word per NUL spelling, each placed at the end of a run, between two
// runs and inside a run. `\u`/`\U` are not decoded by bash 3.2.57 (they stay
// literal there; bash 4.2 and later decode them), so they are included only
// because the predicate must over-report rather than under-report.
const NUL_WORDS: ReadonlyArray<string> = [
  "$'-delete\\0XYZ'",
  "-$'\\0'delete",
  "-$'\\x00'delete",
  "$'-delete\\000x'",
  "$'-delete\\u0000x'",
  "$'-delete\\U00000000x'",
  "$'-delete\\0'",
  "$'-del'$'\\0'$'ete'",
  "$'-del\\0ete'",
  "$'-del\\00ete'",
  "$'-del\\x0-ete'",
  "$'-del\\u0-ete'",
  "$'-del\\U0-ete'",
  "$'-dele\\c@x'te",
  "$'-dele\\c x'te",
  "$'-dele\\c`x'te",
  "$'-del\\400ete'",
];

describe("hasAnsiCNulEscape (task 241d9e9e)", () => {
  it.each(NUL_WORDS)("is true for %s", (w) => {
    expect(hasAnsiCNulEscape(w)).toBe(true);
  });

  it.each(NUL_WORDS)("is true when %s sits inside a longer command", (w) => {
    expect(hasAnsiCNulEscape(`find . -name c ${w} x`)).toBe(true);
  });

  it("finds a NUL escape behind a single-quoted dollar sign", () => {
    // `'$'` is a quoted dollar, the real run starts at the second `$'`; a
    // scan that resumed after the first false run would miss it.
    expect(hasAnsiCNulEscape("echo '$'$'\\0'")).toBe(true);
  });

  it.each([
    "$'\\x64elete'",
    "$'\\101'",
    "$'\\x41'",
    "$'\\u0041'",
    "$'\\U00000041'",
    "$'\\x4'",
    "$'\\n\\t\\\\0'",
    "$'\\xz'",
    "$'plain'",
    "-delete",
    "--output=out.txt",
    "'\\0'",
    '"\\0"',
    "\\0",
    "",
  ])("is false for %s", (w) => {
    expect(hasAnsiCNulEscape(w)).toBe(false);
  });

  it("never throws on odd input", () => {
    expect(() => hasAnsiCNulEscape("$'\\")).not.toThrow();
    expect(() => hasAnsiCNulEscape("$'")).not.toThrow();
    expect(hasAnsiCNulEscape("$'")).toBe(false);
  });
});

// Values decodeShellWord returned for these words before the NUL predicate
// existed; they are pinned so the decoder stays what the deny-side callers
// were built against (see destructive-shell-floor.test.ts and
// deletion-target-resolve.test.ts for the consumer verdicts).
describe("decodeShellWord keeps its decoding for a NUL escape (task 241d9e9e)", () => {
  it.each([
    ["$'-delete\\0XYZ'", "-delete\u0000XYZ"],
    ["-$'\\0'delete", "-\u0000delete"],
    ["-$'\\x00'delete", "-\u0000delete"],
    ["$'-delete\\000x'", "-delete\u0000x"],
    ["$'-delete\\u0000x'", "-delete\u0000x"],
    ["$'-delete\\U00000000x'", "-delete\u0000x"],
    ["$'-del'$'\\0'$'ete'", "-del\u0000ete"],
    ["$'-del\\x0-ete'", "-del\u0000-ete"],
    ["$'of=/dev/sda\\0'", "of=/dev/sda\u0000"],
    ["$'-dele\\c@x'te", "-dele\\c@xte"],
    ["$'-dele\\c x'te", "-dele\\c xte"],
    ["$'-f\\c@'", "-f\\c@"],
  ])("decodes %s to the base value", (w, expected) => {
    expect(decodeShellWord(w)).toBe(expected);
  });

  it("still decodes the non-NUL spellings of the same words", () => {
    expect(decodeShellWord("-$'\\x64'elete")).toBe("-delete");
    expect(decodeShellWord("$'-\\144elete'")).toBe("-delete");
  });
});
