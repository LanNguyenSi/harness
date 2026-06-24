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
