// Risk Gate — static deletion-target resolver (task d03af8f6).
//
// The existing `dangerous-shell` classifier + `gate-prod-destructive*`
// policies gate a destructive shell action only when the Context
// Resolver resolves `environment: production`. On a task branch the
// environment is `unknown`, and every deletion — including one whose
// target is a typo or a stale variable pointing outside any scratch
// area — runs unconfirmed. This module closes that specific gap: it
// recognizes a deletion-verb command (`rm -r*`/`-f*`, `find ... -delete`
// or `find ... -exec*/-execdir rm ...`, `git clean -f*`) and decides,
// STATICALLY (no filesystem I/O, no process-env read, no shell-variable
// expansion, no cwd substitution), whether every target it names is
// provably inside a declared `risk.safe_deletion_roots` entry.
// `src/runtime/when-eval.ts`'s `action.deletion_target_unresolvable`
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
//      `segmentViewOfAmpAware` (the same alphabet plus a bare `&`,
//      closing the `echo hi & rm -rf /home/x` background-job gap) —
//      combined additively and de-duplicated by exact segment text
//      (`collectSegmentTexts`). A verdict from EITHER arm counts toward
//      the combined result: unresolvable if any recognized segment is,
//      resolved only if every recognized segment is (`combineVerdicts`).
//      When both arms decline (a command past `MAX_NORMALIZE_LENGTH`)
//      this module falls back to a single-first-segment contract.
//   2. A wrapper prefix on the deletion verb is peeled with
//      `command-normalize.ts`'s own exported `peelWrapperPrefixes` (the
//      SAME loop `canonicalizeSegment` uses for `git`/`gh`/`npm`/
//      `harness` trigger recognition) — `sudo`, `doas`, `command`,
//      `env`, `time`, `timeout`, `nice`, `exec`, `nohup`. `xargs` is a
//      LOCAL concern (`peelWrapperHeadsAndXargs` below): its own argv
//      is not simply "the command to run", so `command-normalize.ts`
//      never peels it; after the `xargs` token, this scans FORWARD for
//      the first token that is itself a recognized deletion-verb head,
//      skipping every flag and value uniformly regardless of spelling —
//      see `findXargsVerbHead`'s own comment — and captures the
//      replace-string along the way (the value of `-I`/`-i`, glued or
//      separated, default `{}` when neither is given) so a target token
//      containing it is treated as unresolvable, the same as an
//      unexpanded `$` token: its real value is substituted from stdin
//      at runtime, never statically knowable.
//   3. A recognised `rm` head additionally accepts a path-qualified
//      spelling (`/bin/rm`, `/usr/bin/rm`) via `RM_HEAD_RE`.
//   4. Every token is decoded with `decodeShellWord` (`shell-word.ts`)
//      before any verb/flag/`-delete` comparison.
//   5. `find` recognition also covers `-exec`/`-execdir` whose next
//      token matches `RM_HEAD_RE`. The verdict's targets are `find`'s
//      own leading, non-flag PATH operands (`findPathOperands`) — never
//      the literal `{}` placeholder token — and collection stops at the
//      first `!`, `(`, `)`, or `-`-prefixed token, so a test/operator
//      token is never mistaken for a search-root operand.
//   6. A target is resolved only when it is an ABSOLUTE path lying
//      STRICTLY INSIDE a declared `risk.safe_deletion_roots` entry, for
//      EVERY recognized verb (`rm`, `find`, `git-clean`) alike — the
//      root path itself never counts, `find` included: `find`'s own
//      start point is removed by `-delete`/`-exec`, the same way `rm`'s
//      operand is, so there is no root-equality exception for `find`
//      (see `isInsideAllowlist`'s own comment). A target whose final
//      path segment is a bare glob-sugar `*`/`**` never counts either,
//      regardless of which root it would otherwise sit under.
//   7. Redirection operands are not collected as deletion targets (a
//      `REDIRECT_TOKEN_RE` match is dropped before target collection in
//      every resolver, and its bare-operator form also drops the
//      following whitespace-separated filename token). A trailing `)`
//      on a subshell segment's last token, and a trailing bare `&` on a
//      backgrounded segment's last token, are each stripped once before
//      flag/target parsing.
//   8. A leading `{` / trailing `}`/`;` token (a `{ ...; }` brace group)
//      is stripped before the head test.
//
// Never throws. Returns `null` when no shell segment of `command`, by
// the narrow head test above, names a recognized deletion verb at all.
//
// NOT COVERED (deliberate residuals, pinned as a `toBeNull()`/no-op test
// in `tests/runtime/deletion-target-resolve.test.ts` so a future change
// that accidentally starts "recognizing" one of these shapes is caught):
//   - `bash -c 'rm -rf /home/x'` / `sh -c '...'`: the wrapped command
//     lives inside a single string argument this module does not parse
//     into.
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
//   - Any command past `MAX_NORMALIZE_LENGTH` (100,000 characters,
//     `command-normalize.ts`) falls back to a single-first-segment
//     contract: only the FIRST shell segment of such an oversized
//     command is inspected, so a recognized deletion verb in a LATER
//     segment goes unrecognized.
//
// History and measurements: CHANGELOG.md, task d03af8f6.

import { parseBashPrefix } from "./bash-prefix-parse.js";
import {
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
 * token early — the boundary-tracking shape mirrors
 * `kubectl-target-parse.ts`'s own tokenizer, duplicated deliberately
 * rather than imported: that module's tokenizer strips quote characters
 * inline as it scans, discarding exactly the raw text this module needs
 * to hand to `decodeShellWord`. NOT reused from `command-normalize.ts`
 * either: that module's own `tokenizeWithOffsets` is deliberately
 * whitespace-naive (no quote tracking at all — see its own module
 * header's "quoted directory arguments containing whitespace" NOT-
 * SUPPORTED note), which would regress this module's round-2 obfuscated-
 * flag coverage (`find /home/x $'\x2ddelete'`) if reused wholesale;
 * this module's peeling now reuses `command-normalize.ts`'s wrapper-
 * peeling FUNCTIONS (which only ever read a token's already-decoded
 * `.text`, never re-tokenize), not its tokenizer.
 */
function tokenizeRaw(segment: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const n = segment.length;
  while (i < n) {
    i = skipWs(segment, i);
    if (i >= n) break;
    const start = i;
    while (i < n && !WS.test(segment[i]!)) {
      const c = segment[i]!;
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

/** Raw-tokenize, then decode every token (`decodeShellWord`) — see the
 *  module header point 4 for the decoded-only scoping decision (round
 *  2, unchanged this round). */
function tokenizeDecoded(segment: string): string[] {
  return tokenizeRaw(segment).map((t) => decodeShellWord(t));
}

/** A path-qualified `rm` head (`/bin/rm`, `/usr/bin/rm`) as well as the
 *  bare word. No nested quantifiers — a single bounded `\S*` alternative. */
const RM_HEAD_RE = /^(?:\S*\/)?rm$/;

/** Normalize a `safeRoots` entry: strip a trailing `/**`, `/*`, or `/`. */
function normalizeRoot(root: string): string {
  let r = root.trim();
  if (r.endsWith("/**")) r = r.slice(0, -3);
  else if (r.endsWith("/*")) r = r.slice(0, -2);
  while (r.length > 1 && r.endsWith("/")) r = r.slice(0, -1);
  return r;
}

/** POSIX path normalization without any filesystem I/O — collapses
 * `.`/`..` segments lexically. Manual (not `node:path`) so this module
 * has no platform-path dependency: harness's own scratchpad convention
 * and every fixture in this task are POSIX paths regardless of host OS. */
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

/** Resolve one raw target token. `false` = unresolvable (gate it).
 * `replaceString`, when given (an `xargs` invocation's own `-I`/`-i`
 * value, default `{}`), makes a token containing it unresolvable too —
 * the same treatment as an unexpanded `$` token: the real value is
 * substituted from stdin at runtime, never statically knowable. */
function targetIsResolvedSafe(token: string, safeRoots: readonly string[], replaceString?: string): boolean {
  if (token.includes("$")) return false; // unexpanded shell variable
  if (replaceString !== undefined && token.includes(replaceString)) return false;
  // Relative (does not start with `/`) — this also covers every
  // `~`-prefixed token, since `~foo` is never `/`-prefixed; a separate
  // `~`-prefix check here would be fully redundant with this one.
  if (!token.startsWith("/")) return false;
  return isInsideAllowlist(token, safeRoots);
}

function buildVerdict(
  verb: DeletionTargetVerdict["verb"],
  targets: string[],
  safeRoots: readonly string[],
  replaceString?: string,
): DeletionTargetVerdict {
  const unresolvedTargets = targets.filter((t) => !targetIsResolvedSafe(t, safeRoots, replaceString));
  const unresolvable = unresolvedTargets.length > 0;
  const reason = unresolvable
    ? `${verb}: target(s) not statically resolvable inside a declared risk.safe_deletion_roots entry: ${unresolvedTargets.join(", ")}`
    : `${verb}: every target resolves inside a declared risk.safe_deletion_roots entry`;
  return { verb, targets, unresolvedTargets, unresolvable, reason };
}

/**
 * Drop a redirection operand token — `REDIRECT_TOKEN_RE` (module header
 * point 7): an optional leading fd number followed by `<`/`>`, OR a
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

const RM_LONG_RECURSIVE = "--recursive";
const RM_LONG_FORCE = "--force";

function resolveRm(
  tokens: string[],
  safeRoots: readonly string[],
  xargsWrapped: boolean,
  replaceString?: string,
): DeletionTargetVerdict | null {
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
    targets.push(t);
  }
  if (!recursive && !force) return null;
  if (targets.length === 0) {
    if (!xargsWrapped) return null;
    // `xargs` supplies rm's real operand(s) from stdin at runtime —
    // never statically knowable — so this is UNRESOLVABLE, not "not a
    // recognized deletion" (module header point 2).
    return buildVerdict("rm", ["(xargs-supplied target, not statically known)"], safeRoots);
  }
  return buildVerdict("rm", targets, safeRoots, replaceString);
}

/** Leading, non-flag path operands of a `find` invocation's own rest
 *  tokens — the search root(s). Shared by both the `-delete` and the
 *  `-exec`/`-execdir` recognition branches. Collection stops at the
 *  first `-`-prefixed token (a flag or an action/test primitive, `-not`
 *  included), or at `!`, `(`, `)` — `find`'s own expression-grouping and
 *  negation operators are never path operands, so none of them is ever
 *  emitted as a target. */
function findPathOperands(rest: string[]): string[] {
  const paths: string[] = [];
  for (const t of rest) {
    if (t.startsWith("-") || t === "!" || t === "(" || t === ")") break;
    paths.push(t);
  }
  return paths;
}

function resolveFind(
  tokens: string[],
  safeRoots: readonly string[],
  replaceString?: string,
): DeletionTargetVerdict | null {
  const rest = stripRedirections(tokens.slice(1));
  const hasDelete = rest.includes("-delete");
  // Module header point 5: `-exec`/`-execdir` whose IMMEDIATELY
  // following token matches `RM_HEAD_RE` is also a recognized deletion —
  // the find path operands are the targets, never the literal `{}`
  // placeholder.
  const hasExecRm = rest.some(
    (t, i) => (t === "-exec" || t === "-execdir") && rest[i + 1] !== undefined && RM_HEAD_RE.test(rest[i + 1]!),
  );
  if (!hasDelete && !hasExecRm) return null;
  const paths = findPathOperands(rest);
  const targets = paths.length > 0 ? paths : ["."];
  return buildVerdict("find", targets, safeRoots, replaceString);
}

function resolveGitClean(
  tokens: string[],
  safeRoots: readonly string[],
  replaceString?: string,
): DeletionTargetVerdict | null {
  const rest = stripRedirections(tokens.slice(2));
  const hasForce = rest.some(
    (t) => t === "-f" || t === "--force" || (t.startsWith("-") && !t.startsWith("--") && t.includes("f")),
  );
  if (!hasForce) return null;
  const pathspecs = rest.filter((t) => !t.startsWith("-"));
  const targets = pathspecs.length > 0 ? pathspecs : ["."];
  return buildVerdict("git-clean", targets, safeRoots, replaceString);
}

const XARGS_DEFAULT_REPLACE_STRING = "{}";
const XARGS_REPLACE_FLAG_GLUED_RE = /^-[Ii](.+)$/;

/**
 * Peel `xargs` — the ONE wrapper `command-normalize.ts`'s shared
 * `peelWrapperPrefixes` deliberately never recognizes (module header
 * point 2). Interleaved with `peelWrapperPrefixes` so a composed chain
 * (`sudo xargs -0 rm -rf`, `xargs sudo rm -rf` — the latter admittedly
 * unusual but not rejected) peels correctly regardless of ordering: each
 * iteration first hands the cursor to the shared loop, then checks
 * whether what's left is `xargs`, and stops once neither step advances
 * the cursor.
 *
 * After the `xargs` token itself, this does not walk `xargs`'s full
 * option table (a fourth independently-drifting copy of exactly the
 * kind of table this module already replaced with shared machinery,
 * module header points 1 and 2). Instead it scans FORWARD from the
 * token after `xargs` (bounded by `tokens.length`) for the first token
 * that is itself a recognized deletion-verb head (`RM_HEAD_RE`, `find`,
 * or `git` immediately followed by `clean`), skipping every `xargs`
 * flag AND its value uniformly regardless of spelling — see
 * `findXargsVerbHead`. Along the way it also captures the invocation's
 * own replace-string: the value of a `-I`/`-i` flag, glued
 * (`-I{}`) or whitespace-separated (`-I {}`), or `{}` (`xargs`'s own
 * default) when neither is given. `xargs`'s own semantics for "no verb
 * head found at all" match `peelWrapperHeadsAndXargs`'s existing
 * behavior: `idx` lands past the end of the segment, `tokens.length ===
 * 0` after slicing, and `resolveSegmentText` returns `null` — e.g.
 * `xargs echo hi` stays unrecognized.
 */
function findXargsVerbHead(
  tokens: readonly WrapperPeelToken[],
  startIdx: number,
): { verbIdx: number; replaceString: string } {
  let replaceString = XARGS_DEFAULT_REPLACE_STRING;
  for (let i = startIdx; i < tokens.length; i++) {
    const t = tokens[i]!.text;
    if (RM_HEAD_RE.test(t) || t === "find" || (t === "git" && tokens[i + 1]?.text === "clean")) {
      return { verbIdx: i, replaceString };
    }
    if (t === "-I" || t === "-i") {
      const value = tokens[i + 1]?.text;
      if (value !== undefined) replaceString = value;
      continue;
    }
    const glued = XARGS_REPLACE_FLAG_GLUED_RE.exec(t);
    if (glued) replaceString = glued[1]!;
  }
  return { verbIdx: tokens.length, replaceString };
}

function peelWrapperHeadsAndXargs(
  tokens: readonly WrapperPeelToken[],
): { idx: number; xargsWrapped: boolean; replaceString: string } {
  let idx = 0;
  let xargsWrapped = false;
  let replaceString = XARGS_DEFAULT_REPLACE_STRING;
  for (let guard = 0; guard <= tokens.length; guard++) {
    const before = idx;
    idx = peelWrapperPrefixes(tokens, idx).idx;
    if (tokens[idx]?.text === "xargs") {
      xargsWrapped = true;
      const found = findXargsVerbHead(tokens, idx + 1);
      idx = found.verbIdx;
      replaceString = found.replaceString;
      continue;
    }
    if (idx === before) break;
  }
  return { idx, xargsWrapped, replaceString };
}

/** Strip a leading `{` token and a trailing `}`/`;` token — the
 *  shell-syntax markers of a `{ ...; }` brace group (module header
 *  point 8). Operates on the RAW (pre-decode) token array so a quoted
 *  literal `"{"` argument (not brace-group syntax) is never mistaken
 *  for one — `decodeShellWord`'s decoded output for a quoted token
 *  never equals the bare, unquoted `{`/`}`/`;` this check compares
 *  against. */
function stripBraceGroupMarkers(rawTokens: string[]): string[] {
  let tokens = rawTokens;
  if (tokens[0] === "{") tokens = tokens.slice(1);
  while (tokens.length > 0 && (tokens[tokens.length - 1] === "}" || tokens[tokens.length - 1] === ";")) {
    tokens = tokens.slice(0, -1);
  }
  return tokens;
}

/** Strip a single trailing `)` from a segment's last RAW token — a
 *  subshell close (module header point 7). `(` is a boundary character
 *  segmentation itself consumes; `)` is not, per `command-normalize
 *  .ts`'s own comment, so it survives glued to whatever token was
 *  last. Applied only to the LAST token, and only when that token is
 *  not the bare `)` alone (which would zero it out into an empty
 *  string) — a lone `)` token is left untouched, matching nothing
 *  either way. */
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
 * a7eb1a71 environment-signal path), strip brace-group/subshell/
 * background-job edge markers, peel a wrapper-command chain
 * (`peelWrapperHeadsAndXargs`), decode every remaining token, and run
 * the head test. `null` when this segment does not name a recognized
 * deletion verb at all.
 */
function resolveSegmentText(
  segmentText: string,
  safeRoots: readonly string[],
): DeletionTargetVerdict | null {
  const prefix = parseBashPrefix(segmentText);
  const remainder = segmentText.slice(prefix.remainderStart);
  const rawTokens = stripTrailingAmp(stripTrailingParen(stripBraceGroupMarkers(tokenizeRaw(remainder))));
  const decodedTokens = rawTokens.map((t) => decodeShellWord(t));
  const peelTokens: WrapperPeelToken[] = decodedTokens.map((text) => ({ text }));
  const { idx, xargsWrapped, replaceString } = peelWrapperHeadsAndXargs(peelTokens);
  const tokens = decodedTokens.slice(idx);
  if (tokens.length === 0) return null;
  const xargsReplaceString = xargsWrapped ? replaceString : undefined;

  const head = tokens[0]!;
  if (RM_HEAD_RE.test(head)) return resolveRm(tokens, safeRoots, xargsWrapped, xargsReplaceString);
  if (head === "find") return resolveFind(tokens, safeRoots, xargsReplaceString);
  if (head === "git" && tokens[1] === "clean") return resolveGitClean(tokens, safeRoots, xargsReplaceString);
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
 * De-duplication in `collectSegmentTexts` is by exact segment TEXT, per
 * arm, which is not enough on its own — a command whose recognized
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
 */
function verdictKey(v: DeletionTargetVerdict): string {
  return `${v.verb} ${JSON.stringify(v.targets)}`;
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
 * Every shell segment `command` names, from BOTH `command-normalize
 * .ts` segmentation arms combined additively and de-duplicated by exact
 * text (module header point 1). `null` when EITHER arm declines (an
 * oversized command past `MAX_NORMALIZE_LENGTH` — the same bound for
 * both, so in practice they decline together).
 */
function collectSegmentTexts(command: string): string[] | null {
  const primary = segmentViewOf(command);
  const ampAware = segmentViewOfAmpAware(command);
  if (primary === null || ampAware === null) return null;
  const seen = new Set<string>();
  const texts: string[] = [];
  for (const seg of primary) {
    if (!seen.has(seg.text)) {
      seen.add(seg.text);
      texts.push(seg.text);
    }
  }
  for (const seg of ampAware) {
    if (!seen.has(seg.text)) {
      seen.add(seg.text);
      texts.push(seg.text);
    }
  }
  return texts;
}

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

  const texts = collectSegmentTexts(command);
  if (texts === null) {
    // Oversized command (past `MAX_NORMALIZE_LENGTH`) — both arms
    // decline to run at all. Fall back to the pre-round-2,
    // single-first-segment contract: prefix-strip the WHOLE command
    // first (a recognized `cd`/`VAR=` prefix can itself span past a
    // `&&`), THEN take the first segment of what remains.
    const prefix = parseBashPrefix(command);
    const remainder = command.slice(prefix.remainderStart);
    return resolveSegmentText(firstSegment(remainder), safeRoots);
  }

  const verdicts: DeletionTargetVerdict[] = [];
  for (const text of texts) {
    const v = resolveSegmentText(text, safeRoots);
    if (v !== null) verdicts.push(v);
  }
  return verdicts.length === 0 ? null : combineVerdicts(verdicts);
}
