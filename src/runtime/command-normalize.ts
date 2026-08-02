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
// (see below) — and, only on a further miss of THIS form, against a
// SECOND, independent, ampersand-aware normalisation pass (`AMP_BOUNDARY_RE`
// / `normalizeCommandAmpAware` below, task aabbad63) that this header
// otherwise never mentions; see that function's own comment for its scope
// and why it carries no `targetDir`/`targetBase` of its own (fix round 1,
// finding F5 — added so a reader of this header, the module's index,
// learns a second pass exists at all instead of finding it only by
// reading past this point). `targetDir` / `targetBase` — the effective target
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
// UPDATE (task `98ad072f`, run `2026-08-02-per-repo-gate-scoping-
// redesign`, T-002): the per-segment foundation named above now EXISTS as
// a real export — `segmentViewOf` / `CommandSegment`, defined below
// `normalizeCommand` — instead of being only a design intention. It
// exposes, per boundary-delimited segment, the canonicalised text, the
// segment's OWN explicit target, and an EFFECTIVE target composed with the
// last preceding `cd <path>` segment (see `CommandSegment`'s own doc
// comment for the composition rules and its own not-covered list, which
// is narrower in places than `targetDir`/`targetBase` above — e.g. no
// `VAR=value cd <path>` tolerance). `normalizeCommand`'s own `targetDir`/
// `targetBase` are UNCHANGED by this addition — byte-identical in every
// pre-existing test.
//
// UPDATE (task `98ad072f`, T-003, this run): `segmentViewOf` /
// `CommandSegment` — NOT `normalizeCommand`'s own `targetDir`/`targetBase`
// above, which stay exactly as unwired as before this slice — IS now
// wired to a gate: `src/runtime/intercept.ts`'s `attributeTriggerSegments`
// re-tests a matched policy's own `bash_match` regex against each
// segment's `text`, and, for a policy whose `requires:` uses
// `${REPO}`/`${BRANCH}`/`at_head`, resolves those builtins (and
// `currentHeadSha`) from the trigger-satisfying segment's
// `effectiveTarget` instead of the event's cwd — lazily, memoised per
// resolved path, never touching `resolverGit`/`riskContext`. Trust in
// `effectiveTarget` is UNIFORM — no distinction between a segment's own
// explicit target and one inherited from a preceding `cd` (orchestrator
// decision D-010: an initial revision distinguished the two and was
// rejected — bash itself draws no such distinction, a `cd <B> && <verb>`
// chain genuinely runs `<verb>` inside B). See that module's own comments
// (`attributeTriggerSegments`, `resolveAttributedContexts`) for the
// consumption rules; this module's OWN extraction and ambiguity rules
// below are unchanged by being consumed.
//
// MEASUREMENT RULE (task 47297478): before measuring THIS module's
// extraction across builds with an ad-hoc corpus, read the per-arm-gate
// design in scripts/measure-bash-prefix-parse.mjs — a corpus arm whose
// baseline never hit proves nothing, and an ungated zero from an ad-hoc
// corpus has already been wrong three times in a row (b093911d run).
// Note the tool itself measures ONLY bash-prefix-parse.ts's `cdTarget`
// extraction; this module's `normalized`/`targetDir`/`targetBase`
// outputs have no instrument yet, so cross-build claims about them need
// their own per-arm-gated measurement — that instrument now exists:
// scripts/measure-command-normalize.mjs (groundwork for task aabbad63, the
// BOUNDARY_RE bare-`&` fix below). It rebuilds a faithful superset of the
// reverted fix's 140-form quoted-value regression corpus and gates arm A
// on bash actually running the verb, per the same never-fold-into-a-zero
// discipline.
//
// THE TRIGGER-MATCHING GAP THIS CLOSES: every `bash_match` policy trigger
// (`src/cli/init/templates.ts`, `docs/examples/full-manifest.yaml`) is a
// single regex tested against the UNPARSED command string, anchored on a
// shell boundary (`^ \n ; | && (`) followed by optional `VAR=value`
// tokens and a literal head token — `git` (most triggers), `gh` (`gh pr
// merge`/`gh pr create`), `npm` (`npm publish`), or `harness` (the
// kill-switch verbs). That anchor is exact-spelling brittle: a wrapper
// binary, a git global option other than `-C`, or even a second space
// between the head token and its subcommand defeats the match silently —
// the policy is skipped, no ledger query happens, no audit signal at all.
// Measured bypasses closed by this module (task `432db3d3`, run
// `2026-07-28-nongit-trigger-wrappers`, D-001): `env gh pr merge`, `env -C
// <dir> gh pr merge`, `nice gh pr merge`, `gh  pr merge` (double space),
// `env gh pr create`, `env npm publish`, `nice npm publish`, `env harness
// pause`, `nice harness pause`, `command harness pause`, `env -C <dir>
// harness pause` — the exact one-word-wrapper class already fixed for
// `git` in the prior run, reproduced against `gh`/`npm`/`harness` because
// the head-token condition at the end of `canonicalizeSegment` checked
// literal equality with `git` and nothing else.
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
//   - THE CLOSED HEAD-TOKEN SET (D-001, run
//     2026-07-28-nongit-trigger-wrappers): after the SAME wrapper-peeling
//     loop above, the head token is checked against `git` OR the three
//     other literal head tokens this module covers — `gh` (`gh pr merge`
//     / `gh pr create`), `npm` (`npm publish`), and `harness` (the
//     kill-switch verbs). `git` alone gets the git-specific global-option
//     dropping described above; the other three get wrapper peeling PLUS
//     whitespace collapsing across the REST OF THE SEGMENT (fix round 2,
//     finding F2 — collapsing only the head-to-next-token gap, the
//     original scope, still let an interior whitespace run defeat a
//     multi-word trigger like `gh pr  merge`), no option-dropping (`gh
//     -R`, `npm --loglevel`, and any other tool-specific flag stay
//     UNSUPPORTED — see below — because a flag inserted between the head
//     token and its subcommand tokens is not looked past). Matched by
//     EXACT literal equality, not basename like `git` — a path-qualified
//     `gh`/`npm`/`harness` invocation is out of scope for this set (named
//     residual below); `harness`'s own trigger regex already covers a
//     path-qualified spelling at the RAW-match level (`(?:npx\s+|\S*/)?
//     harness` in `deny-kill-switch-bypass`), so nothing is lost there
//     specifically. This is a CLOSED set, not a general "peel wrappers
//     for any head token" rule.
//   - SHIPPED BUT NOT COVERED (fix round 2, finding F1 — corrects an
//     inaccurate claim in the prior version of this comment, which said
//     this module's four head tokens were "the head tokens shipped
//     policies actually gate today"): a shipped `bash_match` trigger
//     actually keys on EIGHT distinct COMMAND-NAME head tokens, not four —
//     plus one HEADLESS alternative with no command name at all:
//     `deny-session-env-strip`'s bare `<SESSION_VAR>=` empty-assignment
//     form, whose wrapped spelling (`nice CLAUDE_SESSION_ID= npm publish`)
//     is equally out of this module's reach, because the peel loop consumes
//     the assignment as an ordinary `VAR=value` prefix (measured
//     2026-07-28, pinned alongside the four below).
//     `deny-session-env-strip` also keys on `env` (`env ... -u <VAR>` /
//     `env ... --unset <VAR>`) and `unset` (`unset <VAR>...`);
//     `deny-pause-sentinel-forgery` also keys on `tee` and `cp`. None of
//     these four are in the closed set above, and adding them is not
//     simply "the same kind of change again":
//       - `env` is STRUCTURALLY unreachable by this module's own
//         architecture, not merely unimplemented: the wrapper-peeling
//         loop treats `env` ONLY as a pass-through wrapper hunting for a
//         `git`/`gh`/`npm`/`harness` invocation behind it, so it ALWAYS
//         calls `peelEnv` and consumes `env`'s OWN `-u`/`--unset` flags
//         (and their VALUES) as part of that hunt — by the time `headTok`
//         is checked, the very `-u <VAR>` text `deny-session-env-strip`'s
//         trigger keys on has already been peeled away. Recognising
//         `env` as ITSELF a head token would need the SAME literal token
//         to get two different treatments depending on WHY it is there —
//         an architecture change, not a set-membership change — and is
//         out of scope for this closed-set run. Measured, still-open
//         bypass: `nice env -u CLAUDE_SESSION_ID ls` (pinned as a
//         documented ceiling, not silently left to a comment).
//       - `unset` is simply not one of the wrapper-peeling loop's
//         recognised names at all (unlike `env`, there is no
//         `peelUnset`), so a wrapped `unset` invocation is not looked
//         past either. Measured, still-open bypass: `nice unset
//         CLAUDE_SESSION_ID`.
//       - `tee` / `cp` are never wrapper-peeled or recognised as a head
//         token by this module at all; `deny-pause-sentinel-forgery`'s
//         own raw regex is the only thing that ever catches them.
//         Measured, still-open bypasses: `nice tee /tmp/.harness-paused`,
//         `nice cp a /tmp/.harness-paused`.
//     A future policy gating some OTHER head token (one of these four, or
//     any other) stays uncovered by this module too — named residual, no
//     follow-up filed unless a real consumer appears. See
//     `tests/runtime/bash-match-head-token-drift.test.ts` for the guard
//     that couples this module's covered set to what FULL_TEMPLATE's
//     shipped `bash_match` policies actually key on today.
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
//   - A shell-boundary character INSIDE a quoted assignment VALUE
//     (`VAR='a; b' git push` — task 13e55484's pinned residual):
//     `BOUNDARY_RE` splits segments BEFORE tokenisation and is quote-
//     unaware, so the quoted value is cut at the `;` and neither
//     resulting segment carries a recognisable invocation. Closing this
//     means a quote-aware segmenter, a different (and riskier) change
//     than the assignment-value continuation that task shipped.
//   - A quoted assignment VALUE containing the literal word `git`/`gh`/
//     `npm`/`harness` as its own token (`VAR='a git b' git push`): the
//     continuation's one-directional guard abandons rather than risk
//     swallowing a real head token (see `consumeAssignment`), leaving
//     the byte-exact pre-task behaviour on those spellings.
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
//   - `gh`'s / `npm`'s own tool-specific flags inserted BETWEEN the head
//     token and its subcommand: `gh -R owner/repo pr merge`, `gh --repo
//     owner/repo pr create`, `npm --loglevel=silent publish`, `npm
//     --registry <url> publish`. Only wrapper prefixes (`env`, `nice`,
//     `command`, ...) and whitespace collapsing across the rest of the
//     segment (see the closed head-token-set rule above) are peeled for
//     these three heads — a flag belonging to `gh`/`npm` itself is never
//     recognised or skipped, so it defeats the match the same way an
//     unrecognised git flag would if `peelGitGlobalOptions` did not know
//     its name.
//   - A path-qualified `gh`/`npm`/`harness` invocation (`/usr/local/bin/gh
//     pr merge`, `./node_modules/.bin/npm publish`): the closed
//     head-token-set check is EXACT literal equality, not basename like
//     `GIT_TOKEN_RE`. `harness`'s own trigger regex already covers a
//     path-qualified spelling at the raw-match level, so nothing is lost
//     there specifically; `gh`/`npm` genuinely have no coverage for this
//     shape.
//
// KNOWN OVER-MATCHING (FALSE POSITIVE) CLASS — `command -v NAME` / `sudo
// -l [NAME]` (fix round 2, finding F5; doc-only, no behaviour change):
// both are INTROSPECTION forms — `command -v NAME` prints what `NAME`
// resolves to without running it, `sudo -l [NAME]` lists (without
// running) whether `NAME` is permitted — but this module's wrapper
// peeling treats `-v` (an otherwise-unrecognised `command` flag) and `-l`
// (an otherwise-unrecognised `sudo` flag) as ordinary BOOLEAN flags to
// skip past, exactly like any other flag either wrapper legitimately
// takes before its real, EXECUTED payload. `command -v harness pause`
// therefore canonicalises to `harness pause` and DENIES via
// `deny-kill-switch-bypass` even though nothing was actually paused
// (measured). This predates this run — `sudo -l git status` was already
// a false positive under the git-only normaliser — this run only widens
// it to also cover `gh`/`npm`/`harness`. Fail-CLOSED direction (an
// operator gets an unnecessary deny, never a missed real gate), so left
// as-is rather than special-cased; noted here so it is not mistaken for
// a security hole if reported.
//
// SAME CLASS, second member (task 13e55484, review round 1): a QUOTED
// ASSIGNMENT INSIDE TEXT at a segment-start position now over-matches.
// `BOUNDARY_RE` splits segments with no quote awareness, so in
// `echo "a; VAR='x y' git push"` the text after the `;` becomes its own
// segment, the assignment continuation normalises it to `git push`, and
// the push gate DENIES a command that only PRINTS the spelling
// (measured; master allowed it). Fail-closed direction, accepted and
// pinned in the test file as a boundary assertion — the practical cost
// is that documenting or testing that bypass class through a Bash call
// trips the gate, the same cost the dbc6d303 quoted/heredoc class
// already carries.
//
// SAME CLASS, third member (task aabbad63, this run's own amp-aware
// second pass): a WIDENING of the second member above, not a new class —
// `AMP_BOUNDARY_RE` is quote-unaware in exactly the same way `BOUNDARY_RE`
// is, so a bare `&` INSIDE a quoted string is now also a segment
// boundary, and a wrapper spelling sitting behind it can be peeled and
// canonicalised as though it were a real invocation. Measured on a
// 160-form quoted-text corpus arbitrated by real bash (PATH-shimmed
// verbs + a marker file the verb would touch if it actually ran): 144
// spellings of `<text> & <wrapper> <gated verb>` INSIDE a quoted string
// now match where the base (pre-aabbad63) build did not, and bash ran
// the gated verb in 0 of them — a false alarm on a command that only
// PRINTS the spelling, never a missed real gate. The wrapper-LESS
// variant of the same shape (`echo 'a & git push'`) already false-
// alarmed on the base build 16/16 via the RAW regex alone, because every
// shipped `bash_match` trigger already anchors on a bare `&` (task
// `d834a065`) — so this is a WIDENING of an already-accepted over-block
// class to the wrapped spellings of it, not a new false-positive class
// this task introduces. The opposite direction, measured on the general
// (non-adversarial) corpus rather than this quoted-text one: of 276
// matches this pass gains there, all 151 classifiable ones were TRUE
// positives, 0 false alarms.
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
   * STILL NOT WIRED TO ANY GATE (see the module header's STATUS
   * paragraph): extracted and fully tested, but task `98ad072f`'s
   * per-policy redesign (T-003) attributes a target from the per-segment
   * `segmentViewOf` view below instead of this whole-command aggregate —
   * a single per-event `targetDir` cannot express "this invocation
   * targets repo B, but the gated verb after it runs in the caller's
   * cwd," which is exactly the property the redesign needs.
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

/**
 * One boundary-delimited segment's canonicalised text plus its own and
 * "effective" target directory (task `98ad072f`, T-002 of run
 * `2026-08-02-per-repo-gate-scoping-redesign`) — attributes a target to
 * the SPECIFIC segment satisfying a policy's own `bash_match` trigger,
 * instead of the single, whole-command `targetDir` / `targetBase` on
 * `NormalizedCommand` above. Produced by `segmentViewOf`. WIRED as of
 * T-003, this run: `src/runtime/intercept.ts`'s `attributeTriggerSegments`
 * / `resolveAttributedContexts` are the consumer (see the module header's
 * STATUS/UPDATE note for the exact contract).
 */
export interface CommandSegment {
  /**
   * This segment's canonicalised text — the same rewrite
   * `NormalizedCommand.normalized` applies to the corresponding span,
   * boundary tokens EXCLUDED (they sit between segments, never inside
   * one). Every shipped `bash_match` pattern's boundary alternation
   * includes a `^` branch, so testing such a pattern against THIS string
   * alone (no leading boundary character) is well-defined — see
   * `01-plan.md`'s Proposed Approach item 2 for how a future consumer
   * uses this.
   */
  text: string;
  /**
   * This segment's OWN explicit target, named by ITS OWN invocation
   * only — a git invocation's REPO-RELOCATING global option ONLY: `-C` /
   * `--git-dir` (or the SAME invocation's wrapping `env -C`, git-own-
   * target-prioritised the same way `NormalizedCommand.targetDir` already
   * is) — or, for a recognised bare `cd <path>` segment, the parsed path.
   * Deliberately EXCLUDES `--work-tree` (D-017, fix round 2, run
   * `2026-08-02-per-repo-gate-scoping-redesign`): `--work-tree` sets a
   * git invocation's working tree but does NOT relocate its `--git-dir`
   * search, so `git --work-tree=<B> push`/`log`/`status` still operate on
   * whatever repo the invocation's ACTUAL directory names, never `<B>`
   * alone — folding it into this field as though it were repo-identity-
   * bearing (the pre-fix behaviour) let `resolveAttributedContexts`
   * (`src/runtime/intercept.ts`, D-011) REPLACE the cwd demand with `<B>`'s
   * on the strength of a flag that never moved the invocation there,
   * measured as a live cross-repo fail-open. `null` when this segment
   * names no repo-relocating target of its own (not a git invocation, not
   * a `cd` segment, a bare git invocation, or a git invocation whose ONLY
   * target-bearing flag is `--work-tree`) OR the named value is one of
   * this view's unattributable forms: `~`-prefixed, carrying a stray quote
   * character (the tokeniser is not quote-aware — a quoted value is
   * captured WITH its quote character(s) still attached, not a real
   * path), containing a command-substitution marker (`$(` or a backtick),
   * or — for `cd` specifically — a bare `cd` with no argument or a `cd`
   * with a flag (`cd -P /x`, three tokens instead of two). ALSO `null`
   * when the SAME invocation names a git target via BOTH a relative own
   * `-C` / `--git-dir` AND a wrapping `env -C` / `--chdir` base (`env -C
   * /tmp/base git -C sub status`) — a mixed, internally ambiguous
   * composition, unattributable for the same reason a relative own target
   * after a preceding `cd` is (see `effectiveTarget` below); this is the
   * ONE case where `ownTarget` itself, not just `effectiveTarget`, is
   * nulled by a composition rule rather than by the raw value being
   * unrecognisable on its own. A relative value (including `-C .`) and an
   * absolute value are both otherwise preserved here verbatim, unresolved
   * against any cwd — that resolution is a future consumer's job, not
   * this module's. `git --git-dir=<A>/.git --work-tree=<B> ...`: this
   * field is `<A>` (the `.git` parent) — `--git-dir` wins regardless of
   * which flag appears first in the invocation, because `--work-tree`
   * never contributes to this field at all, not because of any ordering
   * rule between the two.
   *
   * ALSO `null` (D-018, fix round 3, pass-3 CRITICAL) when the invocation
   * carries MORE THAN ONE recognised, resolved repo-relocating option:
   * two-or-more `-C`, `-C` combined with `--git-dir`, `--git-dir` twice,
   * or a same-invocation `env -C`/`--chdir` wrap whose target diverges
   * from git's own ABSOLUTE `-C`/`--git-dir` target. Real git composes
   * every one of these cumulatively (a later absolute value wins); this
   * module does not encode that composition (same "not this module's
   * job" reasoning as the relative-mix case above) and instead falls back
   * to unattributable rather than trust the first flag it saw — `git -C
   * <forge> -C <realA> push` actually runs in `<realA>`, but a first-
   * flag-wins reading named `<forge>`, letting an agent redirect a gate's
   * demanded evidence away from the repo the verb truly targets (measured
   * against real git 2.34.1). An EXACT repeat of the same already-
   * recorded value (`-C X -C X`, `env -C X git -C X`) is not new
   * information and does not trigger this — see `peelGitGlobalOptions`'s
   * `noteRelocatingOption` for the precise counting rule.
   */
  ownTarget: string | null;
  /**
   * The directory this segment's own invocation actually runs in, once
   * composed with the LAST PRECEDING recognised `cd <path>` segment in the
   * same command (not necessarily the immediately preceding segment — any
   * non-`cd` segment in between leaves the running cd-basis unchanged, the
   * same way a non-`cd` shell command never itself changes the directory).
   * Composition rules (`01-plan.md`, Proposed Approach item 1, verbatim):
   *   - `ownTarget === null` → inherits the incoming cd-basis as-is
   *     (including `null` when nothing preceding named one either).
   *   - `ownTarget` absolute → itself, unconditionally — an absolute
   *     value is never "relative to" anything a preceding `cd` named.
   *   - `ownTarget` relative AND a preceding `cd` basis is known
   *     (non-`null`) → `null`. This is the K1 divergence case
   *     (`docs/okf/quote-model-divergence.md`): `cd T && git -C sub
   *     status` does NOT become `T/sub` here — that would need real
   *     filesystem-shaped path joining this module deliberately does not
   *     perform — so it is UNATTRIBUTABLE rather than guessed at.
   *   - `ownTarget` relative AND no preceding `cd` basis is known → the
   *     raw relative value itself (deferred to a future consumer to
   *     resolve against the real cwd).
   * A same-invocation mixed `env -C <base>` + relative own `-C`/
   * `--git-dir` composition (see `ownTarget` above — `--work-tree` is
   * EXCLUDED from this mix entirely, D-017: it never sets `ownTarget`, so
   * it can never trigger this ambiguity either) is `null` here TOO —
   * checked BEFORE the cd-basis rules above and
   * independently of them: `env -C /tmp/base git -C sub status` never
   * becomes `/tmp/base/sub` (real path joining, deliberately not this
   * module's job — same reasoning as the cd-basis K1 case) NOR does it
   * fall through to the "relative, no cd basis, stays raw" branch above
   * (that would hand a future consumer resolving relatives against ITS
   * OWN cwd a CONFIDENTLY WRONG repository whenever the caller's cwd
   * differs from `/tmp/base` — the "relative and `~` target dirs resolve
   * to a confidently wrong repo" class named in the 07-27 review). A bare
   * `env -C <base> git status` (no relative own target) is UNAFFECTED —
   * `ownTarget` is `<base>` as usual, composed the ordinary way below.
   * A recognised `cd <path>` segment whose OWN value is one of the
   * unattributable forms above (e.g. `cd ~`) still RESETS the running
   * cd-basis to `null` for every LATER segment — a later segment must not
   * silently keep inheriting whatever basis existed BEFORE that `cd`,
   * since the shell genuinely changed directory to somewhere this module
   * cannot name.
   *
   * FULL reset-trigger list (D-014, fix round, run 2026-08-02-per-repo-
   * gate-scoping-redesign — corrects this comment, which previously named
   * only the unattributable-`cd`-value case above): the running basis
   * resets to `null` — rather than the pre-fix behaviour of silently
   * carrying an earlier basis forward unchanged — for ALL of: a bare `cd`
   * with no argument, `cd -`, any other flagged `cd` (`cd -P /tmp/x`),
   * `pushd`, `popd` (see `classifyCdSegment`), and the unattributable-
   * `cd`-value case documented above. TWO of the reset triggers are NOT
   * decided by this per-segment composition at all — they depend on the
   * BOUNDARY a segment sits behind, which only the caller
   * (`segmentAndCanonicalize`'s own walk) can see: the basis never
   * crosses a bare `|` (each side of a pipe is bash's own subshell), and
   * it resets after any segment whose text contains a `)` (a subshell
   * close — `BOUNDARY_RE` has no `)` boundary of its own, so this is a
   * substring check on the segment that happens to end there, not paren-
   * depth tracking). See `segmentAndCanonicalize`'s own comment at its
   * `computeSegmentTarget` call site for those two. NOT covered by any of
   * this (same ceiling as before this fix round, unchanged): a `cd`
   * inside a NESTED subshell that never closes within the command
   * string's visible boundaries, and any construct outside this module's
   * documented NOT-SUPPORTED list in the module header.
   */
  effectiveTarget: string | null;
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
 * Exported (fix round 2, finding F3) so
 * `tests/runtime/bash-match-head-token-drift.test.ts` can couple this
 * module's covered set to what FULL_TEMPLATE's shipped `bash_match`
 * policies actually key on today, instead of a test-owned duplicate.
 */
export const GIT_TOKEN_RE = /^(?:\S*\/)?git$/;

/**
 * The three OTHER head tokens this module covers (D-001, run
 * 2026-07-28-nongit-trigger-wrappers) — `gh` (`gh pr merge` / `gh pr
 * create`), `npm` (`npm publish`), `harness` (the kill-switch verbs). A
 * closed set, deliberately NOT a general "any head token" rule (see the
 * module header): matched by EXACT literal equality, unlike `GIT_TOKEN_RE`'s
 * basename match, so a path-qualified spelling of any of these three stays
 * out of scope (named residual, module header NOT-SUPPORTED list). This is
 * NOT the complete set of head tokens a shipped `bash_match` trigger keys
 * on — see the module header's "SHIPPED BUT NOT COVERED" paragraph (fix
 * round 2, finding F1) for the four that are NOT in this set (`env`,
 * `unset`, `tee`, `cp`) and why. Exported (fix round 2, finding F3) for the
 * same drift-guard reason as `GIT_TOKEN_RE` above.
 */
export const NON_GIT_HEAD_TOKENS: ReadonlySet<string> = new Set(["gh", "npm", "harness"]);

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
 *
 * DELIBERATELY MISSING, STILL: single `&`, even though bash starts a new
 * command after it. Adding it HERE was tried and REVERTED after
 * measurement: this regex is quote-unaware, `&` inside a quoted
 * assignment value is common, and the split lands mid-quote, so the
 * value continuation never engages and the wrapper is never peeled.
 * Measured against the pre-change build with a passing positive
 * control: 140 of 140 sampled `<wrapper> FOO='a&b' <gated verb>`
 * spellings LOST a gate they previously held, including the
 * `operator_only` kill-switch deny. That evidence is why THIS alphabet
 * stays byte-identical rather than growing a bare `&` alternative
 * directly — see `scripts/measure-command-normalize.mjs`'s arm A for the
 * regression corpus that keeps proving it stays byte-identical.
 *
 * TASK aabbad63 (this run): the bare-`&` family this alphabet cannot see
 * (`A=x&env -C /tmp git status`, `echo hi & nice git status`) is now
 * handled WITHOUT touching this regex at all — by a SECOND, independent
 * boundary alphabet (`AMP_BOUNDARY_RE` below) driving a SECOND
 * normalisation pass (`normalizeCommandAmpAware`) that
 * `policyMatchesEvent` (`src/runtime/intercept.ts`) tries ONLY as a
 * third, additional raw-OR-normalised-OR-amp-normalised disjunct — never
 * a replacement for either of the first two arms. That construction is
 * exactly what avoids re-triggering the 140/140 regression above: every
 * command that matched via the raw test or via THIS (BOUNDARY_RE)
 * normalised form keeps matching through those same two arms, byte-for-
 * byte unchanged; the amp-aware arm can only ADD a match a spelling
 * would otherwise have missed, so a quoted `FOO='a&b'` value that this
 * alphabet already normalises correctly is never at risk of losing that
 * gate to the new arm. See `AMP_BOUNDARY_RE`'s own comment for why it
 * has to be a distinct regex object rather than a mutation of this one,
 * and `normalizeCommandAmpAware`'s comment for why its return type
 * carries no `targetDir`/`targetBase`.
 */
const BOUNDARY_RE = /\n|&&|;|\||\(/g;

/**
 * Second boundary alphabet (task aabbad63): identical to `BOUNDARY_RE`
 * plus a bare `&` — bash's OWN "start a new command here" token, which
 * every shipped `bash_match` trigger regex has treated as one of its own
 * anchor characters since task `d834a065`, but which `BOUNDARY_RE` above
 * has never recognised as a NORMALISATION-time boundary (see its comment
 * for the reverted, measured-140/140-regression attempt to add it there
 * directly).
 *
 * ALTERNATION ORDER IS LOAD-BEARING: `&&` MUST be listed to the LEFT of
 * the bare `&` alternative. JS regex alternation is leftmost-FIRST, not
 * leftmost-longest — with `&` tried before `&&`, every `&&` in a command
 * would tokenise as TWO consecutive one-character `&` boundary MATCHES
 * instead of a single two-character `&&` boundary match.
 *
 * MEASURED, NOT ASSUMED (do not "simplify" the pin below to an
 * end-to-end `.normalized` string assertion): for THIS module's segment-
 * and-rejoin architecture specifically, that reordering is, perhaps
 * counter-intuitively, INVISIBLE in `normalizeCommandAmpAware`'s own
 * output string. Two adjacent single-`&` matches sandwich a genuinely
 * zero-length segment between them (the two `&` characters of a real
 * `&&` are, by definition, adjacent), `canonicalizeSegment("")` is a
 * verbatim no-op, and `parts.join("")` reassembles the exact same bytes
 * either way — verified directly (not merely reasoned about) by
 * temporarily swapping this alternation's order, rebuilding, and
 * diffing `normalizeCommandAmpAware(...).normalized` across several
 * `&&`-bearing commands (including this comment's own `git -C
 * /tmp/repoB status && git -C /tmp/repoB log` example): byte-identical
 * output both ways. So a test asserting on the OUTPUT STRING alone
 * cannot distinguish the two orderings for this architecture — the pin
 * in `tests/runtime/command-normalize.test.ts` therefore execs this
 * regex object DIRECTLY against a `&&`-bearing string and asserts the
 * match text is `"&&"`, not `"&"`, which DOES fail under a swap. The
 * order is still specified exactly as documented above (leftmost-first
 * is real JS semantics, and the internal `segmentAndCanonicalize`
 * bookkeeping this alphabet ALSO drives — `hasAmbiguousNonGitSegment`,
 * discarded by `normalizeCommandAmpAware` but not by a hypothetical
 * future consumer of `segmentAndCanonicalize` under this alphabet —
 * would still see a spurious extra "non-git segment" under the wrong
 * order), it just cannot be pinned through this module's ONE exposed
 * string alone.
 *
 * Used ONLY by `normalizeCommandAmpAware` below, which is consulted ONLY
 * as `policyMatchesEvent`'s third, additional matching arm — see that
 * function's own comment for why its result never carries a `targetDir`/
 * `targetBase`, and `src/runtime/intercept.ts` for the memoised-thunk
 * threading that keeps this off the common (raw-or-normalised-already-
 * matched) path. Exported (mirrors `GIT_TOKEN_RE` / `NON_GIT_HEAD_TOKENS`
 * / `MAX_NORMALIZE_LENGTH` above) solely so the ordering pin test can
 * exec it directly instead of re-declaring an equivalent regex literal
 * that would test JS semantics in general, not THIS source's actual
 * alternation.
 */
export const AMP_BOUNDARY_RE = /\n|&&|&|;|\||\(/g;

/** A target value starting with `~` — not expanded, treated as unparseable (F5). */
function isTildeTarget(dir: string): boolean {
  return dir.startsWith("~");
}

/**
 * A target value `segmentViewOf`'s `CommandSegment.ownTarget` (task
 * `98ad072f` groundwork) treats as unattributable even where the
 * pre-existing per-segment machinery below (`canonicalizeSegment` /
 * `peelGitGlobalOptions` / `peelEnv`) still captures SOME string for the
 * OLD aggregate's `targetDir` — that extraction is UNCHANGED by this check
 * (see the module header's STATUS/UPDATE note): the tokeniser is not
 * quote-aware, so a quoted `-C` / `--work-tree` / `--git-dir` / `env -C`
 * value is captured WITH its quote character(s) still attached
 * (`git -C "/tmp/repoB" status` captures `"/tmp/repoB"`, quotes included —
 * not a real path, and not `null` either under the pre-existing
 * extraction) rather than being rejected outright. The same is true of a
 * value containing a command-substitution marker (`$(` or a backtick) —
 * this module never resolves substitutions, so a value carrying one names
 * nothing this module can vouch for as a literal path. A
 * whitespace-containing path needs no separate check here: the
 * whitespace-splitting tokeniser never captures a value containing
 * whitespace as ONE token in the first place — it becomes a different,
 * unrecognised token sequence instead (see the module header's own
 * "quoted directory arguments containing whitespace" note), which for
 * `segmentViewOf` purposes simply fails to produce a recognised own target
 * at all (see `parseCdSegmentTarget` below for the `cd` case).
 *
 * A value ENDING in a bare `$` is ALSO rejected, even though it does not
 * literally contain the two-character `$(` marker: `BOUNDARY_RE` (this
 * function is only ever reached through the primary, non-amp-aware pass —
 * `segmentViewOf` never runs under `AMP_BOUNDARY_RE`) treats a bare `(` as
 * a shell boundary UNCONDITIONALLY (needed for the leading-command case,
 * module header), so `$(` can never survive as a substring WITHIN one
 * token or segment in the first place — the `(` always splits it into its
 * own boundary match first. A `cd` target ending in `$` is the tell-tale
 * leftover of exactly that split (`cd $(pwd)/T && ...` tokenises this
 * function's caller's OWN segment as literal `cd $`, a syntactically
 * valid-LOOKING two-token `cd <path>` with `<path>` being the single
 * character `$` — measured live, not hypothetical). Rejecting it here
 * closes that gap without needing `parseCdSegmentTarget` (which has no
 * visibility into what boundary token follows its own segment) to
 * special-case it itself. The `-C`/`--work-tree`/`--git-dir`/`env -C` side
 * of this module never has this specific gap: a value-capturing git
 * global option additionally requires a SUBCOMMAND token after its value
 * (`peelGitGlobalOptions`'s caller checks `gitOpts.idx >= tokens.length`),
 * so `git -C $(pwd) status` already comes back `isGit: false` (no
 * subcommand token survives the split) before this function is ever
 * consulted for it — this extra check is `cd`-specific, `cd <path>` having
 * no analogous "and then a subcommand" requirement.
 */
function isUnattributableTargetValue(value: string): boolean {
  return (
    value.includes("'") ||
    value.includes('"') ||
    value.includes("$(") ||
    value.includes("`") ||
    value.endsWith("$")
  );
}

/**
 * Classification of a segment for `segmentViewOf`'s cd-basis tracking
 * (task `98ad072f` groundwork; RESET variant added D-014, fix round,
 * run `2026-08-02-per-repo-gate-scoping-redesign`):
 *   - `{ kind: "cd", arg }` — a bare `cd <path>` invocation and nothing
 *     else (no flags, no extra arguments, `<path>` a single
 *     whitespace-delimited token). `arg` is the raw path text (still
 *     possibly `~`-prefixed, quoted, or substitution-bearing — the caller
 *     applies the SAME `isTildeTarget` / `isUnattributableTargetValue`
 *     filters used for a git invocation's own target).
 *   - `{ kind: "reset" }` — a segment that GENUINELY changes the shell's
 *     directory to somewhere this module cannot (or should not) name as a
 *     basis for a LATER segment: a bare `cd` with no argument (goes to
 *     `$HOME`), `cd -` (goes to `$OLDPWD`), any OTHER flagged `cd` (`cd -P
 *     /tmp/x`, `cd -L .` — three-or-more tokens; this module does not
 *     resolve what `-P`/`-L`/`-e`/`-@` do to the destination), and `pushd`
 *     / `popd` (directory-stack navigation this module does not track at
 *     all, unlike `bash-prefix-parse.ts`'s own scope — module header). D-014
 *     fix round: these previously fell through to "not cd-shaped" below,
 *     which left the running basis UNCHANGED (silently INHERITING whatever
 *     preceded them) — wrong, since the shell demonstrably did change
 *     directory; `computeSegmentTarget`'s caller now resets the basis to
 *     `null` for these instead.
 *   - `{ kind: "none" }` — anything else: not a recognised `cd` shape at
 *     all (a `pushd -0` `cd`-adjacent typo, an ordinary command, or a `cd`
 *     preceded by an assignment — `bash-prefix-parse.ts`'s own
 *     `consumeLeadingCd` tolerates a leading `VAR=value`, quoting, for the
 *     OLD aggregate's `targetDir` fallback; this segment-local function
 *     deliberately does not replicate that tolerance, a narrower ceiling
 *     than the old aggregate carries for that one construction, named
 *     here rather than left implicit). The running cd-basis passes through
 *     UNCHANGED for this kind — this module has no evidence the shell's
 *     directory changed, so it does not guess either way.
 */
type CdSegmentClass =
  | { kind: "cd"; arg: string }
  | { kind: "reset" }
  | { kind: "none" };

function classifyCdSegment(segmentText: string): CdSegmentClass {
  const tokens = tokenizeWithOffsets(segmentText);
  if (tokens.length === 0) return { kind: "none" };
  const head = tokens[0]!.text;
  if (head === "pushd" || head === "popd") return { kind: "reset" };
  if (head !== "cd") return { kind: "none" };
  if (tokens.length === 1) return { kind: "reset" }; // bare `cd`, no argument
  if (tokens.length > 2) return { kind: "reset" }; // flagged cd: `cd -P /tmp/x`
  const arg = tokens[1]!.text;
  if (arg.length === 0 || arg.startsWith("-")) return { kind: "reset" }; // `cd -`, `cd -P` alone
  return { kind: "cd", arg };
}

/**
 * Compute one segment's `ownTarget` / `effectiveTarget` (task `98ad072f`
 * groundwork, `segmentViewOf` / `CommandSegment`) and the cd-basis to
 * carry into the NEXT segment, from: this segment's own canonicalisation
 * result (already computed by the shared walk — `identityTargetDir` /
 * `identityTargetBase` / `isGit`, unmodified here; NOT the OLD aggregate's
 * `targetDir`/`targetBase`, which still includes `--work-tree` — D-017,
 * fix round 2), whether THIS segment is itself a recognised `cd <path>`
 * segment, and the cd-basis carried in from whatever preceded it.
 * Implements `CommandSegment.effectiveTarget`'s doc comment verbatim; see
 * that comment for the consumer-facing statement of these rules.
 */
function computeSegmentTarget(
  segmentText: string,
  canon: { identityTargetDir: string | null; identityTargetBase: string | null; isGit: boolean },
  incomingCdBasis: string | null,
): { ownTarget: string | null; effectiveTarget: string | null; outgoingCdBasis: string | null } {
  // Same-invocation `env -C`/`--chdir` base + a RELATIVE own git
  // REPO-RELOCATING target (`-C`/`--git-dir` — orchestrator follow-up
  // after the initial T-002 round, still task `98ad072f` groundwork):
  // `canon.identityTargetBase` is non-null EXACTLY in this mixed case —
  // see `canonicalizeSegment`'s own `identityTargetBase` computation,
  // reused here unmodified, never when there is no wrapping `env -C` on
  // the SAME invocation. `env -C /tmp/base git -C sub status` must NOT
  // hand a future consumer `ownTarget`/`effectiveTarget: "sub"` (raw,
  // relative): a naive consumer resolving a relative value against ITS
  // OWN cwd (this module's documented fallback for the "no known basis"
  // branch below) would land on a CONFIDENTLY WRONG repository whenever
  // the caller's cwd differs from `/tmp/base` — precisely the "relative
  // and `~` target dirs resolve to a confidently wrong repo" class named
  // in the 07-27 review. Composing correctly to `/tmp/base/sub` would ALSO
  // be correct but is deliberately NOT this module's job (real
  // filesystem-shaped path joining — the same reason the cd-basis
  // composition rule below refuses to compose `cd T && git -C sub` into
  // `T/sub`); noted here as a possible LATER precision gain, not built in
  // this slice. A bare git invocation with an `env -C` base and no
  // relative own REPO-RELOCATING target (`env -C /abs git status`) is
  // UNAFFECTED — the ordinary `canon.identityTargetDir` extraction below
  // already folds that in (`gitOpts.relocateTargetDir ?? envTargetDir`),
  // and `canon.identityTargetBase` stays `null` for that shape (no
  // relative own repo-relocating target to be relative TO). A `--work-
  // tree`-only invocation (no `-C`/`--git-dir` on the same call) is NEVER
  // "mixed" here even when wrapped by `env -C`: `relocateTargetDir` is
  // `null` for it, so `identityTargetDir` falls through to `envTargetDir`
  // (or stays `null`) and `identityTargetBase` stays `null` — D-017, this
  // is the fix. A `cd`-shaped segment never reaches this branch: it never
  // matches `GIT_TOKEN_RE`, so `canon.isGit` is always `false` for one.
  if (canon.isGit && canon.identityTargetBase !== null) {
    return { ownTarget: null, effectiveTarget: null, outgoingCdBasis: incomingCdBasis };
  }

  const cdClass = classifyCdSegment(segmentText);

  // D-014 (fix round, run 2026-08-02-per-repo-gate-scoping-redesign): a
  // segment that GENUINELY changes directory to somewhere this module
  // cannot name (bare `cd`, `cd -`, a flagged `cd`, `pushd`, `popd`)
  // RESETS the running basis to `null` for every later segment, rather
  // than the pre-fix behaviour of leaving it unchanged (silently
  // INHERITING whatever preceded it, as though the shell had not moved at
  // all). This segment names nothing itself either. A PRECISION fix, not
  // the security fix: `src/runtime/intercept.ts`'s D-011 additive
  // attribution rule means an inherited target always also demands the
  // cwd context, so an over-cautious reset here can only make a LATER
  // segment fall back to cwd-only evaluation — identical to the shipped
  // baseline for an unattributable form (D-003), never a fail-open.
  if (cdClass.kind === "reset") {
    return { ownTarget: null, effectiveTarget: null, outgoingCdBasis: null };
  }

  const cdArg = cdClass.kind === "cd" ? cdClass.arg : null;
  const rawOwn = cdArg !== null ? cdArg : canon.isGit ? canon.identityTargetDir : null;
  const ownTarget =
    rawOwn !== null && !isTildeTarget(rawOwn) && !isUnattributableTargetValue(rawOwn)
      ? rawOwn
      : null;

  let effectiveTarget: string | null;
  if (ownTarget === null) {
    // D-014: a recognised `cd <path>` segment whose OWN value came out
    // unattributable (tilde/quoted/substitution) RESETS rather than
    // inherits — the shell genuinely changed directory to somewhere this
    // module cannot name, so silently keeping an earlier basis in place
    // would be a confidently-wrong carry-forward, exactly the class this
    // whole module exists to avoid. A segment that is NOT cd-shaped at
    // all (`cdArg === null`, `cdClass.kind === "none"`) still inherits —
    // this module has no evidence the shell moved, so it does not guess.
    effectiveTarget = cdArg !== null ? null : incomingCdBasis;
  } else if (path.isAbsolute(ownTarget)) {
    effectiveTarget = ownTarget;
  } else {
    effectiveTarget = incomingCdBasis === null ? ownTarget : null;
  }

  // Only a recognised `cd <path>` segment updates the outgoing basis
  // (whether or not its OWN value came out attributable — see
  // `CommandSegment.effectiveTarget`'s doc comment for why an
  // unattributable `cd` must still RESET the basis to `null`, not leave a
  // stale earlier one in place). Every other segment — gated or not —
  // never itself changes the shell's directory, so the incoming basis
  // passes through unchanged.
  const outgoingCdBasis = cdArg !== null ? effectiveTarget : incomingCdBasis;
  return { ownTarget, effectiveTarget, outgoingCdBasis };
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

/**
 * Given a Bash command string, return its per-segment view (task
 * `98ad072f` groundwork, T-002) — see `CommandSegment`'s own doc comment
 * for the field-level composition rules. `null` when the input exceeded
 * `MAX_NORMALIZE_LENGTH` (mirrors `NormalizedCommand.truncated`, but as
 * the ABSENCE of a view rather than a boolean flag alongside one, since
 * there is no meaningful per-segment view to return for an input whose
 * normalisation itself was skipped). `[]` for an empty or non-string
 * command, and as the never-throws fallback (mirrors `normalizeCommand`'s
 * own defensive backstop — see its doc comment above).
 *
 * THIS function's OWN call into `segmentAndCanonicalize` (`collectSegments:
 * true`) is one walk, O(length) — the "no additional pass" claim is scoped
 * to that ONE call, not to a caller's total work. CORRECTED (D-015, fix
 * round, run 2026-08-02-per-repo-gate-scoping-redesign) — the prior wording
 * here read "no additional pass over the command string" without that
 * scoping, which a reader could take as "calling this costs nothing beyond
 * `normalizeCommand`'s own walk." Measured false: `normalizeCommand(cmd)`
 * and `segmentViewOf(cmd)` are two SEPARATE top-level calls, each running
 * its own full `segmentAndCanonicalize` pass over the SAME string — a
 * caller needing both (as `src/cli/policy/intercept.ts` does, for
 * `normalized`/`truncated` and the segment view respectively) pays TWO
 * walks, not one; measured +206% at the `MAX_NORMALIZE_LENGTH` bound
 * (2.73 → 8.36 ms), harmless against the 1000 ms hook budget but not free.
 * As of the same fix round, the one production caller only pays this
 * second walk lazily, when some matching policy actually needs it (see
 * `InterceptOptions.commandSegmentsThunk` in `src/runtime/intercept.ts`) —
 * but that laziness lives in the CALLER, not in this function, which still
 * does exactly one walk every time it runs. The ampersand-aware second pass
 * (`normalizeCommandAmpAware`) NEVER collects a segment view (always calls
 * `segmentAndCanonicalize` with `collectSegments: false`) — see that
 * function's own comment for why a directory extracted under the
 * ampersand-aware alphabet would be unreliable in the first place; the
 * same reasoning applies here, so this module offers no amp-aware variant
 * of this function at all.
 */
export function segmentViewOf(command: string): CommandSegment[] | null {
  if (typeof command !== "string" || command.length === 0) return [];
  if (command.length > MAX_NORMALIZE_LENGTH) return null;
  try {
    return segmentAndCanonicalize(command, BOUNDARY_RE, true).segments ?? [];
  } catch {
    return [];
  }
}

/**
 * Return type of `normalizeCommandAmpAware` — deliberately NOT
 * `NormalizedCommand` (task aabbad63, hard constraint). It carries only
 * `normalized`/`truncated`; there is no `targetDir`/`targetBase` field at
 * all, so a future caller cannot wire one up to a gate by mistake — see
 * `normalizeCommandAmpAware`'s own comment for why a directory extracted
 * under the ampersand-aware alphabet would be unreliable in the first
 * place, not merely "unwired today".
 */
export interface AmpAwareNormalizedCommand {
  /** Same contract as `NormalizedCommand.normalized`, under `AMP_BOUNDARY_RE`. */
  normalized: string;
  /** Same contract as `NormalizedCommand.truncated`. */
  truncated: boolean;
}

/**
 * Ampersand-aware SECOND normalisation pass (task aabbad63). Segments the
 * command under `AMP_BOUNDARY_RE` (`BOUNDARY_RE` plus a bare `&`) instead
 * of `BOUNDARY_RE`, then canonicalises exactly like the primary pass
 * (same `canonicalizeSegment`, same wrapper-peeling rules, same
 * `MAX_NORMALIZE_LENGTH` bound). Closes the gap `BOUNDARY_RE`'s own
 * comment names: `A=x&env -C /tmp git status` and `echo hi & nice git
 * status` were ungated because a wrapper can only be peeled after a
 * recognised boundary, and a bare `&` was not one.
 *
 * Return type deliberately has NO `targetDir`/`targetBase` — not merely
 * "always null under this alphabet", genuinely ABSENT from the type, so
 * no consumer can read one by mistake. Reason: a bare `&` is ALSO how
 * bash spells a background job (`git -C /x push &`) and how a redirect
 * merges streams (`git -C /x log 2>&1`, `... &> out`). Under THIS
 * alphabet each of those splits into a spurious extra "segment", which
 * `segmentAndCanonicalize`'s own non-git-segment ambiguity rule (a
 * segment that starts a new command and is not itself a git invocation
 * forces `targetDir` to `null` — see its G1 comment) would turn into a
 * wrong-shaped loss for a case the PRIMARY pass still resolves correctly
 * today. Pinned in `tests/runtime/command-normalize.test.ts`'s "aabbad63
 * groundwork" describe block, which exercises ONLY `normalizeCommand`
 * (the primary pass), never this function — `targetDir`/`targetBase`
 * stay the primary pass's property alone.
 *
 * Only consulted by `policyMatchesEvent`'s third arm
 * (`src/runtime/intercept.ts`), and only when a policy's `bash_match`
 * regex has already missed BOTH the raw command and the primary
 * normalised form — see that module and `src/cli/policy/intercept.ts`
 * for the memoised-thunk threading that keeps this computation off the
 * common (already-matched) path.
 */
export function normalizeCommandAmpAware(command: string): AmpAwareNormalizedCommand {
  if (typeof command !== "string" || command.length === 0) {
    return { normalized: typeof command === "string" ? command : "", truncated: false };
  }
  if (command.length > MAX_NORMALIZE_LENGTH) {
    return { normalized: command, truncated: true };
  }
  try {
    return {
      normalized: segmentAndCanonicalize(command, AMP_BOUNDARY_RE, false).normalized,
      truncated: false,
    };
  } catch {
    return { normalized: command, truncated: false };
  }
}

function normalizeCommandInner(command: string): NormalizedCommand {
  const { normalized, targetDir, targetBase } = segmentAndCanonicalize(command, BOUNDARY_RE, false);
  return { normalized, targetDir, targetBase, truncated: false };
}

/**
 * The shared segmentation + canonicalisation engine behind BOTH
 * normalisation passes (task aabbad63). Parameterised on the boundary
 * alphabet (`boundaryRe`) instead of closing over a single module-level
 * regex, so the primary pass (`BOUNDARY_RE`) and the ampersand-aware
 * second pass (`AMP_BOUNDARY_RE`) never share regex scan state: each
 * call is handed its OWN regex object, and `findNextBoundary` resets
 * that object's own `lastIndex` before every use, so the two passes
 * (even if a future change nested one inside the other, which nothing
 * here does today) can never observe or clobber each other's position.
 * `targetDir`/`targetBase` ARE still computed here regardless of which
 * alphabet drove the segmentation — `normalizeCommandAmpAware` below
 * simply never returns them to its own caller; see that function's
 * comment for why exposing them would be wrong under the amp alphabet
 * specifically. Fix round 1, finding F10: under the amp alphabet
 * specifically, ALL of this function's target bookkeeping
 * (`explicitTargets`, `explicitTargetBase`, `bareGitSegmentCount`,
 * `leadingCd`'s full `parseBashPrefix` pass, and the whole G1 ambiguity
 * resolution below) is knowingly computed and then discarded by
 * `normalizeCommandAmpAware` ITSELF, which returns only
 * `{ normalized, truncated }` — its own caller never sees these fields at
 * all. This is the containment design's cost, not an oversight, so a
 * future reader should not "fix" it by exposing these fields to a
 * hypothetical amp-alphabet consumer.
 *
 * `collectSegments` (task `98ad072f` groundwork, T-002): when `true`, ALSO
 * builds the per-segment view `segmentViewOf` returns (`CommandSegment[]`)
 * inside this SAME walk — no SECOND walk INSIDE this one function call,
 * just a bounded amount of extra work per segment already being visited
 * (see `computeSegmentTarget`). Scoped claim only (D-015 correction, fix
 * round, run 2026-08-02-per-repo-gate-scoping-redesign): this says nothing
 * about a CALLER that invokes this function twice with different
 * `collectSegments` values on the same string — see `segmentViewOf`'s own
 * doc comment, corrected in the same fix round, for the measured cost of
 * exactly that. `normalizeCommandInner` and
 * `normalizeCommandAmpAware` both pass `false`: the OLD aggregate never
 * needed this, and the amp-aware pass deliberately never exposes a segment
 * view at all (see that function's own comment). `segments` is `null` on
 * the returned object when `collectSegments` is `false`, an array
 * (possibly empty) otherwise.
 */
function segmentAndCanonicalize(
  command: string,
  boundaryRe: RegExp,
  collectSegments: boolean,
): {
  normalized: string;
  targetDir: string | null;
  targetBase: string | null;
  segments: CommandSegment[] | null;
} {
  const parts: string[] = [];
  const explicitTargets = new Set<string>();
  let explicitTargetBase: string | null = null;
  let sawExplicitBase = false;
  let bareGitSegmentCount = 0;
  let i = 0;
  const n = command.length;

  // task `98ad072f` groundwork (T-002): the per-segment view's own,
  // independent bookkeeping — a running cd-basis (see
  // `computeSegmentTarget`) and the accumulated segments themselves.
  // Entirely separate from `explicitTargets` / `bareGitSegmentCount` /
  // `hasAmbiguousNonGitSegment` above, which stay exactly as they were:
  // this never reads or writes them, and they never read or write this.
  const segments: CommandSegment[] | null = collectSegments ? [] : null;
  let cdBasis: string | null = null;

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
    const boundary = findNextBoundary(command, i, boundaryRe);
    const segEnd = boundary ? boundary.start : n;
    const segmentText = command.slice(i, segEnd);
    const result = canonicalizeSegment(segmentText);
    parts.push(result.text);
    if (segments !== null) {
      // task `98ad072f` groundwork (T-002): O(1) extra work per segment
      // already being visited — see `segmentAndCanonicalize`'s own doc
      // comment for why this is not a second pass over `command`.
      //
      // D-014 (fix round, run 2026-08-02-per-repo-gate-scoping-redesign),
      // two bash-truthfulness corrections applied around the call, not
      // inside `computeSegmentTarget` itself (both are about WHICH basis
      // crosses a BOUNDARY, not about one segment's own composition):
      //
      //   - a running cd-basis never crosses a bare `|` — each side of a
      //     pipeline is bash's own subshell, so a `cd` on one side cannot
      //     affect the other (measured bypass: `cd <forged> | git push`
      //     really runs `git push` at the real cwd, never `<forged>`).
      //     The segment immediately after a `|` is handed `null` as its
      //     incoming basis, as though nothing preceded it.
      //   - the OUTGOING basis resets to `null` whenever THIS segment's
      //     own text contains a `)` (a subshell close riding along after
      //     `BOUNDARY_RE`'s bare `(` boundary — this alphabet has no `)`
      //     boundary of its own, see its header comment — so a subshell's
      //     `cd` genuinely stops applying once the subshell exits: `(cd
      //     <forged> ; echo hi) && git push` must not let `<forged>` reach
      //     `git push`). THIS segment's own `effectiveTarget` is computed
      //     from the UNCHANGED incoming basis first — a segment ending in
      //     `)` (e.g. the `git status)` tail of `(cd A && git status)`)
      //     still correctly attributes to A for itself, exactly as it
      //     should while still inside the subshell; only what carries
      //     FORWARD to the next segment is affected. A simple substring
      //     check, not paren-depth tracking: conservative, precision-only
      //     under D-011 (see `computeSegmentTarget`'s own D-014 note) — an
      //     over-eager reset here can only make a later segment fall back
      //     to cwd-only, never a fail-open.
      const incomingBasis = precedingBoundaryToken === "|" ? null : cdBasis;
      const seg = computeSegmentTarget(segmentText, result, incomingBasis);
      segments.push({
        text: result.text,
        ownTarget: seg.ownTarget,
        effectiveTarget: seg.effectiveTarget,
      });
      cdBasis = segmentText.includes(")") ? null : seg.outgoingCdBasis;
    }
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

  return { normalized: parts.join(""), targetDir, targetBase, segments };
}

/**
 * Find the earliest shell boundary token at or after `from`, under the
 * CALLER-SUPPLIED boundary alphabet. Takes `boundaryRe` as an explicit
 * parameter rather than closing over a single module-level regex (task
 * aabbad63) so the primary pass (`BOUNDARY_RE`) and the ampersand-aware
 * second pass (`AMP_BOUNDARY_RE`) each carry their own `lastIndex` state.
 *
 * Fix round 1, finding F8 (corrects the prior wording here): resetting
 * `lastIndex = from` on every call is NOT what stops the two passes from
 * clobbering each other's scan position — they are two DISTINCT regex
 * objects, so there is nothing shared for either to clobber, and
 * `segmentAndCanonicalize`'s own loop always calls this with `from`
 * already equal to where the previous match's `lastIndex` would have
 * landed anyway. That is why removing this reset measured 0 output
 * differences across the corpus and left the suite green (see
 * `tests/runtime/command-normalize.test.ts`'s F8 note — the mutation was
 * applied and reverted to confirm this, not merely reasoned about). The
 * line is still a legitimate guard, just for a DIFFERENT reason:
 * `BOUNDARY_RE` and `AMP_BOUNDARY_RE` are module-level `/g` objects
 * shared by every call in the process, so their `lastIndex` outlives any
 * single scan. If `canonicalizeSegment` THROWS partway through a scan,
 * the top-level `catch` in `normalizeCommand` /
 * `normalizeCommandAmpAware` returns a fallback but leaves that shared
 * object's `lastIndex` wherever the last successful match landed — and
 * the NEXT call, on a completely different command, would then start
 * scanning from that stale offset. This reset re-anchors it.
 *
 * DO NOT DELETE THIS LINE ON THE STRENGTH OF ITS MUTATION-INERTNESS.
 * Measured (fix round 2): with the reset removed and a throw forced into
 * `canonicalizeSegment`, the FOLLOWING call to
 * `normalizeCommandAmpAware("a | env git push origin master")` returned
 * the un-normalised string, and `preflight-before-push` went from MATCH
 * to NO-MATCH. That is a gate-losing fail-open, not a stylistic nit.
 * The honest caveat, stated rather than implied: no throw is KNOWN to be
 * reachable from real input — the leak above was demonstrated with a
 * forced throw, which is why the line measures inert. The module's own
 * top-level `catch` exists because a throw is treated as possible, and
 * this reset is the other half of that same posture.
 */
function findNextBoundary(
  s: string,
  from: number,
  boundaryRe: RegExp,
): { start: number; token: string } | null {
  boundaryRe.lastIndex = from;
  const m = boundaryRe.exec(s);
  return m === null ? null : { start: m.index, token: m[0] };
}

/**
 * Consume one leading `VAR=value` assignment starting at `idx`, returning
 * the index of the first token AFTER it. Task 13e55484: the VALUE may be
 * quoted and span multiple whitespace-split tokens (`VAR='hello world'`),
 * which used to leave a dangling `world'` token that aborted the peel
 * loop — the one measured spelling where BOTH matching layers failed on
 * the same character. The continuation engages ONLY while an opening
 * quote from the assignment stays unbalanced at a token's end and a
 * matching close exists in a later token; every other shape keeps the
 * exact pre-task one-token consume:
 * - an UNTERMINATED quote (`VAR='a git push`) falls back to consuming
 *   one token, because that spelling normalised to `git push` before
 *   this task and must keep doing so (never-unmatch);
 * - backslash-escaped whitespace without quotes (`VAR=a\ b`) is task
 *   b093911d's escape-handling class and is deliberately NOT continued
 *   here (pinned as a still-open bypass in the test file).
 * Quote semantics per POSIX: outside quotes `\` escapes the next char,
 * single quotes close only at `'`, double quotes close at an unescaped
 * `"`. A quote run may chain (`VAR='a b'"c d"`); the assignment ends at
 * the first token that finishes outside any quote.
 *
 * ONE-DIRECTIONAL GUARD (review round 1, CRITICAL): the continuation
 * ABANDONS (returns the pre-task one-token consume) the moment the token
 * it would consume next is a recognised head token (`GIT_TOKEN_RE` or
 * `NON_GIT_HEAD_TOKENS`). Without this, a quote model diverging from
 * bash on even ONE spelling lets the continuation swallow the gated
 * command word and turn a previously-BLOCKED command into a bypass —
 * measured live with ANSI-C quoting, where bash escapes `\'` inside
 * `$'...'` but this scanner (correctly for plain `'...'`) treats the
 * backslash as literal: `A=$'don\'t' env harness pause # '` produced a
 * phantom-open state that consumed the whole segment, and NEITHER layer
 * matched where master's one-token consume blocked. The guard closes
 * the HEAD-SWALLOW channel specifically: a diverging quote state can
 * never re-target or swallow a recognised head token (measured — see
 * the differential pins in the test file). It is NOT a universal
 * monotonicity guarantee (round-2 review, measured): when the
 * continuation closes on a WRAPPER'S glued flag token, the peel resumes
 * at that wrapper's next ARGUMENT (a positional like timeout's
 * duration, or a second flag), which is neither head nor wrapper, so
 * the segment comes back unchanged where the pre-continuation peel
 * completed — e.g. `A='x timeout --signal=INT' 5 git push` matched on
 * master and does not here. Every found member of that class (550 of
 * 41,440 adversarial cases) is a MASTER FALSE POSITIVE, PATH-shim-
 * verified: bash treats the quoted run as one assignment word and then
 * executes the next word (`5`, `-e0`), never the gated verb — 110 are
 * outright `bash -n` syntax errors — so no gated invocation is lost and
 * this side is the more bash-accurate one; the class is pinned in the
 * test file so it cannot silently widen. The honest cost of the guard,
 * measured and named rather than implied: a quoted VALUE containing the
 * literal word `git`/`gh`/`npm`/`harness` as its own token
 * (`VAR='a git b' git push`) is not continued — the pre-task consume
 * applies, byte-identical to master's behaviour, so nothing regresses.
 * The guard checks EXACT head spellings only: a path-qualified head
 * glued to the closing quote (`VAR='a /usr/bin/git' git push` — the
 * token is `/usr/bin/git'`, which GIT_TOKEN_RE rejects) is NOT
 * abandoned, the continuation completes, and the REAL invocation behind
 * it now matches — a measured fail-closed gain over master, also
 * pinned.
 */
function consumeAssignment(tokens: Token[], idx: number): number {
  let state: "" | "'" | '"' = "";
  let escaped = false;
  for (let i = idx; i < tokens.length; i++) {
    const text = tokens[i]!.text;
    if (i > idx && (GIT_TOKEN_RE.test(text) || NON_GIT_HEAD_TOKENS.has(text))) {
      return idx + 1;
    }
    for (let k = 0; k < text.length; k++) {
      const c = text[k]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (state === "'") {
        if (c === "'") state = "";
        continue;
      }
      if (state === '"') {
        if (c === "\\") escaped = true;
        else if (c === '"') state = "";
        continue;
      }
      if (c === "\\") escaped = true;
      else if (c === "'" || c === '"') state = c;
    }
    // A backslash pending at a token's end would escape the separating
    // whitespace itself — b093911d's class, not continued here.
    escaped = false;
    if (state === "") return i + 1;
  }
  // Ran out of tokens with a quote still open: unterminated. Preserve the
  // pre-task behaviour exactly (consume only the assignment's first token).
  return idx + 1;
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
 * for an invocation of one of the closed head-token set's four members
 * (`git`, `gh`, `npm`, `harness` — D-001, run
 * 2026-07-28-nongit-trigger-wrappers), and — ONLY if one is found —
 * canonicalise it. `git` is canonicalised to `git <subcommand>` with its
 * OWN global options dropped, same as before this run. The other three
 * are canonicalised by wrapper peeling plus whitespace collapsing across
 * the REST OF THE SEGMENT (fix round 2, finding F2 — rejoining every
 * token from the head onward with a single space, not just the head-to-
 * next-token gap), no option-dropping (see the module header). When no
 * recognised head token is found (wrong binary, ran out of tokens, or a
 * malformed git global option), the segment is returned COMPLETELY
 * UNCHANGED: peeling is tentative, and nothing is stripped from a
 * segment that turns out not to be a recognised call (so `digit=1 foo`,
 * `env -C X ls`, `ghx pr merge`, etc. are never touched).
 */
function canonicalizeSegment(segmentText: string): {
  text: string;
  targetDir: string | null;
  targetBase: string | null;
  /**
   * D-017 (fix round 2, run 2026-08-02-per-repo-gate-scoping-redesign):
   * this segment's own REPO-RELOCATING target only — `-C` / `--git-dir`
   * (or the same invocation's wrapping `env -C` / `--chdir`), NEVER
   * `--work-tree`. Consumed by `computeSegmentTarget` for `ownTarget` /
   * `effectiveTarget` instead of `targetDir` above (which stays the OLD,
   * unconsumed aggregate's extraction, `--work-tree` included, unchanged
   * by this fix). `null` under the exact same conditions `targetDir`
   * would be, MINUS the `--work-tree`-only case, which is `null` here
   * even when `targetDir` captured it.
   */
  identityTargetDir: string | null;
  /** Same relationship to `targetBase` that `identityTargetDir` has to `targetDir`. */
  identityTargetBase: string | null;
  isGit: boolean;
} {
  const tokens = tokenizeWithOffsets(segmentText);
  if (tokens.length === 0) {
    return {
      text: segmentText,
      targetDir: null,
      targetBase: null,
      identityTargetDir: null,
      identityTargetBase: null,
      isGit: false,
    };
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
      idx = consumeAssignment(tokens, idx);
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
  if (headTok === undefined) {
    return {
      text: segmentText,
      targetDir: null,
      targetBase: null,
      identityTargetDir: null,
      identityTargetBase: null,
      isGit: false,
    };
  }

  if (GIT_TOKEN_RE.test(headTok)) {
    idx += 1; // consume the git token (whatever spelling matched GIT_TOKEN_RE)

    const gitOpts = peelGitGlobalOptions(tokens, idx);
    if (gitOpts.malformed || gitOpts.idx >= tokens.length) {
      // Malformed global option (missing required value) or no subcommand
      // token left: nothing safe to canonicalise. Leave untouched.
      return {
        text: segmentText,
        targetDir: null,
        targetBase: null,
        identityTargetDir: null,
        identityTargetBase: null,
        isGit: false,
      };
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
    // D-017: the identity pair mirrors targetDir/targetBase's composition
    // exactly, but is fed by `relocateTargetDir` (repo-relocating flags
    // only — `-C`/`--git-dir`, never `--work-tree`) instead of
    // `gitOpts.targetDir` (which still includes `--work-tree`).
    //
    // D-018 (fix round 3): a same-invocation wrapping `env -C`/`--chdir`
    // PLUS the git invocation's OWN absolute repo-relocating flag are two
    // repo-relocating options on one invocation, the same "more than one"
    // class `noteRelocatingOption` (in `peelGitGlobalOptions`) closes for
    // git's own flags — extended here across the `env -C` wrap. When they
    // diverge (different resolved directories), git's own flag DOES
    // deterministically win in reality, but this module deliberately does
    // not encode that composition rule (`computeSegmentTarget`'s own
    // comment on why path composition is out of scope) — `null` (cwd
    // fallback, D-003) rather than keep preferring git's own flag as
    // before this fix. An identical pair (`env -C X git -C X ...`) is the
    // same idempotent-repeat allowance as `noteRelocatingOption`'s single-
    // function case, so it stays `X`, not `null`. The pre-existing
    // RELATIVE-own-target + env-base mix is untouched by this check —
    // `identityTargetBase` below already resolves that class fully to
    // `null` via `computeSegmentTarget`'s early return; this new check
    // only has any effect when `gitOpts.relocateTargetDir` is ABSOLUTE
    // (`path.isAbsolute` guards it out for the relative case, the same
    // condition `identityTargetBase` below already uses).
    const relocateEnvDiverges =
      gitOpts.relocateTargetDir !== null &&
      envTargetDir !== null &&
      path.isAbsolute(gitOpts.relocateTargetDir) &&
      gitOpts.relocateTargetDir !== envTargetDir;
    const identityTargetDir = relocateEnvDiverges
      ? null
      : (gitOpts.relocateTargetDir ?? envTargetDir);
    const identityTargetBase =
      gitOpts.relocateTargetDir !== null &&
      envTargetDir !== null &&
      !path.isAbsolute(gitOpts.relocateTargetDir)
        ? envTargetDir
        : null;
    return {
      text: rewritten,
      targetDir,
      targetBase,
      identityTargetDir,
      identityTargetBase,
      isGit: true,
    };
  }

  if (NON_GIT_HEAD_TOKENS.has(headTok)) {
    // D-001 + fix round 2 (finding F2): `gh` / `npm` / `harness` get
    // wrapper peeling (already applied above, same loop as `git`'s) plus
    // whitespace collapsing ACROSS THE REST OF THE SEGMENT — rejoining
    // every token from the head token onward with exactly one space
    // between each. The original scope (collapse only between the head
    // token and the SINGLE token immediately following it) left an
    // INTERIOR whitespace run further into a multi-word trigger able to
    // defeat the match: `gh pr  merge` (double space between `pr` and
    // `merge`, not `gh` and `pr`), `gh pr<TAB>merge`, `gh pr  create`.
    // Full-segment rejoin closes any such run anywhere after the head,
    // not just immediately after it. Safe because this is additive-only
    // matching (raw-OR-normalised, module header) and byte-identity is an
    // acceptance criterion only for heads NOT in this set (see the
    // byte-identity negative tests below) — a RECOGNISED head's own tail
    // may be freely rewritten. Still no option-dropping (`gh -R`, `npm
    // --loglevel`, etc. stay unsupported — module header): a tool-specific
    // flag between the head and its subcommand still isn't recognised or
    // skipped, it just no longer needs an interior whitespace run to
    // survive the rejoin. `targetDir`/`targetBase` stay `null`: these are
    // never git invocations, so no per-invocation target is extracted for
    // them (unaffected by the STATUS note above — that extraction was
    // never wired to a gate either way).
    if (idx + 1 >= tokens.length) {
      // Head token alone, no further token to canonicalise toward — no
      // shipped trigger matches a bare head token anyway, and rewriting to
      // just the head would silently drop whatever wrapper preceded it for
      // no benefit. Leave untouched, same fail-safe shape as the git
      // malformed/no-subcommand case above.
      return {
        text: segmentText,
        targetDir: null,
        targetBase: null,
        identityTargetDir: null,
        identityTargetBase: null,
        isGit: false,
      };
    }
    const rewritten = tokens
      .slice(idx)
      .map((t) => t.text)
      .join(" ");
    return {
      text: rewritten,
      targetDir: null,
      targetBase: null,
      identityTargetDir: null,
      identityTargetBase: null,
      isGit: false,
    };
  }

  return {
    text: segmentText,
    targetDir: null,
    targetBase: null,
    identityTargetDir: null,
    identityTargetBase: null,
    isGit: false,
  };
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
      idx = consumeAssignment(tokens, idx);
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
 * parsing continues past it) as `targetDir` — the OLD, UNCONSUMED
 * aggregate's own extraction (module header STATUS note), UNCHANGED by
 * the fix below. `malformed: true` means a value-requiring option was
 * missing its value — the caller bails without rewriting rather than
 * guess.
 *
 * `relocateTargetDir` (D-017, fix round 2, run `2026-08-02-per-repo-
 * gate-scoping-redesign`): a SEPARATE tracker, fed ONLY by the
 * repo-relocating flags `-C` and `--git-dir` — NEVER `--work-tree`.
 * `--work-tree` sets the working tree but does NOT relocate git's
 * `--git-dir` search; `git push`/`log`/`status` under `--work-tree=<B>`
 * alone still operate on whatever repo the CURRENT directory (or an
 * actual `-C`/`--git-dir`) names, not `<B>`. Pass-2 review measured this
 * as a live cross-repo fail-open once `--work-tree` was folded into the
 * same `targetDir` bucket as `-C`/`--git-dir` and that bucket fed
 * `CommandSegment.ownTarget`'s REPLACE attribution (`computeSegmentTarget`
 * below, `src/runtime/intercept.ts`'s `resolveAttributedContexts`,
 * D-011): `git --work-tree=<B> push`, cwd = A, was attributed to B alone,
 * dropping the cwd demand a real `git push` there still has to satisfy.
 * `relocateTargetDir` is what `computeSegmentTarget` now consults for a
 * git segment's `ownTarget` — see that function and `canonicalizeSegment`
 * below. Kept as a distinct field (a whitelist of repo-relocating flags),
 * not a `--work-tree` special-case, so a future path-valued-but-repo-
 * neutral git global option cannot silently reopen this class by being
 * folded into `targetDir` the way `--work-tree` originally was.
 *
 * D-018 (fix round 3, pass-3 CRITICAL): `relocateTargetDir` is set ONLY
 * when the invocation carries EXACTLY ONE recognised, fully-resolved
 * repo-relocating option (a single `-C` or a single `--git-dir`/
 * `--git-dir=`). Pass-3 review measured (against real git 2.34.1) that
 * `git -C <forge> -C <realA> push` attributes to the FIRST `-C` here
 * while git composes ALL of them cumulatively and actually operates in
 * `<realA>` — the same first-token-wins gap spans `-C` combined with
 * `--git-dir`. `noteRelocatingOption` below counts every RESOLVED
 * (non-`~`) occurrence of either flag across the whole invocation; the
 * second (or later) occurrence forces `relocateTargetDir` to `null` and
 * LOCKS it there for the rest of this call — UNLESS its value is an
 * exact repeat of the one already recorded (idempotent, e.g. `-C X -C
 * X`), which is not new information and does not trigger the lock. This
 * is a deliberate under-approximation of git's real `-C`-chains-relative-
 * to-the-previous-`-C` composition rule (the module has never encoded
 * that, by design — see `computeSegmentTarget`'s own comment on why
 * composing paths is not this module's job): ANY invocation this module
 * cannot resolve to a single, unambiguous flag falls back to `null` here,
 * which downstream (`computeSegmentTarget`) means "no own target" and the
 * cwd context is demanded instead — exactly the shipped, pre-this-run
 * semantics, never a forged first-token guess.
 */
function peelGitGlobalOptions(
  tokens: Token[],
  startIdx: number,
): { idx: number; targetDir: string | null; relocateTargetDir: string | null; malformed: boolean } {
  let idx = startIdx;
  let targetDir: string | null = null;
  let relocateTargetDir: string | null = null;
  let relocateResolvedCount = 0;
  let relocateAmbiguous = false;

  // D-018: record one repo-relocating flag's resolved value (`null` for a
  // `~`-prefixed value, which — same as the pre-fix code — never sets or
  // counts against `relocateTargetDir` at all, D-003's "treated as if
  // absent"). The SECOND (or later) resolved occurrence nulls and LOCKS
  // `relocateTargetDir`, unless it is an exact repeat of the value
  // already recorded (idempotent, e.g. `-C X -C X` or `-C X --git-dir
  // X/.git`), which stays a single value rather than tripping the lock —
  // "im Zweifel null" still applies to every OTHER two-or-more case.
  function noteRelocatingOption(resolved: string | null): void {
    if (resolved === null) return;
    relocateResolvedCount += 1;
    if (relocateAmbiguous) return;
    if (relocateResolvedCount === 1) {
      relocateTargetDir = resolved;
      return;
    }
    if (resolved === relocateTargetDir) return; // idempotent repeat
    relocateTargetDir = null;
    relocateAmbiguous = true;
  }

  while (idx < tokens.length) {
    const t = tokens[idx]!.text;
    if (t === "-C") {
      const dir = tokens[idx + 1]?.text;
      if (dir === undefined) return { idx, targetDir, relocateTargetDir, malformed: true };
      if (targetDir === null && !isTildeTarget(dir)) targetDir = dir;
      noteRelocatingOption(isTildeTarget(dir) ? null : dir);
      idx += 2;
      continue;
    }
    if (t === "-c") {
      if (tokens[idx + 1] === undefined) return { idx, targetDir, relocateTargetDir, malformed: true };
      idx += 2;
      continue;
    }
    if (t === "--git-dir") {
      const dir = tokens[idx + 1]?.text;
      if (dir === undefined) return { idx, targetDir, relocateTargetDir, malformed: true };
      if (targetDir === null && !isTildeTarget(dir)) targetDir = parentIfDotGit(dir);
      noteRelocatingOption(isTildeTarget(dir) ? null : parentIfDotGit(dir));
      idx += 2;
      continue;
    }
    if (t.startsWith("--git-dir=")) {
      const dir = t.slice("--git-dir=".length);
      if (targetDir === null && !isTildeTarget(dir)) targetDir = parentIfDotGit(dir);
      noteRelocatingOption(isTildeTarget(dir) ? null : parentIfDotGit(dir));
      idx += 1;
      continue;
    }
    if (t === "--work-tree") {
      // D-017: `--work-tree` still feeds the OLD `targetDir` aggregate
      // (unchanged, unconsumed by any gate) but deliberately NEVER
      // `relocateTargetDir` — see this function's own doc comment.
      const dir = tokens[idx + 1]?.text;
      if (dir === undefined) return { idx, targetDir, relocateTargetDir, malformed: true };
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
      if (tokens[idx + 1] === undefined) return { idx, targetDir, relocateTargetDir, malformed: true };
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
  return { idx, targetDir, relocateTargetDir, malformed: false };
}
