import { describe, expect, it } from "vitest";
import { isReadOnlyBashCommand } from "../../src/cli/pack/read-only-bash.js";

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
      "grep -r foo src/",
      "rg foo",
      "wc -l src/index.ts",
      "head -20 README.md",
      "tail -f /var/log/app.log",
      "file src/index.ts",
      "stat src/index.ts",
      "ps aux",
      "whoami",
      "id",
      "date",
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
});
