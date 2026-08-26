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
// REVIEW ROUND 3 (task d03af8f6, this revision): the ROUND-2 HALT RULE
// fired — two consecutive review rounds each found the recognition
// surface failing OPEN on a NEW, structurally similar class of common
// shapes (round 1: first-segment-only; round 2: flag-blind wrapper
// peeling plus bare-`&`/brace/exec/nohup). The structural cause: this
// module hand-rolled its own segmentation and wrapper peeling instead of
// reusing `src/runtime/command-normalize.ts`, which already ships
// flag-aware, measured, pinned peelers and TWO segmentation arms trusted
// by the `bash_match` gate. This revision replaces the hand-rolled
// recognition with that shared machinery:
//
//   1. Segments now come from BOTH of `command-normalize.ts`'s
//      segmentation arms — `segmentViewOf` (the primary `BOUNDARY_RE`
//      alphabet) AND `segmentViewOfAmpAware` (the `AMP_BOUNDARY_RE`
//      alphabet, which additionally splits on a bare `&` — task
//      aabbad63's own gap-closer for trigger matching, reused here for
//      the same reason: `echo hi & rm -rf /home/x` is a background job,
//      not a chain the primary alphabet splits on). The two arms'
//      segment TEXTS are combined ADDITIVELY and de-duplicated by exact
//      text (see `collectSegmentTexts`): when a command has no bare `&`
//      the two arms produce byte-identical segmentation, so
//      de-duplication is what keeps `targets`/`unresolvedTargets` from
//      double-counting the common case, while a command that DOES split
//      differently under the two alphabets (the `&`-background case)
//      gets the union of both views' recognized deletion segments. A
//      verdict from EITHER arm counts toward the combined result:
//      unresolvable if any recognized segment (from either arm) is,
//      resolved only if every recognized segment (from both arms) is —
//      see `combineVerdicts`, unchanged from round 2's rule, now fed a
//      richer segment set. When both arms decline (an oversized command
//      past `MAX_NORMALIZE_LENGTH` — the same bound for both) this
//      module falls back to the pre-round-2, single-first-segment
//      contract.
//   2. A wrapper prefix on the deletion verb ITSELF is peeled with
//      `command-normalize.ts`'s own exported `peelWrapperPrefixes` —
//      the SAME loop `canonicalizeSegment` uses for `git`/`gh`/`npm`/
//      `harness` trigger recognition, not a second, independently
//      drifting copy. This closes every flag this module's OWN
//      round-2 `peelWrapperHeads` missed: `sudo -u root ...`, `sudo -E
//      ...`, `sudo --preserve-env ...`, `nice -n 10 ...`, `nice -10
//      ...`, `env -i ...`, `env -u FOO ...`, `timeout -k 5 10 ...`,
//      `timeout --signal=KILL 5 ...` — none of these advanced past the
//      wrapper's own bare name before, because the round-2 peeler
//      recognized ONLY the bare wrapper token, never its flags. `exec`
//      and `nohup` are ALSO now peeled — added to
//      `peelWrapperPrefixes` itself (`command-normalize.ts`) rather
//      than only here, so this module's own gate AND the `bash_match`
//      trigger gate both benefit; see that function's own comment.
//      `xargs` stays a LOCAL concern (`peelWrapperHeadsAndXargs` below):
//      `command-normalize.ts` deliberately never recognizes it (its own
//      argv is not simply "the command to run" — see that module's
//      NOT-SUPPORTED list), but this resolver's own semantics for it —
//      UNRESOLVABLE when no explicit operand survives, since the real
//      target comes from stdin — are unchanged from round 2. REVIEW
//      ROUND 4 (HIGH): `xargs`'s own flags are no longer peeled by
//      walking a flag table at all (round 3's `peelGenericFlags` reuse
//      was boolean-only and stranded a SEPARATED flag value — `-I {}`,
//      `-n 1`, `-P 4`, `-a list`, `-d '\n'` — where the verb was
//      expected, leaving those five spellings ungated); instead, after
//      the `xargs` token, this scans FORWARD for the first token that is
//      itself a recognized deletion-verb head, skipping every flag and
//      value uniformly regardless of spelling — see
//      `findXargsVerbHead`'s own comment.
//   3. A recognised `rm` head additionally accepts a path-qualified
//      spelling (`/bin/rm`, `/usr/bin/rm`) via `RM_HEAD_RE` — unchanged
//      from round 2.
//   4. Every token is decoded with `decodeShellWord` (`shell-word.ts`)
//      before any verb/flag/`-delete` comparison — unchanged from round
//      2 (see that round's scoping note, preserved verbatim below).
//   5. `find` recognition now ALSO covers `-exec`/`-execdir` whose next
//      token matches `RM_HEAD_RE` (`find /home -exec rm -rf {} +`,
//      `find /home -execdir rm {} \;`) — round 2 recognized only
//      `-delete`. The verdict's targets are `find`'s own PATH operands
//      (the same leading-non-flag-token extraction `-delete` recognition
//      already used), never the literal `{}` placeholder token itself:
//      `{}` is not a real path (does not start with `/`) and would
//      always come out unresolvable on its own merits if it were ever
//      handed to the resolver, so naming the search root instead is both
//      the more useful verdict and the safer one (a target this module
//      cannot statically prove safe still gates the action either way).
//   6. `find`'s own search-ROOT operand is resolved when it EQUALS a
//      declared root, not only when strictly deeper, BUT ONLY when the
//      expression carries at least one non-action test predicate
//      (`-name`, `-type`, ... — see `FIND_TEST_PREDICATES`). REVIEW
//      ROUND 4 (MEDIUM, correcting round 3's premise here): `find
//      <root> -delete` does NOT only ever delete entries strictly
//      inside `<root>` — a BARE `find /tmp -delete` (no test predicate
//      narrowing which entries match) removes `/tmp` itself too, on
//      both GNU findutils and BSD find, so that shape still GATES. Only
//      `find /tmp -name '*.log' -delete` (a test predicate narrows
//      matches away from the root's own directory entry) is exactly as
//      safe as `find /tmp/scratch -delete`. `rm`
//      keeps the round-2 strictly-deeper rule (`rm -rf /tmp` still
//      GATES): `rm`'s own operand names the directory to be removed,
//      not merely searched, so equality to the root itself really would
//      remove the root's own directory entry.
//   7. Redirection operands are no longer collected as deletion targets:
//      a token matching `REDIRECT_TOKEN_RE` (a `>`/`>>`/`<`/`<<`/`<<<`
//      operator, glued or bare, with an optional leading fd number, PLUS
//      `&>`/`&>>` — added REVIEW ROUND 4 MEDIUM, round 3's regex missed
//      bash's combined stdout+stderr redirect) is dropped before target
//      collection in EVERY resolver, and when the token IS the bare
//      operator (no filename glued to it, now also covering `>&`/`<&`/
//      `&>`/`&>>`) the FOLLOWING token is dropped too — `rm -rf /tmp/x
//      >/dev/null 2>&1` no longer collects `/dev/null` as a second,
//      unresolvable "target", and neither does `rm -rf /tmp/x
//      &>/dev/null` or `rm -rf /tmp/x >& out`. A trailing `)` on a
//      subshell segment's last token (`(rm -rf /home/x)` — `(` is a
//      `BOUNDARY_RE`/`AMP_BOUNDARY_RE` boundary character consumed by
//      segmentation itself, but `)` is not one, per that module's own
//      comment) is stripped before flag/target parsing for the same
//      reason.
//   8. A leading `{` / trailing `}`/`;` token — the shell-syntax markers
//      of a `{ ...; }` brace group — is stripped before the head test.
//      `{` is NOT one of `BOUNDARY_RE`/`AMP_BOUNDARY_RE`'s boundary
//      characters (by design — see that module's own alphabet comments),
//      so it survives as an ordinary leading TOKEN of whatever segment
//      follows it, and the `;` immediately before the closing `}` IS a
//      boundary character, so a `{ rm -rf /home/x; }` command segments
//      to `"{ rm -rf /home/x"` / `"}"` — the `{` would otherwise sit
//      where the verb token is expected and defeat the head test.
//
// Never throws. Returns `null` when no shell segment of `command`, by
// the narrow head test above, names a recognized deletion verb at all.
//
// NOT COVERED (deliberate residuals, named rather than left implicit —
// mirrors `command-normalize.ts`'s own convention). Each of these is
// pinned as a `toBeNull()`/no-op test in `tests/runtime/
// deletion-target-resolve.test.ts` so a future change that accidentally
// starts "recognizing" one of these shapes (a false negative turning
// into an unreviewed false ceiling-widening, not a fix) is caught:
//   - `bash -c 'rm -rf /home/x'` / `sh -c '...'`: the wrapped command
//     lives inside a single string argument this module does not parse
//     into — same boundary `command-normalize.ts`'s own NOT-SUPPORTED
//     list draws for the identical shape.
//   - `eval "rm -rf /home/x"`: `eval` is not a recognized wrapper —
//     unlike `sudo`/`env`/..., its argument is a STRING to be
//     re-parsed, not "the command to run" positionally, the same
//     architectural reason `xargs` needs bespoke handling rather than
//     generic peeling.
//   - `sh script.sh` / `bash script.sh` / any script FILE the agent
//     writes and then executes: this module never reads a file's
//     contents.
//   - `shred`, `rmdir`, `unlink`: real deletion-shaped verbs this
//     module's closed head-token set (`rm`, `find`, `git clean`) does
//     not include. `shred` overwrites-then-optionally-deletes;
//     `rmdir`/`unlink` are narrower single-purpose deletion verbs. None
//     are in scope for this task; a future task can extend the closed
//     set the same way `-exec`/`-execdir` extended `find`'s.
//   - `npm run clean` (or any `package.json` script / Makefile target /
//     CI job whose NAME suggests deletion): this module inspects the
//     literal command line only, never a script's own body.
//   - `` `rm -rf /home/x` `` (backtick command substitution): like
//     `bash -c '...'`, the deletion command lives inside a substitution
//     this module does not parse into — a leading/trailing backtick
//     token is not stripped the way a brace-group `{`/`}` or a subshell
//     `)` is (module header points 7-8), so the outer segment's head
//     test never matches. Added REVIEW ROUND 4, LOW (c).
//   - Any command past `MAX_NORMALIZE_LENGTH` (100,000 characters,
//     `command-normalize.ts`) falls back to the pre-round-2,
//     single-first-segment contract (`collectSegmentTexts` returns
//     `null`, see `resolveDeletionTarget`): only the FIRST shell segment
//     of such an oversized command is inspected, so a recognized
//     deletion verb in a LATER segment goes unrecognized. Named REVIEW
//     ROUND 4, LOW (f) — an accepted size-bounded residual of the
//     multi-segment recognition module header point 1 adds, not a new
//     gap this revision introduces.

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

/** True when `target` (already known absolute) lies inside one of
 * `safeRoots`. `allowRootItself` (module header point 6, corrected
 * REVIEW ROUND 4 MEDIUM): for `find`, the search-ROOT operand equalling
 * a declared root counts ONLY when the caller has determined the
 * invocation carries at least one non-action test predicate (see
 * `findHasTestPredicate`) — round 3's premise that "`find <root>
 * -delete` only ever deletes entries strictly inside `<root>`" is FALSE:
 * a bare `find /tmp -delete` (no `-name`/`-type`/... narrowing which
 * entries match) removes `/tmp` itself too, on both GNU findutils and
 * BSD find. `find /tmp -name '*.log' -delete` (a test predicate narrows
 * matches away from the root's own directory entry) is exactly as safe
 * as `find /tmp/scratch -delete`, so root-equality is allowed there. For
 * `rm` (and `git-clean`, unchanged), only STRICTLY deeper counts (module
 * header point 6) — the root path itself never does, and a target whose
 * final segment is a bare glob-sugar `*`/`**` never counts, regardless
 * of which root it would otherwise sit under. */
function isInsideAllowlist(
  target: string,
  safeRoots: readonly string[],
  allowRootItself: boolean,
): boolean {
  const normalizedTarget = normalizePosixPath(target);
  const lastSlash = normalizedTarget.lastIndexOf("/");
  const lastSegment = normalizedTarget.slice(lastSlash + 1);
  if (lastSegment === "*" || lastSegment === "**") return false;
  for (const rawRoot of safeRoots) {
    const root = normalizePosixPath(normalizeRoot(rawRoot));
    if (normalizedTarget.startsWith(`${root}/`)) return true;
    if (allowRootItself && normalizedTarget === root) return true;
  }
  return false;
}

/** Resolve one raw target token. `false` = unresolvable (gate it). */
function targetIsResolvedSafe(
  token: string,
  safeRoots: readonly string[],
  allowRootItself: boolean,
): boolean {
  if (token.includes("$")) return false; // unexpanded shell variable
  // Relative (does not start with `/`) — this also covers every
  // `~`-prefixed token, since `~foo` is never `/`-prefixed; a separate
  // `~`-prefix check here would be fully redundant with this one.
  if (!token.startsWith("/")) return false;
  return isInsideAllowlist(token, safeRoots, allowRootItself);
}

function buildVerdict(
  verb: DeletionTargetVerdict["verb"],
  targets: string[],
  safeRoots: readonly string[],
  allowRootItself = false,
): DeletionTargetVerdict {
  const unresolvedTargets = targets.filter((t) => !targetIsResolvedSafe(t, safeRoots, allowRootItself));
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
 * does NOT start with a digit or `<`/`>` and so needed a separate
 * alternative — REVIEW ROUND 4 MEDIUM; round 3's regex missed it, so
 * `rm -rf /tmp/x &>/dev/null` GATED with `&>/dev/null` misread as a
 * second, unresolvable target). Covers `>`, `>>`, `<`, `<<`, `<<<`,
 * `>&`, `<&`, `&>`, `&>>`, and a glued form like `>/dev/null` or
 * `2>&1`. When the matched token IS the bare operator (nothing glued to
 * it — `BARE_REDIRECT_OPERATOR_RE`), the FOLLOWING token (the filename,
 * when whitespace-separated from the operator) is dropped too — this
 * now also recognizes `>&`/`<&`/`&>`/`&>>` as bare operators (round 3
 * only recognized `>`/`>>`/`<`/`<<`/`<<<`), so `rm -rf /tmp/x >& out`
 * drops `out` the same way `rm -rf /tmp/x > out` already did. Applied
 * to the "rest" tokens of every resolver, before flag/target parsing —
 * a redirection operand is never a deletion target.
 *
 * ALSO stops accumulating at a bare `&` token (background-job marker)
 * rather than merely dropping it (REVIEW ROUND 4, LOW (b), corrected
 * from round 3): `nohup rm -rf /home/x &` segmented under the PRIMARY
 * (`BOUNDARY_RE`) arm keeps its trailing ` &` attached to the same
 * segment text (bare `&` is not one of that arm's boundary characters —
 * see `AMP_BOUNDARY_RE`'s own comment). Round 3 only dropped the `&`
 * token itself and kept parsing past it — which is harmless for a
 * single trailing `&` but WRONG for `rm -rf /home/x & rm -rf /home/y`:
 * the primary arm never splits on the bare `&` at all, so its ONE
 * segment's rest-tokens continued past the dropped `&` into the SECOND
 * invocation's own tokens, and the second invocation's verb (`rm`) —
 * not `-`-prefixed, so it fell through every flag check — was collected
 * as a spurious literal `"rm"` TARGET. Stopping at the first bare `&`
 * instead treats it as the end of THIS invocation, matching what a
 * background job actually is; the amp-aware arm already produces the
 * correct, separate segment for what comes after the `&`, and
 * `combineVerdicts`'s de-duplication (see its own comment) collapses
 * the resulting duplicate target this now yields, rather than the
 * previous version's bogus extra one.
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
  return buildVerdict("rm", targets, safeRoots);
}

/** Leading, non-flag path operands of a `find` invocation's own rest
 *  tokens — the search root(s). Shared by both the `-delete` and the
 *  `-exec`/`-execdir` recognition branches. */
function findPathOperands(rest: string[]): string[] {
  const paths: string[] = [];
  for (const t of rest) {
    if (t.startsWith("-")) break;
    paths.push(t);
  }
  return paths;
}

/**
 * `find`'s non-action TEST predicates (as opposed to its ACTION
 * primaries like `-delete`/`-exec`/`-print`): a `find <root> -delete`
 * whose expression carries at least one of these narrows which entries
 * match away from the root directory ENTRY itself, which is what makes
 * root-equality safe to resolve (see `isInsideAllowlist`'s own comment,
 * REVIEW ROUND 4 MEDIUM). A bare `find <root> -delete` with NONE of
 * these removes `<root>` itself too, so it must NOT get the
 * root-equality allowance. `-maxdepth`/`-mindepth` only count with a
 * value `>= 1` — `-maxdepth 0` still matches (and can delete) the root
 * entry alone.
 */
const FIND_TEST_PREDICATES: ReadonlySet<string> = new Set([
  "-name",
  "-iname",
  "-path",
  "-ipath",
  "-regex",
  "-type",
  "-mtime",
  "-mmin",
  "-newer",
  "-size",
  "-empty",
  "-user",
  "-perm",
]);

function findHasTestPredicate(rest: string[]): boolean {
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]!;
    if (FIND_TEST_PREDICATES.has(t)) return true;
    if (t === "-maxdepth" || t === "-mindepth") {
      const value = rest[i + 1];
      if (value !== undefined && Number.isFinite(Number(value)) && Number(value) >= 1) return true;
    }
  }
  return false;
}

function resolveFind(tokens: string[], safeRoots: readonly string[]): DeletionTargetVerdict | null {
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
  return buildVerdict("find", targets, safeRoots, findHasTestPredicate(rest));
}

function resolveGitClean(tokens: string[], safeRoots: readonly string[]): DeletionTargetVerdict | null {
  const rest = stripRedirections(tokens.slice(2));
  const hasForce = rest.some(
    (t) => t === "-f" || t === "--force" || (t.startsWith("-") && !t.startsWith("--") && t.includes("f")),
  );
  if (!hasForce) return null;
  const pathspecs = rest.filter((t) => !t.startsWith("-"));
  const targets = pathspecs.length > 0 ? pathspecs : ["."];
  return buildVerdict("git-clean", targets, safeRoots);
}

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
 * REVIEW ROUND 4 (task d03af8f6, HIGH): after the `xargs` token itself,
 * this NO LONGER walks `xargs`'s own flag table with `peelGenericFlags`
 * (a boolean-only loop). `xargs` has SEPARATED-value flags
 * (`-I {}`, `-n 1`, `-P 4`, `-a list`, `-d '\n'`) whose value token
 * `peelGenericFlags` cannot distinguish from a verb: it consumed only
 * the flag token itself, leaving the value token (`{}`, `1`, `4`, ...)
 * sitting where the verb was expected, so `xargs -I {} rm -rf {}`,
 * `xargs -n 1 rm -rf`, `xargs -P 4 rm -rf`, `xargs -a list rm -rf`, and
 * `xargs -d '\n' rm -rf` all failed the head test and ran UNGATED (only
 * the glued forms — `-I{}`, `-0`, `-n1` — happened to gate, since those
 * have no separate value token to strand). Modeling `xargs`'s full
 * separated-vs-glued value-flag vocabulary would be a fourth
 * independently-drifting copy of exactly the kind of table this module
 * has twice now replaced with shared machinery (module header points 1
 * and 2) — so instead of enumerating `xargs`'s option table at all, this
 * scans FORWARD from the token after `xargs` (bounded by
 * `tokens.length`, `findXargsVerbHead` below) for the first token that
 * is itself a recognized deletion-verb head (`RM_HEAD_RE`, `find`, or
 * `git` immediately followed by `clean`) and resumes recognition there,
 * skipping over every `xargs` flag AND its value uniformly, regardless
 * of which spelling was used. `xargs`'s own semantics for "no verb head
 * found at all" match `peelWrapperHeadsAndXargs`'s existing behavior:
 * `idx` lands past the end of the segment, `tokens.length === 0` after
 * slicing, and `resolveSegmentText` returns `null` — e.g. `xargs echo
 * hi` stays unrecognized, same as before this fix.
 */
function findXargsVerbHead(tokens: readonly WrapperPeelToken[], startIdx: number): number {
  for (let i = startIdx; i < tokens.length; i++) {
    const t = tokens[i]!.text;
    if (RM_HEAD_RE.test(t) || t === "find" || (t === "git" && tokens[i + 1]?.text === "clean")) {
      return i;
    }
  }
  return tokens.length;
}

function peelWrapperHeadsAndXargs(
  tokens: readonly WrapperPeelToken[],
): { idx: number; xargsWrapped: boolean } {
  let idx = 0;
  let xargsWrapped = false;
  for (let guard = 0; guard <= tokens.length; guard++) {
    const before = idx;
    idx = peelWrapperPrefixes(tokens, idx).idx;
    if (tokens[idx]?.text === "xargs") {
      xargsWrapped = true;
      idx = findXargsVerbHead(tokens, idx + 1);
      continue;
    }
    if (idx === before) break;
  }
  return { idx, xargsWrapped };
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

/**
 * Resolve one already-isolated shell segment's text: strip a leading
 * `cd <path> &&` / `VAR=value` / `git switch|checkout <branch> &&`
 * prefix via `parseBashPrefix` (composing with, not duplicating, the
 * a7eb1a71 environment-signal path), strip brace-group/subshell edge
 * markers, peel a wrapper-command chain
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
  const rawTokens = stripTrailingParen(stripBraceGroupMarkers(tokenizeRaw(remainder)));
  const decodedTokens = rawTokens.map((t) => decodeShellWord(t));
  const peelTokens: WrapperPeelToken[] = decodedTokens.map((text) => ({ text }));
  const { idx, xargsWrapped } = peelWrapperHeadsAndXargs(peelTokens);
  const tokens = decodedTokens.slice(idx);
  if (tokens.length === 0) return null;

  const head = tokens[0]!;
  if (RM_HEAD_RE.test(head)) return resolveRm(tokens, safeRoots, xargsWrapped);
  if (head === "find") return resolveFind(tokens, safeRoots);
  if (head === "git" && tokens[1] === "clean") return resolveGitClean(tokens, safeRoots);
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
 * REVIEW ROUND 4 (LOW (b), replacing round 3's "accepted cosmetic
 * quirk"): de-duplication in `collectSegmentTexts` is by exact segment
 * TEXT, per arm, which is not enough — a command whose recognized
 * segment differs between the two arms only in a trailing marker the
 * PRIMARY arm's alphabet does not split on but the AMP-AWARE arm's does
 * (`nohup rm -rf /home/x &`: the trailing ` &` survives inside the
 * primary arm's single segment, but the amp-aware arm splits it off
 * into its own unrecognized segment) produces two textually DIFFERENT
 * recognized segments for what a human reads as ONE invocation, whose
 * `verb`+`targets` are nonetheless IDENTICAL once each is resolved.
 * `dedupeVerdicts` below removes that duplication (and its matching
 * `reason` line) by exact `(verb, JSON(targets))` equality before
 * combining, rather than accepting it as cosmetic. This also fixes a
 * correctness bug the round-3 comment did not anticipate: for `rm -rf
 * /home/x & rm -rf /home/y`, the primary arm's SINGLE segment (bare `&`
 * is not one of its boundary characters) used to keep parsing past the
 * dropped `&` into the SECOND invocation's own tokens, collecting its
 * verb `rm` as a spurious literal target; `stripRedirections` now stops
 * at the first bare `&` instead (see its own comment), so the primary
 * arm's verdict for that command is now IDENTICAL to the amp-aware
 * arm's first-segment verdict, and dedup collapses the pair, leaving
 * only the real, distinct `/home/x`/`/home/y` targets.
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
