import { describe, expect, it } from "vitest";
import { isRecoveryGitCommit } from "../../src/runtime/recovery-git-commit.js";

/**
 * This repo's own commit convention (AGENTS.md / CLAUDE.md): every commit
 * message ends with this exact trailer. It contains `<`/`>` (the email
 * angle brackets GitHub attribution needs) — a real-world case the
 * quote-aware metachar scan MUST admit when it appears inside a properly
 * quoted `-m` value (review finding HIGH, task 6e888423).
 */
const REAL_TRAILER = "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>";

describe("isRecoveryGitCommit (task 6e888423)", () => {
  describe("admits the narrow recovery-commit shape", () => {
    it.each([
      "git commit",
      "git commit -a",
      "git commit --all",
      "git commit --allow-empty",
      `git commit -m "fix(x): recovery commit"`,
      `git commit -m 'fix(x): recovery commit'`,
      `git commit -am "fix(x): recovery commit"`,
      `git commit --message="fix(x): recovery commit"`,
      `git commit --all --message="fix(x): recovery commit"`,
      `git commit --allow-empty -m "fix(x): recovery commit"`,
      // Multiple -m paragraphs (subject, body, trailer) — the idiomatic
      // way to express a multi-paragraph message without embedding a
      // literal newline in one token.
      `git commit -m "subject line" -m "body paragraph" -m "Co-Authored-By: Claude Fable 5"`,
      // Extra whitespace between `git` and `commit`.
      "git  commit  -a",
      // --- HIGH fix (review): a quoted -m value may contain `<`/`>`/`;`/
      // `&`/`|` — bash treats them as literal text inside quotes, so
      // rejecting them there was an effectiveness gap, not a safety
      // margin. This is THE documented main case: the real
      // Co-Authored-By trailer, single-line via -m and via -am, double-
      // and single-quoted. ---
      `git commit -m "fix: recovery commit ${REAL_TRAILER}"`,
      `git commit -am "fix: recovery commit ${REAL_TRAILER}"`,
      `git commit -m 'fix: recovery commit ${REAL_TRAILER}'`,
      // Multi -m form carrying the real trailer as its own paragraph —
      // the supported multi-paragraph shape (subject, body, trailer).
      `git commit -m "fix: address reviewer feedback" -m "${REAL_TRAILER}"`,
      // The trailer glued via --message= (shell concatenates the flag
      // prefix and the quoted value into one word).
      `git commit --message="fix: recovery commit ${REAL_TRAILER}"`,
      // A literal `;`/`&`/`|` inside a quoted value is inert text, same
      // reasoning as `<`/`>`.
      `git commit -m "fix(x): a; b & c | d"`,
      // Backtick / $( inside a SINGLE-quoted value are inert (single
      // quotes suppress ALL bash expansion) — safe to admit.
      `git commit -m 'literal backtick \` and literal $( are inert here'`,
    ])("allows %s", (cmd) => {
      expect(isRecoveryGitCommit(cmd)).toBe(true);
    });
  });

  describe("fails closed on anything outside the narrow shape", () => {
    it.each([
      // Not a commit at all.
      "git status",
      "git push origin master",
      "git commitish", // must not match on a `git commit`-prefixed word
      "gitcommit",
      // History-rewriting / hook-skipping flags: deliberately excluded
      // (see module header for why).
      "git commit --amend",
      `git commit --amend -m "oops"`,
      `git commit -m "msg" --no-verify`,
      "git commit --no-verify",
      // Repo/dir redirection before `commit`: does not match the
      // `^git\s+commit\b` anchor at all.
      "git -C /other/repo commit -m 'msg'",
      "git --git-dir=/other/.git commit -m 'msg'",
      // Pathspec / unrecognised positional operand.
      "git commit -- src/index.ts",
      "git commit src/index.ts",
      // Dangling message flag with no value.
      "git commit -m",
      "git commit --message=",
      // Unterminated quoting.
      `git commit -m "unterminated`,
      // --- LOW 2 fix (review): `-ma` is NOT the same as `-am`. getopt
      // clustering makes the LAST flag in a short-option cluster the one
      // that consumes the next argv token as its value; `-m` is not last
      // in `-ma`, so it takes the cluster's own remainder ("a") as its
      // value and `-a` is never set. The next token (the agent's
      // intended message) would be consumed by git as a pathspec
      // instead. Must stay rejected. ---
      `git commit -ma "fix(x): recovery commit"`,
      // --- HIGH fix boundary: metachars are safe ONLY inside a quoted
      // span. The same characters UNQUOTED (or straddling outside a
      // quote) must still reject — this is the negative control for the
      // relaxation above. ---
      `git commit -m "safe message" ; rm -rf /`,
      `git commit -m "msg"; rm -rf /`,
      `git commit -m "msg" && rm -rf /`,
      `git commit -m "msg" | tee /tmp/x`,
      `git commit -m "safe message" > /tmp/out`,
      `git commit -m "safe message" < /tmp/in`,
      "git commit -m `whoami`",
      `git commit -m "$(whoami)"`,
      // Backtick / $( are still live INSIDE double quotes (bash expands
      // them there), unlike inside single quotes.
      `git commit -m "literal backtick \` is NOT inert here"`,
      `git commit -m "danger: $(whoami)"`,
      "git commit -m msg > /tmp/out",
      "git commit -m msg < /tmp/in",
      // A quote that closes, then more metachars appear UNQUOTED after
      // it — the "inside a quote" carve-out must not leak past the
      // closing quote.
      `git commit -m "safe" ${"`"}whoami${"`"}`,
      // Multi-line command (heredoc-ish smuggling attempt). Newlines are
      // rejected unconditionally regardless of quoting — multiple -m
      // flags are the supported multi-paragraph shape, so a heredoc-style
      // multi-line message (even carrying the real trailer) is out of
      // scope by design, not a residual bug.
      "git commit -m \"msg\"\ngit push",
      `git commit -F - <<'EOF'\nsubject\n\n${REAL_TRAILER}\nEOF`,
      "",
      "   ",
    ])("rejects %s", (cmd) => {
      expect(isRecoveryGitCommit(cmd)).toBe(false);
    });
  });

  describe("CRITICAL — backslash-escaped quote must not open a phantom quote span (found on re-review of commit 872c9a6)", () => {
    // hasUnsafeMetachar/tokenize toggle quote state on every raw `"`/`'`
    // character with no concept of backslash-escaping. Bash treats `\"`
    // OUTSIDE a quote as a LITERAL `"` that does NOT open a quote
    // context — so `a\"` is just the two characters `a"`, not the start
    // of a quoted span. Before the backslash guard, the classifier
    // "entered" a phantom double-quote span at the escaped `"`, which
    // made it treat the live `;`/`||`/`|` that followed as literal text
    // (the "safe inside quotes" rule), while bash itself never entered a
    // quote at all and ran the injected command as a separate statement.
    // Confirmed end-to-end (classifier ADMIT + a real shell actually
    // executing the injected `echo`) for all three control operators
    // below, reachable exactly at `markerExpired === true` — the state
    // where the gate is supposed to hard-block everything.
    it.each([
      // The three payloads verified live to execute `echo INJECTED`
      // against 872c9a6 (git commit -am a" ; echo INJECTED ; " et al.,
      // written with escaped quotes so the JS string carries a literal
      // backslash).
      'git commit -am a\\" ; echo INJECTED ; \\"',
      'git commit -am a\\" || echo INJECTED \\"',
      'git commit -am a\\" | echo INJECTED \\"bar',
      // Same class via a backslash-escaped SINGLE quote.
      "git commit -am a\\' ; echo INJECTED ; \\'",
      // A backslash anywhere at all — not just adjacent to a quote — is
      // rejected outright, per the minimal fix (fail closed on any `\`
      // rather than modeling bash's escape grammar).
      'git commit -m "safe message with a literal \\\\ backslash"',
    ])("rejects %s (would otherwise admit live shell injection)", (cmd) => {
      expect(isRecoveryGitCommit(cmd)).toBe(false);
    });

    it("the real recovery-commit trailer (no backslash) still converges after the backslash guard", () => {
      expect(
        isRecoveryGitCommit(
          `git commit -am "fix(understanding-gate): address reviewer feedback" -m "${REAL_TRAILER}"`,
        ),
      ).toBe(true);
    });
  });
});
