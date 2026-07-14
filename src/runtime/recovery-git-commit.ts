// Recovery git-commit exemption for the understanding-gate PreToolUse
// hooks (task 6e888423).
//
// The problem: `approval_lifecycle.max_age` (default 4h, see
// src/cli/init/templates.ts) expires the operator-approval MARKER
// independently of any task-completion boundary. That is by design for
// genuinely new work — a session idle for hours should re-justify itself
// before its next Edit/Write/Bash. But it also fires mid-task, e.g. while
// an agent is deep in a reviewer-amendment loop (apply fixes, wait on CI,
// iterate again) that outlives the window. When the marker ages out at
// exactly the moment the agent needs to run the recovery `git commit`
// that consolidates already-approved Edit/Write output into a new HEAD
// (so `preflight` / solution-acceptance can re-pin their verdict there),
// the gate hard-blocks that Bash call — including the recovery commit
// itself — and only the operator can unblock it (agent-grounding
// frictions #2/#9/#58/#71).
//
// The fix is narrow on purpose. A `git commit` records whatever is
// ALREADY sitting in the working tree; it introduces no new file
// content. Every byte in that working tree was necessarily produced by
// an Edit/Write/Bash call that was itself gated at the time it ran, so
// letting a bare, unchained `git commit` through does not let unreviewed
// content sneak past the Understanding Gate — it only lets the agent
// finish recording work that was already approved once. This is
// deliberately NOT a blanket "any Bash whitelist" or "ignore
// max_age" fix:
//   - The caller (hook-pre-tool-use.ts / hook-codex-pre-tool-use.ts)
//     gates this classifier behind `expired === true` from
//     `checkOperatorApprovalMarkers` — i.e. a real operator-written
//     marker for THIS session/task existed and simply aged past
//     max_age. A session that was NEVER approved (marker absent) gets
//     no exemption: `isRecoveryGitCommit` alone is not a bypass, it
//     only matters once the caller has already proven prior approval.
//   - A marker CLEARED by a task-completion boundary tool
//     (`task_finish`, `pull_requests_merge`, ...) reads as "missing",
//     not "expired" (`clearApprovalMarker` deletes the file rather than
//     leaving a stale one behind). The exemption therefore does not
//     fire for a fresh task's first commit — the gate still re-arms
//     exactly as `approval_lifecycle` intends.
//   - Edit / Write and every other Bash shape stay hard-gated
//     regardless of this exemption; only the exact `git commit`
//     invocation classified below is admitted.
//   - The matcher refuses chaining (`;`, `&`, `|`, `&&`, `||`) and
//     redirection (`<`, `>`) that appear OUTSIDE a quoted span, and
//     command substitution (backtick, `$(...)`) that appears outside a
//     quote OR inside a DOUBLE-quoted span (both are still expanded by
//     bash there) — so a compound command cannot ride a legitimate
//     commit past the gate. `;`/`&`/`|`/`<`/`>` are treated as literal
//     when they appear inside a quoted span (single OR double), exactly
//     as bash treats them: this is what lets a real commit-message
//     trailer like `Co-Authored-By: Claude Fable 5
//     <noreply@anthropic.com>` (this very repo's own commit convention)
//     through a quoted `-m` value without opening a metachar hole,
//     because git only ever sees the trailer as inert message text, not
//     as shell syntax. A backtick or `$(` inside a SINGLE-quoted span is
//     also literal (single quotes suppress all expansion) and therefore
//     safe to admit. Newlines are rejected unconditionally regardless of
//     quoting (see `isRecoveryGitCommit`): multiple `-m` flags are the
//     supported shape for a multi-paragraph message, so no caller needs
//     an embedded newline inside one quoted token. The matcher also
//     fails closed on any flag it does not recognise, in particular
//     `--amend` (rewrites a commit that may have been approved under an
//     entirely different, unrelated window) and `--no-verify` (skips
//     local hooks, which this exemption has no mandate to waive — see
//     AGENTS.md "no workarounds").
//   - ANY backslash in the command rejects the whole thing outright, in
//     `isRecoveryGitCommit` before the quote-aware scan even runs. The
//     quote-toggling in `hasUnsafeMetachar`/`tokenize` has no concept of
//     backslash-escaping, so a payload like `git commit -am a\" ; echo
//     INJECTED ; \"` was, for one commit on this branch, misclassified
//     as a single safely-quoted message — the classifier "entered" a
//     phantom quote span at the escaped `"` and read the live `;` inside
//     it as literal text, while bash itself never entered a quote at all
//     and executed `echo INJECTED` as a separate command (confirmed
//     end-to-end for `;`, `||`, and `|`). Rejecting every backslash
//     up front closes the whole escape-based attack surface: without a
//     backslash present, naive quote-toggling matches bash's real
//     quoting exactly. A hand-rolled bash-accurate escape state machine
//     is deliberately NOT built here — too risky for a security boundary
//     to get subtly wrong twice.

/** Flags that take no following value. */
const FLAG_ONLY_TOKENS: ReadonlySet<string> = new Set(["-a", "--all", "--allow-empty"]);

/**
 * Flags that consume the NEXT token as their value. `-am` is the common
 * combined `-a -m` shorthand — the LAST flag in a short-option cluster is
 * the one that takes an argument, so `-am <value>` clusters to `-a` (no
 * value) followed by `-m <value>` exactly like a real shell/getopt would
 * parse it. `-ma` is deliberately NOT included: there `-m` is NOT last in
 * the cluster, so getopt takes the cluster's OWN remainder ("a") as `-m`'s
 * value and the flag `-a` is never set at all — the next token (the
 * agent's intended message) would be consumed by git as a pathspec
 * instead, silently restricting the commit to files matching that
 * pathspec. Admitting `-ma` here would therefore misclassify a command
 * whose ACTUAL git semantics differ from what this exemption assumes.
 * Multiple `-m`/`--message` occurrences are allowed (git concatenates
 * them as separate paragraphs — the idiomatic way to express a subject
 * line, a body, and a trailer such as `Co-Authored-By:` without embedding
 * a literal newline in one token).
 */
const MESSAGE_FLAG_TOKENS: ReadonlySet<string> = new Set(["-m", "--message", "-am"]);

/**
 * Quote-aware scan for shell metacharacters that are unsafe given WHERE
 * they appear. Unlike a flat regex, this walks the string tracking
 * whether we are inside a single-quoted span, a double-quoted span, or
 * neither:
 *   - Outside any quote: `;`, `&`, `|`, `<`, `>`, backtick, and `$(` are
 *     all live shell syntax — any of them is unsafe.
 *   - Inside a single-quoted span: everything is inert (bash disables
 *     ALL expansion inside single quotes, including backtick and `$(`),
 *     so nothing here is unsafe.
 *   - Inside a double-quoted span: `;`, `&`, `|`, `<`, `>` are literal
 *     characters (bash does NOT treat them specially inside double
 *     quotes) and therefore safe, but backtick and `$(` are STILL
 *     expanded by bash inside double quotes and therefore still unsafe.
 * An unterminated quote (the scan ends still "inside" one) is itself
 * unsafe: the caller's tokenizer performs the authoritative parse and
 * would also reject it, but this scan must not silently pass through
 * content it could not fully account for.
 */
function hasUnsafeMetachar(command: string): boolean {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue; // single-quoted: fully inert, including ` and $(
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
        continue;
      }
      if (ch === "`") return true;
      if (ch === "$" && command[i + 1] === "(") return true;
      continue; // ; & | < > are literal inside double quotes
    }
    // Outside any quote: every metacharacter is live.
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ";" || ch === "&" || ch === "|" || ch === "<" || ch === ">") return true;
    if (ch === "`") return true;
    if (ch === "$" && command[i + 1] === "(") return true;
  }
  return quote !== null; // unterminated quote: unsafe/unparseable
}

/**
 * Quote-aware tokenizer for the residual argv after `git commit`, mimicking
 * plain shell word-splitting: a "word" runs until unquoted whitespace, and a
 * quoted region (single OR double quotes) within a word contributes its
 * literal contents to that same word, quotes stripped. This is what lets
 * both the standalone-token shape (`-m "a message"`) and the glued shape
 * (`--message="a message"`, where the shell concatenates the flag prefix
 * and the quoted value into ONE argv word) tokenize the same way a real
 * shell would. An unterminated quote fails the parse (`null`); the caller
 * treats that as "not a recognised recovery commit" and falls through to
 * the ordinary gate block rather than guessing at the intended word.
 */
function tokenize(rest: string): string[] | null {
  const tokens: string[] = [];
  const n = rest.length;
  let i = 0;
  while (i < n) {
    while (i < n && /\s/.test(rest[i]!)) i += 1;
    if (i >= n) break;
    let token = "";
    while (i < n && !/\s/.test(rest[i]!)) {
      const ch = rest[i]!;
      if (ch === '"' || ch === "'") {
        const close = rest.indexOf(ch, i + 1);
        if (close === -1) return null;
        token += rest.slice(i + 1, close);
        i = close + 1;
        continue;
      }
      token += ch;
      i += 1;
    }
    tokens.push(token);
  }
  return tokens;
}

/**
 * Classify a Bash/shell command string as the narrow "recovery commit"
 * shape: a bare, unchained `git commit` invocation carrying only
 * `-a`/`--all`/`--allow-empty` and one or more `-m`/`--message`/`-am`
 * message flags. `true` means the understanding-gate PreToolUse hooks
 * may admit this ONE call without a fresh Understanding Report, provided
 * the caller has already established that this session/task had a real
 * (now-expired) operator approval — see module header for the full
 * safety argument and why that precondition is load-bearing.
 *
 * A properly single- or double-quoted `-m`/`--message` value may contain
 * ANY text, including characters like `<`/`>`/`;`/`&`/`|` that would be
 * dangerous unquoted — that is what lets a real trailer such as
 * `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` through (see
 * `hasUnsafeMetachar`'s doc for the exact quote-aware rule). Anything
 * outside this narrow shape — `--amend`, `--no-verify`, `-C <dir>`
 * (rejected implicitly: it does not appear directly after `git commit`),
 * a pathspec, UNQUOTED chaining/redirection, command substitution that
 * is live where it appears, an unrecognised flag — fails closed
 * (`false`) and the caller falls through to the ordinary hard block.
 */
export function isRecoveryGitCommit(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed === "") return false;
  if (trimmed.includes("\n") || trimmed.includes("\r")) return false;
  // CRITICAL (found on re-review of the quote-aware rewrite): reject ANY
  // backslash before doing anything else. `hasUnsafeMetachar` and
  // `tokenize` both toggle quote state on every `"`/`'` character with no
  // concept of backslash-escaping, but bash does: `\"` outside a quote is
  // a LITERAL `"` that does NOT open a quote context. Without this
  // check, a payload like `git commit -am a\" ; echo INJECTED ; \"` gets
  // classified as one big safely-quoted message (the classifier "enters"
  // a phantom quote span at the escaped `"` and treats the live `;`
  // inside it as literal), while bash itself never entered a quote at
  // all and executes `echo INJECTED` as a separate command — confirmed
  // end-to-end (classifier ADMIT + a live shell actually running the
  // injected command) for `;`, `||`, and `|` riding this exact shape.
  // Same bug class the 0.40.0 CHANGELOG already documents once for the
  // `harness approve` heredoc matcher (a backslash-escaped redirect
  // smuggled past a quote-blind check there too).
  //
  // The fix is deliberately blunt rather than a full escape-aware state
  // machine: modeling bash's actual backslash rules (live outside
  // quotes and inside double quotes for a few characters, entirely inert
  // inside single quotes, `$'...'` ANSI-C quoting has its own escape
  // grammar again) is exactly the kind of bash-parser-in-miniature this
  // module's design explicitly avoids building for a security boundary.
  // Without any backslash present, the naive quote-toggling in
  // `hasUnsafeMetachar`/`tokenize` matches bash's real quoting exactly,
  // so rejecting every backslash closes the whole escape-based attack
  // surface at the cost of not admitting messages that happen to contain
  // one — an acceptable narrowing (the documented main case, this repo's
  // own `Co-Authored-By: ... <noreply@anthropic.com>` trailer, has no
  // backslash) for a fail-closed exemption gate.
  if (trimmed.includes("\\")) return false;
  if (hasUnsafeMetachar(trimmed)) return false;

  const m = /^git\s+commit\b/.exec(trimmed);
  if (!m) return false;
  const rest = trimmed.slice(m[0].length);
  const tokens = tokenize(rest);
  if (tokens === null) return false;

  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (FLAG_ONLY_TOKENS.has(t)) {
      i += 1;
      continue;
    }
    if (MESSAGE_FLAG_TOKENS.has(t)) {
      i += 1;
      if (i >= tokens.length) return false; // dangling flag, no message value
      i += 1; // consume the message token (already quote-aware metachar-screened above)
      continue;
    }
    if (/^--message=.+/.test(t)) {
      i += 1;
      continue;
    }
    // Unrecognised token (e.g. --amend, --no-verify, a pathspec, an
    // unknown flag): fail closed.
    return false;
  }
  return true;
}
