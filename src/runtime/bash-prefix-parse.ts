// Risk Gate resolver input — Bash command-prefix parser.
//
// Three normal POSIX shell idioms slip past the production environment
// resolver when only `process.env` and the hook's starting cwd (and, for
// the branch, its current `.git/HEAD`) are inspected:
//
//   DATABASE_URL=postgres://prod terraform destroy   # inline env
//   cd /repos/prod-infra && terraform destroy        # working-dir hop
//   git switch main && rm -rf node_modules && ...    # branch hop
//
// The hook intercept sees Claude Code's process env and starting cwd, so
// `env_var_patterns` and `branch_patterns` miss all three signals and the
// gate silently treats a prod mutation as non-prod.
//
// This parser extracts the leading idioms from a Bash command string so
// the resolver layer can merge them into its inputs before
// `environments.resolvers[]` runs. Three POSIX forms are supported in v1
// (kept narrow on purpose, see follow-up scope in the originating tasks):
//
//   1. Inline env: leading `\w+=value` tokens. Values may be unquoted,
//      single-quoted (literal), or double-quoted (literal, no $
//      interpolation in v1).
//   2. cd prefix: a single leading `cd <path> [&&|;] ...`. Quoted paths
//      supported. No `pushd`, no subshell `(cd X && ...)`, no `bash -c`.
//   3. git branch switch: a single leading `git [-C <path>]
//      (switch|checkout) <branch> [&&|;] ...` (task 341e024b). The
//      `<branch>` must be a plain, literal token, unquoted OR quoted
//      (single- or double-quoted, surrounding quotes stripped — same
//      quoted-literal handling `cd`'s path token gets, task 341e024b fix
//      round 1: a quoted `"main"`/`'main'` used to read as the literal
//      6-character string `"main"` including the quote characters,
//      which never matches a `branch_patterns` entry like `main` and so
//      silently defeated the gate). A `-`-prefixed first argument (`-`,
//      `--`, `-b`, ...; this is how `git checkout -- <path>`'s
//      file-restore form is excluded) or an unquoted `$VAR`/`${VAR}`
//      shell variable is left unresolved (`branchTarget: null`) rather
//      than guessed; a DOUBLE-quoted token whose content contains a `$`
//      is treated the same way (not guessed) since double quotes DO
//      interpolate in real bash and this parser does not evaluate the
//      shell environment — a single-quoted token is always taken
//      literally, since single quotes never interpolate. The optional
//      `-C <path>` is recognized so it does not block the match, but its
//      value is discarded: the ONLY thing this idiom feeds the resolver
//      is the branch name being switched TO (see
//      `src/cli/policy/intercept.ts`'s merge, which is upgrade-only —
//      unlike the `cd` merge below, a resolved branch target here can
//      only push the resolved environment to something MORE dangerous,
//      never less).
//
//      LIMIT, stated so a maintainer does not over-trust this idiom's
//      coverage: only the FIRST leading branch switch is captured. A
//      chained `git switch dev && git switch main && rm ...` resolves
//      `branchTarget` as `dev`, never `main` — multi-switch parsing
//      (walking past the first `&&` to find a SECOND switch) is
//      deliberately not built; it would widen the parser's surface
//      toward the false-positive class task dbc6d303 already measured
//      (branch-shaped tokens picked up from further into a command that
//      is not actually a chained branch hop).
//
// The clauses may appear in any order relative to each other (`cd /x &&
// VAR=v cmd`, `VAR=v cd /x && cmd`, `cd /x && git switch main && cmd`,
// ...); the parser walks up to two passes before giving up.
//
// On a syntactically broken prefix (unterminated quote, missing `&&`
// after `cd <path>` / a switch-or-checkout branch) the parser falls
// through cleanly: the malformed prefix is not consumed, the
// resolver-side fallback to process env / hook cwd holds. There are no
// thrown errors from this module.
//
// MEASUREMENT RULE (task 47297478): any claim about this parser's
// CD-TARGET extraction versus another build (lost or gained `cdTarget`
// values) must come from scripts/measure-bash-prefix-parse.mjs, the
// per-arm-gated corpus with real bash as referee. Three consecutive
// ad-hoc corpora in the b093911d run reported "0 lost" while being
// structurally unable to report a loss; that tool's self-test rebuilds
// exactly that failure and demands the gate catch it. The tool does NOT
// measure `inlineEnv` or `branchTarget` extraction — claims about those
// have no instrument yet and need their own measurement.

/** Parsed leading-prefix result. */
export interface BashPrefix {
  /** `VAR -> value` pairs from leading inline-env assignments. Empty when none. */
  inlineEnv: Record<string, string>;
  /** Path argument of a leading `cd <path> &&|;`, or null when none. */
  cdTarget: string | null;
  /**
   * Branch argument of a leading `git [-C <path>] (switch|checkout)
   * <branch> &&|;`, or null when none, including when the branch
   * argument is a `-`-prefixed flag/file-restore form or an
   * unresolvable `$VAR` (see module doc, form 3). Task 341e024b.
   */
  branchTarget: string | null;
  /**
   * Index into the original `command` string right after the last
   * consumed prefix clause: `command.slice(remainderStart)` is what is
   * left once every recognized leading `VAR=value` / `cd <path> &&` /
   * `git switch <branch> &&` clause has been stripped. `0` when nothing
   * matched. Added (task a7eb1a71) so a caller needing to test the
   * REMAINING command's own head, such as
   * `kubectl-target-parse.ts`'s narrow kubectl-head anchor, can do so
   * without re-implementing this module's prefix grammar.
   */
  remainderStart: number;
}

/**
 * Parse leading inline-env and `cd <path>` idioms from a Bash command
 * string. Returns an empty `inlineEnv` and `cdTarget:null` when neither
 * idiom matches. Never throws.
 */
export function parseBashPrefix(command: string): BashPrefix {
  if (typeof command !== "string" || command.length === 0) {
    return { inlineEnv: {}, cdTarget: null, branchTarget: null, remainderStart: 0 };
  }
  const inlineEnv: Record<string, string> = {};
  let cdTarget: string | null = null;
  let branchTarget: string | null = null;
  let cursor = 0;
  // Two passes catch e.g. `cd /x && VAR=v cmd`, `VAR=v cd /x && cmd`, and
  // `cd /x && git switch main && cmd` (the last resolves fully within a
  // single pass — cd then switch are tried back to back below — the
  // second pass just confirms nothing more is left to consume). A third
  // pass would only fire on a redundant prefix; bail to keep this
  // bounded.
  for (let pass = 0; pass < 2; pass++) {
    const before = cursor;
    cursor = consumeInlineEnv(command, cursor, inlineEnv);
    if (cdTarget === null) {
      const cd = consumeLeadingCd(command, cursor);
      if (cd !== null) {
        cdTarget = cd.path;
        cursor = cd.next;
      }
    }
    if (branchTarget === null) {
      const sw = consumeLeadingGitSwitch(command, cursor);
      if (sw !== null) {
        branchTarget = sw.branch;
        cursor = sw.next;
      }
    }
    if (cursor === before) break;
  }
  return { inlineEnv, cdTarget, branchTarget, remainderStart: cursor };
}

const WS = /\s/;
const VAR_START = /[A-Za-z_]/;
const VAR_CONT = /[A-Za-z0-9_]/;

function skipWs(s: string, i: number): number {
  while (i < s.length && WS.test(s[i]!)) i++;
  return i;
}

/**
 * Consume zero or more leading `VAR=value` tokens. Each successful
 * consumption registers into `into`. Returns the cursor position after
 * the last consumed token, or the original cursor when nothing parsed
 * (so the caller can try another prefix kind).
 *
 * On a syntactically broken token (e.g. unterminated quote) the broken
 * token is NOT consumed and the function returns the cursor at the
 * start of that token, preserving the rest of the command for fallback.
 *
 * QUOTE-MODEL DIVERGENCE, recorded so the next change here starts from
 * the known state instead of rediscovering it (task 13e55484, review
 * round 1): `command-normalize.ts`'s `consumeAssignment` is a SECOND
 * quote model for the same leading-`VAR=value` construction, with
 * different deliberate coverage — it handles backslash escapes (outside
 * single quotes) and chained quote runs (`'a b'"c d"`), which this
 * function does not, while this function extracts the VALUE (which the
 * normaliser never needs). Neither model handles ANSI-C `$'...'`
 * escapes; the normaliser side carries a one-directional guard so that
 * divergence can only fall back to its pre-continuation behaviour,
 * never swallow a gated head token. This function's own escape gaps are
 * task `b093911d`.
 */
function consumeInlineEnv(s: string, start: number, into: Record<string, string>): number {
  let i = skipWs(s, start);
  let lastGood = i;
  while (i < s.length) {
    const nameStart = i;
    if (!VAR_START.test(s[i]!)) break;
    i++;
    while (i < s.length && VAR_CONT.test(s[i]!)) i++;
    if (s[i] !== "=") break;
    const name = s.slice(nameStart, i);
    i++;
    // Read value: quoted (single/double, literal) or unquoted (to ws).
    let value: string;
    if (s[i] === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) return lastGood;
      value = s.slice(i + 1, end);
      i = end + 1;
    } else if (s[i] === '"') {
      const end = s.indexOf('"', i + 1);
      if (end < 0) return lastGood;
      value = s.slice(i + 1, end);
      i = end + 1;
    } else {
      const vStart = i;
      while (i < s.length && !WS.test(s[i]!)) i++;
      value = s.slice(vStart, i);
    }
    into[name] = value;
    i = skipWs(s, i);
    lastGood = i;
  }
  return lastGood;
}

/**
 * Consume a single leading `cd <path> [&&|;]` clause. Returns
 * `{path, next}` on success (where `next` is the cursor after the
 * separator), or null when the prefix does not match. A path that is
 * missing the trailing `&&` / `;` separator is treated as not-a-prefix
 * (the operator typed `cd <path>` and nothing else — no useful resolver
 * override).
 */
function consumeLeadingCd(s: string, start: number): { path: string; next: number } | null {
  let i = skipWs(s, start);
  // Match `cd` followed by whitespace; do NOT match `cd&&` or `cdx`.
  if (s[i] !== "c" || s[i + 1] !== "d") return null;
  if (i + 2 >= s.length || !WS.test(s[i + 2]!)) return null;
  i = skipWs(s, i + 2);
  // Path: quoted or unquoted.
  let path: string;
  if (s[i] === "'") {
    const end = s.indexOf("'", i + 1);
    if (end < 0) return null;
    path = s.slice(i + 1, end);
    i = end + 1;
  } else if (s[i] === '"') {
    const end = s.indexOf('"', i + 1);
    if (end < 0) return null;
    path = s.slice(i + 1, end);
    i = end + 1;
  } else {
    const pStart = i;
    while (i < s.length && !WS.test(s[i]!) && s[i] !== ";" && s[i] !== "&") i++;
    path = s.slice(pStart, i);
  }
  if (path.length === 0) return null;
  i = skipWs(s, i);
  if (s[i] === "&" && s[i + 1] === "&") {
    return { path, next: i + 2 };
  }
  if (s[i] === ";") {
    return { path, next: i + 1 };
  }
  return null;
}

/**
 * Match a literal keyword at `i` on a word boundary — immediately
 * followed by whitespace or end-of-string, never a partial-word match
 * (`"git"` must not match inside `"github"`, `"switch"` must not match
 * inside `"switching"`). Returns the cursor just past the keyword on
 * success, or null.
 */
function matchKeyword(s: string, i: number, word: string): number | null {
  if (s.slice(i, i + word.length) !== word) return null;
  const after = i + word.length;
  if (after < s.length && !WS.test(s[after]!)) return null;
  return after;
}

/**
 * Skip a single path token (quoted or unquoted) starting at `i`.
 * Returns the cursor just past it, or null on an unterminated quote or
 * an empty token. Deliberately a separate copy of `consumeLeadingCd`'s
 * path-reading rules rather than a shared helper: this function's only
 * caller (`consumeLeadingGitSwitch`'s `-C <path>` skip) discards the
 * value, `consumeLeadingCd`'s does not, and factoring them together was
 * judged not worth the risk to `consumeLeadingCd`'s existing,
 * separately-measured behavior for a value nothing here uses.
 */
function skipPathToken(s: string, i: number): number | null {
  if (s[i] === "'") {
    const end = s.indexOf("'", i + 1);
    return end < 0 ? null : end + 1;
  }
  if (s[i] === '"') {
    const end = s.indexOf('"', i + 1);
    return end < 0 ? null : end + 1;
  }
  const start = i;
  while (i < s.length && !WS.test(s[i]!) && s[i] !== ";" && s[i] !== "&") i++;
  return i > start ? i : null;
}

/**
 * Consume a single leading `git [-C <path>] (switch|checkout) <branch>
 * [&&|;]` clause (task 341e024b). Returns `{branch, next}` on success,
 * or null when the prefix does not match — including these deliberate
 * exclusions, which return null WITHOUT guessing a branch:
 *
 *   - A `-`-prefixed first argument after `switch`/`checkout` (`-`,
 *     `--`, `-b`, `-c`, `-C`, `--force`, ...). This specifically covers
 *     `git checkout -- <path>` (git's file-restore form — no branch is
 *     switched at all) as one case of the general rule "a flag is not a
 *     branch name", rather than special-casing `--` alone.
 *   - An unquoted `$VAR` / `${VAR}` first argument: a shell variable,
 *     not a literal branch name. Resolving it would require evaluating
 *     the shell environment, which this parser does not do (see module
 *     doc). A DOUBLE-quoted token whose content contains a `$` is
 *     excluded the same way (double quotes interpolate in real bash); a
 *     single-quoted token is never excluded on this basis (single
 *     quotes never interpolate, so its content is always the literal
 *     branch name).
 *   - A missing trailing `&&` / `;` separator, mirroring
 *     `consumeLeadingCd`'s identical rule: `git switch main` alone, with
 *     nothing following, has no "rest of command" for the branch
 *     candidate to apply to.
 *
 * The branch token itself is read as a single word up to the next
 * whitespace/`;`/`&` (unquoted — this covers slashed names like
 * `task/foo`, `release/1.2`, since branch names cannot contain
 * whitespace), OR, when the token opens with `'` or `"`, as a quoted
 * literal with the surrounding quotes stripped (task 341e024b fix round
 * 1) — mirroring `consumeLeadingCd`'s / `skipPathToken`'s quoted-token
 * handling, since a whitespace-free branch name can still be quoted by
 * the operator (`git switch "main"`), and an unstripped quote character
 * left inside the extracted token would never match a plain
 * `branch_patterns` entry.
 *
 * The optional leading `-C <path>` is recognized so it does not block
 * the match, but its value is discarded — see the module doc's form 3
 * for why only the branch name matters to the caller.
 */
function consumeLeadingGitSwitch(s: string, start: number): { branch: string; next: number } | null {
  let i = skipWs(s, start);
  const afterGit = matchKeyword(s, i, "git");
  if (afterGit === null) return null;
  i = skipWs(s, afterGit);
  const afterDashC = matchKeyword(s, i, "-C");
  if (afterDashC !== null) {
    i = skipWs(s, afterDashC);
    const skipped = skipPathToken(s, i);
    if (skipped === null) return null;
    i = skipWs(s, skipped);
  }
  let afterVerb = matchKeyword(s, i, "switch");
  if (afterVerb === null) afterVerb = matchKeyword(s, i, "checkout");
  if (afterVerb === null) return null;
  i = skipWs(s, afterVerb);
  if (i >= s.length) return null;
  // A `-`-prefixed or unquoted `$`-prefixed first argument is not a
  // plain branch name — do not guess (see doc comment above).
  if (s[i] === "-" || s[i] === "$") return null;
  let branch: string;
  if (s[i] === "'" || s[i] === '"') {
    // Quoted branch literal (task 341e024b fix round 1): strip the
    // surrounding quotes, mirroring `consumeLeadingCd`'s path handling.
    // A DOUBLE-quoted token containing `$` is left unresolved (real
    // bash interpolates inside double quotes; this parser does not
    // evaluate the shell environment) — a SINGLE-quoted token is always
    // literal, since single quotes never interpolate.
    const quote = s[i]!;
    const end = s.indexOf(quote, i + 1);
    if (end < 0) return null;
    const content = s.slice(i + 1, end);
    if (quote === '"' && content.includes("$")) return null;
    if (content.length === 0) return null;
    branch = content;
    i = end + 1;
  } else {
    const branchStart = i;
    while (i < s.length && !WS.test(s[i]!) && s[i] !== ";" && s[i] !== "&") i++;
    branch = s.slice(branchStart, i);
    if (branch.length === 0) return null;
  }
  i = skipWs(s, i);
  if (s[i] === "&" && s[i + 1] === "&") {
    return { branch, next: i + 2 };
  }
  if (s[i] === ";") {
    return { branch, next: i + 1 };
  }
  return null;
}
