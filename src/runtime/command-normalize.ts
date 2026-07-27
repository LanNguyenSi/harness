// Trigger-matching normaliser for Bash command strings (run
// 2026-07-27-gate-target-repo-resolution, T-001/T-002).
//
// Every `bash_match` policy trigger (`src/cli/init/templates.ts`,
// `docs/examples/full-manifest.yaml`) is a single regex tested against the
// UNPARSED command string, anchored on a shell boundary
// (`^ \n ; | && (`) followed by optional `VAR=value` tokens and a literal
// `git`. That anchor is exact-spelling brittle: an `env` / `nice` / `command`
// wrapper, a git global option other than `-C`, or even a second space
// between `git` and its subcommand defeats the match silently — the policy
// is skipped, no ledger query happens, and there is zero audit signal (see
// `01-plan.md` for the reproduction). This module closes that gap by
// deriving a NORMALISED form of the command that a `bash_match` regex can
// ALSO be tested against (raw-OR-normalised, never raw-replaced-by-
// normalised — see `src/runtime/intercept.ts`'s `policyMatchesEvent`).
//
// SUPPORTED (peeled/canonicalised):
//   - Leading `VAR=value` tokens (any number, in sequence).
//   - `env`, including `-C <dir>` / `--chdir <dir>` / `-C<dir>` /
//     `--chdir=<dir>` and its own `VAR=value` arguments.
//   - `command` (its own flags, e.g. `-p`/`-v`/`-V`, and `--`).
//   - `nice`, including `-n <n>` / `-n<n>` / `--adjustment=<n>`.
//   - A git invocation's own global options: `-C <dir>`, `-c <k=v>`,
//     `--git-dir[= ]<dir>`, `--work-tree[= ]<dir>`, `--no-pager`,
//     `-p`/`--paginate`, `--exec-path[=<path>]`, `--namespace[= ]<ns>`,
//     `--literal-pathspecs`, `--no-replace-objects` — dropped so the
//     subcommand becomes adjacent to the literal `git` token, and the
//     whitespace between them collapses to exactly one space.
//   - The effective target directory of the first git invocation found,
//     from (in priority order) the git invocation's own `-C` /
//     `--work-tree` / `--git-dir` (parent directory when the path ends in
//     `.git`), the wrapping `env -C` / `--chdir`, or — only when nothing
//     else names one — a leading `cd <dir> &&|;` prefix (delegated to
//     `bash-prefix-parse.ts`, which already parses that idiom).
//
// DELIBERATELY NOT SUPPORTED, and out of reach of ANY string-level
// approach (see `CHANGELOG.md` task `2cc73f55`, decision D-005 in this
// run's `03-decisions.md`):
//   - `sh -c '...'` / `bash -c '...'`: the wrapped command lives inside a
//     single string argument. This module does not parse into it — note
//     that such a command usually still matches a `bash_match` regex
//     anyway, because the regex scans the RAW command string without
//     respecting quoting, so a shell boundary (`&&`, `;`, ...) inside the
//     quoted string is still "seen".
//   - Heredocs, `eval`, base64-decoded payloads, or a script file the
//     agent writes and then executes.
//   - `pushd`/`popd`, and a `cd` inside a nested subshell
//     (`(cd X && ...)`) — mirrors `bash-prefix-parse.ts`'s own scope.
//   - Quoted directory arguments containing whitespace (e.g. `git -C
//     '/path with spaces' status`): the tokeniser splits on whitespace
//     without quote-awareness, so such a case falls through to "no git
//     invocation found here" and the segment is left unchanged. Safe
//     (never a false positive), just not one of the covered shapes.
//
// Bounded, allocation-light, pure string work: no `fs`, no
// `child_process`, no network. This runs on every Bash/Edit/Write tool
// call, so it must stay cheap. Never throws: a malformed or unparseable
// command falls through cleanly and `normalized` is the input unchanged.

import { parseBashPrefix } from "./bash-prefix-parse.js";

export interface NormalizedCommand {
  /**
   * The command with wrapper prefixes peeled and git invocations
   * canonicalised to `git <subcommand>`. Shell boundary characters
   * (`\n ; | && ( )`) are preserved verbatim so a boundary-anchored
   * regex still matches. Byte-identical to the input when nothing
   * recognisable was found anywhere in the command.
   */
  normalized: string;
  /**
   * The effective target directory of the first git invocation the
   * command names (see the module header for the resolution order), or
   * `null` when the command names none. NOT yet consumed by
   * `policyMatchesEvent` — a later task resolves `${REPO}`/`${BRANCH}`
   * from it.
   */
  targetDir: string | null;
}

/** A whitespace-delimited token plus its offset within the segment it came from. */
interface Token {
  text: string;
  start: number;
  end: number;
}

const VAR_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Shell boundary substrings a `bash_match` regex can anchor on. Order is irrelevant: `findNextBoundary` picks the earliest occurrence, longest-token-first on a tie. */
const BOUNDARY_TOKENS: readonly string[] = ["\n", "&&", ";", "|", "("];

/**
 * Given a Bash command string, return its normalised form and the target
 * directory of its first git invocation. Never throws: any internal
 * failure (there should be none — this is a defensive backstop matching
 * the fail-safe shape used elsewhere in this codebase, e.g.
 * `policyMatchesEvent`'s `try/catch` around `new RegExp`) falls back to
 * the input unchanged.
 */
export function normalizeCommand(command: string): NormalizedCommand {
  if (typeof command !== "string" || command.length === 0) {
    return { normalized: typeof command === "string" ? command : "", targetDir: null };
  }
  try {
    return normalizeCommandInner(command);
  } catch {
    return { normalized: command, targetDir: null };
  }
}

function normalizeCommandInner(command: string): NormalizedCommand {
  const parts: string[] = [];
  let targetDir: string | null = null;
  let i = 0;
  const n = command.length;

  // Walk the command as alternating (segment, boundary) pairs. Each
  // segment is handed to `canonicalizeSegment`, which rewrites ONLY its
  // head (wrapper prefixes + a git invocation's global options, if any
  // are found) and leaves the remainder of the segment — and every
  // boundary token — untouched. Bounded: `i` strictly increases by at
  // least one boundary token's length each iteration a boundary is
  // found, and the loop stops once none remain.
  for (;;) {
    const boundary = findNextBoundary(command, i);
    const segEnd = boundary ? boundary.start : n;
    const segmentText = command.slice(i, segEnd);
    const result = canonicalizeSegment(segmentText);
    parts.push(result.text);
    if (targetDir === null) targetDir = result.targetDir;
    if (!boundary) break;
    parts.push(boundary.token);
    i = boundary.start + boundary.token.length;
  }

  // Lowest-priority target-dir source: a leading `cd <dir> &&|;` prefix,
  // only consulted when no segment named a target directory more
  // directly (env -C, git -C, --work-tree, --git-dir). Delegated to the
  // existing leading-prefix parser rather than reimplementing its
  // quote-handling.
  if (targetDir === null) {
    const cd = parseBashPrefix(command).cdTarget;
    if (cd !== null) targetDir = cd;
  }

  return { normalized: parts.join(""), targetDir };
}

/** Find the earliest shell boundary token at or after `from`. Returns null when none remain. */
function findNextBoundary(
  s: string,
  from: number,
): { start: number; token: string } | null {
  let best: { start: number; token: string } | null = null;
  for (const token of BOUNDARY_TOKENS) {
    const idx = s.indexOf(token, from);
    if (idx === -1) continue;
    if (
      best === null ||
      idx < best.start ||
      (idx === best.start && token.length > best.token.length)
    ) {
      best = { start: idx, token };
    }
  }
  return best;
}

/** Split a segment into whitespace-delimited tokens with their offsets. */
function tokenizeWithOffsets(s: string): Token[] {
  const out: Token[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * Rewrite one boundary-delimited segment: peel wrapper prefixes to look
 * for a git invocation, and — ONLY if one is found — canonicalise it to
 * `git <subcommand>`, keeping everything after the subcommand verbatim.
 * When no git invocation is found (wrong binary, ran out of tokens, or a
 * malformed git global option), the segment is returned COMPLETELY
 * UNCHANGED: peeling is tentative, and nothing is stripped from a
 * segment that turns out not to be a git call (so `digit=1 foo`, `env -C
 * X ls`, etc. are never touched).
 */
function canonicalizeSegment(segmentText: string): {
  text: string;
  targetDir: string | null;
} {
  const tokens = tokenizeWithOffsets(segmentText);
  if (tokens.length === 0) return { text: segmentText, targetDir: null };

  let idx = 0;
  let envTargetDir: string | null = null;

  // Peel wrapper prefixes: VAR=value tokens, `env` (+ its own flags/
  // assignments), `command` (+ its own flags), `nice` (+ its own
  // flags). Bounded by tokens.length so a pathological input cannot spin.
  for (let guard = 0; guard < tokens.length; guard++) {
    const head = tokens[idx]?.text;
    if (head === undefined) break;
    if (VAR_ASSIGN_RE.test(head)) {
      idx += 1;
      continue;
    }
    if (head === "env") {
      const r = peelEnv(tokens, idx + 1);
      idx = r.idx;
      if (envTargetDir === null) envTargetDir = r.targetDir;
      continue;
    }
    if (head === "command") {
      idx = peelCommand(tokens, idx + 1);
      continue;
    }
    if (head === "nice") {
      idx = peelNice(tokens, idx + 1);
      continue;
    }
    break;
  }

  if (tokens[idx]?.text !== "git") {
    return { text: segmentText, targetDir: null };
  }
  idx += 1; // consume the literal `git` token

  const gitOpts = peelGitGlobalOptions(tokens, idx);
  if (gitOpts.malformed || gitOpts.idx >= tokens.length) {
    // Malformed global option (missing required value) or no subcommand
    // token left: nothing safe to canonicalise. Leave untouched.
    return { text: segmentText, targetDir: null };
  }

  const subcommandTok = tokens[gitOpts.idx]!;
  const rewritten = `git ${subcommandTok.text}${segmentText.slice(subcommandTok.end)}`;
  return { text: rewritten, targetDir: gitOpts.targetDir ?? envTargetDir };
}

/**
 * Peel `env`'s own leading flags and `VAR=value` assignments, mirroring
 * the shape of the equivalent peeling in `read-only-bash.ts`'s `env`
 * branch (not imported from there — that module's constants are
 * private, and this module's job, canonicalising for regex matching, is
 * distinct enough from that one's read-only classification that forking
 * a small, self-contained copy is clearer than reaching across layers).
 * Returns the cursor after the last recognised token and the `-C`/
 * `--chdir` target directory, if any.
 */
function peelEnv(
  tokens: Token[],
  startIdx: number,
): { idx: number; targetDir: string | null } {
  let idx = startIdx;
  let targetDir: string | null = null;
  while (idx < tokens.length) {
    const t = tokens[idx]!.text;
    // `-S`/`--split-string` re-parses a single string argument into a
    // fresh argv — we cannot safely see through it. Stop peeling here;
    // whatever follows is opaque, and since it is not the literal `git`
    // token the caller's git-check below fails harmlessly.
    if (/^(-S.*|--split-string(=.*)?)$/.test(t)) break;
    if (t === "--") {
      idx += 1;
      break;
    }
    if (t === "-C" || t === "--chdir") {
      const dir = tokens[idx + 1]?.text;
      if (dir === undefined) break;
      if (targetDir === null) targetDir = dir;
      idx += 2;
      continue;
    }
    if (t.startsWith("-C") && t.length > 2) {
      if (targetDir === null) targetDir = t.slice(2);
      idx += 1;
      continue;
    }
    if (t.startsWith("--chdir=")) {
      if (targetDir === null) targetDir = t.slice("--chdir=".length);
      idx += 1;
      continue;
    }
    if (t === "-i" || t === "--ignore-environment" || t === "-") {
      idx += 1;
      continue;
    }
    if (t === "-u" || t === "--unset") {
      idx += 2;
      continue;
    }
    if (t.startsWith("--unset=") || /^-u./.test(t)) {
      idx += 1;
      continue;
    }
    if (VAR_ASSIGN_RE.test(t)) {
      idx += 1;
      continue;
    }
    break;
  }
  return { idx, targetDir };
}

/** Peel `command`'s own flags (e.g. `-p`, `-v`, `-V`, `--`). */
function peelCommand(tokens: Token[], startIdx: number): number {
  let idx = startIdx;
  while (idx < tokens.length) {
    const t = tokens[idx]!.text;
    if (t === "--") {
      idx += 1;
      break;
    }
    if (t.startsWith("-") && t !== "-") {
      idx += 1;
      continue;
    }
    break;
  }
  return idx;
}

/** Peel `nice`'s own flags: `-n <n>`, `-n<n>`, `--adjustment=<n>`. */
function peelNice(tokens: Token[], startIdx: number): number {
  let idx = startIdx;
  while (idx < tokens.length) {
    const t = tokens[idx]!.text;
    if (t === "-n" || t === "--adjustment") {
      if (tokens[idx + 1] === undefined) break;
      idx += 2;
      continue;
    }
    if (/^-n-?\d+$/.test(t)) {
      idx += 1;
      continue;
    }
    if (t.startsWith("--adjustment=")) {
      idx += 1;
      continue;
    }
    break;
  }
  return idx;
}

/** Strip a path that ends in a `.git` directory down to its parent. */
function parentIfDotGit(dir: string): string {
  const trimmed = dir.replace(/\/+$/, "");
  if (trimmed === ".git") return ".";
  if (trimmed.endsWith("/.git")) return trimmed.slice(0, -"/.git".length) || "/";
  return dir;
}

/**
 * Peel git's own global options (dropping them so the subcommand becomes
 * adjacent to `git`), tracking the first `-C` / `--work-tree` /
 * `--git-dir` target directory encountered. `malformed: true` means a
 * value-requiring option was missing its value — the caller bails
 * without rewriting rather than guess.
 */
function peelGitGlobalOptions(
  tokens: Token[],
  startIdx: number,
): { idx: number; targetDir: string | null; malformed: boolean } {
  let idx = startIdx;
  let targetDir: string | null = null;
  while (idx < tokens.length) {
    const t = tokens[idx]!.text;
    if (t === "-C") {
      const dir = tokens[idx + 1]?.text;
      if (dir === undefined) return { idx, targetDir, malformed: true };
      if (targetDir === null) targetDir = dir;
      idx += 2;
      continue;
    }
    if (t === "-c") {
      if (tokens[idx + 1] === undefined) return { idx, targetDir, malformed: true };
      idx += 2;
      continue;
    }
    if (t === "--git-dir") {
      const dir = tokens[idx + 1]?.text;
      if (dir === undefined) return { idx, targetDir, malformed: true };
      if (targetDir === null) targetDir = parentIfDotGit(dir);
      idx += 2;
      continue;
    }
    if (t.startsWith("--git-dir=")) {
      if (targetDir === null) targetDir = parentIfDotGit(t.slice("--git-dir=".length));
      idx += 1;
      continue;
    }
    if (t === "--work-tree") {
      const dir = tokens[idx + 1]?.text;
      if (dir === undefined) return { idx, targetDir, malformed: true };
      if (targetDir === null) targetDir = dir;
      idx += 2;
      continue;
    }
    if (t.startsWith("--work-tree=")) {
      if (targetDir === null) targetDir = t.slice("--work-tree=".length);
      idx += 1;
      continue;
    }
    if (t === "--no-pager" || t === "-p" || t === "--paginate") {
      idx += 1;
      continue;
    }
    if (t === "--exec-path" || t.startsWith("--exec-path=")) {
      idx += 1;
      continue;
    }
    if (t === "--namespace") {
      if (tokens[idx + 1] === undefined) return { idx, targetDir, malformed: true };
      idx += 2;
      continue;
    }
    if (t.startsWith("--namespace=")) {
      idx += 1;
      continue;
    }
    if (t === "--literal-pathspecs" || t === "--no-replace-objects") {
      idx += 1;
      continue;
    }
    break;
  }
  return { idx, targetDir, malformed: false };
}
