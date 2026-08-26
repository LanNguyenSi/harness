// Risk Gate — static deletion-target resolver (task d03af8f6).
//
// The existing `dangerous-shell` classifier + `gate-prod-destructive*`
// policies gate a destructive shell action only when the Context
// Resolver resolves `environment: production`. On a task branch the
// environment is `unknown`, and every deletion — including one whose
// target is a typo or a stale variable pointing outside any scratch
// area — runs unconfirmed. This module closes that specific gap: it
// recognizes a deletion-verb command (`rm -r*`/`-f*`, `find ... -delete`
// or `find ... -exec*/-execdir/-ok/-okdir rm ...`, `git clean -f*`) and
// decides, STATICALLY (no filesystem I/O, no process-env read, no
// shell-variable expansion, no cwd substitution), whether every target
// it names is provably inside a declared `risk.safe_deletion_roots`
// entry. `src/runtime/when-eval.ts`'s `action.deletion_target_unresolvable`
// clause reads the verdict this module produces to gate
// environment-INDEPENDENTLY, deliberately NOT reusing the `risk.*`
// when-clauses (see that module's own doc comment for why: those
// clauses fail-close to matched=true for ANY unclassified action, which
// would make an unscoped policy fire on every unrelated unclassified
// Bash call in every environment — approval spam, not a deletion-
// specific gate).
//
// Recognition rule (current):
//   1. Segments come from BOTH of `command-normalize.ts`'s segmentation
//      arms — `segmentViewOf` (the primary alphabet) AND
//      `segmentViewOfAmpAware` (the same alphabet plus a bare `&`) —
//      each arm walked in command order (`collectSegmentArms`), verdicts
//      combined additively and de-duplicated by exact segment text. A
//      verdict from EITHER arm counts toward the combined result:
//      unresolvable if any recognized segment is, resolved only if every
//      recognized segment is (`combineVerdicts`). Within one arm, a
//      `find`-headed segment's search roots are carried into a directly
//      following segment headed by a `find` primitive (`SegmentCarry`):
//      `;` is a segment boundary, so `find <root> -exec echo {} \; -exec
//      rm -rf {} \;` puts the deleting `-exec` in a segment of its own.
//      When both arms decline (a command past `MAX_NORMALIZE_LENGTH`)
//      this module falls back to a single-first-segment contract.
//   2. Per segment, before the head test: a leading `cd <path> &&` /
//      `VAR=value` prefix is skipped (`parseBashPrefix`); a `#` word
//      starts a comment and ends the segment; a leading run of shell
//      keywords and group markers that precede a command (`if`, `then`,
//      `else`, `elif`, `while`, `until`, `do`, `!`, `{`, `)`, `){`) is
//      stripped, as is a trailing `}`/`;` token, a trailing `)` glued
//      to the last token, and a trailing bare `&`.
//   3. A wrapper prefix on the deletion verb is peeled with
//      `command-normalize.ts`'s own exported `peelWrapperPrefixes`
//      (`sudo`, `doas`, `command`, `env`, `time`, `timeout`, `nice`,
//      `stdbuf`, `setsid`, `exec`, `nohup`). Three wrappers are peeled
//      LOCALLY first (`peelWrapperHeadsAndXargs`): `exec -a <name>` (the
//      shared peeler treats `-a` as boolean, which would leave `<name>`
//      as the head), the multi-call binaries `busybox`/`toybox` (their
//      first argument IS the verb), and `xargs` (bare or path-qualified,
//      `XARGS_HEAD_RE`). After `xargs`, a bounded forward scan finds the
//      first token that is itself a recognized deletion-verb head, with
//      no parsing of `xargs`'s own option vocabulary; when one is found
//      the invocation is `xargsWrapped`, and EVERY resolver then returns
//      UNRESOLVABLE regardless of any explicit operand: `xargs` appends
//      (or substitutes) stdin-supplied operands at runtime, which are
//      never statically knowable, so `xargs rm -rf /tmp/known` gates
//      exactly like `xargs rm -rf` does. The forward scan does not stop
//      at an intervening non-verb command word, so `xargs echo rm -rf
//      /home/x` (which only prints) is gated too — accepted over-gate.
//   4. A recognised `rm` head accepts a path-qualified spelling
//      (`/bin/rm`, `RM_HEAD_RE`); a `git` head likewise (`GIT_HEAD_RE`),
//      and `git`'s own global options between `git` and `clean` are
//      skipped (`-C`/`--git-dir`/`--work-tree`/`--namespace`/`-c`/
//      `--config-env` with their value, any other `-`-prefixed token
//      alone) so an option `command-normalize.ts` does not canonicalize
//      away cannot hide the subcommand.
//   5. Every token is decoded with `decodeShellWord` (`shell-word.ts`)
//      before any verb/flag/`-delete` comparison; the raw tokenizer
//      honours single/double/ANSI-C quotes and a backslash escape, so
//      `rm -rf /tmp/x\ y` is one operand, as it is for bash.
//   6. `find`: leading `-H`/`-L` and the `-follow` primary make the
//      verdict unresolvable (find would follow a symlink out of the
//      root); `-P`, `-E`, `-X`, `-d`, `-s`, `-x`, `-O<n>`, `-D <opts>` are
//      skipped and BSD `-f <path>` contributes its path. The search
//      roots are the leading non-flag operands (`findPathOperands`,
//      stopping at the first `!` or `-`-prefixed token). An `-exec`/
//      `-execdir`/`-ok`/`-okdir` whose payload head matches `RM_HEAD_RE`
//      is a recognized deletion; the payload's own explicit operands
//      (every non-flag token other than the exact `{}` placeholder, up to
//      a `+` terminator or the end of the segment — the `;` terminator is
//      a segment boundary, so its orphaned escape `\`/`'`/`"` token is
//      dropped) are ADDITIONAL targets resolved like any other, so `find
//      /tmp/x -exec rm -rf /home/y \;` gates on `/home/y`.
//   7. `git clean`: recognized with `-f`/`--force`/a short cluster
//      containing `f`, OR when the command text anywhere mentions
//      `clean.requireForce` (case-insensitive: `git -c
//      clean.requireForce=false clean`, `GIT_CONFIG_PARAMETERS=...`, a
//      `git config clean.requireForce false &&` earlier in the same
//      command) — `command-normalize.ts` canonicalizes `git -c k=v
//      clean` to `git clean`, so the override must be read from the raw
//      command. `-e`/`--exclude` consume their value; a bare `(`/`)`
//      token is never a pathspec; a bare `-n`/`--dry-run` invocation
//      without a force flag stays unrecognized (git refuses to delete).
//   8. A target is resolved ONLY when ALL of the following hold; each
//      failing check is a closed CLASS, not an instance:
//      - it contains no `$` (variable/command substitution), no backtick
//        (command substitution), and no `{` (brace expansion, or an
//        `xargs`/`find` placeholder);
//      - it starts with `/` (relative and every `~`-prefixed form is
//        unresolvable — this module never consults cwd);
//      - it does not end in `/` or `/.` (a trailing slash makes `rm`
//        and `find` follow a symlinked directory into its target —
//        measured: `rm -rf <link>/` removed the link's target directory);
//      - no path component is `..` (a lexical collapse assumes no
//        component is a symlink; `/tmp/<link>/../y` physically resolves
//        relative to the link's TARGET);
//      - no path component is a glob that can expand to `..`: a
//        component starting with an explicit `.` whose remainder can
//        match `.` (`.*`, `..*`, `.?`, `.[.]`, `.[!x]`; see
//        `globComponentCanMatchDotDot`) — bash only ever matches `.`/`..`
//        against an explicit leading dot, so `.[!.]*` and `.??*` stay
//        resolvable;
//      - its final component is not a bare `*`/`**`;
//      - when the command contains an extglob opener (`?(`, `*(`, `+(`,
//        `@(`, `!(`), the target does not end in one of those characters
//        (the `(` is a segment boundary, so the token is the cut-off
//        pattern head);
//      - after `.`/`//` normalization it lies STRICTLY inside a declared
//        root (`root + "/"` prefix; the root itself never counts, for
//        every verb alike).
//   9. Redirection operands are never targets (`REDIRECT_TOKEN_RE`; a
//      bare operator also drops the following filename token), and
//      target collection stops at a bare `&`.
//
// Never throws. Returns `null` when no shell segment of `command`, by
// the narrow head test above, names a recognized deletion verb at all.
//
// NOT COVERED (deliberate residuals, pinned as a `toBeNull()`/no-op test
// in `tests/runtime/deletion-target-resolve.test.ts` so a future change
// that accidentally starts "recognizing" one of these shapes is caught):
//   - `bash -c 'rm -rf /home/x'` / `sh -c '...'` / `env -S '...'` /
//     `find ... -exec sh -c '...'`: the wrapped command lives inside a
//     single string argument this module does not parse into. More
//     generally, a `find -exec`/`-execdir`/`-ok`/`-okdir` payload whose
//     head is not `rm` (`xargs rm -rf {} +`, `bash -c`, `perl -e`, ...)
//     is not recognized as a deletion at all: only an `rm` payload is.
//   - Backslash-newline line continuation (`rm -rf \<newline>/tmp/x`):
//     the newline is a segment boundary before the tokenizer can join
//     the lines, so the lone `\` becomes a relative target and the
//     command over-gates (fail-closed, never a missed deletion).
//   - `eval "rm -rf /home/x"`: `eval`'s argument is a STRING to be
//     re-parsed, not "the command to run" positionally.
//   - `sh script.sh` / `bash script.sh` / any script FILE the agent
//     writes and then executes: this module never reads a file's
//     contents.
//   - `shred`, `rmdir`, `unlink`: real deletion-shaped verbs outside
//     this module's closed head-token set (`rm`, `find`, `git clean`).
//   - `npm run clean` (or any `package.json` script / Makefile target /
//     CI job whose NAME suggests deletion): this module inspects the
//     literal command line only, never a script's own body.
//   - `` `rm -rf /home/x` `` (backtick command substitution): the
//     deletion command lives inside a substitution this module does not
//     parse into.
//   - `find /home '(' -name a ')' -delete` (grouped `find` expression
//     with QUOTED parentheses): `(` is a segment boundary in both
//     `command-normalize.ts` alphabets, quote-unaware, and the cut lands
//     inside the quoted run, so the continuation segment's own tokens
//     are mis-quoted and its `-delete` is never seen. The escaped
//     spelling `\( ... \)` IS covered, via the continuation carry
//     (rule 1): the cut leaves `-delete` at the head of its own segment.
//   - A `case` arm (`case x in *) rm -rf /home/x;; esac`): the arm's
//     pattern and `)` are glued to the command's own segment head.
//   - Runners outside the peeled wrapper set that hand their argv to
//     another program: `parallel`, `ionice`, `chrt`, `taskset`,
//     `caffeinate`, `flock <file>`, `strace`, `ssh <host>`, `docker
//     exec <c>`, `chroot <dir>`, `su -c`, `watch`.
//   - A symlink inside a root pointing outside it, when the command
//     names the link WITHOUT a trailing slash (`rm -rf /tmp/link/y`
//     deletes `<target>/y`): only the trailing-slash and `..` spellings
//     are lexically visible.
//   - A `clean.requireForce=false` git config set OUTSIDE the command
//     text (repository config, an earlier command): same literal-
//     command-line ceiling as scripts.
//   - Any command past `MAX_NORMALIZE_LENGTH` (100,000 characters,
//     `command-normalize.ts`) falls back to a single-first-segment
//     contract: only the FIRST shell segment of such an oversized
//     command is inspected, so a recognized deletion verb in a LATER
//     segment goes unrecognized.
//
// History and measurements: CHANGELOG.md, task d03af8f6.

import { parseBashPrefix } from "./bash-prefix-parse.js";
import {
  GIT_GLOBAL_VALUE_TAKING_FLAGS,
  peelWrapperPrefixes,
  segmentViewOf,
  segmentViewOfAmpAware,
  type WrapperPeelToken,
} from "./command-normalize.js";
import { firstSegment } from "./kubectl-target-parse.js";
import { decodeShellWord } from "./shell-word.js";

/** Verdict for one recognized deletion-verb command. */
export interface DeletionTargetVerdict {
  /**
   * The recognized deletion verb. When a chained command names MORE
   * THAN ONE recognized deletion segment, this names only the FIRST
   * recognized segment's verb — `unresolvable`/`targets`/
   * `unresolvedTargets` still account for every recognized segment; see
   * `combineVerdicts`.
   */
  verb: "rm" | "find" | "git-clean";
  /** Every target token this invocation acts on, in encounter order
   *  (across every recognized segment, when there is more than one). */
  targets: string[];
  /** The subset of `targets` that could not be statically proven safe. */
  unresolvedTargets: string[];
  /** True when at least one target is unresolved — the action should be gated. */
  unresolvable: boolean;
  /** One human-readable summary line (joined across segments with `; `
   *  when more than one recognized deletion segment contributed). */
  reason: string;
}

/** Per-command facts every resolver needs — computed ONCE from the raw
 *  command text in `resolveDeletionTarget` (module header points 7 and
 *  8), never from a canonicalized segment, because canonicalization
 *  can erase them. */
interface ResolveContext {
  safeRoots: readonly string[];
  /** The command text mentions `clean.requireForce` anywhere. */
  gitRequireForceOverride: boolean;
  /** The command text contains an extglob opener (`?(`, `*(`, ...). */
  extglobOpener: boolean;
}

const WS = /\s/;

function skipWs(s: string, i: number): number {
  while (i < s.length && WS.test(s[i]!)) i++;
  return i;
}

/**
 * Whitespace-delimited tokenizer that preserves each token's raw text
 * (quote/escape characters included, nothing stripped) so
 * `decodeShellWord` can decode it afterward. A single-quoted, double-
 * quoted, or ANSI-C (`$'...'`) run is tracked so embedded whitespace or
 * a chain-boundary-looking character inside it does not split the
 * token early, and an unquoted backslash escapes the character after
 * it (so `/tmp/x\ y` is ONE token, as it is one operand for bash). A
 * token that STARTS with an unquoted `#` begins a comment: it and
 * everything after it are dropped. The boundary-tracking shape mirrors
 * `kubectl-target-parse.ts`'s own tokenizer, duplicated deliberately
 * rather than imported: that module's tokenizer strips quote characters
 * inline as it scans, discarding exactly the raw text this module needs
 * to hand to `decodeShellWord`. NOT reused from `command-normalize.ts`
 * either: that module's own `tokenizeWithOffsets` is deliberately
 * whitespace-naive (no quote tracking at all — see its own module
 * header's "quoted directory arguments containing whitespace" NOT-
 * SUPPORTED note), which would lose the obfuscated-flag coverage
 * (`find /home/x $'\x2ddelete'`) if reused wholesale; this module's
 * peeling reuses `command-normalize.ts`'s wrapper-peeling FUNCTIONS
 * (which only ever read a token's already-decoded `.text`, never
 * re-tokenize), not its tokenizer.
 */
function tokenizeRaw(segment: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const n = segment.length;
  while (i < n) {
    i = skipWs(segment, i);
    if (i >= n) break;
    if (segment[i] === "#") break; // comment: the rest of the segment is not a command
    const start = i;
    while (i < n && !WS.test(segment[i]!)) {
      const c = segment[i]!;
      if (c === "\\") {
        i += i + 1 < n ? 2 : 1;
        continue;
      }
      if (c === "'") {
        const end = segment.indexOf("'", i + 1);
        i = end < 0 ? n : end + 1;
        continue;
      }
      if (c === '"') {
        let j = i + 1;
        while (j < n && segment[j] !== '"') {
          if (segment[j] === "\\") j++;
          j++;
        }
        i = j < n ? j + 1 : n;
        continue;
      }
      if (c === "$" && segment[i + 1] === "'") {
        let j = i + 2;
        while (j < n && segment[j] !== "'") {
          if (segment[j] === "\\") j++;
          j++;
        }
        i = j < n ? j + 1 : n;
        continue;
      }
      i++;
    }
    tokens.push(segment.slice(start, i));
  }
  return tokens;
}

/** A path-qualified `rm` head (`/bin/rm`, `/usr/bin/rm`) as well as the
 *  bare word. No nested quantifiers — a single bounded `\S*` alternative. */
const RM_HEAD_RE = /^(?:\S*\/)?rm$/;
/** Same shape for `git` — `command-normalize.ts` canonicalizes a
 *  path-qualified `git` already, but the oversized-command fallback
 *  hands this module un-canonicalized text. */
const GIT_HEAD_RE = /^(?:\S*\/)?git$/;
/** Same shape for `xargs` (`/usr/bin/xargs`). */
const XARGS_HEAD_RE = /^(?:\S*\/)?xargs$/;

/** Normalize a `safeRoots` entry: strip a trailing `/**`, `/*`, or `/`. */
function normalizeRoot(root: string): string {
  let r = root.trim();
  if (r.endsWith("/**")) r = r.slice(0, -3);
  else if (r.endsWith("/*")) r = r.slice(0, -2);
  while (r.length > 1 && r.endsWith("/")) r = r.slice(0, -1);
  return r;
}

/** POSIX path normalization without any filesystem I/O — collapses
 * `.`/`..`/empty segments lexically. Manual (not `node:path`) so this
 * module has no platform-path dependency: harness's own scratchpad
 * convention and every fixture in this task are POSIX paths regardless
 * of host OS. A TARGET never reaches this with a `..` component (module
 * header point 8 rejects it first); the `..` branch serves root entries. */
function normalizePosixPath(p: string): string {
  const absolute = p.startsWith("/");
  const parts = p.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(part);
  }
  const joined = out.join("/");
  return absolute ? `/${joined}` : joined || ".";
}

/** True when `target` (already known absolute) lies STRICTLY inside one
 * of `safeRoots` — the root path itself never counts, for ANY
 * recognized verb (`rm`, `find`, `git-clean` alike; `find`'s own start
 * point is removed by `-delete`/`-exec`, the same way `rm`'s operand
 * is, so it gets no exception). A target whose final path segment is a
 * bare glob-sugar `*`/`**` never counts either, regardless of which
 * root it would otherwise sit under. */
function isInsideAllowlist(target: string, safeRoots: readonly string[]): boolean {
  const normalizedTarget = normalizePosixPath(target);
  const lastSlash = normalizedTarget.lastIndexOf("/");
  const lastSegment = normalizedTarget.slice(lastSlash + 1);
  if (lastSegment === "*" || lastSegment === "**") return false;
  for (const rawRoot of safeRoots) {
    const root = normalizePosixPath(normalizeRoot(rawRoot));
    if (normalizedTarget.startsWith(`${root}/`)) return true;
  }
  return false;
}

const GLOB_META_RE = /[*?[]/;

/**
 * Minimal `fnmatch` over `*`, `?`, and `[...]` (with `!`/`^` negation,
 * ranges, a leading `]` literal, and a POSIX class `[:name:]` treated
 * conservatively as matching anything). Only ever asked about very
 * short subjects (`.`) — see `globComponentCanMatchDotDot`. Iterative
 * two-pointer `*` backtracking; bounded by the pattern length.
 */
function globMatches(pattern: string, subject: string): boolean {
  let p = 0;
  let s = 0;
  let starP = -1;
  let starS = -1;
  while (s < subject.length) {
    if (p < pattern.length && pattern[p] === "*") {
      starP = p++;
      starS = s;
      continue;
    }
    const step = matchOne(pattern, p, subject[s]!);
    if (step !== null) {
      p = step;
      s++;
      continue;
    }
    if (starP >= 0) {
      p = starP + 1;
      s = ++starS;
      continue;
    }
    return false;
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}

/** Match ONE subject character at `pattern[p]`; returns the next pattern
 *  index or `null` when it does not match. */
function matchOne(pattern: string, p: number, ch: string): number | null {
  if (p >= pattern.length) return null;
  const c = pattern[p]!;
  if (c === "?") return p + 1;
  if (c !== "[") return c === ch ? p + 1 : null;
  const close = findBracketClose(pattern, p);
  if (close < 0) return c === ch ? p + 1 : null; // unterminated: literal `[`
  const body = pattern.slice(p + 1, close);
  if (body.includes("[:")) return close + 1; // POSIX class: assume it can match
  let negate = false;
  let i = 0;
  if (body[0] === "!" || body[0] === "^") {
    negate = true;
    i = 1;
  }
  let hit = false;
  while (i < body.length) {
    const lo = body[i]!;
    if (body[i + 1] === "-" && i + 2 < body.length) {
      const hi = body[i + 2]!;
      if (lo <= ch && ch <= hi) hit = true;
      i += 3;
      continue;
    }
    if (lo === ch) hit = true;
    i++;
  }
  return hit !== negate ? close + 1 : null;
}

function findBracketClose(pattern: string, open: number): number {
  let i = open + 1;
  if (pattern[i] === "!" || pattern[i] === "^") i++;
  if (pattern[i] === "]") i++; // a leading `]` is literal
  while (i < pattern.length && pattern[i] !== "]") i++;
  return i < pattern.length ? i : -1;
}

/** True when a path component is a glob pattern that can expand to
 *  `..` (module header point 8): bash matches `.`/`..` only against an
 *  EXPLICIT leading `.` (never `*`, `?`, or `[.]` — measured on bash
 *  3.2, with and without `dotglob`), so the test is "starts with a
 *  literal `.`, contains a glob metacharacter, and the remainder can
 *  match a single `.`". `..*` (remainder `.*`), `.?`, `.[.]`, `.[!x]`,
 *  `.*` all qualify; `.[!.]*` and `.??*` (the safe idioms) do not. */
function globComponentCanMatchDotDot(component: string): boolean {
  if (!component.startsWith(".") || !GLOB_META_RE.test(component)) return false;
  return globMatches(component.slice(1), ".");
}

const EXTGLOB_OPENER_RE = /[?*+@!]\(/;
const EXTGLOB_TAIL_RE = /[?*+@!]$/;

/** Resolve one raw (decoded) target token. `false` = unresolvable (gate
 * it). Every check is a CLASS rule — module header point 8. */
function targetIsResolvedSafe(token: string, ctx: ResolveContext): boolean {
  if (token.includes("$")) return false; // unexpanded variable / $(...) substitution
  if (token.includes("`")) return false; // backtick command substitution
  if (token.includes("{")) return false; // brace expansion, or an xargs/find placeholder
  // Relative (does not start with `/`) — this also covers every
  // `~`-prefixed token, since `~foo` is never `/`-prefixed.
  if (!token.startsWith("/")) return false;
  // A trailing `/` or `/.` follows a symlinked directory into its target.
  if (token.endsWith("/") || token.endsWith("/.")) return false;
  for (const component of token.split("/")) {
    if (component === "..") return false; // physical `..` through a symlink escapes
    if (globComponentCanMatchDotDot(component)) return false;
  }
  if (ctx.extglobOpener && EXTGLOB_TAIL_RE.test(token)) return false;
  return isInsideAllowlist(token, ctx.safeRoots);
}

function buildVerdict(
  verb: DeletionTargetVerdict["verb"],
  targets: string[],
  ctx: ResolveContext,
): DeletionTargetVerdict {
  const unresolvedTargets = targets.filter((t) => !targetIsResolvedSafe(t, ctx));
  const unresolvable = unresolvedTargets.length > 0;
  const reason = unresolvable
    ? `${verb}: target(s) not statically resolvable inside a declared risk.safe_deletion_roots entry: ${unresolvedTargets.join(", ")}`
    : `${verb}: every target resolves inside a declared risk.safe_deletion_roots entry`;
  return { verb, targets, unresolvedTargets, unresolvable, reason };
}

/** A verdict that is unresolvable REGARDLESS of what its targets are —
 *  every target is reported as unresolved and `why` explains the
 *  invocation-level reason (an `xargs` wrapper, a symlink-following
 *  `find`). Never resolves anything. */
function forcedUnresolvableVerdict(
  verb: DeletionTargetVerdict["verb"],
  targets: string[],
  why: string,
): DeletionTargetVerdict {
  return {
    verb,
    targets,
    unresolvedTargets: targets,
    unresolvable: true,
    reason: `${verb}: ${why}: ${targets.join(", ")}`,
  };
}

const XARGS_SYNTHETIC_TARGET = "(xargs-supplied target, not statically known)";
const XARGS_WHY = "xargs supplies its operand(s) from stdin at runtime, never statically knowable";

/** Module header point 3: an `xargs`-wrapped deletion is unresolvable
 *  whatever explicit operands it also names; those are reported (never
 *  resolved) after the synthetic stdin marker. */
function xargsVerdict(verb: DeletionTargetVerdict["verb"], explicitTargets: string[]): DeletionTargetVerdict {
  return forcedUnresolvableVerdict(verb, [XARGS_SYNTHETIC_TARGET, ...explicitTargets], XARGS_WHY);
}

/**
 * Drop a redirection operand token — `REDIRECT_TOKEN_RE` (module header
 * point 9): an optional leading fd number followed by `<`/`>`, OR a
 * bare `&>`/`&>>` (bash's own combined stdout+stderr redirect, which
 * does NOT start with a digit or `<`/`>` and so needs a separate
 * alternative). Covers `>`, `>>`, `<`, `<<`, `<<<`, `>&`, `<&`, `&>`,
 * `&>>`, and a glued form like `>/dev/null` or `2>&1`. When the matched
 * token IS the bare operator (nothing glued to it —
 * `BARE_REDIRECT_OPERATOR_RE`), the FOLLOWING token (the filename, when
 * whitespace-separated from the operator) is dropped too — `rm -rf
 * /tmp/x >& out` drops `out` the same way `rm -rf /tmp/x > out` does.
 * Applied to the "rest" tokens of every resolver, before flag/target
 * parsing — a redirection operand is never a deletion target.
 *
 * ALSO stops accumulating at a bare `&` token (background-job marker)
 * rather than merely dropping it: `nohup rm -rf /home/x &` segmented
 * under the PRIMARY (`BOUNDARY_RE`) arm keeps its trailing ` &` attached
 * to the same segment text (bare `&` is not one of that arm's boundary
 * characters — see `AMP_BOUNDARY_RE`'s own comment). Stopping (not
 * merely dropping the `&` token and continuing) matters for `rm -rf
 * /home/x & rm -rf /home/y`: the primary arm never splits on the bare
 * `&` at all, so without stopping its ONE segment's rest-tokens would
 * continue past the `&` into the SECOND invocation's own tokens, and
 * the second invocation's verb (`rm`) — not `-`-prefixed, so it falls
 * through every flag check — would be collected as a spurious literal
 * `"rm"` TARGET. Stopping at the first bare `&` instead treats it as the
 * end of THIS invocation, matching what a background job actually is;
 * the amp-aware arm already produces the correct, separate segment for
 * what comes after the `&`, and `combineVerdicts`'s de-duplication (see
 * its own comment) collapses the resulting duplicate target this
 * yields.
 */
const REDIRECT_TOKEN_RE = /^(?:\d*[<>]|&>>?)/;
const BARE_REDIRECT_OPERATOR_RE = /^(?:\d*(?:>>|<<<|<<|>|<)|>&|<&|&>>|&>)$/;

function stripRedirections(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "&") break;
    if (REDIRECT_TOKEN_RE.test(t)) {
      if (BARE_REDIRECT_OPERATOR_RE.test(t) && i + 1 < tokens.length) {
        i += 1; // also drop the whitespace-separated filename
      }
      continue;
    }
    out.push(t);
  }
  return out;
}

/** A bare `(`/`)` token inside a segment is subshell syntax (`( rm -rf
 *  /home/x )` — the opening `(` is a segment boundary, the closing `)`
 *  survives as its own token when whitespace-separated), never an
 *  operand. */
function isBareParen(t: string): boolean {
  return t === "(" || t === ")";
}

const RM_LONG_RECURSIVE = "--recursive";
const RM_LONG_FORCE = "--force";

function resolveRm(tokens: string[], ctx: ResolveContext, xargsWrapped: boolean): DeletionTargetVerdict | null {
  let recursive = false;
  let force = false;
  const targets: string[] = [];
  let endOfFlags = false;
  for (const t of stripRedirections(tokens.slice(1))) {
    if (!endOfFlags && t === "--") {
      endOfFlags = true;
      continue;
    }
    if (!endOfFlags && t.startsWith("--")) {
      if (t === RM_LONG_RECURSIVE) recursive = true;
      else if (t === RM_LONG_FORCE) force = true;
      continue;
    }
    if (!endOfFlags && t.startsWith("-") && t.length > 1) {
      if (t.includes("r") || t.includes("R")) recursive = true;
      if (t.includes("f")) force = true;
      continue;
    }
    if (isBareParen(t)) continue;
    targets.push(t);
  }
  if (!recursive && !force) return null;
  if (xargsWrapped) return xargsVerdict("rm", targets);
  if (targets.length === 0) return null;
  return buildVerdict("rm", targets, ctx);
}

/** Leading, non-flag path operands of a `find` invocation's rest tokens
 *  (after its leading options — see `resolveFind`) — the search
 *  root(s). Collection stops at the first `-`-prefixed token (a flag or
 *  an action/test primitive, `-not` included) or at `!` (`find`'s
 *  negation operator), so a test/operator token is never mistaken for a
 *  search-root operand. `(`/`)` need no stop of their own: `(` is a
 *  segment boundary and never reaches this module, and a lone `)` that
 *  did would be collected as a relative — unresolvable — operand. */
function findPathOperands(rest: string[]): string[] {
  const paths: string[] = [];
  for (const t of rest) {
    if (t.startsWith("-") || t === "!") break;
    if (isOrphanBoundaryEscape(t)) continue;
    paths.push(t);
  }
  return paths;
}

/** The token an escaped or quoted boundary character leaves behind once
 *  the segmenter (quote- and escape-unaware) has cut the segment at that
 *  character: `\` from `\;`/`\(`, `'` from `';'`/`'('`, `"` likewise.
 *  Never an operand. */
function isOrphanBoundaryEscape(t: string): boolean {
  return t === "\\" || t === "'" || t === '"';
}

const FIND_EXEC_PRIMARIES: ReadonlySet<string> = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
/** `find`'s leading options that take no value and do not change what
 *  a path operand means (GNU `-P`, `-O<n>`; BSD `-E`, `-X`, `-d`, `-s`,
 *  `-x`). */
const FIND_LEADING_BOOLEAN_RE = /^(?:-P|-E|-X|-d|-s|-x|-O\d*)$/;
const FIND_SYMLINK_FOLLOW_WHY =
  "find follows symlinks here (-H/-L/-follow), so a target inside a root may resolve outside it";

/** The explicit operands of one `-exec`/`-execdir`/`-ok`/`-okdir rm ...`
 *  payload starting at `rest[start]` (the token after the `rm` head):
 *  every non-flag token other than the exact `{}` placeholder, up to a
 *  `+` terminator or the end of the segment. The `\;` terminator never
 *  reaches this module intact — `;` is a segment boundary — so the
 *  orphaned escape/quote token it leaves behind (`\`, `'`, `"`) is
 *  dropped rather than reported as a relative operand. */
function findExecPayloadOperands(rest: string[], start: number): string[] {
  const operands: string[] = [];
  let endOfFlags = false;
  for (let j = start; j < rest.length; j++) {
    const t = rest[j]!;
    if (t === "+" || t === ";") break;
    if (t === "{}" || isOrphanBoundaryEscape(t)) continue;
    if (!endOfFlags && t === "--") {
      endOfFlags = true;
      continue;
    }
    if (!endOfFlags && t.startsWith("-") && t.length > 1) continue;
    operands.push(t);
  }
  return operands;
}

/**
 * Resolve a `find` invocation. `tokens[0]` is the `find` head itself,
 * OR — for a CONTINUATION segment (module header point 6: `;` is a
 * segment boundary, so everything after a `\;` terminator lands in a
 * new segment headed by the next primitive, `find /tmp/x -exec rm -rf
 * {} \; -exec rm -rf /home/y \;`) — the first primitive, with
 * `carriedRoots` supplying the search roots the preceding segment
 * named. Always returns the roots as targets so a payload that deletes
 * the match (`{}`) is resolved against where `find` searches.
 */
function resolveFind(
  tokens: string[],
  ctx: ResolveContext,
  xargsWrapped: boolean,
  carriedRoots: readonly string[] | null = null,
): DeletionTargetVerdict | null {
  const rest = stripRedirections(carriedRoots === null ? tokens.slice(1) : tokens);
  const hasDelete = rest.includes("-delete");
  const execTargets: string[] = [];
  let hasExecRm = false;
  rest.forEach((t, i) => {
    const payloadHead = rest[i + 1];
    if (FIND_EXEC_PRIMARIES.has(t) && payloadHead !== undefined && RM_HEAD_RE.test(payloadHead)) {
      hasExecRm = true;
      execTargets.push(...findExecPayloadOperands(rest, i + 2));
    }
  });
  if (!hasDelete && !hasExecRm) return null;

  const { paths, followsSymlinks } =
    carriedRoots === null
      ? findSearchRoots(rest)
      : { paths: [...carriedRoots], followsSymlinks: rest.includes("-follow") };
  const targets = [...paths, ...execTargets];
  if (xargsWrapped) return xargsVerdict("find", targets);
  if (followsSymlinks) return forcedUnresolvableVerdict("find", targets, FIND_SYMLINK_FOLLOW_WHY);
  return buildVerdict("find", targets, ctx);
}

/** The search roots a `find` invocation names — its leading options
 *  skipped (module header point 6: `-H`/`-L` flagged as symlink-
 *  following, `-P`/`-E`/`-X`/`-d`/`-s`/`-x`/`-O<n>` and `-D <opts>`
 *  dropped, BSD `-f <path>` contributing its path), then the leading
 *  non-flag operands (`findPathOperands`), `.` when none. `-follow`
 *  anywhere in the expression also flags symlink-following. Shared by
 *  `resolveFind` and the continuation carry in `resolveSegmentText`. */
function findSearchRoots(rest: string[]): { paths: string[]; followsSymlinks: boolean } {
  let i = 0;
  let followsSymlinks = rest.includes("-follow");
  const leadingPaths: string[] = [];
  while (i < rest.length) {
    const t = rest[i]!;
    if (t === "-H" || t === "-L") {
      followsSymlinks = true;
      i += 1;
      continue;
    }
    if (FIND_LEADING_BOOLEAN_RE.test(t)) {
      i += 1;
      continue;
    }
    if (t === "-D") {
      i += 2;
      continue;
    }
    if (t === "-f") {
      if (rest[i + 1] !== undefined) leadingPaths.push(rest[i + 1]!);
      i += 2;
      continue;
    }
    break;
  }
  const paths = [...leadingPaths, ...findPathOperands(rest.slice(i))];
  return { paths: paths.length > 0 ? paths : ["."], followsSymlinks };
}

/** `git`'s own global options that consume the following token — the
 *  shared `GIT_GLOBAL_VALUE_TAKING_FLAGS` plus `-c`/`--config-env`,
 *  which `read-only-bash.ts` deliberately leaves out of that set for
 *  ITS fail-closed reasons; here the value must be stepped over so the
 *  `clean` subcommand behind it is still found (module header point 4). */
const GIT_CLEAN_SKIP_VALUE_FLAGS: ReadonlySet<string> = new Set([
  ...GIT_GLOBAL_VALUE_TAKING_FLAGS,
  "-c",
  "--config-env",
]);
const GIT_CLEAN_EXCLUDE_FLAGS: ReadonlySet<string> = new Set(["-e", "--exclude"]);

/** Index of the `clean` subcommand token after a `git` head and its
 *  global options, or `-1` when the subcommand is something else. */
function findGitCleanSubcommand(tokens: string[]): number {
  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t === "--") {
      i += 1;
      break;
    }
    if (GIT_CLEAN_SKIP_VALUE_FLAGS.has(t)) {
      i += 2;
      continue;
    }
    if (t.startsWith("-")) {
      i += 1;
      continue;
    }
    break;
  }
  return tokens[i] === "clean" ? i : -1;
}

function resolveGitClean(
  tokens: string[],
  cleanIdx: number,
  ctx: ResolveContext,
  xargsWrapped: boolean,
): DeletionTargetVerdict | null {
  const rest = stripRedirections(tokens.slice(cleanIdx + 1));
  const hasForce =
    ctx.gitRequireForceOverride ||
    rest.some((t) => t === "-f" || t === "--force" || (t.startsWith("-") && !t.startsWith("--") && t.includes("f")));
  if (!hasForce) return null;
  const pathspecs: string[] = [];
  let endOfFlags = false;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]!;
    if (!endOfFlags && t === "--") {
      endOfFlags = true;
      continue;
    }
    if (!endOfFlags && GIT_CLEAN_EXCLUDE_FLAGS.has(t)) {
      i += 1; // the pattern value is not a pathspec
      continue;
    }
    if (!endOfFlags && t.startsWith("-")) continue;
    if (isBareParen(t)) continue;
    pathspecs.push(t);
  }
  const targets = pathspecs.length > 0 ? pathspecs : ["."];
  if (xargsWrapped) return xargsVerdict("git-clean", targets);
  return buildVerdict("git-clean", targets, ctx);
}

/** Index of the first token at or after `startIdx` that is itself a
 *  recognized deletion-verb head (`RM_HEAD_RE`, `find`, or `git`
 *  immediately followed by `clean`), or `tokens.length` when none is —
 *  the bounded forward scan module header point 3 describes. Skips
 *  every intervening token uniformly, whatever `xargs` option or value
 *  it is: no option-table copy to drift. */
function findXargsVerbHead(tokens: readonly WrapperPeelToken[], startIdx: number): number {
  for (let i = startIdx; i < tokens.length; i++) {
    const t = tokens[i]!.text;
    if (RM_HEAD_RE.test(t) || t === "find" || (t === "git" && tokens[i + 1]?.text === "clean")) return i;
  }
  return tokens.length;
}

/** `exec`'s own flags, peeled locally (module header point 3): `-a
 *  <name>` (or glued `-a<name>`, or `-cla <name>`) consumes its value,
 *  `-c`/`-l` and `--` are boolean. */
function peelExecLocal(tokens: readonly WrapperPeelToken[], startIdx: number): number {
  let idx = startIdx;
  while (idx < tokens.length) {
    const t = tokens[idx]!.text;
    if (t === "--") return idx + 1;
    if (/^-[cl]*a$/.test(t)) {
      idx += 2;
      continue;
    }
    if (/^-[cl]*a./.test(t) || /^-[cl]+$/.test(t)) {
      idx += 1;
      continue;
    }
    break;
  }
  return idx;
}

/**
 * Peel the wrapper chain in front of the verb (module header point 3).
 * Each iteration first handles the THREE locally-owned wrappers —
 * `exec` (so `-a <name>` is consumed with its value), `busybox`/
 * `toybox` (multi-call binaries: the next token IS the verb), and
 * `xargs` (never recognized by `command-normalize.ts`; its own argv is
 * not simply "the command to run") — then hands the cursor to the
 * shared `peelWrapperPrefixes` loop, and stops once neither step
 * advances it. Interleaving keeps a composed chain (`sudo xargs -0 rm
 * -rf`, `xargs sudo rm -rf`) correct regardless of ordering. `xargs`'s
 * own semantics for "no verb head found at all": `idx` lands past the
 * end, `tokens.length === 0` after slicing, and `resolveSegmentText`
 * returns `null` — e.g. `xargs echo hi` stays unrecognized.
 */
function peelWrapperHeadsAndXargs(tokens: readonly WrapperPeelToken[]): { idx: number; xargsWrapped: boolean } {
  let idx = 0;
  let xargsWrapped = false;
  for (let guard = 0; guard <= tokens.length; guard++) {
    const before = idx;
    const head = tokens[idx]?.text;
    if (head === "exec") {
      idx = peelExecLocal(tokens, idx + 1);
      continue;
    }
    if (head === "busybox" || head === "toybox") {
      idx += 1;
      continue;
    }
    if (head !== undefined && XARGS_HEAD_RE.test(head)) {
      xargsWrapped = true;
      idx = findXargsVerbHead(tokens, idx + 1);
      continue;
    }
    idx = peelWrapperPrefixes(tokens, idx).idx;
    if (idx === before) break;
  }
  return { idx, xargsWrapped };
}

/** Shell keywords and group markers that PRECEDE a command inside a
 *  segment (module header point 2): `if rm ...`, `then rm ...`, `do rm
 *  ...`, `! rm ...`, `{ rm ...`, and the `) {` / `){` a function body
 *  starts with after the segmenter cut at its `(`. Compared on the RAW
 *  token so a quoted `"if"` (a command name, for bash) is left alone. */
const LEADING_KEYWORD_RE = /^(?:if|then|else|elif|while|until|do|!|[){]+)$/;

/** Strip leading keyword/group-marker tokens and a trailing `}`/`;`
 *  token (a `{ ...; }` brace group's close). Operates on the RAW
 *  (pre-decode) token array so a quoted literal `"{"` argument (not
 *  brace-group syntax) is never mistaken for one — `decodeShellWord`'s
 *  decoded output for a quoted token never equals the bare, unquoted
 *  `{`/`}`/`;` this check compares against. */
function stripCommandMarkers(rawTokens: string[]): string[] {
  let tokens = rawTokens;
  while (tokens.length > 0 && LEADING_KEYWORD_RE.test(tokens[0]!)) tokens = tokens.slice(1);
  while (tokens.length > 0 && (tokens[tokens.length - 1] === "}" || tokens[tokens.length - 1] === ";")) {
    tokens = tokens.slice(0, -1);
  }
  return tokens;
}

/** Strip a single trailing `)` from a segment's last RAW token — a
 *  subshell close (module header point 2). `(` is a boundary character
 *  segmentation itself consumes; `)` is not, per `command-normalize
 *  .ts`'s own comment, so it survives glued to whatever token was
 *  last (`(rm -rf /home/x)` -> `/home/x)`). Applied only to the LAST
 *  token, and only when that token is not the bare `)` alone (which
 *  would zero it out into an empty string) — a lone `)` token is left
 *  for the resolvers, which drop it as subshell syntax (`isBareParen`)
 *  rather than collect it as an operand. */
function stripTrailingParen(rawTokens: string[]): string[] {
  if (rawTokens.length === 0) return rawTokens;
  const last = rawTokens[rawTokens.length - 1]!;
  if (last.length > 1 && last.endsWith(")")) {
    return [...rawTokens.slice(0, -1), last.slice(0, -1)];
  }
  return rawTokens;
}

/** Strip a single trailing bare `&` from a segment's last RAW token —
 *  the same treatment `stripTrailingParen` gives a subshell's trailing
 *  `)`. The PRIMARY segmentation arm does not split on a bare `&` (see
 *  `AMP_BOUNDARY_RE`'s own comment), so it survives glued to whatever
 *  token was last (`rm -rf /home/x&` -> last raw token `/home/x&`); the
 *  AMP-AWARE arm's segment for the same command has no trailing `&` at
 *  all. Left unstripped, the primary arm's target (`/home/x&`) and the
 *  amp-aware arm's target (`/home/x`) are textually different, so
 *  `combineVerdicts` would concatenate both instead of the dedup it
 *  performs on identical targets, reporting the same target twice.
 *  Applied only to the LAST token, and only when that token is not the
 *  bare `&` alone (which would zero it out into an empty string). */
function stripTrailingAmp(rawTokens: string[]): string[] {
  if (rawTokens.length === 0) return rawTokens;
  const last = rawTokens[rawTokens.length - 1]!;
  if (last.length > 1 && last.endsWith("&")) {
    return [...rawTokens.slice(0, -1), last.slice(0, -1)];
  }
  return rawTokens;
}

/**
 * Resolve one already-isolated shell segment's text: strip a leading
 * `cd <path> &&` / `VAR=value` / `git switch|checkout <branch> &&`
 * prefix via `parseBashPrefix` (composing with, not duplicating, the
 * a7eb1a71 environment-signal path), strip keyword/brace-group/
 * subshell/background-job edge markers, peel a wrapper-command chain
 * (`peelWrapperHeadsAndXargs`), decode every remaining token, and run
 * the head test. `null` when this segment does not name a recognized
 * deletion verb at all.
 */
/** Cross-segment state within ONE segmentation arm: the search roots
 *  of the most recent `find`-headed segment, or `null` once any other
 *  command has intervened. A segment whose first token is a `find`
 *  primitive (`-`-prefixed) while roots are carried is the tail of that
 *  `find` expression, cut at a `\;` terminator. */
interface SegmentCarry {
  findRoots: string[] | null;
}

function resolveSegmentText(segmentText: string, ctx: ResolveContext, carry: SegmentCarry): DeletionTargetVerdict | null {
  const prefix = parseBashPrefix(segmentText);
  const remainder = segmentText.slice(prefix.remainderStart);
  const rawTokens = stripTrailingAmp(stripTrailingParen(stripCommandMarkers(tokenizeRaw(remainder))));
  const decodedTokens = rawTokens.map((t) => decodeShellWord(t));
  const peelTokens: WrapperPeelToken[] = decodedTokens.map((text) => ({ text }));
  const { idx, xargsWrapped } = peelWrapperHeadsAndXargs(peelTokens);
  const tokens = decodedTokens.slice(idx);
  if (tokens.length === 0) return null;

  const head = tokens[0]!;
  if (head.startsWith("-") && carry.findRoots !== null) {
    return resolveFind(tokens, ctx, xargsWrapped, carry.findRoots);
  }
  if (head === "find") {
    carry.findRoots = findSearchRoots(stripRedirections(tokens.slice(1))).paths;
    return resolveFind(tokens, ctx, xargsWrapped);
  }
  carry.findRoots = null;
  if (RM_HEAD_RE.test(head)) return resolveRm(tokens, ctx, xargsWrapped);
  if (GIT_HEAD_RE.test(head)) {
    const cleanIdx = findGitCleanSubcommand(tokens);
    if (cleanIdx >= 0) return resolveGitClean(tokens, cleanIdx, ctx, xargsWrapped);
  }
  return null;
}

/**
 * Combine every recognized deletion segment's verdict from one command
 * (module header point 1) into a single verdict: `unresolvable` is the
 * OR of every segment's, `targets`/`unresolvedTargets` are the
 * concatenation in encounter order, `verb` names only the FIRST
 * recognized segment's verb, and `reason` joins every segment's own
 * reason with `; `.
 *
 * De-duplication in `resolveDeletionTarget` is by exact segment TEXT,
 * across arms, which is not enough on its own — a command whose recognized
 * segment differs between the two arms only in a trailing marker the
 * PRIMARY arm's alphabet does not split on but the AMP-AWARE arm's does
 * (`nohup rm -rf /home/x &`: the trailing ` &` survives inside the
 * primary arm's single segment, but the amp-aware arm splits it off
 * into its own unrecognized segment) produces two textually DIFFERENT
 * recognized segments for what a human reads as ONE invocation, whose
 * `verb`+`targets` are nonetheless IDENTICAL once each is resolved.
 * `dedupeVerdicts` below removes that duplication (and its matching
 * `reason` line) by exact `(verb, JSON(targets))` equality before
 * combining. For `rm -rf /home/x & rm -rf /home/y`, `stripRedirections`
 * stops at the first bare `&` (see its own comment) so the primary
 * arm's verdict for that command is IDENTICAL to the amp-aware arm's
 * first-segment verdict, and dedup collapses the pair, leaving only the
 * real, distinct `/home/x`/`/home/y` targets.
 *
 * Reporting-only ceiling: the amp-aware arm is quote-unaware, so a
 * QUOTED literal `&` inside an operand (`rm -rf '/tmp/a&b'`) is split
 * by that arm into a segment whose cut-off token (`'/tmp/a`) differs
 * from the primary arm's whole operand; the verdict then lists both
 * spellings, and the cut-off one is unresolvable (a fail-closed
 * over-gate on that shape, never a missed deletion).
 */
function verdictKey(v: DeletionTargetVerdict): string {
  return `${v.verb} ${JSON.stringify(v.targets)}`;
}

function dedupeVerdicts(verdicts: DeletionTargetVerdict[]): DeletionTargetVerdict[] {
  const seen = new Set<string>();
  const deduped: DeletionTargetVerdict[] = [];
  for (const v of verdicts) {
    const key = verdictKey(v);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(v);
  }
  return deduped;
}

function combineVerdicts(verdicts: DeletionTargetVerdict[]): DeletionTargetVerdict {
  const deduped = dedupeVerdicts(verdicts);
  if (deduped.length === 1) return deduped[0]!;
  const seenReasons = new Set<string>();
  const reasons: string[] = [];
  for (const v of deduped) {
    if (seenReasons.has(v.reason)) continue;
    seenReasons.add(v.reason);
    reasons.push(v.reason);
  }
  return {
    verb: deduped[0]!.verb,
    targets: deduped.flatMap((v) => v.targets),
    unresolvedTargets: deduped.flatMap((v) => v.unresolvedTargets),
    unresolvable: deduped.some((v) => v.unresolvable),
    reason: reasons.join("; "),
  };
}

/**
 * Every shell segment `command` names, per `command-normalize.ts`
 * segmentation arm, each arm in command order (module header point 1).
 * `null` when EITHER arm declines (an oversized command past
 * `MAX_NORMALIZE_LENGTH` — the same bound for both, so in practice they
 * decline together). De-duplication by exact text happens in the
 * caller, which still walks every segment of every arm so the per-arm
 * `SegmentCarry` sees each arm's full sequence.
 */
function collectSegmentArms(command: string): string[][] | null {
  const primary = segmentViewOf(command);
  const ampAware = segmentViewOfAmpAware(command);
  if (primary === null || ampAware === null) return null;
  return [primary.map((s) => s.text), ampAware.map((s) => s.text)];
}

const GIT_REQUIRE_FORCE_RE = /clean\.requireforce/i;

/**
 * Resolve the static deletion-target verdict for a Bash command string,
 * across EVERY shell segment named by either segmentation arm (module
 * header point 1), or `null` when no segment names a recognized
 * deletion verb at all. Never throws.
 */
export function resolveDeletionTarget(
  command: string,
  safeRoots: readonly string[],
): DeletionTargetVerdict | null {
  if (typeof command !== "string" || command.length === 0) return null;
  const ctx: ResolveContext = {
    safeRoots,
    gitRequireForceOverride: GIT_REQUIRE_FORCE_RE.test(command),
    extglobOpener: EXTGLOB_OPENER_RE.test(command),
  };

  const arms = collectSegmentArms(command);
  if (arms === null) {
    // Oversized command (past `MAX_NORMALIZE_LENGTH`) — both arms
    // decline to run at all. Fall back to the single-first-segment
    // contract: prefix-strip the WHOLE command first (a recognized
    // `cd`/`VAR=` prefix can itself span past a `&&`), THEN take the
    // first segment of what remains.
    const prefix = parseBashPrefix(command);
    const remainder = command.slice(prefix.remainderStart);
    return resolveSegmentText(firstSegment(remainder), ctx, { findRoots: null });
  }

  const verdicts: DeletionTargetVerdict[] = [];
  const seen = new Set<string>();
  for (const arm of arms) {
    const carry: SegmentCarry = { findRoots: null };
    for (const text of arm) {
      const v = resolveSegmentText(text, ctx, carry);
      if (seen.has(text)) continue;
      seen.add(text);
      if (v !== null) verdicts.push(v);
    }
  }
  return verdicts.length === 0 ? null : combineVerdicts(verdicts);
}
