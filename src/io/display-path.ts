// Safe rendering of a path (or any other agent-chosen string) into text an
// operator reads on a terminal.
//
// A file name in a directory the gated agent can write is attacker-chosen:
// POSIX permits every byte but `/` and NUL in it, so it can carry an ESC
// (an OSC 52 clipboard write, a screen clear), a CR (overwrite the line it
// lands on) or a newline (forge an extra diagnostic-looking line). A path
// that reaches stderr therefore goes through this one helper; it ESCAPES
// rather than strips, so the operator can still see which name is meant and
// can copy its escaped form into a recovery command.
//
// Lives in `src/io/` for the same reason `project-name.ts` does: it is a
// leaf utility any layer may use (`io/` may not import from `runtime/`).

import { INVISIBLE_CHARACTER_CLASS } from "./invisible-characters.js";

/** Controls JSON leaves raw, the shared invisible-character rule and line separators. */
const UNSAFE_DISPLAY_CHARACTERS = new RegExp(
  `[\\u007f-\\u009f\\u2028\\u2029${INVISIBLE_CHARACTER_CLASS}]`,
  "gu",
);

/**
 * `value` as one double-quoted, single-line literal that is safe to print:
 * `JSON.stringify` escapes `"`, `\`, every C0 control character (ESC as
 * `\u001b`, CR as `\r`, LF as `\n`) and lone surrogates, and DEL and the C1
 * range, which JSON leaves raw (U+009B is a one-byte CSI on terminals that
 * honour C1), are escaped here as `\uXXXX`. Characters of the shared
 * invisible-character rule (`invisible-characters.ts`: format characters
 * including bidi overrides, variation selectors, Hangul fillers, the zero
 * width joiner) and line/paragraph separators are escaped too.
 * Supplementary characters use two UTF-16 `\uXXXX` escapes so the result
 * stays a JSON literal that parses back to the original string.
 */
export function escapeForDisplay(value: string): string {
  return JSON.stringify(value).replace(
    UNSAFE_DISPLAY_CHARACTERS,
    (ch) => ch.split("").map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""),
  );
}
