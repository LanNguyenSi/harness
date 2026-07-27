// Trigger-matching normaliser for Bash command strings.
//
// STATUS (read this before wiring anything new to `targetDir`/
// `targetBase`): this module has two independent outputs with different
// consumption status. `normalized` — the command with wrapper prefixes
// peeled and a git invocation's own global options collapsed — is LIVE:
// `policyMatchesEvent` (`src/runtime/intercept.ts`) tests every
// `bash_match` regex against the raw command first and, only on a raw
// miss, against this normalised form too (raw-OR-normalised, never raw-
// replaced-by-normalised), closing a class of silent trigger bypasses
// (see below). `targetDir` / `targetBase` — the effective target
// directory of the command's own git invocation(s), when one can be
// named unambiguously — are NOT WIRED TO ANY GATE. An earlier version of
// this run used them to resolve the `${REPO}`/`${BRANCH}` policy
// builtins (`src/cli/policy/intercept.ts`) to a command's named target
// instead of the hook's own cwd; that wiring produced three consecutive
// review-round security regressions (Risk Gate risk declassification, a
// push-gate multi-invocation fail-open, and a non-git gated verb leaking
// a decoy repo's target, first via `&&`, still open via `|`/`||`), each
// only partially closeable because a single per-event `targetDir` cannot
// express "this invocation targets repo B, but the gated verb after it
// runs in the caller's cwd." The wiring was removed before shipping (see
// `src/cli/policy/intercept.ts` and `CHANGELOG.md`); the extraction and
// its own ambiguity rules stay here, fully tested, as the foundation for
// a redesign that attributes a target to the SEGMENT satisfying a
// policy's own trigger instead of to the whole event — follow-up task
// `98ad072f`. Nothing below describes gate wiring; it describes what
// THIS MODULE computes, live or not.
//
// THE TRIGGER-MATCHING GAP THIS CLOSES: every `bash_match` policy trigger
// (`src/cli/init/templates.ts`, `docs/examples/full-manifest.yaml`) is a
// single regex tested against the UNPARSED command string, anchored on a
// shell boundary (`^ \n ; | && (`) followed by optional `VAR=value`
// tokens and a literal `git`. That anchor is exact-spelling brittle: a
// wrapper binary, a git global option other than `-C`, or even a second
// space between `git` and its subcommand defeats the match silently —
// the policy is skipped, no ledger query happens, no audit signal at all.
//
// CURRENT RULES — trigger normalisation (peeled/canonicalised into
// `normalized`):
//   - Leading `VAR=value` tokens (any number, in sequence).
//   - `env`, including `-C <dir>` / `--chdir <dir>` / `-C<dir>` /
//     `--chdir=<dir>` and its own `VAR=value` arguments. The flag-NAME
//     enumeration (which flags exist, not their VALUES) is IMPORTED from
//     `read-only-bash.ts`'s `ENV_LEADING_FLAGS` / `ENV_VALUE_FLAGS` /
//     `ENV_SPLIT_STRING_FLAGS` rather than hand-rolled here a second
//     time, so the two peelers cannot independently drift on which
//     flags exist; `read-only-bash.ts`'s generic "any OTHER glued
//     `--long=value` flag" catch-all is mirrored here too. Each module
//     keeps its own decision about what a recognised flag MEANS: this
//     module additionally needs the VALUE of `-C`/`--chdir` to extract
//     `targetDir`, which `read-only-bash.ts` never needs, so that
//     glued-value parsing (`-C<dir>`, `--chdir=<dir>`) stays local here.
//   - `command` (its own flags, e.g. `-p`/`-v`/`-V`, and `--`).
//   - `nice`, including `-n <n>` / `-n<n>` / `--adjustment=<n>`, and the
//     bare `-<n>` / `+<n>` forms — `nice -10 cmd` (increment glued
//     straight to the leading dash, no `n`) is `nice(1)`'s PRIMARY
//     documented spelling.
//   - `sudo` / `doas` (their own user/group/config flags — see
//     `SUDO_VALUE_FLAGS` / `DOAS_VALUE_FLAGS`), `time` (`-o`/`-f`/
//     `--output`/`--format` plus boolean flags), `timeout` (its own flags
//     PLUS the mandatory leading DURATION positional — see
//     `peelTimeout`), `stdbuf` (`-i`/`-o`/`-e`, always value-taking), and
//     `setsid` (`-w`/`-c`/`-f`, boolean). NOT `xargs` — deliberately
//     excluded, see NOT SUPPORTED below.
//   - A git invocation's own global options: `-C <dir>`, `-c <k=v>`,
//     `--git-dir[= ]<dir>`, `--work-tree[= ]<dir>`, `--no-pager`,
//     `-p`/`--paginate`, `--exec-path[=<path>]`, `--namespace[= ]<ns>`,
//     `--literal-pathspecs`, `--no-replace-objects` — dropped so the
//     subcommand becomes adjacent to the literal `git` token, and the
//     whitespace between them collapses to exactly one space.
//   - The `git` token itself may be path-qualified (`/usr/bin/git`,
//     `./git`, any `\S*/git`), matched by BASENAME (mirrors the existing
//     `deny-kill-switch-bypass` regex's own `(?:npx\s+|\S*/)?harness`
//     shape). The canonicalised output always writes the literal `git`,
//     regardless of how the invocation spelled the binary.
//
// CURRENT RULES — target-directory extraction (`targetDir`/`targetBase`;
// UNCONSUMED — see STATUS above):
//   - The effective target directory of the command's git invocation(s),
//     from (in priority order per invocation) the git invocation's own
//     `-C` / `--work-tree` / `--git-dir` (parent directory when the path
//     ends in `.git`), the wrapping `env -C` / `--chdir` on the SAME
//     invocation, or — only when NO invocation named one explicitly — a
//     leading `cd <dir> &&|;` prefix (delegated to `bash-prefix-
//     parse.ts`, which already parses that idiom). A `~`-prefixed value
//     is treated as though no target were named AT ALL: this module does
//     not expand `~`, and letting it resolve against the caller's cwd
//     would produce a CONFIDENTLY WRONG answer (an unrelated repo found
//     by walking up from a bogus path) instead of the documented "no
//     target" fallback.
//   - `targetBase`: when exactly one git invocation named an explicit
//     target (or several agree on the SAME one) and it is a RELATIVE
//     path, this names the directory it is relative to, when this
//     module saw one — the wrapping `env -C` on the SAME invocation
//     (highest priority), else a leading `cd <dir> &&|;` prefix (`cd
//     <repo> && git -C src status` resolves `src` against `<repo>`, not
//     a caller's own cwd). `null` when neither is present — a
//     hypothetical future consumer resolves `targetDir` against its own
//     cwd instead.
//   - When a command names MORE THAN ONE git invocation, `targetDir` (and
//     `targetBase`) are populated only when every invocation AGREES: all
//     of them name the SAME explicit target, or NONE of them do (falling
//     through to the leading-`cd` case above). A command mixing a bare
//     invocation with an explicitly-targeted one — `git -C <B> log &&
//     git push` — or naming two DIFFERENT explicit targets, is AMBIGUOUS
//     and `targetDir` is `null`.
//   - "Every invocation agrees" is ALSO broken by a non-git command that
//     shares the chain: a command-starting segment (follows
//     `&&`/`;`/`\n`/`(`, or is the first segment — never a bare `|`,
//     which stays in the SAME directory) that is NEITHER a git
//     invocation NOR the recognised leading `cd` prefix forces
//     `targetDir` to `null` too, the same conservative fallback used for
//     git-vs-git disagreement — measured case: `git -C <B> rev-parse
//     HEAD && gh pr merge`, where `-C` scopes only the ONE git call it
//     decorates and `gh pr merge` genuinely runs at the real, unaffected
//     cwd. The leading `cd` prefix stays exempt on purpose: unlike `-C`,
//     `cd` genuinely persists for the rest of the chain, so `cd <B> &&
//     gh pr create` really does run against B — only a PER-INVOCATION
//     override (`-C`, `--work-tree`, `--git-dir`, wrapping `env -C`) can
//     leak across an unrelated later command; a persistent `cd` cannot,
//     by construction.
//
// DELIBERATELY NOT SUPPORTED, and out of reach of ANY string-level
// approach (see `CHANGELOG.md` task `2cc73f55`, decision D-005):
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
//   - `xargs git status`: unlike `env`/`command`/`nice`/`sudo`/`doas`/...,
//     `xargs`'s own argv is not simply "the command to run" — it appends
//     stdin lines as trailing arguments and may invoke the wrapped
//     command MULTIPLE times, or zero, depending on stdin. Different
//     enough semantics that peeling it the same way would be misleading,
//     not just incomplete, so it is deliberately excluded, not merely
//     missed.
//   - A quoted git subcommand (`git "status"`): the tokeniser sees the
//     literal token `"status"` (quotes included) and canonicalises to
//     `git "status"`, which does not satisfy a `bash_match` regex
//     expecting a bare word boundary. The same class of problem as the
//     whitespace-in-quoted-path gap above.
//   - Backtick command substitution wrapping the real invocation, e.g.
//     `` echo `env -C /tmp git status` ``: this module canonicalises the
//     OUTER command only and does not recurse into a substitution's
//     contents — the same boundary `sh -c` stops at, above.
//   - `$(...)` command substitution is NOT in this list — see the
//     "accidentally covered" note right below. Do not read its absence
//     here as "also open"; it genuinely blocks today, pinned by a test.
//   - Ten more measured-bypass spellings, none of them peeled wrapper
//     prefixes or a recognised `git` spelling: `exec git status`, `nohup
//     git status`, `ionice -c3 git status`, `flock /tmp/l git status`,
//     `script -q /dev/null git status`, `chrt -b 0 git status`, `taskset
//     -c 0 git status`, `\git status` (the backslash defeats
//     `GIT_TOKEN_RE`, which requires the bare basename), `"git" status`
//     (a QUOTED binary name — the mirror image of the quoted-subcommand
//     gap above), and `env -S "git status"` (the split-string flag hands
//     the rest of the argv to a fresh, opaque re-parse this module
//     deliberately does not follow, per `peelEnv`'s own comment).
//
// `$(...)` command substitution is ACCIDENTALLY covered — not a
// deliberate feature, and distinct from the backtick case above, which
// is a genuine, deliberate gap. `BOUNDARY_RE` treats a bare `(` as a
// shell-boundary token (needed for the leading-command case, `(cd X &&
// ...)`), and `$(...)`'s opening paren is, character-for-character, the
// same `(`. So `echo $(env -C /tmp git status)` splits into a segment
// starting exactly at that `(`, `canonicalizeSegment` finds a real git
// invocation inside it, and the close paren rides along harmlessly as
// trailing text after the subcommand (`git status)` still satisfies a
// `...status\b` regex, since `)` is a non-word character). This is
// coincidental: `BOUNDARY_RE` was never designed with `$(...)` in mind,
// and an unrelated future change to it could silently drop this coverage
// with no test noticing — pinned by a dedicated test for exactly that
// reason.
//
// Above `MAX_NORMALIZE_LENGTH` characters, normalisation is skipped
// entirely and the command is returned unchanged: `harness policy
// intercept` runs on every Bash/Edit/Write tool call and `require-
// preflight-evidence` declares `budget_ms: 1000`, so command SIZE must
// never be able to drive the hook past its own timeout budget. The RAW
// command is still tested by `policyMatchesEvent` regardless (raw-OR-
// normalised construction), so an oversized command only loses the
// ADDITIONAL normalised-form coverage, never the baseline one.
// `NormalizedCommand.truncated` reports the skip back to the caller;
// `runInterceptCli` (`src/cli/policy/intercept.ts`) writes exactly one
// stderr line when it sees `truncated: true`, keeping this module itself
// pure and I/O-free (see below) while making the skip observable at the
// one place that already owns a stderr stream for this event.
//
// Bounded, allocation-light, pure string work: no `fs`, no
// `child_process`, no network — `node:path` is used ONLY for
// `path.isAbsolute`, a synchronous string check with no I/O. This runs on
// every Bash/Edit/Write tool call, so it must stay cheap: `findNextBoundary`
// is a single combined-alternation regex scan rather than one `indexOf`
// per boundary token (a command with many segments and at least one
// boundary kind that never occurs anywhere would otherwise degenerate to
// O(segments × length) — see `findNextBoundary`'s own comment). Never
// throws: a malformed or unparseable command falls through cleanly and
// `normalized` is the input unchanged.

import * as path from "node:path";
import { parseBashPrefix } from "./bash-prefix-parse.js";
import {
  ENV_LEADING_FLAGS,
  ENV_SPLIT_STRING_FLAGS,
  ENV_VALUE_FLAGS,
} from "./read-only-bash.js";

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
   * The effective target directory of the command's git invocation, or
   * `null` when the command names none, the command names invocations
   * that disagree, or the only named value is `~`-prefixed (see the
   * module header's target-directory-extraction rules).
   *
   * NOT WIRED TO ANY GATE (see the module header's STATUS paragraph):
   * extracted and fully tested, pending a redesign that attributes a
   * target per-policy instead of per-event — follow-up task
   * `98ad072f`.
   */
  targetDir: string | null;
  /**
   * When `targetDir` is a RELATIVE path, the directory it should be
   * resolved against instead of the caller's own cwd — the wrapping
   * `env -C` on the same invocation, or a leading `cd` prefix (see the
   * module header). `null` when `targetDir` is absolute, `null` itself,
   * or no more specific base was found.
   *
   * Same unconsumed status as `targetDir` above — see the module
   * header's STATUS paragraph.
   */
  targetBase: string | null;
  /**
   * `true` when the input exceeded `MAX_NORMALIZE_LENGTH` and
   * normalisation was skipped entirely (G4 fix, review round 2,
   * 2026-07-27): the caller previously had no way to tell "nothing
   * recognisable was found" apart from "normalisation never ran at all",
   * so the skip carried no audit signal. `false` whenever the input WAS
   * run through `normalizeCommandInner` (including when nothing
   * recognisable was found there either — that case is still `false`,
   * only the length-bound short-circuit sets this).
   */
  truncated: boolean;
}

/** A whitespace-delimited token plus its offset within the segment it came from. */
interface Token {
  text: string;
  start: number;
  end: number;
}

const VAR_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * The `git` token itself, matched by BASENAME so a path-qualified
 * invocation (`/usr/bin/git`, `./git`) is recognised too (F4 fix).
 * Anchored to the WHOLE token (not a substring) so `mygit` / `git-foo`
 * still correctly fail to match — `\S*` only ever contributes characters
 * immediately before a literal `/`, never before `git` directly.
 */
const GIT_TOKEN_RE = /^(?:\S*\/)?git$/;

/**
 * Above this length, normalisation is skipped entirely and the command
 * is returned unchanged (F3 fix — see the module header for why command
 * SIZE must be bounded even after `findNextBoundary` was made linear).
 * 100k characters comfortably covers any command a human or agent would
 * plausibly type, while keeping the worst case a small constant instead
 * of scaling with whatever ends up pasted into a single Bash call.
 * Exported (G4 fix, review round 2) so a caller reporting the skip (see
 * `NormalizedCommand.truncated`) can reference the same number instead of
 * hand-copying it into a diagnostic message.
 */
export const MAX_NORMALIZE_LENGTH = 100_000;

/**
 * Shell boundary tokens a `bash_match` regex can anchor on, expressed as
 * ONE alternation so `findNextBoundary` does a single regex scan per
 * remaining span instead of one `indexOf` per token (F3 fix, review
 * round 2026-07-27). Order among the alternatives does not affect
 * correctness: no two of these tokens can start at the same string
 * position (only `&&` is multi-character, and no other alternative
 * starts with `&`), so there is no tie for the regex engine's leftmost-
 * match rule to break.
 */
const BOUNDARY_RE = /\n|&&|;|\||\(/g;

/** A target value starting with `~` — not expanded, treated as unparseable (F5). */
function isTildeTarget(dir: string): boolean {
  return dir.startsWith("~");
}

/**
 * Given a Bash command string, return its normalised form and the target
 * directory (and base, if relative) of its git invocation. Never throws:
 * any internal failure (there should be none — this is a defensive
 * backstop matching the fail-safe shape used elsewhere in this codebase,
 * e.g. `policyMatchesEvent`'s `try/catch` around `new RegExp`) falls back
 * to the input unchanged.
 */
export function normalizeCommand(command: string): NormalizedCommand {
  if (typeof command !== "string" || command.length === 0) {
    return {
      normalized: typeof command === "string" ? command : "",
      targetDir: null,
      targetBase: null,
      truncated: false,
    };
  }
  if (command.length > MAX_NORMALIZE_LENGTH) {
    return { normalized: command, targetDir: null, targetBase: null, truncated: true };
  }
  try {
    return normalizeCommandInner(command);
  } catch {
    return { normalized: command, targetDir: null, targetBase: null, truncated: false };
  }
}

function normalizeCommandInner(command: string): NormalizedCommand {
  const parts: string[] = [];
  const explicitTargets = new Set<string>();
  let explicitTargetBase: string | null = null;
  let sawExplicitBase = false;
  let bareGitSegmentCount = 0;
  let i = 0;
  const n = command.length;

  // A leading `cd <dir> &&|;` prefix, parsed ONCE up front (G1 fix,
  // review round 2, 2026-07-27) instead of the two separate calls the
  // size===1 and size===0 branches below each used to make on their own.
  // Also needed here now to exempt the recognised leading-cd segment
  // itself from the new non-git-command ambiguity check just below: that
  // segment is not "some other command sharing the chain" — it IS the
  // directory every later bare command in the chain actually runs
  // inside.
  const leadingCd = parseBashPrefix(command).cdTarget;

  // Boundary token immediately preceding the segment currently being
  // examined (`null` for the very first segment). Tracked so the G1
  // check below can tell a real "new command" boundary (`&&`/`;`/`\n`/
  // `(`) apart from a bare `|`, which keeps running in the SAME
  // directory as whatever precedes it.
  let precedingBoundaryToken: string | null = null;
  let hasAmbiguousNonGitSegment = false;

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
    if (result.isGit) {
      if (result.targetDir === null) {
        bareGitSegmentCount += 1;
      } else {
        explicitTargets.add(result.targetDir);
        if (!sawExplicitBase && result.targetBase !== null) {
          explicitTargetBase = result.targetBase;
          sawExplicitBase = true;
        }
      }
    } else if (
      precedingBoundaryToken !== "|" &&
      !(precedingBoundaryToken === null && leadingCd !== null)
    ) {
      // G1 fix (HIGH, review round 2, 2026-07-27): a segment that STARTS
      // a new command (follows `&&`/`;`/`\n`/`(` — or is the very first
      // segment in the command — never a bare `|`, which keeps running
      // in the SAME directory as whatever it reads from) and is NOT
      // itself a git invocation is a genuinely DIFFERENT command that
      // does not necessarily run wherever some OTHER git invocation
      // elsewhere in the chain explicitly pointed. Measured case: `git
      // -C <B> rev-parse HEAD && gh pr merge` — `-C` scopes only the ONE
      // git call it decorates, so `gh pr merge` actually runs at the
      // real (unaffected) cwd; resolving ${REPO}/${BRANCH} from B for it
      // let a fact recorded against a decoy repo satisfy
      // `review-before-merge-bash` / `review-subagent-before-pr-create-
      // bash` for a merge/PR that never touched B. The one exemption is
      // the recognised LEADING `cd` prefix itself: unlike `-C`, `cd`
      // genuinely persists for the rest of the chain, so `cd <B> && git
      // status` (or any other command after it) really does run in B —
      // that stays the untouched `explicitTargets.size === 0` branch
      // below, not this one.
      hasAmbiguousNonGitSegment = true;
    }
    if (!boundary) break;
    parts.push(boundary.token);
    i = boundary.start + boundary.token.length;
    precedingBoundaryToken = boundary.token;
  }

  let targetDir: string | null;
  let targetBase: string | null = null;

  if (
    explicitTargets.size === 1 &&
    bareGitSegmentCount === 0 &&
    !hasAmbiguousNonGitSegment
  ) {
    // Every git invocation the command names agrees on ONE repository —
    // safe to use it even when there are several (e.g. two `git -C <same
    // dir>` calls chained together) — AND no OTHER, non-git command
    // shares the chain that this single target does not actually apply
    // to (G1 fix, review round 2).
    targetDir = [...explicitTargets][0]!;
    targetBase = explicitTargetBase;
    if (targetBase === null && !path.isAbsolute(targetDir)) {
      // F5 fix: a RELATIVE git-level target with no more specific base
      // (no wrapping `env -C` on the SAME invocation) is relative to
      // wherever the shell's cwd was at that point in the chain, which a
      // LEADING `cd <dir> &&|;` prefix moves for every later command.
      // Only the leading form is consulted — this module does not
      // simulate the chain deeply enough to attribute a NON-leading `cd`
      // to a specific later invocation, same ceiling as the leading-only
      // fallback immediately below.
      if (leadingCd !== null && !isTildeTarget(leadingCd)) targetBase = leadingCd;
    }
  } else if (explicitTargets.size === 0) {
    // No git invocation named an explicit target of its own (whether
    // there were zero git invocations, or one or more entirely bare
    // ones). A leading `cd <dir> &&|;` prefix, if present, names the
    // target DIRECTLY here — every bare invocation in the chain runs
    // inside it, so this is not a base for something else, it IS the
    // answer — delegated to the existing leading-prefix parser rather
    // than reimplementing its quote-handling. Unaffected by the G1
    // ambiguity flag above: a non-git command after a leading `cd` is
    // exactly the case that flag exempts, and a non-git command with NO
    // git invocation anywhere in the chain never disagrees with
    // anything, since there is no explicit git target to disagree with
    // in the first place.
    targetDir = leadingCd !== null && !isTildeTarget(leadingCd) ? leadingCd : null;
  } else {
    // Ambiguous: either more than one git invocation names a DIFFERENT
    // repository, at least one invocation names a repo explicitly while
    // another runs bare (which may be a THIRD repo — whatever the
    // shell's cwd happens to be at that point), or (G1 fix, review round
    // 2) a non-git, non-leading-cd command elsewhere in the chain that
    // the single explicit git target does not actually apply to. None of
    // these has one unambiguous answer, so — per the "when in doubt,
    // fall back to cwd" rule this whole run was built on — report no
    // target at all rather than silently picking one invocation's answer
    // for the whole command (F2 fix; see the module header for the
    // push-gate fail-open this closes).
    targetDir = null;
  }

  return { normalized: parts.join(""), targetDir, targetBase, truncated: false };
}

/** Find the earliest shell boundary token at or after `from`. Returns null when none remain. */
function findNextBoundary(
  s: string,
  from: number,
): { start: number; token: string } | null {
  BOUNDARY_RE.lastIndex = from;
  const m = BOUNDARY_RE.exec(s);
  return m === null ? null : { start: m.index, token: m[0] };
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
  targetBase: string | null;
  isGit: boolean;
} {
  const tokens = tokenizeWithOffsets(segmentText);
  if (tokens.length === 0) {
    return { text: segmentText, targetDir: null, targetBase: null, isGit: false };
  }

  let idx = 0;
  let envTargetDir: string | null = null;

  // Peel wrapper prefixes: VAR=value tokens, `env` (+ its own flags/
  // assignments), `command` (+ its own flags), `nice` (+ its own
  // flags), `sudo` / `doas` / `time` / `timeout` / `stdbuf` / `setsid`
  // (+ each one's own flags — F4 fix). Bounded by tokens.length so a
  // pathological input cannot spin.
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
    if (head === "sudo") {
      idx = peelSudo(tokens, idx + 1);
      continue;
    }
    if (head === "doas") {
      idx = peelDoas(tokens, idx + 1);
      continue;
    }
    if (head === "time") {
      idx = peelTime(tokens, idx + 1);
      continue;
    }
    if (head === "timeout") {
      idx = peelTimeout(tokens, idx + 1);
      continue;
    }
    if (head === "stdbuf") {
      idx = peelStdbuf(tokens, idx + 1);
      continue;
    }
    if (head === "setsid") {
      idx = peelSetsid(tokens, idx + 1);
      continue;
    }
    break;
  }

  const headTok = tokens[idx]?.text;
  if (headTok === undefined || !GIT_TOKEN_RE.test(headTok)) {
    return { text: segmentText, targetDir: null, targetBase: null, isGit: false };
  }
  idx += 1; // consume the git token (whatever spelling matched GIT_TOKEN_RE)

  const gitOpts = peelGitGlobalOptions(tokens, idx);
  if (gitOpts.malformed || gitOpts.idx >= tokens.length) {
    // Malformed global option (missing required value) or no subcommand
    // token left: nothing safe to canonicalise. Leave untouched.
    return { text: segmentText, targetDir: null, targetBase: null, isGit: false };
  }

  const subcommandTok = tokens[gitOpts.idx]!;
  const rewritten = `git ${subcommandTok.text}${segmentText.slice(subcommandTok.end)}`;
  const targetDir = gitOpts.targetDir ?? envTargetDir;
  // F5: the git invocation's OWN target wins (already the priority
  // order above), but when it's RELATIVE and this same segment is
  // wrapped by `env -C`, that env target is the base it's relative to —
  // only meaningful when git's own target is the one actually used.
  const targetBase =
    gitOpts.targetDir !== null &&
    envTargetDir !== null &&
    !path.isAbsolute(gitOpts.targetDir)
      ? envTargetDir
      : null;
  return { text: rewritten, targetDir, targetBase, isGit: true };
}

/**
 * Peel `env`'s own leading flags and `VAR=value` assignments. The flag-
 * NAME sets are shared with `read-only-bash.ts` (F6 fix — see the module
 * header); the VALUE extraction for `-C`/`--chdir` (needed for
 * `targetDir`, not needed by that module) stays local. Returns the
 * cursor after the last recognised token and the `-C`/`--chdir` target
 * directory, if any (excluding a `~`-prefixed value — F5, treated as if
 * absent).
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
    if (ENV_SPLIT_STRING_FLAGS.test(t)) break;
    if (t === "--") {
      idx += 1;
      break;
    }
    if (t === "-C" || t === "--chdir") {
      const dir = tokens[idx + 1]?.text;
      if (dir === undefined) break;
      if (targetDir === null && !isTildeTarget(dir)) targetDir = dir;
      idx += 2;
      continue;
    }
    if (ENV_VALUE_FLAGS.has(t)) {
      // Reached only for `-u` / `--unset` — `-C` / `--chdir` are handled
      // above (with value capture) before this generic check runs.
      idx += 2;
      continue;
    }
    if (ENV_LEADING_FLAGS.has(t)) {
      idx += 1;
      continue;
    }
    if (t.startsWith("-C") && t.length > 2) {
      if (targetDir === null && !isTildeTarget(t.slice(2))) targetDir = t.slice(2);
      idx += 1;
      continue;
    }
    if (t.startsWith("--chdir=")) {
      const dir = t.slice("--chdir=".length);
      if (targetDir === null && !isTildeTarget(dir)) targetDir = dir;
      idx += 1;
      continue;
    }
    if (t.startsWith("--unset=") || /^-u./.test(t)) {
      idx += 1;
      continue;
    }
    // Generic glued long flag with a value (`--default-signal=INT`, or
    // any OTHER `env` long option this module does not need the VALUE
    // of): single token, skip it (G6 fix, review round 2, 2026-07-27 —
    // mirrors `read-only-bash.ts`'s own generic catch-all, so the two
    // peelers' coverage cannot drift again the way `--default-signal=INT`
    // once did; see the module header). Placed AFTER the named `-C` /
    // `--chdir` / `--unset` forms above so it only ever catches a flag
    // this module has no more specific handling for.
    if (t.startsWith("--") && t.includes("=")) {
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

/**
 * Peel `nice`'s own flags: `-n <n>`, `-n<n>`, `--adjustment=<n>`, and the
 * bare `-<n>` / `+<n>` forms (G3 fix, review round 2, 2026-07-27):
 * `nice(1)` documents `nice -10 cmd` (increment glued directly to the
 * leading dash, no `n`) as its PRIMARY spelling, and some BSD variants
 * also accept a leading `+` for a positive increment — `nice -10 git
 * status` bypassed even though `nice` was already in the SUPPORTED list,
 * because only the `-n`-prefixed spellings were recognised.
 */
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
    if (/^[-+]\d+$/.test(t)) {
      idx += 1;
      continue;
    }
    break;
  }
  return idx;
}

/**
 * Generic "peel this wrapper's own flags" loop shared by the small,
 * bounded-vocabulary runners added for F4 (`sudo`, `doas`, `time`,
 * `stdbuf`, `setsid`): consume `--`, any flag in `valueFlags` (+ its
 * following token), any glued short/long form matching `gluedRe`, then
 * any OTHER `-`-prefixed token treated as boolean (mirrors `peelCommand`
 * above — safe because an unrecognised flag is either genuinely boolean,
 * in which case this is correct, or value-taking, in which case its
 * VALUE token is left for the next iteration and — not being `git`, a
 * known wrapper, or another flag — simply causes a clean, safe bail-out
 * a token late rather than a false match). Does NOT capture flag
 * VALUES: none of these five wrappers have a "run in a different
 * directory" semantic this module tracks as a target directory — only
 * `env -C`/`--chdir` does, and that stays hand-written in `peelEnv`.
 */
function peelGenericFlags(
  tokens: Token[],
  startIdx: number,
  valueFlags: ReadonlySet<string>,
  gluedRe: RegExp | null,
): number {
  let idx = startIdx;
  while (idx < tokens.length) {
    const t = tokens[idx]!.text;
    if (t === "--") {
      idx += 1;
      break;
    }
    if (valueFlags.has(t)) {
      if (tokens[idx + 1] === undefined) break;
      idx += 2;
      continue;
    }
    if (t.startsWith("--") && t.includes("=")) {
      idx += 1;
      continue;
    }
    if (gluedRe !== null && gluedRe.test(t)) {
      idx += 1;
      continue;
    }
    if (t.startsWith("-") && t !== "-") {
      idx += 1;
      continue;
    }
    break;
  }
  return idx;
}

/**
 * `sudo`'s own value-taking flags (user/group/prompt/chroot/role/type/
 * timeout/close-from). Every other `-`-prefixed `sudo` flag (`-E`, `-H`,
 * `-i`, `-k`, `-n`, `-S`, `-v`, ...) is boolean and falls through
 * `peelGenericFlags`'s generic "-flag consumes one token" branch.
 */
const SUDO_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-g", "-h", "-p", "-R", "-r", "-t", "-T", "-u", "-C",
  "--group", "--host", "--prompt", "--chroot", "--role",
  "--type", "--command-timeout", "--user", "--close-from",
]);
/** `sudo`'s glued short-value forms: `-uroot`, `-Cbastion`, etc. */
const SUDO_GLUED_RE = /^-[ghpRrtTuC]./;

function peelSudo(tokens: Token[], startIdx: number): number {
  return peelGenericFlags(tokens, startIdx, SUDO_VALUE_FLAGS, SUDO_GLUED_RE);
}

/** `doas`'s own value-taking flags: `-u user`, `-C configfile`. */
const DOAS_VALUE_FLAGS: ReadonlySet<string> = new Set(["-u", "-C"]);
const DOAS_GLUED_RE = /^-[uC]./;

function peelDoas(tokens: Token[], startIdx: number): number {
  return peelGenericFlags(tokens, startIdx, DOAS_VALUE_FLAGS, DOAS_GLUED_RE);
}

/** `time`'s own value-taking flags: `-o`/`--output`, `-f`/`--format`. */
const TIME_VALUE_FLAGS: ReadonlySet<string> = new Set(["-o", "-f", "--output", "--format"]);
const TIME_GLUED_RE = /^-[of]./;

function peelTime(tokens: Token[], startIdx: number): number {
  return peelGenericFlags(tokens, startIdx, TIME_VALUE_FLAGS, TIME_GLUED_RE);
}

/** `timeout`'s own value-taking flags: `-k`/`--kill-after`, `-s`/`--signal`. */
const TIMEOUT_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-k", "-s", "--kill-after", "--signal",
]);
const TIMEOUT_GLUED_RE = /^-[ks]./;

/**
 * `timeout DURATION command...` requires a DURATION positional BEFORE
 * the wrapped command — unlike the other four runners, so it cannot
 * share `peelGenericFlags` unmodified. Peel `timeout`'s own flags first,
 * then consume the mandatory duration token. A missing duration
 * (malformed/truncated command) leaves `idx` where the flag loop left
 * it; the caller's "is this token `git`?" check bails safely on
 * whatever token is actually there.
 */
function peelTimeout(tokens: Token[], startIdx: number): number {
  let idx = peelGenericFlags(tokens, startIdx, TIMEOUT_VALUE_FLAGS, TIMEOUT_GLUED_RE);
  if (tokens[idx] !== undefined) idx += 1;
  return idx;
}

/** `stdbuf`'s flags are ALWAYS value-taking: `-i`/`-o`/`-e` (buffering mode). */
const STDBUF_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-i", "-o", "-e", "--input", "--output", "--error",
]);
const STDBUF_GLUED_RE = /^-[ioe]./;

function peelStdbuf(tokens: Token[], startIdx: number): number {
  return peelGenericFlags(tokens, startIdx, STDBUF_VALUE_FLAGS, STDBUF_GLUED_RE);
}

/** `setsid`'s flags (`-w`/`--wait`, `-c`/`--ctty`, `-f`/`--fork`) are all boolean. */
function peelSetsid(tokens: Token[], startIdx: number): number {
  return peelGenericFlags(tokens, startIdx, new Set(), null);
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
 * `--git-dir` target directory encountered (excluding a `~`-prefixed
 * value — F5, treated as if absent, but still consumed as an option so
 * parsing continues past it). `malformed: true` means a value-requiring
 * option was missing its value — the caller bails without rewriting
 * rather than guess.
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
      if (targetDir === null && !isTildeTarget(dir)) targetDir = dir;
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
      if (targetDir === null && !isTildeTarget(dir)) targetDir = parentIfDotGit(dir);
      idx += 2;
      continue;
    }
    if (t.startsWith("--git-dir=")) {
      const dir = t.slice("--git-dir=".length);
      if (targetDir === null && !isTildeTarget(dir)) targetDir = parentIfDotGit(dir);
      idx += 1;
      continue;
    }
    if (t === "--work-tree") {
      const dir = tokens[idx + 1]?.text;
      if (dir === undefined) return { idx, targetDir, malformed: true };
      if (targetDir === null && !isTildeTarget(dir)) targetDir = dir;
      idx += 2;
      continue;
    }
    if (t.startsWith("--work-tree=")) {
      const dir = t.slice("--work-tree=".length);
      if (targetDir === null && !isTildeTarget(dir)) targetDir = dir;
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
