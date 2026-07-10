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
// must pass the same metachar rules as the single-line shape, the
// terminator is the FIRST line exactly equal to the delimiter (mirroring
// shell semantics, so this parser and the shell can never disagree on
// where the body ends), and nothing but whitespace may follow it. Any
// deviation — unquoted delimiter, second redirect, trailing commands,
// unterminated body — fails closed to the ordinary gate block.

/** Metacharacters rejected in the executable (non-heredoc-body) part. */
const COMMAND_META_RE = /[;&|<>]/;

function commandPartIsClean(part: string): boolean {
  if (COMMAND_META_RE.test(part)) return false;
  if (part.includes("`") || part.includes("$(")) return false;
  return /^harness\s+approve\b/.test(part);
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
  // rejects it.
  const m = /^(.*?)<<\s*'([A-Z_][A-Z0-9_]*)'\s*$/.exec(head);
  if (!m) return null;
  const commandPart = m[1]!.trimEnd();
  const delimiter = m[2]!;
  if (!commandPartIsClean(commandPart)) return null;
  const rest = trimmed.slice(nl + 1).split("\n");
  // First line EXACTLY equal to the delimiter terminates the body — the
  // same rule the shell applies — so a delimiter line smuggled early in
  // the body shifts the terminator up and the trailing content check
  // below rejects the command as a whole.
  const termIdx = rest.findIndex((line) => line === delimiter);
  if (termIdx === -1) return null;
  const after = rest.slice(termIdx + 1);
  if (!after.every((line) => line.trim() === "")) return null;
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
