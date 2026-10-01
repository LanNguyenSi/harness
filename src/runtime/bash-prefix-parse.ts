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
//   1. Inline env: leading `\w+=value` tokens. A value is read as one
//      shell word (see `readWord`): unquoted text, backslash escapes,
//      single-quoted parts (literal) and double-quoted parts (literal, no
//      $ interpolation in v1) glued together up to unescaped whitespace,
//      so `VAR="say \"hi\""` is `say "hi"` and `VAR='it'\''s'` is `it's`
//      (task b093911d). NOT covered, pinned by tests: ANSI-C `$'...'`
//      (kept as the raw text, not decoded), `$VAR` / `$(...)` (kept as
//      literal text), and `;` / `&` inside an UNQUOTED value (they do not
//      end it).
//   2. cd prefix: a single leading `cd <path> [&&|;] ...`. The path is
//      read as the same kind of shell word, ended at an unquoted `;` or
//      `&`. No `pushd`, no subshell `(cd X && ...)`, no `bash -c`.
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
//      than guessed; a token that STARTS with a quote and carries an
//      unescaped `$` in a double-quoted part (`"release/$V"`) is treated
//      the same way (not guessed) since double quotes DO interpolate in
//      real bash and this parser does not evaluate the shell
//      environment. A token that does NOT start with a quote but carries
//      such a `$` mid-word (`release/"$V"`) is read raw, quotes included,
//      exactly as before the escape-aware reader: bash expands it, so the
//      branch is unknown, but the raw word still matches a glob like
//      `release/*` and the clauses behind it (a later `cd`, the kubectl
//      remainder) stay reachable. A single-quoted token is always taken
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
// ESCAPES VS FALL-THROUGH (task b093911d): for a gate that SEARCHES for
// production indicators, falling through is not the safe direction, a
// dropped `cd` target or env value hides the very signal being looked
// for. So a quoted word is decoded the way bash reads it instead of
// being abandoned when it contains a backslash. Two places keep the OLD
// reading on purpose: a word whose quote only an escaped quote could
// close (`VAR="abc\" cd /x && y`, an unterminated string for bash), where
// the first matching quote ends the word, and a branch word that does not
// start with a quote but has a `$` in a double-quoted part (form 3).
//
// What was measured, and what was not: the cd targets on
// `scripts/measure-bash-prefix-parse.mjs`'s arms (no honest loss against
// master and the shipped release; 11 of 17 arms prove nothing), plus a
// bash-referee differential over generated commands (see the pull
// request). That is NOT a general "nothing extracted before is lost".
// Known residuals, not covered:
//   - a `cd` path or branch word that carries a quote or an escape and is
//     ended at an unquoted `|`, `<`, `>`, `(` or `)` (`cd /srv/p|ro"d"`)
//     rejects its clause and stops the prefix walk; the old reading
//     accepted a phantom word there and could reach a later honest
//     clause by accident;
//   - the plain `A=x|| cd /t && y` and an escape-led word ended by a
//     single `|` (`A=a\ b| cd /t && y`) still read the `cd` behind the
//     operator (bash skips it after `||` and runs it in a pipeline
//     subshell after `|`). Ending the walk at `||` and never reading a
//     `cd` clause after `|` is a separate follow-up, not done here;
//   - ANSI-C `$'...'` and `$VAR` / `$(...)` are kept as raw text.
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
    return { inlineEnv: newEnvMap(), cdTarget: null, branchTarget: null, remainderStart: 0 };
  }
  const inlineEnv = newEnvMap();
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

/**
 * The `inlineEnv` map. A null-prototype object, so an assignment to a
 * name that exists on `Object.prototype` is kept instead of lost:
 * `into["__proto__"] = value` on a plain `{}` runs the prototype
 * setter, which ignores a string, so `__proto__=/prod cd /x && ...`
 * used to drop the assignment without a trace. The same shape also
 * means a lookup of a name that was never assigned (`constructor`,
 * `toString`) reads as `undefined` instead of an inherited function.
 * Spreading it into a plain object (what the resolver does) creates
 * own data properties, `__proto__` included.
 */
function newEnvMap(): Record<string, string> {
  return Object.create(null) as Record<string, string>;
}

/** Unquoted, unescaped characters that end a word (see `readWord` for where the old reading is kept instead). */
const WORD_STOPS = ";&|<>()";
/** Extra word terminators of a plain inline env value (none) and of a plain `cd` path / branch token. */
const ENV_PLAIN_STOPS = "";
const PATH_PLAIN_STOPS = ";&";

/** One shell word read by `readWord` / `readWordLegacy`. */
interface WordRead {
  /** The word's literal text after quote removal and escape decoding. */
  value: string;
  /** Cursor just past the word. */
  next: number;
  /**
   * True when an UNESCAPED `$` sat inside a double-quoted part: real bash
   * would interpolate it, and this parser does not evaluate the shell
   * environment, so a caller that must not guess (the branch token) treats
   * the word as unresolved.
   */
  interpolates: boolean;
}

/**
 * Read one shell word starting at `start`, the way bash does: a run of
 * unquoted text, backslash escapes, single-quoted parts and double-quoted
 * parts, glued together until the first unquoted, unescaped whitespace
 * (task b093911d). `'it'\''s fine'` is therefore ONE word (`it's fine`),
 * and so is `"say \"hi\""`.
 *
 *   - Outside quotes `\x` is the literal `x`; a backslash-newline pair
 *     vanishes (line continuation); a backslash that ends the string is a
 *     literal backslash (bash does the same for `bash -c 'VAR=a\'`).
 *   - In single quotes nothing is special, a backslash included.
 *   - In double quotes a backslash escapes only `"`, `\`, `$`, `` ` `` and
 *     a newline; before any other character it stays a literal backslash.
 *     `$VAR` / `$(...)` are NOT evaluated: they stay literal text (v1).
 *   - An unquoted `$'...'` (ANSI-C quoting) is NOT decoded: the raw text
 *     including its `$'` and `'` is kept, so the value is no worse than
 *     before (explicitly not covered).
 *
 * Pre-existing behaviour that is kept to limit what the new reader can
 * lose (bash itself ends a word at every unquoted shell metacharacter;
 * this is not a no-loss guarantee, see the module doc's residuals):
 *   - a word with no quote and no backslash in it is read exactly as
 *     before (`readWordLegacy`): an inline env value ends at whitespace
 *     only, so it swallows an unquoted `;`, `&`, `|`, ...; a `cd` path or
 *     branch token (`plainStops` = `;&`) ends at whitespace or `;` / `&`;
 *   - an inline env word that carries an escape or a mid-word quote but
 *     does not START with a quote (`swallowOps`) keeps swallowing the
 *     same operators, because the old reading did and a later assignment
 *     behind them (`V=\"& W=/tmp cmd`) was extracted through it. It ends
 *     at an unquoted `||` though (bash never runs what follows a pure
 *     assignment on the left of `||`), so `A=a\ b|| cd /x && y` reads no
 *     `cd`; a single `|` is still swallowed (`A=a\ b| cd /x && y` reads
 *     the `cd`, like the plain `A=x|| cd /x && y` always has: a known
 *     phantom, not covered);
 *   - a word that STARTS with a quote, and every `cd` / branch word, ends
 *     at an unquoted, unescaped `;`, `&`, `|`, `<`, `>`, `(` or `)`, so
 *     `A='a b'|| cd /x && y` ends the value at `||` and never reads the
 *     `cd` behind a short-circuit or a pipe as a leading one (the old
 *     reading also stopped right after the closing quote).
 *
 * Returns null when a quote has no closing quote. Never throws.
 */
function readWord(
  s: string,
  start: number,
  plainStops: string,
  swallowOps: boolean,
): WordRead | null {
  let end = start;
  while (end < s.length && !WS.test(s[end]!) && !plainStops.includes(s[end]!)) end++;
  if (!/['"\\]/.test(s.slice(start, end))) return readWordLegacy(s, start, plainStops);
  const swallow = swallowOps && s[start] !== "'" && s[start] !== '"';
  const stops = swallow ? "" : WORD_STOPS;
  let i = start;
  let value = "";
  let interpolates = false;
  while (i < s.length) {
    const c = s[i]!;
    if (WS.test(c) || stops.includes(c)) break;
    // A swallowing word still ends at an unquoted `||`: bash never runs
    // what follows a pure assignment on the left of `||`, so nothing an
    // honest command needs is behind it.
    if (swallow && c === "|" && s[i + 1] === "|") break;
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) return null;
      value += s.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      i++;
      let closed = false;
      while (i < s.length) {
        const d = s[i]!;
        if (d === '"') {
          closed = true;
          i++;
          break;
        }
        if (d === "\\" && i + 1 < s.length) {
          const e = s[i + 1]!;
          if (e === '"' || e === "\\" || e === "$" || e === "`") {
            value += e;
            i += 2;
            continue;
          }
          if (e === "\n") {
            i += 2;
            continue;
          }
        } else if (d === "$") {
          interpolates = true;
        }
        value += d;
        i++;
      }
      if (!closed) return null;
    } else if (c === "\\") {
      if (i + 1 < s.length) {
        if (s[i + 1] !== "\n") value += s[i + 1];
        i += 2;
      } else {
        value += c;
        i++;
      }
    } else if (c === "$" && s[i + 1] === "'") {
      let j = i + 2;
      while (j < s.length && s[j] !== "'") j += s[j] === "\\" ? 2 : 1;
      if (j >= s.length) return null;
      value += s.slice(i, j + 1);
      i = j + 1;
    } else {
      value += c;
      i++;
    }
  }
  return { value, next: i, interpolates };
}

/**
 * The reading this module used before it knew about escapes: a word that
 * opens with a quote ends at the FIRST matching quote character, any
 * other word ends at whitespace (and at any character of `plainStops`).
 * Kept as the fall-back for a word `readWord` cannot terminate, so that
 * word still yields what the old reading yielded (`VAR="abc\" cd /x && y`
 * is an unterminated string for bash, but the old reading still yields
 * `VAR` and the `cd`). Null only for a quote with no closing quote at all.
 */
function readWordLegacy(s: string, start: number, plainStops: string): WordRead | null {
  const first = s[start];
  if (first === "'" || first === '"') {
    const end = s.indexOf(first, start + 1);
    if (end < 0) return null;
    const value = s.slice(start + 1, end);
    return { value, next: end + 1, interpolates: first === '"' && value.includes("$") };
  }
  let i = start;
  while (i < s.length && !WS.test(s[i]!) && !plainStops.includes(s[i]!)) i++;
  return { value: s.slice(start, i), next: i, interpolates: false };
}

/** `readWord`, else `readWordLegacy`; null only when no reading closes the quote. */
function readWordOrLegacy(
  s: string,
  start: number,
  plainStops: string,
  swallowOps: boolean,
): WordRead | null {
  return readWord(s, start, plainStops, swallowOps) ?? readWordLegacy(s, start, plainStops);
}

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
 * the known state instead of rediscovering it (task 13e55484; updated
 * by task b093911d): `command-normalize.ts`'s
 * `consumeAssignment` is a SECOND quote model for the same leading
 * `VAR=value` construction. Both now handle backslash escapes (outside
 * single quotes) and chained quote runs (`'a b'"c d"`), but they stay
 * two separate implementations (not unified), and this function
 * extracts the VALUE (which the normaliser never needs). Neither model
 * handles ANSI-C `$'...'` escapes; the normaliser side carries a
 * one-directional guard so that divergence can only fall back to its
 * pre-continuation behaviour, never swallow a gated head token.
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
    // Read the value as one shell word: unquoted text, backslash escapes
    // and quoted parts glued together up to unescaped whitespace.
    const word = readWordOrLegacy(s, i, ENV_PLAIN_STOPS, true);
    if (word === null) return lastGood;
    const value = word.value;
    i = word.next;
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
  // Path: one shell word (quotes, escapes and quote runs as in an env value).
  const word = readWordOrLegacy(s, i, PATH_PLAIN_STOPS, false);
  if (word === null) return null;
  const path = word.value;
  i = word.next;
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
 * an empty token. Reads the token with the same `readWordOrLegacy` rules
 * `consumeLeadingCd` uses for its path; this function's only caller
 * (`consumeLeadingGitSwitch`'s `-C <path>` skip) discards the value.
 */
function skipPathToken(s: string, i: number): number | null {
  const word = readWordOrLegacy(s, i, PATH_PLAIN_STOPS, false);
  return word !== null && word.next > i ? word.next : null;
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
 *     doc). A token that STARTS with a quote and carries an unescaped `$`
 *     in a double-quoted part is excluded the same way (double quotes
 *     interpolate in real bash); a single-quoted token is never excluded
 *     on this basis (single quotes never interpolate, so its content is
 *     always the literal branch name). A token that does not start with a
 *     quote but has such a `$` mid-word (`release/"$V"`) is NOT excluded:
 *     it is read raw (quotes kept) as before, so a glob like `release/*`
 *     and the clauses behind it still resolve.
 *   - A missing trailing `&&` / `;` separator, mirroring
 *     `consumeLeadingCd`'s identical rule: `git switch main` alone, with
 *     nothing following, has no "rest of command" for the branch
 *     candidate to apply to.
 *
 * The branch token is read as ONE shell word, with the same rules as a
 * `cd` path (`readWordOrLegacy`, ended at whitespace / `;` / `&`): an
 * unquoted slashed name like `task/foo` or `release/1.2`, a quoted
 * literal with its quotes stripped (task 341e024b: a quote character
 * left inside the token would never match a plain `branch_patterns`
 * entry), and, since task b093911d, backslash escapes
 * and chained quote runs (`'it'\''s'`, `"ma\"in"`, `feat\ x`).
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
  // One shell word, quotes and escapes decoded like a `cd` path (task
  // 341e024b for the quote stripping, task b093911d for the escapes). A word with an UNESCAPED `$` inside double quotes is left
  // unresolved (real bash interpolates there; this parser does not
  // evaluate the shell environment); a single-quoted `$` and an escaped
  // `\$` are literal and kept.
  let word = readWordOrLegacy(s, i, PATH_PLAIN_STOPS, false);
  // A word that does NOT start with a quote but carries a `$` in a
  // double-quoted part (`release/"$V"`): bash expands it, so the branch
  // is unknown, but the pre-change reading kept the raw word (quotes
  // included, which still matches a glob such as `release/*`) and went on
  // to the clauses behind it (a later `cd`, the kubectl remainder). Fall
  // back to that reading instead of dropping them. A word that starts
  // with a double quote stays unresolved: the pre-change reading did the
  // same. One that starts with a single quote cannot be saved either: the
  // old reading ends it at the first closing quote, and a `$` part glued
  // behind it means the next character is neither whitespace nor `;` / `&`.
  if (word !== null && word.interpolates && s[i] !== '"') {
    word = readWordLegacy(s, i, PATH_PLAIN_STOPS);
  }
  if (word === null || word.interpolates) return null;
  const branch = word.value;
  if (branch.length === 0) return null;
  i = word.next;
  i = skipWs(s, i);
  if (s[i] === "&" && s[i + 1] === "&") {
    return { branch, next: i + 2 };
  }
  if (s[i] === ";") {
    return { branch, next: i + 1 };
  }
  return null;
}
