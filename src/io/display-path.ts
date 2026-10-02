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

/** DEL (U+007F) and every C1 control character (U+0080 to U+009F). */
const DEL_AND_C1 = new RegExp("[\\u007f-\\u009f]", "g");

/**
 * `value` as one double-quoted, single-line literal that is safe to print:
 * `JSON.stringify` escapes `"`, `\`, every C0 control character (ESC as
 * `\u001b`, CR as `\r`, LF as `\n`) and lone surrogates, and DEL and the C1
 * range, which JSON leaves raw (U+009B is a one-byte CSI on terminals that
 * honour C1), are escaped here as `\uXXXX`. The result contains no raw byte
 * below 0x20 and no DEL or C1 character.
 */
export function escapeForDisplay(value: string): string {
  return JSON.stringify(value).replace(
    DEL_AND_C1,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
