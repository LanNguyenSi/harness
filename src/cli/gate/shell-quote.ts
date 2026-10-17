// One place that quotes a path for a command the gate prints for the
// operator to run: a path with a space, a quote or a shell metacharacter
// pasted bare would run against a different file than the one named.

/** Characters a POSIX shell passes through unchanged inside a word. */
const SAFE_WORD = /^[A-Za-z0-9_@+:,./-]+$/;

/**
 * `value` as one POSIX shell word. A plain path stays bare; anything else,
 * including the empty string, is wrapped in single quotes with each embedded
 * single quote written as `'\''`, so the shell hands the command exactly
 * `value` back whatever it holds.
 */
export function shellQuote(value: string): string {
  if (SAFE_WORD.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
