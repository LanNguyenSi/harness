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
//   - The matcher itself refuses chaining (`;`, `&`, `|`, `&&`, `||`),
//     redirection (`<`, `>`), and command substitution (backticks,
//     `$(...)`), so a compound command cannot ride a legitimate commit
//     past the gate. It also fails closed on any flag it does not
//     recognise, in particular `--amend` (rewrites a commit that may
//     have been approved under an entirely different, unrelated
//     window) and `--no-verify` (skips local hooks, which this
//     exemption has no mandate to waive — see AGENTS.md "no
//     workarounds").

/** Metacharacters that make the whole command unclassifiable. */
const COMMAND_META_RE = /[;&|<>]/;

/** Flags that take no following value. */
const FLAG_ONLY_TOKENS: ReadonlySet<string> = new Set(["-a", "--all", "--allow-empty"]);

/**
 * Flags that consume the NEXT token as their value. `-am`/`-ma` are the
 * common combined `-a -m` shorthand; each still takes one message
 * argument. Multiple `-m`/`--message` occurrences are allowed (git
 * concatenates them as separate paragraphs — the idiomatic way to
 * express a subject line, a body, and a trailer such as
 * `Co-Authored-By:` without embedding a literal newline in one token).
 */
const MESSAGE_FLAG_TOKENS: ReadonlySet<string> = new Set(["-m", "--message", "-am", "-ma"]);

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
 * `-a`/`--all`/`--allow-empty` and one or more `-m`/`--message`/`-am`/`-ma`
 * message flags. `true` means the understanding-gate PreToolUse hooks
 * may admit this ONE call without a fresh Understanding Report, provided
 * the caller has already established that this session/task had a real
 * (now-expired) operator approval — see module header for the full
 * safety argument and why that precondition is load-bearing.
 *
 * Anything not on this narrow shape — `--amend`, `--no-verify`, `-C
 * <dir>` (rejected implicitly: it does not appear directly after `git
 * commit`), a pathspec, chaining, redirection, substitution, an
 * unrecognised flag — fails closed (`false`) and the caller falls
 * through to the ordinary hard block.
 */
export function isRecoveryGitCommit(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed === "") return false;
  if (trimmed.includes("\n") || trimmed.includes("\r")) return false;
  if (COMMAND_META_RE.test(trimmed)) return false;
  if (trimmed.includes("`") || trimmed.includes("$(")) return false;

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
      i += 1; // consume the message token (already metachar-screened above)
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
