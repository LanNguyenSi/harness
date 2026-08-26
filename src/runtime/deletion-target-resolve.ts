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
// SCOPE, deliberately narrow, mirroring `kubectl-target-parse.ts`'s own
// stated narrowing:
//
//   1. The deletion verb is recognized only as the command's FIRST shell
//      segment, after stripping a leading `cd <path> &&` / `VAR=value` /
//      `git switch|checkout <branch> &&` prefix via the shared
//      `parseBashPrefix` (composing with, not duplicating, the a7eb1a71
//      environment-signal path). A deletion verb that is not the first
//      segment of a chained command (`echo hi && rm -rf /x`) is not
//      recognized — the existing `dangerous-shell` classifier's
//      unanchored regex already covers a dangerous tail for the
//      production-scoped gates; this module's job is the narrower
//      dev-context safety net.
//   2. Tokenization is whitespace-delimited with single/double-quote
//      support (quote characters stripped, no escape or `$`
//      interpolation modeled) — the same quoted-token handling this
//      runtime's other narrow parsers (`kubectl-target-parse.ts`,
//      `bash-prefix-parse.ts`) already use. No shell is ever spawned; no
//      regex is used anywhere in this module (regex-hygiene constraint,
//      task d03af8f6 — a tokenizer over a flag/target token list, not a
//      nested-quantifier pattern, so no ReDoS timing test applies here).
//   3. Target resolution is purely SYNTACTIC:
//        - A token containing `$` (an unexpanded shell variable
//          reference) is UNRESOLVABLE — this module never evaluates the
//          shell environment (outOfScope, task d03af8f6).
//        - A token starting with `~` is UNRESOLVABLE — expanding it
//          would need the runtime's real `$HOME`, which this static
//          resolver does not read.
//        - A RELATIVE path (does not start with `/`) is UNRESOLVABLE —
//          this resolver does NOT consult the event's cwd (deliberately:
//          a relative target's real location depends on ambient state
//          this module does not read, and guessing would defeat the
//          "statically resolvable" contract).
//        - An ABSOLUTE path is resolved via `path.posix.normalize` (so a
//          `..`-traversal that exits every declared root is caught) and
//          compared against each `safeRoots` entry as a directory-prefix
//          match (target === root, or target.startsWith(root + "/")).
//
// Never throws. Returns `null` when `command` does not, by the narrow
// head test above, name a recognized deletion verb at all.

import { parseBashPrefix } from "./bash-prefix-parse.js";

/** Verdict for one recognized deletion-verb command. */
export interface DeletionTargetVerdict {
  /** The recognized deletion verb. */
  verb: "rm" | "find" | "git-clean";
  /** Every target token this invocation acts on, in encounter order. */
  targets: string[];
  /** The subset of `targets` that could not be statically proven safe. */
  unresolvedTargets: string[];
  /** True when at least one target is unresolved — the action should be gated. */
  unresolvable: boolean;
  /** One human-readable summary line. */
  reason: string;
}

const WS = /\s/;

function skipWs(s: string, i: number): number {
  while (i < s.length && WS.test(s[i]!)) i++;
  return i;
}

/**
 * Slice `command` down to its first shell segment: everything up to
 * (not including) the first unquoted `&&`, `||`, `;`, bare `|`, bare
 * `&`, or newline. Quoted spans are tracked so a chain-looking character
 * inside a quoted value does not end the segment early. Copied narrowly
 * from `kubectl-target-parse.ts`'s own `firstSegment` (not exported
 * there; that module's doc explains why a shared helper was judged not
 * worth the coupling for a ~15-line, single-purpose function).
 */
function firstSegment(command: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (inSingle) {
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      continue;
    }
    if (c === "\n" || c === ";" || c === "|" || c === "&") {
      return command.slice(0, i);
    }
  }
  return command;
}

/** Whitespace-delimited tokenizer with quote support. Same shape as
 * `kubectl-target-parse.ts`'s private `tokenize`. */
function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const n = segment.length;
  while (i < n) {
    i = skipWs(segment, i);
    if (i >= n) break;
    let token = "";
    while (i < n && !WS.test(segment[i]!)) {
      const c = segment[i]!;
      if (c === "'" || c === '"') {
        const end = segment.indexOf(c, i + 1);
        if (end < 0) {
          token += segment.slice(i + 1);
          i = n;
          break;
        }
        token += segment.slice(i + 1, end);
        i = end + 1;
        continue;
      }
      token += c;
      i++;
    }
    tokens.push(token);
  }
  return tokens;
}

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

/** True when `target` (already known absolute) lies inside one of `safeRoots`. */
function isInsideAllowlist(target: string, safeRoots: readonly string[]): boolean {
  const normalizedTarget = normalizePosixPath(target);
  for (const rawRoot of safeRoots) {
    const root = normalizePosixPath(normalizeRoot(rawRoot));
    if (normalizedTarget === root || normalizedTarget.startsWith(`${root}/`)) {
      return true;
    }
  }
  return false;
}

/** Resolve one raw target token. `false` = unresolvable (gate it). */
function targetIsResolvedSafe(token: string, safeRoots: readonly string[]): boolean {
  if (token.includes("$")) return false; // unexpanded shell variable
  if (token.startsWith("~")) return false; // unexpanded home directory
  if (!token.startsWith("/")) return false; // relative path — not statically resolvable
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

function resolveRm(tokens: string[], safeRoots: readonly string[]): DeletionTargetVerdict | null {
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
  if (targets.length === 0) return null;
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
 * Resolve the static deletion-target verdict for a Bash command string,
 * or `null` when the command's first shell segment (after stripping a
 * leading `cd`/`VAR=`/`git switch` prefix) does not name a recognized
 * deletion verb at all. Never throws.
 */
export function resolveDeletionTarget(
  command: string,
  safeRoots: readonly string[],
): DeletionTargetVerdict | null {
  if (typeof command !== "string" || command.length === 0) return null;
  const prefix = parseBashPrefix(command);
  const remainder = command.slice(prefix.remainderStart);
  const tokens = tokenize(firstSegment(remainder));
  if (tokens.length === 0) return null;

  const head = tokens[0];
  if (head === "rm") return resolveRm(tokens, safeRoots);
  if (head === "find") return resolveFind(tokens, safeRoots);
  if (head === "git" && tokens[1] === "clean") return resolveGitClean(tokens, safeRoots);
  return null;
}
