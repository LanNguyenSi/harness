import { describe, expect, it } from "vitest";
import { isRecoveryGitCommit } from "../../src/runtime/recovery-git-commit.js";

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
      `git commit -ma "fix(x): recovery commit"`,
      `git commit --message="fix(x): recovery commit"`,
      `git commit --all --message="fix(x): recovery commit"`,
      `git commit --allow-empty -m "fix(x): recovery commit"`,
      // Multiple -m paragraphs (subject, body, trailer) — the idiomatic
      // way to express a multi-paragraph message without embedding a
      // literal newline in one token. (No angle brackets in the trailer:
      // `<`/`>` are rejected everywhere, even inside quotes — see the
      // "fails closed" describe block below.)
      `git commit -m "subject line" -m "body paragraph" -m "Co-Authored-By: Claude Fable 5"`,
      // Extra whitespace between `git` and `commit`.
      "git  commit  -a",
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
      // Chaining, redirection, substitution: must not smuggle other work.
      `git commit -m "msg"; rm -rf /`,
      `git commit -m "msg" && rm -rf /`,
      `git commit -m "msg" | tee /tmp/x`,
      "git commit -m `whoami`",
      `git commit -m "$(whoami)"`,
      "git commit -m msg > /tmp/out",
      "git commit -m msg < /tmp/in",
      // Multi-line command (heredoc-ish smuggling attempt).
      "git commit -m \"msg\"\ngit push",
      "",
      "   ",
    ])("rejects %s", (cmd) => {
      expect(isRecoveryGitCommit(cmd)).toBe(false);
    });
  });
});
