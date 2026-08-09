import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

// Reviewer-residual from task 623640a5 (isEscapeCommand \s -> [ \t]):
// this module tokenizes on bare `\s` at three sites — the `git\s+commit`
// prefix anchor and the two `\s`-tests inside `tokenize` (leading-skip
// and token-continuation) — the SAME JS-\s-vs-bash-blank divergence class
// 623640a5 closed in approve-escape.ts. Ground truth there (PATH-stub
// measurement against real bash, task 623640a5, restated in
// tests/cli/pack-approve-escape.test.ts's own "bash-blank divergence"
// block): bash's lexical blank set is exactly TAB (U+0009) and SPACE
// (U+0020); every other JS `\s` codepoint (23 of them) is something bash
// GLUES onto the adjacent word instead of treating as a separator. Since
// {TAB, SPACE} subset \s, this module's tokenizer can only OVER-split
// relative to bash (add a JS token boundary bash does not have) — it can
// never UNDER-split (merge two words bash keeps separate), because every
// real bash blank is itself also matched by \s. Under-split is the
// dangerous direction for an ALLOW-path classifier (it could hide a live
// token inside what the classifier treats as inert text); over-split
// cannot, by that same subset argument.
//
// Task 822a508d measured (real bash 3.2.57 / real git 2.50.1, PATH-stub
// pattern, this task's own scratch dir) what over-split actually costs
// here across every \s call site, including the worst construction found
// (every glued piece independently matching a recognised safe token —
// see "the worst-case construction" below). In every case the classifier
// ADMITS a command real bash tokenizes differently than the classifier's
// model assumes, and in every case the ACTUAL bash+git execution is
// still safe:
//   - a non-bash-blank codepoint between "git" and "commit" glues them
//     into ONE argv word ("git<char>commit"), so bash looks up a
//     nonexistent binary and fails with "command not found" before git
//     commit ever runs — the exemption is granted for a call that does
//     not do the thing it was exempted for;
//   - a non-bash-blank codepoint glued directly onto a MESSAGE flag's
//     value (`-m`/`--message`/`-am`) becomes part of git's own
//     combined-short-option value: the text lands in the commit MESSAGE
//     verbatim, never as a separate flag — already metachar-screened
//     upstream, so its content cannot matter;
//   - anywhere else (a `--message=` glue, a FLAG-ONLY token glued to
//     more content), git's own combined-option parser refuses the
//     malformed cluster outright ("unknown option" / "unknown non-ascii
//     option") and nothing commits.
// This is a *narrower* safety argument than the same story in
// approve-escape.ts (there the fix was to REQUIRE `[ \t]`; here the
// PINNED conclusion is that the wider `\s` class stays and is safe) —
// see each `it` block below for the specific mechanism and the exact
// measured incident it pins.
describe("over-split direction is safe against real bash+git (task 822a508d)", () => {
  let cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups) c();
    cleanups = [];
  });

  function newRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-recovery-commit-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    execFileSync("git", ["init", "-q", "-b", "master"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
    return dir;
  }

  function commitCount(dir: string): number {
    try {
      return Number(
        execFileSync("git", ["rev-list", "--count", "HEAD"], {
          cwd: dir,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"], // unborn-HEAD error text is expected noise, not a signal.
        }).trim(),
      );
    } catch {
      return 0; // unborn HEAD: no commits yet.
    }
  }

  /**
   * Runs `cmd` through a real `sh` (INFRA-allowlisted, see
   * tests/_helpers/hermetic-spawn-allowlist.ts D6) exactly the way the
   * understanding-gate PreToolUse hook's exempted Bash call would really
   * execute — no shell:true double-parsing, `cmd` is handed to `sh -c`
   * as ONE argv element, so the raw non-ASCII bytes inside it are parsed
   * by a real shell's own lexer, not re-interpreted by Node/execFileSync.
   * `/bin/sh` on this suite's platforms is bash itself (POSIX mode) or a
   * POSIX-compatible shell with the SAME default IFS blank set
   * {TAB, SPACE, NEWLINE} this measurement is about — verified identical
   * to `/bin/bash`'s word-splitting for this exact construction during
   * this task's own PATH-stub measurement.
   */
  function runShell(dir: string, cmd: string): number {
    const result = execFileSync("sh", ["-c", `${cmd}; echo EXIT:$?`], {
      cwd: dir,
      encoding: "utf8",
      // git's own usage/error text on the expected-failure cases below is
      // noise here — only the appended EXIT:<code> marker on stdout matters.
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = /EXIT:(\d+)\s*$/.exec(result);
    if (!m) throw new Error(`runShell: could not read exit code from: ${JSON.stringify(result)}`);
    return Number(m[1]);
  }

  function writeAndStage(dir: string, name: string, content: string): void {
    fs.writeFileSync(path.join(dir, name), content);
    execFileSync("git", ["add", name], { cwd: dir });
  }

  const NBSP = " ";

  it("git<NBSP>commit — over-split at the git/commit anchor (line ~246) admits, but real bash treats \"git<NBSP>commit\" as ONE nonexistent binary and never runs git at all", () => {
    const dir = newRepo();
    writeAndStage(dir, "f.txt", "hi\n");
    const before = commitCount(dir);
    const cmd = `git${NBSP}commit -m "recovery commit"`;
    expect(isRecoveryGitCommit(cmd)).toBe(true);
    const exit = runShell(dir, cmd);
    expect(exit).not.toBe(0); // sh: "command not found" for the glued word.
    expect(commitCount(dir)).toBe(before); // nothing committed.
  });

  it('git commit<NBSP>-m "x" — over-split at tokenize\'s leading-skip (line ~169) admits, but real bash glues "commit" and "-m" into ONE malformed git subcommand and git refuses it', () => {
    const dir = newRepo();
    writeAndStage(dir, "f.txt", "hi\n");
    const before = commitCount(dir);
    const cmd = `git commit${NBSP}-m "x"`;
    expect(isRecoveryGitCommit(cmd)).toBe(true);
    const exit = runShell(dir, cmd);
    expect(exit).not.toBe(0); // git: "'commit -m' is not a git command".
    expect(commitCount(dir)).toBe(before);
  });

  it("git commit -m<NBSP>--amend — over-split at tokenize's token-continuation (line ~172) admits, but real git's combined-value parsing absorbs the glued text as literal MESSAGE content, never as the --amend flag", () => {
    const dir = newRepo();
    writeAndStage(dir, "f.txt", "hi\n");
    execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: dir });
    writeAndStage(dir, "f.txt", "hi again\n");
    const before = commitCount(dir); // 1 (the seed commit)
    const cmd = `git commit -m${NBSP}--amend`;
    expect(isRecoveryGitCommit(cmd)).toBe(true);
    const exit = runShell(dir, cmd);
    expect(exit).toBe(0);
    // A NEW commit, not a rewrite of "seed" — proves --amend never took
    // effect as a flag (an actual amend would have kept the count at 1
    // and replaced "seed"'s content).
    expect(commitCount(dir)).toBe(before + 1);
    const message = execFileSync("git", ["log", "-1", "--format=%B"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(message).toContain("--amend"); // present only as inert text.
    const seedMessage = execFileSync("git", ["log", "--format=%B", "--skip=1", "-1"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(seedMessage.trim()).toBe("seed"); // the seed commit is untouched.
  });

  it("git commit --message<NBSP>=hello — over-split admits, but real git refuses the malformed combined long-option glued via NBSP outright", () => {
    const dir = newRepo();
    writeAndStage(dir, "f.txt", "hi\n");
    const before = commitCount(dir);
    const cmd = `git commit --message${NBSP}=hello`;
    expect(isRecoveryGitCommit(cmd)).toBe(true);
    const exit = runShell(dir, cmd);
    expect(exit).not.toBe(0); // git: "unknown option `message =hello'".
    expect(commitCount(dir)).toBe(before);
  });

  it("the worst-case construction: git commit -a<NBSP>--all<NBSP>-a — every glued piece independently matches a recognised FLAG-ONLY token, so the classifier admits, but real git refuses the malformed combined short-option cluster as a whole", () => {
    const dir = newRepo();
    writeAndStage(dir, "f.txt", "hi\n");
    const before = commitCount(dir);
    const cmd = `git commit -a${NBSP}--all${NBSP}-a`;
    expect(isRecoveryGitCommit(cmd)).toBe(true);
    const exit = runShell(dir, cmd);
    expect(exit).not.toBe(0); // git: "unknown non-ascii option in string".
    expect(commitCount(dir)).toBe(before);
  });
});

describe("over-split direction pinned across every non-bash-blank \\s codepoint (task 822a508d, hermetic)", () => {
  // Same computed-not-hardcoded enumeration as
  // tests/cli/pack-approve-escape.test.ts's "bash-blank divergence" block
  // (task 623640a5) — that file already pins the codepoint COUNT (25
  // total: 2 real bash blanks, 23 non-blank); this block reuses the same
  // derivation to stay in sync with that pin rather than re-asserting it.
  const ALL_JS_WHITESPACE_CODEPOINTS: number[] = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue; // surrogate range, not a scalar value.
    if (/^\s$/.test(String.fromCodePoint(cp))) {
      ALL_JS_WHITESPACE_CODEPOINTS.push(cp);
    }
  }
  const BASH_BLANK_CODEPOINTS = [0x09, 0x20];
  const NON_BASH_BLANK_CODEPOINTS = ALL_JS_WHITESPACE_CODEPOINTS.filter(
    (cp) => !BASH_BLANK_CODEPOINTS.includes(cp),
  );
  // LF/CR are excluded exactly as in the sibling file: `isRecoveryGitCommit`
  // rejects both unconditionally before any \s regex runs (see the
  // `trimmed.includes("\n")` / `"\r"` guard), so they are not a
  // whitespace-CLASS question at these three call sites.
  const LOOP_EXCLUDED = new Set([0x0a, 0x0d]);

  it("admits every non-bash-blank codepoint as the git/commit separator (line ~246) — pinned safe by the live-bash NBSP case above (command-not-found)", () => {
    for (const cp of NON_BASH_BLANK_CODEPOINTS) {
      if (LOOP_EXCLUDED.has(cp)) continue;
      const ch = String.fromCodePoint(cp);
      const label = `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
      expect(isRecoveryGitCommit(`git${ch}commit -m "x"`), label).toBe(true);
    }
  });

  it("admits every non-bash-blank codepoint at tokenize's leading-skip, right after \"commit\" (line ~169) — pinned safe by the live-bash NBSP case above (malformed git subcommand, refused)", () => {
    for (const cp of NON_BASH_BLANK_CODEPOINTS) {
      if (LOOP_EXCLUDED.has(cp)) continue;
      const ch = String.fromCodePoint(cp);
      const label = `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
      expect(isRecoveryGitCommit(`git commit${ch}-m "x"`), label).toBe(true);
    }
  });

  it("admits every non-bash-blank codepoint glued directly after a MESSAGE flag (line ~172) — pinned safe by the live-bash NBSP case above (absorbed as literal message text)", () => {
    for (const cp of NON_BASH_BLANK_CODEPOINTS) {
      if (LOOP_EXCLUDED.has(cp)) continue;
      const ch = String.fromCodePoint(cp);
      const label = `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
      expect(isRecoveryGitCommit(`git commit -m${ch}--amend`), label).toBe(true);
      expect(isRecoveryGitCommit(`git commit -m${ch}--no-verify`), label).toBe(true);
    }
  });

  it("negative control: still REJECTS a dangerous flag glued after a FLAG-ONLY token, for every non-bash-blank codepoint — FLAG_ONLY_TOKENS consumption never swallows what follows, so --amend/--no-verify stay their own unrecognised token", () => {
    for (const cp of NON_BASH_BLANK_CODEPOINTS) {
      if (LOOP_EXCLUDED.has(cp)) continue;
      const ch = String.fromCodePoint(cp);
      const label = `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
      expect(isRecoveryGitCommit(`git commit -a${ch}--amend`), label).toBe(false);
      expect(isRecoveryGitCommit(`git commit --all${ch}--no-verify`), label).toBe(false);
    }
  });

  it("still accepts real bash blanks (TAB, SPACE) in the same positions — no regression from this block's own probes", () => {
    for (const cp of BASH_BLANK_CODEPOINTS) {
      const ch = String.fromCodePoint(cp);
      const label = `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
      expect(isRecoveryGitCommit(`git${ch}commit -m "x"`), label).toBe(true);
      expect(isRecoveryGitCommit(`git commit${ch}-m "x"`), label).toBe(true);
      expect(isRecoveryGitCommit(`git commit -m${ch}"x"`), label).toBe(true);
      expect(isRecoveryGitCommit(`git commit -a${ch}--amend`), label).toBe(false);
    }
  });
});
