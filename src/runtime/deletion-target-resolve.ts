// Risk Gate — static deletion-target resolver (task d03af8f6).
//
// The existing `dangerous-shell` classifier + `gate-prod-destructive*`
// policies gate a destructive shell action only when the Context
// Resolver resolves `environment: production`. On a task branch the
// environment is `unknown`, and every deletion — including one whose
// target is a typo or a stale variable pointing outside any scratch
// area — runs unconfirmed. This module closes that specific gap: it
// recognizes a deletion-verb command (`rm -r*`/`-f*`, `find ... -delete`,
// `git clean -f*`) and decides, STATICALLY (no filesystem I/O, no
// process-env read, no shell-variable expansion, no cwd substitution),
// whether every target it names is provably inside a declared
// `risk.safe_deletion_roots` entry. `src/runtime/when-eval.ts`'s new
// `action.deletion_target_unresolvable` clause reads the verdict this
// module produces to gate environment-INDEPENDENTLY, deliberately NOT
// reusing the `risk.*` when-clauses (see that module's own doc comment
// for why: those clauses fail-close to matched=true for ANY unclassified
// action, which would make an unscoped policy fire on every unrelated
// unclassified Bash call in every environment — approval spam, not a
// deletion-specific gate).
//
// REVIEW ROUND 2 (task d03af8f6, this revision) rewrote the recognition
// surface after five measured gaps in the first cut. Corrected scope,
// replacing the round-1 SCOPE section verbatim:
//
//   1. EVERY shell segment is inspected, not just the first. Multi-
//      segment splitting reuses `segmentViewOf` (`command-normalize.ts`)
//      — the same per-segment canonicalised-text view
//      `resolveAttributedContexts` already consumes — so `S=/tmp/x\nrm
//      -rf $S/dogfood`, `T=/tmp/a && rm -rf $T && mkdir -p $T`, and
//      `echo hi && rm -rf /home/x` are all recognised now. The round-1
//      claim that "the existing dangerous-shell classifier's unanchored
//      regex already covers a dangerous tail" was WRONG in dev context:
//      that classifier only feeds the production-scoped
//      `gate-prod-destructive*` policies, so on a task branch
//      (`environment: unknown`) a chained deletion tail was gated by
//      NOTHING. The verdict for a multi-segment command is the AND of
//      every recognised deletion segment: unresolvable if ANY of them
//      is, resolved only if ALL of them are — see `combineVerdicts`.
//      `segmentViewOf` also canonicalises a git invocation's own global
//      options (`git -C /repo clean -fdx` -> `git clean -fdx`), closing
//      a wrapper gap for free. When `segmentViewOf` declines (an
//      oversized command past `MAX_NORMALIZE_LENGTH`) this module falls
//      back to the single-first-segment path only, matching its
//      pre-round-2 contract.
//   2. A wrapper prefix on the deletion verb ITSELF is peeled before the
//      head test: `sudo`, `doas`, `command`, `env` (consuming its
//      leading `VAR=value` arguments), `time`, `timeout` (consuming its
//      leading duration argument), `nice`, and `xargs` — see
//      `peelWrapperHeads`. `command-normalize.ts`'s own peeling does
//      NOT cover this: that module's wrapper-prefix handling is scoped
//      to a closed set of APPLICATION head tokens (`git`/`gh`/`npm`/
//      `harness`), not arbitrary shell verbs like `rm`/`find`, so `sudo
//      rm -rf /x` reached this module's segment text completely
//      unpeeled — verified empirically against `segmentViewOf`, not
//      assumed. `xargs` is a special case: it supplies its wrapped
//      command's operands from STDIN at runtime, which this resolver
//      can never read, so `xargs rm -rf` (no explicit path operand at
//      all) is UNRESOLVABLE rather than "not recognised as a deletion"
//      the way a bare, operand-less `rm -rf` normally is — see
//      `resolveRm`'s `xargsWrapped` parameter.
//   3. A recognised `rm` head additionally accepts a path-qualified
//      spelling (`/bin/rm`, `/usr/bin/rm`) via `RM_HEAD_RE`.
//   4. Every token is decoded with `decodeShellWord` (`shell-word.ts`)
//      before any verb/flag/`-delete` comparison, so a flag hidden
//      behind quote concatenation or an ANSI-C escape (`find /home/x
//      $'\x2ddelete'`, `git clean $'\x2df'`) is recognised. Scoping
//      note (deliberately narrower than `shell-word.ts`'s documented
//      "test raw OR decoded" convention): this module decodes ONCE and
//      compares the decoded value only, not raw-or-decoded. That
//      convention exists to guard against a decode LOSING a match an
//      already-plain raw token would have had; the flag vocabulary this
//      module tests (`-r`/`-R`/`-f`/`--recursive`/`--force`/`-delete`)
//      has no member where decoding a legitimately-quoted argument could
//      produce a non-matching string the raw form would have matched,
//      and `decodeShellWord` returns a token completely unchanged
//      (fast-pathed) whenever it contains no quote/escape syntax at all
//      — so for the ordinary, unquoted case decoded === raw exactly.
//   5. Target resolution is purely SYNTACTIC, corrected in two ways this
//      round:
//        - A token containing `$` (an unexpanded shell variable
//          reference) or NOT starting with `/` (relative — including
//          every `~`-prefixed token, since `~` is never a `/`-prefixed
//          absolute path; the round-1 module carried a SEPARATE,
//          entirely redundant `~`-prefix early return that this
//          relative-path check already fully subsumed) is
//          UNRESOLVABLE.
//        - An ABSOLUTE path is resolved via `normalizePosixPath` (so a
//          `..`-traversal that exits every declared root is caught),
//          and a target is inside a root only when it is STRICTLY
//          DEEPER than that root (`target.startsWith(root + "/")`) —
//          round 1 wrongly treated the root path ITSELF as resolved
//          (`rm -rf /tmp` allowed), which this round flips. A target
//          whose final path segment is a bare `*` or `**` (glob sugar,
//          not a real glob evaluation) is UNRESOLVABLE regardless of
//          which root it sits under: `/tmp/*` names "whatever `/tmp`
//          currently contains," not a specific, provably-safe path.
//
// Never throws. Returns `null` when no shell segment of `command`, by
// the narrow head test above, names a recognized deletion verb at all.

import { parseBashPrefix } from "./bash-prefix-parse.js";
import { segmentViewOf } from "./command-normalize.js";
import { firstSegment } from "./kubectl-target-parse.js";
import { decodeShellWord } from "./shell-word.js";

/** Verdict for one recognized deletion-verb command. */
export interface DeletionTargetVerdict {
  /**
   * The recognized deletion verb. When a chained command names MORE
   * THAN ONE recognized deletion segment (task d03af8f6, review round
   * 2), this names only the FIRST recognized segment's verb —
   * `unresolvable`/`targets`/`unresolvedTargets` still account for
   * every recognized segment; see `combineVerdicts`.
   */
  verb: "rm" | "find" | "git-clean";
  /** Every target token this invocation acts on, in encounter order
   *  (across every recognized deletion segment, when there is more than
   *  one). */
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
 * to hand to `decodeShellWord`.
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
 *  module header point 4 for the decoded-only scoping decision. */
function tokenizeDecoded(segment: string): string[] {
  return tokenizeRaw(segment).map((t) => decodeShellWord(t));
}

/** Verbs whose own leading argument(s) this loop consumes as it peels
 *  the wrapper away — boolean-flag-only wrappers that take no argument
 *  of their own before the wrapped command. */
const BOOLEAN_WRAPPER_HEADS = new Set(["sudo", "doas", "command", "time", "nice"]);

const ENV_VAR_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const LEADING_DIGIT_RE = /^[0-9]/;

/**
 * Peel a leading wrapper-command chain off `tokens` (module header point
 * 2): `sudo`/`doas`/`command`/`time`/`nice` (no argument of their own),
 * `env` (consuming leading `VAR=value` tokens), `timeout` (consuming its
 * leading duration argument, e.g. `5`, `5s`, `1m30s`), and `xargs`
 * (flagged via the returned `xargsWrapped`, its own flags NOT modeled —
 * this module only needs to know a deletion verb sits behind it, not
 * xargs's own invocation shape). Composes: `sudo env X=1 timeout 5 rm
 * -rf /x` peels all four. Never throws; an unrecognized head simply
 * stops the loop.
 */
function peelWrapperHeads(tokens: string[]): { tokens: string[]; xargsWrapped: boolean } {
  let i = 0;
  let xargsWrapped = false;
  while (i < tokens.length) {
    const head = tokens[i]!;
    if (BOOLEAN_WRAPPER_HEADS.has(head)) {
      i++;
      continue;
    }
    if (head === "env") {
      i++;
      while (i < tokens.length && ENV_VAR_ASSIGNMENT_RE.test(tokens[i]!)) i++;
      continue;
    }
    if (head === "timeout") {
      i++;
      if (i < tokens.length && LEADING_DIGIT_RE.test(tokens[i]!)) i++;
      continue;
    }
    if (head === "xargs") {
      i++;
      xargsWrapped = true;
      continue;
    }
    break;
  }
  return { tokens: tokens.slice(i), xargsWrapped };
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
 * of `safeRoots` — the root path itself does not count (module header
 * point 5), and a target whose final segment is a bare glob-sugar `*`/
 * `**` never counts, regardless of which root it would otherwise sit
 * under. */
function isInsideAllowlist(target: string, safeRoots: readonly string[]): boolean {
  const normalizedTarget = normalizePosixPath(target);
  const lastSlash = normalizedTarget.lastIndexOf("/");
  const lastSegment = normalizedTarget.slice(lastSlash + 1);
  if (lastSegment === "*" || lastSegment === "**") return false;
  for (const rawRoot of safeRoots) {
    const root = normalizePosixPath(normalizeRoot(rawRoot));
    if (normalizedTarget.startsWith(`${root}/`)) {
      return true;
    }
  }
  return false;
}

/** Resolve one raw target token. `false` = unresolvable (gate it). */
function targetIsResolvedSafe(token: string, safeRoots: readonly string[]): boolean {
  if (token.includes("$")) return false; // unexpanded shell variable
  // Relative (does not start with `/`) — this also covers every
  // `~`-prefixed token, since `~foo` is never `/`-prefixed; a separate
  // `~`-prefix check here would be fully redundant with this one (see
  // module header point 5).
  if (!token.startsWith("/")) return false;
  return isInsideAllowlist(token, safeRoots);
}

function buildVerdict(
  verb: DeletionTargetVerdict["verb"],
  targets: string[],
  safeRoots: readonly string[],
): DeletionTargetVerdict {
  const unresolvedTargets = targets.filter((t) => !targetIsResolvedSafe(t, safeRoots));
  const unresolvable = unresolvedTargets.length > 0;
  const reason = unresolvable
    ? `${verb}: target(s) not statically resolvable inside a declared risk.safe_deletion_roots entry: ${unresolvedTargets.join(", ")}`
    : `${verb}: every target resolves inside a declared risk.safe_deletion_roots entry`;
  return { verb, targets, unresolvedTargets, unresolvable, reason };
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
  for (const t of tokens.slice(1)) {
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

function resolveFind(tokens: string[], safeRoots: readonly string[]): DeletionTargetVerdict | null {
  if (!tokens.slice(1).includes("-delete")) return null;
  const paths: string[] = [];
  for (const t of tokens.slice(1)) {
    if (t.startsWith("-")) break;
    paths.push(t);
  }
  const targets = paths.length > 0 ? paths : ["."];
  return buildVerdict("find", targets, safeRoots);
}

function resolveGitClean(tokens: string[], safeRoots: readonly string[]): DeletionTargetVerdict | null {
  const rest = tokens.slice(2);
  const hasForce = rest.some(
    (t) => t === "-f" || t === "--force" || (t.startsWith("-") && !t.startsWith("--") && t.includes("f")),
  );
  if (!hasForce) return null;
  const pathspecs = rest.filter((t) => !t.startsWith("-"));
  const targets = pathspecs.length > 0 ? pathspecs : ["."];
  return buildVerdict("git-clean", targets, safeRoots);
}

/**
 * Resolve one already-isolated shell segment's text: strip a leading
 * `cd <path> &&` / `VAR=value` / `git switch|checkout <branch> &&`
 * prefix via `parseBashPrefix` (composing with, not duplicating, the
 * a7eb1a71 environment-signal path), peel a wrapper-command chain
 * (`peelWrapperHeads`), decode every remaining token, and run the head
 * test. `null` when this segment does not name a recognized deletion
 * verb at all.
 */
function resolveSegmentText(
  segmentText: string,
  safeRoots: readonly string[],
): DeletionTargetVerdict | null {
  const prefix = parseBashPrefix(segmentText);
  const remainder = segmentText.slice(prefix.remainderStart);
  const decodedTokens = tokenizeDecoded(remainder);
  const { tokens, xargsWrapped } = peelWrapperHeads(decodedTokens);
  if (tokens.length === 0) return null;

  const head = tokens[0]!;
  if (RM_HEAD_RE.test(head)) return resolveRm(tokens, safeRoots, xargsWrapped);
  if (head === "find") return resolveFind(tokens, safeRoots);
  if (head === "git" && tokens[1] === "clean") return resolveGitClean(tokens, safeRoots);
  return null;
}

/**
 * Combine every recognized deletion segment's verdict from one chained
 * command (module header point 1) into a single verdict: `unresolvable`
 * is the OR of every segment's, `targets`/`unresolvedTargets` are the
 * concatenation in encounter order, `verb` names only the FIRST
 * recognized segment's verb, and `reason` joins every segment's own
 * reason with `; `.
 */
function combineVerdicts(verdicts: DeletionTargetVerdict[]): DeletionTargetVerdict {
  if (verdicts.length === 1) return verdicts[0]!;
  return {
    verb: verdicts[0]!.verb,
    targets: verdicts.flatMap((v) => v.targets),
    unresolvedTargets: verdicts.flatMap((v) => v.unresolvedTargets),
    unresolvable: verdicts.some((v) => v.unresolvable),
    reason: verdicts.map((v) => v.reason).join("; "),
  };
}

/**
 * Resolve the static deletion-target verdict for a Bash command string,
 * across EVERY shell segment (module header point 1), or `null` when no
 * segment names a recognized deletion verb at all. Never throws.
 */
export function resolveDeletionTarget(
  command: string,
  safeRoots: readonly string[],
): DeletionTargetVerdict | null {
  if (typeof command !== "string" || command.length === 0) return null;

  const segments = segmentViewOf(command);
  if (segments === null) {
    // Oversized command (past `MAX_NORMALIZE_LENGTH`) — `segmentViewOf`
    // declines to run at all. Fall back to the pre-round-2,
    // single-first-segment contract: prefix-strip the WHOLE command
    // first (a recognized `cd`/`VAR=` prefix can itself span past a
    // `&&`), THEN take the first segment of what remains.
    const prefix = parseBashPrefix(command);
    const remainder = command.slice(prefix.remainderStart);
    return resolveSegmentText(firstSegment(remainder), safeRoots);
  }

  const verdicts: DeletionTargetVerdict[] = [];
  for (const seg of segments) {
    const v = resolveSegmentText(seg.text, safeRoots);
    if (v !== null) verdicts.push(v);
  }
  return verdicts.length === 0 ? null : combineVerdicts(verdicts);
}
