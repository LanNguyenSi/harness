import { describe, expect, it } from "vitest";
import { isReadOnlyBashCommand } from "../../src/runtime/read-only-bash.js";

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
    // `sort -o` / `tree -o` write a file, `file -C` compiles a .mgc,
    // `uniq`'s second operand is its output, `date -s` sets the clock,
    // `hostname NAME` sets the hostname, all with no shell metacharacter.
    // They are dropped from SIMPLE_READ_ONLY_BINS entirely, so even their
    // bare read forms are unclassified rather than risk laundering a write
    // through them.
    it.each([
      "sort -o out.txt in.txt",
      "sort --output=out.txt in.txt",
      "sort in.txt",
      "uniq in.txt out.txt",
      "uniq in.txt",
      "tree -o listing.txt",
      "tree /some/dir",
      "file -C -m mymagic",
      "file --compile",
      "file src/index.ts",
      "date -s 2020-01-01T00:00:00",
      "date",
      "hostname newname",
      "hostname",
    ])("blocks %s", (cmd) => {
      expect(isReadOnlyBashCommand(cmd)).toBe(false);
    });
  });
});
