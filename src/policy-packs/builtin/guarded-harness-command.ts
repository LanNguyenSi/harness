// The command line a blocking PreToolUse hook runs, and the one place that
// recognises it again.
//
// A hook command is resolved through PATH when the agent process spawns it.
// When `harness` is not on that PATH (the usual way: an nvm switch left the
// npm global bin directory off the agent's PATH) the shell exits 127. Both
// runtimes read only exit 2 on a PreToolUse hook as a block: Claude Code
// treats any other non-zero exit as a non-blocking error and runs the tool,
// and Codex reports the hook as failed and runs the tool. A bare
// `harness pack hook ...` therefore turned a missing binary into "no
// protection installed", silently.
//
// The guarded form checks for the binary first and answers exit 2 with a
// reason on stderr (the reason is what both runtimes show for a block; Codex
// treats exit 2 without a stderr reason as a failure again), then `exec`s the
// real hook so its exit code, stdout and stdin are the hook's own.
//
// It is wrapped in `/bin/sh -c '...'` because the runtimes do not all start a
// hook with a POSIX shell: Codex runs the command with the user's `$SHELL -c`
// (fish before 4.0 has no `{ ...; }` group, so the guard would be a syntax
// error and exit non-2). The outer line is only a single-quoted word, which
// every shell parses the same way; the guard itself always runs under sh.
// The script holds no single quote, `$` or backslash so the quoting stays
// trivially correct.

/** The command word every guarded line runs and the PATH lookup targets. */
const HARNESS_BINARY = "harness";

/** What the guard writes to stderr when the binary is missing. No quote, `$` or backslash. */
export const MISSING_BINARY_REASON =
  "harness not found on PATH: branch protection cannot run, so this tool call is blocked. " +
  "Fix PATH (for example nvm use the Node version harness was installed under, or add the npm global bin directory) and retry.";

/**
 * The line a blocking harness hook runs. `subcommand` is everything after the
 * `harness` word (`pack hook branch-protection --runtime codex`); it must not
 * contain a single quote.
 */
export function guardedHarnessCommand(subcommand: string): string {
  if (subcommand.includes("'")) {
    throw new Error("guardedHarnessCommand: the subcommand must not contain a single quote");
  }
  const script =
    `command -v ${HARNESS_BINARY} >/dev/null 2>&1 || ` +
    `{ echo "${MISSING_BINARY_REASON}" >&2; exit 2; }; ` +
    `exec ${HARNESS_BINARY} ${subcommand}`;
  return `/bin/sh -c '${script}'`;
}

// Matches any release's guarded line: the reason text is not pinned, so a
// line an older harness wrote is still recognised after the wording changes.
const GUARDED_LINE =
  /^\/bin\/sh -c 'command -v harness >\/dev\/null 2>&1 \|\| \{ echo "[^"'\\$]*" >&2; exit 2; \}; exec (harness [^']+)'$/;

/**
 * The plain `harness <subcommand>` command a guarded line runs, or `null`
 * when `command` is not a guarded line.
 */
export function unwrapGuardedHarnessCommand(command: string): string | null {
  const m = GUARDED_LINE.exec(command.trim());
  return m === null ? null : (m[1] as string);
}

/**
 * `command` as a plain harness invocation: the inner `harness <subcommand>`
 * for a guarded line, the trimmed command otherwise. Every recogniser of
 * harness's own hook entries (uninstall, the Codex install's kept-table scan,
 * doctor) goes through this, so the old bare form and the guarded form are
 * both recognised.
 */
export function asPlainHarnessCommand(command: string): string {
  return unwrapGuardedHarnessCommand(command) ?? command.trim();
}

/** True when `command` is a guarded line (the form this release generates). */
export function isGuardedHarnessCommand(command: string): boolean {
  return unwrapGuardedHarnessCommand(command) !== null;
}
