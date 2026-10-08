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
// exactly that reason (the removed gate's `isGateEligibleCommand`). What
// separates the two is which side of a
// security boundary the model sits on:
//
//   - There, the model gated a PERMISSIVE decision: every construct it
//     failed to model became a silent pass-through, i.e. a new bypass.
//   - Here, callers test their predicate on the raw token OR the decoded
//     one and take either match, so decoding can only ADD a match, never
//     remove one. An incomplete decode therefore yields today's behaviour
//     (a detection this codebase already misses), never a new fail-open.
//
// That `raw || decoded` shape is load-bearing and must not be "simplified"
// to testing the decoded value alone. This module shipped once with the
// simplified form and the guarantee above stated as an ARGUMENT; review
// measured it false at three of five call sites, because those predicates
// exclude `--` by construction and a token like `-"-out"=x` decodes out of
// the branch that used to match it (`sort -"-out"=x` went BLOCKED ->
// READONLY, artefact-confirmed). Testing both makes the property hold by
// construction rather than by reasoning.
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
//
// NUL-DECODING ESCAPES are not modelled here (task `241d9e9e`). GNU bash
// 3.2.57 (measured with `printf '[%s]' <word> | od -c`; the first report
// measured 5.1.16) truncates a `$'...'` run at a NUL, drops a NUL between two
// runs, and reads `\c@` (value 0) the same way. `decodeShellWord` does not
// rebuild that rule: `readAnsiC` keeps decoding such an escape exactly as before (a
// literal U+0000 for `\0`, `\x00` and the like), and `decodeShellWord` output
// for these words is unchanged. That is on purpose: the deny-side callers
// match PREFIXES and short-flag clusters of the decoded value (`of=`, `-s`,
// `-f`, `+ref`, `-c`, `-R`, `-i`, `-rf`), and a decoded value that carries a
// U+0000 after the flag text still starts with it, so those detections hold;
// returning the raw token instead would drop them. `hasAnsiCNulEscape` is a
// separate predicate that lets a caller refuse a whole command text; the
// read-only classifier does, so a command with such an escape is never read
// only. It over-reports on purpose (any `\c` escape counts, `\u`/`\U` count
// although bash 3.2.57 does not decode them), because a false positive only
// blocks an exotic read.
//
// DENY-SIDE COMPARISONS (task `5cc64860`). The prefix and cluster matches
// above do not help an EXACT comparison (a whole flag such as `--force`, a
// head name such as `dd`, a subcommand): `$'--force\0'` decodes to a value
// that carries a trailing U+0000 and never equals `--force`, while bash
// passes `--force`. `decodeShellWordTruncatingNul` and `truncateNulRuns`
// give the deny-side scanners the value bash passes, for the COMPARISON only:
// they never replace the decoded value, the scanners keep their existing scan
// of the command as written and add a second one over the rewritten text, so
// the second scan can only add a verdict. The truncation is the one measured rule, nothing more: a `$'...'`
// run ends at the first escape that decodes to NUL (or a `\c` escape, which
// is not modelled and so counts as possibly NUL), and the text around the run
// is kept (`x$'a\0b'y` is `xay`, measured on GNU bash 3.2.57 with
// `printf '[%s]' <word> | od -c`).

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
 * True when the `$'...'` escape that starts at `word[at]` (a backslash)
 * decodes to NUL, or is a `\c` control escape, which is not modelled and so
 * counts as possibly NUL. Conservative: it may say true too often, never too
 * rarely. Octal values wrap modulo 256 because bash keeps one byte.
 */
function isNulEscapeAt(word: string, at: number): boolean {
  const nxt = word[at + 1];
  if (nxt === undefined) return false;
  if (nxt === "c") return true;
  if (nxt === "x" || nxt === "u" || nxt === "U") {
    const max = nxt === "x" ? 2 : nxt === "u" ? 4 : 8;
    let hex = "";
    for (let j = at + 2; j < word.length && hex.length < max && /[0-9a-fA-F]/.test(word[j]!); j++) {
      hex += word[j]!;
    }
    return hex.length > 0 && /^0+$/.test(hex);
  }
  if (/[0-7]/.test(nxt)) {
    let oct = "";
    for (let j = at + 1; j < word.length && oct.length < 3 && /[0-7]/.test(word[j]!); j++) {
      oct += word[j]!;
    }
    return Number.parseInt(oct, 8) % 256 === 0;
  }
  return false;
}

/**
 * True when `text` contains, inside any `$'...'` run, an escape that decodes
 * to NUL (`\0`, `\00`, `\000`, `\x0`, `\x00`, `\u0` to `\u0000`, `\U0` to
 * `\U00000000`) or a `\c` control escape (not modelled, so counted). Works on
 * a whole command string or a single word. Every `$'` occurrence is scanned
 * on its own, including one that sits inside a single-quoted span, so a real
 * run is never hidden by an earlier false start; the cost is an occasional
 * over-report, which the caller treats as "refuse".
 *
 * This is deliberately not a model of bash's NUL truncation. Never throws.
 */
export function hasAnsiCNulEscape(text: string): boolean {
  if (typeof text !== "string") return false;
  let from = text.indexOf("$'");
  while (from !== -1) {
    for (let i = from + 2; i < text.length; ) {
      const ch = text[i]!;
      if (ch === "'") break;
      if (ch === "\\") {
        if (isNulEscapeAt(text, i)) return true;
        i += 2;
        continue;
      }
      i++;
    }
    from = text.indexOf("$'", from + 1);
  }
  return false;
}

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
 * unterminated quote, or a truncated escape at end of input. A NUL-decoding
 * escape inside `$'...'` does not make a word unresolvable (see the module
 * header; the read-only classifier refuses such a command through
 * `hasAnsiCNulEscape` instead). Per the module
 * header's direction rule, callers compare the result against a set of
 * things to REJECT, so falling back to the raw token reproduces today's
 * behaviour instead of inventing one.
 *
 * Never throws.
 */
export function decodeShellWord(word: string): string {
  return decodeWith(word, false);
}

/**
 * The value bash passes for `word` when a `$'...'` run carries a NUL-decoding
 * escape: each such run is cut at its first NUL (or `\c`) escape, everything
 * else is decoded exactly as `decodeShellWord` does. Equal to
 * `decodeShellWord(word)` for a word without such an escape. For the
 * deny-side exact comparisons only (module header, task `5cc64860`); like
 * `decodeShellWord` it returns the raw word when it cannot resolve it, and
 * never throws.
 */
export function decodeShellWordTruncatingNul(word: string): string {
  return decodeWith(word, true);
}

/**
 * Rewrite every `$'...'` run of `text` that carries a NUL-decoding escape into
 * a single-quoted literal of the value bash passes for it, and leave the rest
 * of the text byte for byte as it was (`rm -rf $'/tmp\\0/x'` becomes
 * `rm -rf '/tmp'`). `null` when nothing was rewritten, so the caller has no
 * second text to examine. Works on a whole command string: the rewrite
 * happens before any boundary split, so a `;`, `|` or `&` that sits inside
 * the cut-off part of a run (`$'--force\\0;'`) disappears with it instead of
 * tearing the word in two. A run without a closing quote is left alone
 * (`decodeShellWord` cannot resolve it either). Every `$'` occurrence is a
 * candidate start, as in `hasAnsiCNulEscape`, so a real run is never hidden
 * behind an earlier false start; the cost is an occasional over-rewrite of
 * text bash reads as quoted, which only gives a deny-side caller one more
 * text to examine next to the original. Never throws.
 */
export function truncateNulRuns(text: string): string | null {
  if (typeof text !== "string") return null;
  let out = "";
  let copied = 0;
  let rewrote = false;
  let from = text.indexOf("$'");
  while (from !== -1) {
    let end = -1;
    for (let i = from + 2; i < text.length; ) {
      const ch = text[i]!;
      if (ch === "'") {
        end = i;
        break;
      }
      i += ch === "\\" ? 2 : 1;
    }
    const run = end === -1 ? "" : text.slice(from, end + 1);
    if (end !== -1 && hasAnsiCNulEscape(run)) {
      const value = decodeShellWordTruncatingNul(run).replace(/'/g, "'\\''");
      out += text.slice(copied, from) + `'${value}'`;
      copied = end + 1;
      rewrote = true;
      from = text.indexOf("$'", end + 1);
      continue;
    }
    from = text.indexOf("$'", from + 1);
  }
  return rewrote ? out + text.slice(copied) : null;
}

function decodeWith(word: string, truncateNul: boolean): string {
  if (typeof word !== "string" || word.length === 0) return typeof word === "string" ? word : "";
  // Fast path: nothing quotable present, so the word is already literal.
  if (!/['"\\]/.test(word)) return word;
  try {
    const decoded = decodeInner(word, truncateNul);
    return decoded === null ? word : decoded;
  } catch {
    return word;
  }
}

/** Returns null when the word is unresolvable (caller falls back to raw). */
function decodeInner(word: string, truncateNul: boolean): string | null {
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
    if (ch === "$" && word[i + 1] === '"') {
      // `$"..."` is locale translation. With no catalog loaded bash returns
      // the contents unchanged with the quotes removed, so the value is the
      // same as a plain double-quoted run. Measured: `printf '%s' -$"delete"`
      // -> `-delete`. Without this branch the `$` was emitted literally and
      // the decode SUCCEEDED with a wrong value, so the raw-token fallback
      // never fired — five artefact-confirmed writes slipped through
      // (review round 1).
      const run = readDoubleQuoted(word, i + 2);
      if (run === null) return null;
      out += run.value;
      i = run.next;
      continue;
    }
    if (ch === "$" && word[i + 1] === "'") {
      const run = readAnsiC(word, i + 2, truncateNul);
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

function readAnsiC(
  word: string,
  start: number,
  truncateNul: boolean,
): { value: string; next: number } | null {
  let out = "";
  let i = start;
  // Set once a NUL-decoding escape was met under `truncateNul`: the rest of
  // the run is read only to find its closing quote, and adds nothing.
  let dropping = false;
  while (i < word.length) {
    const ch = word[i]!;
    if (ch === "'") return { value: out, next: i + 1 };
    if (ch !== "\\") {
      if (!dropping) out += ch;
      i++;
      continue;
    }
    const nxt = word[i + 1];
    if (nxt === undefined) return null;
    if (dropping) {
      i += 2;
      continue;
    }
    if (truncateNul && isNulEscapeAt(word, i)) {
      dropping = true;
      i += 2;
      continue;
    }
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
        // Not a valid escape. Bash keeps the BACKSLASH as well as the
        // character: `printf '%s' $'\xz'` emits `\xz` (3 chars, verified
        // with od -c). An earlier version dropped the backslash.
        out += "\\" + nxt;
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
