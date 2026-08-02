// `decodeShellWord` — the shared "what literal value does bash see for this
// word?" primitive (task `fdee7d0f`).
//
// WHY THIS EXISTS: three consumers each carried their own partial model of
// shell quoting, and the same missing unquoting logic produced a separate
// bypass in each (`cf3dff51`, `b093911d`, `2dfdf472`). This module is the
// single source of truth for the decoding half of that; each consumer keeps
// its own decision about what a decoded value MEANS.
//
// DIRECTION RULE (binding, and the reason this module is allowed to exist
// at all). A hand-written partial model of another language's grammar is a
// design smell, and one was removed from this codebase on 2026-08-02 for
// exactly that reason (see the post-merge-gate blocker's
// `isGateEligibleCommand`). What separates the two is which side of a
// security boundary the model sits on:
//
//   - There, the model gated a PERMISSIVE decision: every construct it
//     failed to model became a silent pass-through, i.e. a new bypass.
//   - Here, callers use the decoded value on the RESTRICTIVE side — to
//     recognise MORE tokens as write flags, never fewer. An incomplete
//     decode therefore yields today's behaviour (a detection this codebase
//     already misses), never a new fail-open.
//
// A caller that wants to use this on the permissive side (to EXEMPT
// something) is outside the rule and must be measured on its own terms.
// `decodeShellWord` returns the RAW token unchanged for anything it cannot
// resolve, which keeps that guarantee mechanical rather than aspirational.
//
// SCOPE, deliberately narrow: quote removal and escape decoding only. No
// expansion of any kind — `$VAR`, `$(...)`, backticks, `~`, globs and
// brace expansion are left verbatim, because their values are not derivable
// from the command text alone. A word containing them decodes to something
// that still contains them, which is the honest answer.

/** Characters a backslash can escape inside a double-quoted run (bash). */
const DOUBLE_QUOTE_ESCAPABLE = new Set(['$', '`', '"', "\\", "\n"]);

/** Single-character ANSI-C (`$'...'`) escapes. */
const ANSI_C_SIMPLE: ReadonlyMap<string, string> = new Map([
  ["a", "\x07"],
  ["b", "\b"],
  ["e", "\x1b"],
  ["E", "\x1b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
  ["v", "\v"],
  ["\\", "\\"],
  ["'", "'"],
  ['"', '"'],
  ["?", "?"],
]);

/**
 * Decode one shell WORD to the literal string bash would pass as an argv
 * entry, as far as that is derivable from the text alone.
 *
 * Handles the four run kinds bash concatenates within a single word, in any
 * combination and any number: unquoted (with `\X` escapes), `'single'`
 * (fully literal), `"double"` (backslash escapes a small set only), and
 * `$'ansi-c'` (including `\xHH`, `\NNN`, `\0NNN`, `\uHHHH`, `\UHHHHHHHH`).
 * That concatenation is the point — `-de"lete"`, `-'delete'` and
 * `-$'\x64elete'` are all the single argv entry `-delete`, which is exactly
 * how the measured bypasses hid a write flag from a raw string comparison.
 *
 * Returns the input UNCHANGED when the word cannot be resolved: an
 * unterminated quote, or a truncated escape at end of input. Per the module
 * header's direction rule, callers compare the result against a set of
 * things to REJECT, so falling back to the raw token reproduces today's
 * behaviour instead of inventing one.
 *
 * Never throws.
 */
export function decodeShellWord(word: string): string {
  if (typeof word !== "string" || word.length === 0) return typeof word === "string" ? word : "";
  // Fast path: nothing quotable present, so the word is already literal.
  if (!/['"\\]/.test(word)) return word;
  try {
    const decoded = decodeInner(word);
    return decoded === null ? word : decoded;
  } catch {
    return word;
  }
}

/** Returns null when the word is unresolvable (caller falls back to raw). */
function decodeInner(word: string): string | null {
  let out = "";
  let i = 0;
  while (i < word.length) {
    const ch = word[i]!;
    if (ch === "'") {
      const end = word.indexOf("'", i + 1);
      if (end === -1) return null; // unterminated
      out += word.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      const run = readDoubleQuoted(word, i + 1);
      if (run === null) return null;
      out += run.value;
      i = run.next;
      continue;
    }
    if (ch === "$" && word[i + 1] === "'") {
      const run = readAnsiC(word, i + 2);
      if (run === null) return null;
      out += run.value;
      i = run.next;
      continue;
    }
    if (ch === "\\") {
      // Outside quotes a backslash escapes ANY next character. A trailing
      // backslash is a line continuation, which a single word cannot carry.
      if (i + 1 >= word.length) return null;
      out += word[i + 1]!;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function readDoubleQuoted(word: string, start: number): { value: string; next: number } | null {
  let out = "";
  let i = start;
  while (i < word.length) {
    const ch = word[i]!;
    if (ch === '"') return { value: out, next: i + 1 };
    if (ch === "\\") {
      const nxt = word[i + 1];
      if (nxt === undefined) return null;
      // Inside double quotes a backslash is literal UNLESS it precedes one
      // of the few characters bash lets it escape there.
      if (DOUBLE_QUOTE_ESCAPABLE.has(nxt)) {
        out += nxt;
        i += 2;
      } else {
        out += "\\";
        i += 1;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return null; // unterminated
}

function readAnsiC(word: string, start: number): { value: string; next: number } | null {
  let out = "";
  let i = start;
  while (i < word.length) {
    const ch = word[i]!;
    if (ch === "'") return { value: out, next: i + 1 };
    if (ch !== "\\") {
      out += ch;
      i++;
      continue;
    }
    const nxt = word[i + 1];
    if (nxt === undefined) return null;
    const simple = ANSI_C_SIMPLE.get(nxt);
    if (simple !== undefined) {
      out += simple;
      i += 2;
      continue;
    }
    if (nxt === "x" || nxt === "u" || nxt === "U") {
      // \xHH (1-2 hex), \uHHHH (1-4), \UHHHHHHHH (1-8).
      const max = nxt === "x" ? 2 : nxt === "u" ? 4 : 8;
      let j = i + 2;
      let hex = "";
      while (j < word.length && hex.length < max && /[0-9a-fA-F]/.test(word[j]!)) {
        hex += word[j]!;
        j++;
      }
      if (hex.length === 0) {
        // Not a valid escape; bash emits the characters literally.
        out += nxt;
        i += 2;
        continue;
      }
      out += String.fromCodePoint(Number.parseInt(hex, 16));
      i = j;
      continue;
    }
    if (/[0-7]/.test(nxt)) {
      // \NNN — up to three octal digits (a leading 0 is one of them).
      let j = i + 1;
      let oct = "";
      while (j < word.length && oct.length < 3 && /[0-7]/.test(word[j]!)) {
        oct += word[j]!;
        j++;
      }
      out += String.fromCharCode(Number.parseInt(oct, 8));
      i = j;
      continue;
    }
    // Unrecognised escape: bash keeps the backslash AND the character.
    out += "\\" + nxt;
    i += 2;
  }
  return null; // unterminated
}
