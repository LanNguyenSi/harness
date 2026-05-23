// Read-only Bash command classifier for the understanding-gate
// PreToolUse blocker.
//
// The pack's hook matcher `Edit|Write|Bash` is too broad on its own:
// `Bash` covers commands like `git status`, `gh pr view`, `ls`, `cat`
// that mutate nothing. Hard-blocking them behind a full Understanding
// Report cycle trains the agent and operator to experience the gate
// as noise, which erodes its credibility on the writes that actually
// matter. A gate scoped exactly to what it must stop is a credible
// gate.
//
// Design contract:
// - The allowlist is intentionally conservative. Anything not on it
//   is treated as a write (block). Better to occasionally annoy a
//   read-only command we haven't enumerated than to let a write slip.
// - Any shell chaining (`;`, `&&`, `||`, `|`), redirection (`>`,
//   `>>`, `<`), or command substitution (backticks, `$()`) makes the
//   whole composition unclassifiable. Even if every individual piece
//   would be read-only, a chained or substituted command can hide
//   writes inside its construction. Refuse the whole thing.
// - The classifier never short-circuits write detection: if a command
//   is on the allowlist but a write indicator is also present, the
//   write indicator wins. The shell-metachar check above accomplishes
//   this without a separate write-binary deny list (the meta-chars
//   are how a write would be smuggled into a "read-only" command in
//   the first place).
//
// This module is the canonical home for the classification. The
// harness pack hook is the superset blocker today, so the classifier
// lives here rather than in the @lannguyensi/understanding-gate
// package. If the package adds a parallel classifier in the future,
// it should mirror this allowlist verbatim, not diverge.

/**
 * Single-token read-only binaries. Each accepts arguments without
 * changing classification: `ls -la /tmp` is still read-only.
 */
const SIMPLE_READ_ONLY_BINS: ReadonlySet<string> = new Set([
  "ls", "cat", "pwd", "which", "type", "command",
  "find", "grep", "rg", "wc",
  "head", "tail", "file", "stat", "tree", "du", "df",
  "ps", "whoami", "id", "date", "echo", "env", "printenv",
  "true", "false", "uptime", "hostname", "uname", "tty",
  "basename", "dirname", "realpath", "readlink",
  "less", "more", "cmp", "diff", "comm",
  "sort", "uniq", "cut", "tr", "tac", "rev",
]);

/**
 * `git` subcommands that do not mutate the working tree, index, or
 * any ref. `git fetch` is included because it only writes to the
 * remote-tracking branches, never touches local refs or the working
 * tree; same for `git ls-remote`. `git config` is excluded: with
 * arguments it can set values.
 */
const GIT_READ_ONLY_SUBS: ReadonlySet<string> = new Set([
  "status", "log", "diff", "show", "branch", "tag",
  "fetch", "remote", "ls-files", "ls-remote", "ls-tree",
  "rev-parse", "rev-list", "describe", "blame", "shortlog",
  "reflog", "cat-file", "check-ref-format", "for-each-ref",
  "name-rev", "merge-base", "show-ref",
]);

/**
 * `gh` (GitHub CLI) noun + verb pairs that read state without writing.
 * `gh pr view`, `gh pr checks`, `gh run view`, `gh workflow list`, etc.
 */
const GH_READ_ONLY_VERBS: ReadonlySet<string> = new Set([
  "view", "list", "diff", "checks", "status",
]);
const GH_READ_ONLY_NOUNS: ReadonlySet<string> = new Set([
  "pr", "issue", "run", "workflow", "release",
  "repo", "label", "secret", "variable",
]);

/**
 * `harness` subcommands that only inspect manifest or harness state.
 * `harness preflight` and `harness approve` are excluded: preflight
 * writes a ledger row, approve writes the approval marker. Both are
 * legitimate, but if the gate is currently blocking, classifying them
 * as read-only would let them bypass it silently. Operator-approval
 * commands have their own escape path in `isEscapeCommand`.
 */
const HARNESS_READ_ONLY_SUBS: ReadonlySet<string> = new Set([
  "doctor", "validate", "audit", "diff", "list", "version",
  "show", "status", "pause",
]);

/**
 * Common single-flag read-only invocations: `<bin> --version`,
 * `<bin> -v`, `<bin> --help`, `<bin> -h`. Token count must be 2 and
 * the second token must be one of these flags. Restricts to a
 * known-safe shape so a binary like `rm` cannot be smuggled past as
 * `rm --version`.
 */
const VERSION_OR_HELP_FLAGS: ReadonlySet<string> = new Set([
  "--version", "-V", "-v", "--help", "-h",
]);

/**
 * Classify a Bash command string. `true` means the command is
 * provably read-only and the understanding-gate can allow it without
 * an approved report. `false` means the command is either a write or
 * unclassifiable; the gate must block (fail-closed).
 *
 * The classifier inspects the command as a raw shell string. It does
 * NOT shell-parse or evaluate the command — that would introduce its
 * own attack surface. Instead it rejects any string that contains
 * shell metacharacters that could hide a write, then looks at the
 * first one or two tokens.
 */
export function isReadOnlyBashCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed === "") return false;

  // Reject any shell chaining, redirection, or command substitution.
  // These make the command unclassifiable even when every visible
  // piece would otherwise be read-only.
  if (/[;&|<>]/.test(trimmed)) return false;
  if (trimmed.includes("\n")) return false;
  if (trimmed.includes("`")) return false;
  if (trimmed.includes("$(")) return false;

  const tokens = trimmed.split(/\s+/);
  const bin = tokens[0] ?? "";
  const sub = tokens[1] ?? "";

  if (SIMPLE_READ_ONLY_BINS.has(bin)) return true;

  // `<bin> --version` / `<bin> --help` shape. Checked BEFORE the
  // per-binary branches so that `git --version`, `gh --version`,
  // `harness --version` all pass through this shape rather than
  // falling into the per-binary subcommand allowlists (which
  // intentionally don't list `--version` since it's not a
  // subcommand). Must be exactly two tokens to keep the surface
  // tight: `<bin> --version <thing>` could exfiltrate or mis-route.
  if (tokens.length === 2 && VERSION_OR_HELP_FLAGS.has(sub)) return true;

  if (bin === "git") return GIT_READ_ONLY_SUBS.has(sub);

  if (bin === "gh") {
    if (!GH_READ_ONLY_NOUNS.has(sub)) return false;
    const verb = tokens[2] ?? "";
    return GH_READ_ONLY_VERBS.has(verb);
  }

  if (bin === "harness") return HARNESS_READ_ONLY_SUBS.has(sub);

  return false;
}
