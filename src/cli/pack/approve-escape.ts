// Escape-command matcher for the understanding-gate PreToolUse hook.
//
// The operator-approval command `harness approve ...` must not be
// hard-denied by the gate (denying the unblock surface makes the gate
// un-recoverable from inside the session), so the hook defers it to the
// interactive permission prompt instead. This module decides what
// qualifies. Deliberately strict: anything that could smuggle other work
// past the gate (chaining, substitution, redirection) is rejected.
//
// Two accepted shapes:
//   1. Single line: `harness approve ...` with no shell metacharacters.
//   2. Report heredoc (task 61fd36db): the same command with the
//      Understanding Report attached as a quoted heredoc on stdin:
//
//        harness approve understanding <<'UNDERSTANDING_REPORT'
//        ## Understanding Report
//        ...
//        UNDERSTANDING_REPORT
//
//      This is the report-capture channel: the Stop-hook producer fires
//      only at END of turn (after approve already ran), and current
//      Claude Code builds do not reliably persist mid-turn assistant
//      text to the transcript JSONL, so the command itself is the only
//      channel that reliably carries the report to `harness approve
//      understanding`. As a bonus the operator reads the full report
//      inside the permission prompt before approving.
//
// Heredoc safety: the delimiter must be single-quoted (no parameter or
// command substitution inside the body), the command part before `<<`
// must match a strict character WHITELIST (so no quoting/escaping trick
// can change how the shell tokenizes the line — see
// heredocCommandPartIsClean), the terminator is the FIRST line exactly
// equal to the delimiter (mirroring shell semantics for a plain `<<'X'`
// intro, which the whitelist guarantees is the only intro that can
// reach it), and nothing but whitespace may follow it. Any deviation —
// unquoted delimiter, second redirect, escaped/quote-obscured intro,
// trailing commands, unterminated body — fails closed to the ordinary
// gate block.

/** Metacharacters rejected in the executable (non-heredoc-body) part. */
const COMMAND_META_RE = /[;&|<>]/;

// bash's actual lexical blank set: SPACE and TAB, nothing else.
// Ground-truthed against GNU bash with a PATH-stub harness (task
// 623640a5): of the 25 codepoints JS's generic `\s` class matches, only
// these two are stripped by bash as an insignificant separator between
// tokens on a line. Setting LF and CR aside (see below), the remaining
// 21 (NBSP U+00A0 and 18 further Unicode space-separator/line-separator/
// BOM codepoints; VT/FF too) glue onto the adjacent token as an ordinary
// word-constituent character instead. `\s` used to accept those
// characters here as if bash agreed they were whitespace, which let a
// report heredoc's delimiter word, as bash actually reads it, diverge
// from the word this matcher extracts (see `parseApproveReportHeredoc`
// below for the exploitable shape that produced). Every regex in this
// module that means "a separator bash will actually treat as blank
// here" uses `[ \t]`, never `\s`. LF and CR (the last 2 of the 23
// non-bash-blank codepoints) are deliberately excluded from this class:
// LF already splits lines before any of these regexes run, and CR is
// rejected by an explicit check in both callers, so neither needs
// blank-class treatment here. (25 total - 2 bash blanks = 23 non-bash-
// blank; 23 - 2 LF/CR = 21 = 1 NBSP + 18 further + 2 VT/FF; enumeration
// and exact figures pinned in tests/cli/pack-approve-escape.test.ts.)
function commandPartIsClean(part: string): boolean {
  if (COMMAND_META_RE.test(part)) return false;
  if (part.includes("`") || part.includes("$(")) return false;
  return /^harness[ \t]+approve\b/.test(part);
}

// The heredoc command part is held to a WHITELIST, not the blacklist
// above (review 2026-07-10, HIGH): a backslash-escaped redirect
// (`harness approve understanding \<<'UR'`) slipped the blacklist —
// the `<` characters were consumed by the heredoc-intro regex and `\`
// is not a rejected metachar — but bash reads `\<` as a literal `<`
// plus a file redirect, so no heredoc exists and the "body" lines
// execute as ordinary commands. A legitimate approve command part only
// ever contains the binary name, subcommand, flags, ids, and paths;
// everything else (backslashes, quotes, `$`, parens, globs) fails
// closed. The single-line shape keeps the blacklist for back-compat:
// it admits no `<` at all, so this divergence class cannot arise there.
const HEREDOC_COMMAND_PART_ALLOWED_RE = /^[A-Za-z0-9_ \t,./=:@~-]*$/;

function heredocCommandPartIsClean(part: string): boolean {
  if (!HEREDOC_COMMAND_PART_ALLOWED_RE.test(part)) return false;
  return commandPartIsClean(part);
}

export interface ApproveReportHeredoc {
  /** The executable command part (first line, heredoc intro stripped). */
  command: string;
  /** The heredoc delimiter word. */
  delimiter: string;
  /** The heredoc body — the Understanding Report markdown. */
  body: string;
}

/**
 * Parse the report-heredoc shape. Returns null unless the WHOLE command
 * is exactly one clean `harness approve ...` line plus one single-quoted
 * heredoc and nothing else.
 */
export function parseApproveReportHeredoc(
  command: string,
): ApproveReportHeredoc | null {
  const trimmed = command.trim();
  const nl = trimmed.indexOf("\n");
  if (nl === -1) return null;
  const head = trimmed.slice(0, nl);
  // CR anywhere in the head means the line structure is not what the
  // shell will see; fail closed. (Body CRs are inert data.)
  if (head.includes("\r")) return null;
  // Lazy `.*?` + end-anchor: a second redirect after the heredoc intro
  // forces the intro into the command part, where the metachar check
  // rejects it. `[ \t]*` (not `\s*`) around the delimiter word: see the
  // bash-blank comment above `commandPartIsClean` (task 623640a5): a
  // non-bash-blank character here (e.g. NBSP) used to be accepted as
  // insignificant trailing/leading whitespace, while bash actually glues
  // it onto the quoted word, widening the REAL heredoc delimiter beyond
  // what this capture group extracts and letting a body line close the
  // heredoc a line early.
  const m = /^(.*?)<<[ \t]*'([A-Z_][A-Z0-9_]*)'[ \t]*$/.exec(head);
  if (!m) return null;
  // [ \t]-only right-trim (not the generic .trimEnd(), which strips every
  // JS `\s` codepoint): a non-bash-blank character immediately before
  // `<<` must reach heredocCommandPartIsClean's whitelist so it gets
  // rejected there, not be silently stripped away first as if it were an
  // insignificant separator bash would also treat as blank (task
  // 623640a5 review). See the bash-blank comment above
  // `commandPartIsClean`.
  const commandPart = m[1]!.replace(/[ \t]*$/, "");
  const delimiter = m[2]!;
  if (!heredocCommandPartIsClean(commandPart)) return null;
  const rest = trimmed.slice(nl + 1).split("\n");
  // First line EXACTLY equal to the delimiter terminates the body — the
  // same rule the shell applies — so a delimiter line smuggled early in
  // the body shifts the terminator up and the trailing content check
  // below rejects the command as a whole.
  const termIdx = rest.findIndex((line) => line === delimiter);
  if (termIdx === -1) return null;
  const after = rest.slice(termIdx + 1);
  // [ \t]-only blank check (not the generic .trim(), which treats every
  // JS `\s` codepoint as blank): a post-terminator line made only of
  // non-bash-blank whitespace (e.g. NBSP, U+2028) is NOT inert to bash.
  // PATH-stub-verified (task 623640a5 review) that bash actually looks
  // up and attempts to execute such a line as a real command.
  if (!after.every((line) => /^[ \t]*$/.test(line))) return null;
  return {
    command: commandPart,
    delimiter,
    body: rest.slice(0, termIdx).join("\n"),
  };
}

/**
 * The operator-approval command `harness approve ...`. See module
 * header for the accepted shapes and the rationale for strictness.
 */
export function isEscapeCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed.includes("\n")) {
    if (trimmed.includes("\r")) return false;
    return commandPartIsClean(trimmed);
  }
  return parseApproveReportHeredoc(trimmed) !== null;
}
