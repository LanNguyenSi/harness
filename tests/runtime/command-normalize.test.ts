import { describe, expect, it } from "vitest";
import { normalizeCommand } from "../../src/runtime/command-normalize.js";

// The exact bash_match regex from src/cli/init/templates.ts:442 (duplicated
// at :224 and in docs/examples/full-manifest.yaml, pinned by
// tests/cli/init-full-template-parity.test.ts). Inlined here as a literal,
// matching the existing precedent in
// tests/runtime/intercept.test.ts's "command-position bash_match" suite.
const PREFLIGHT_BASH_MATCH =
  "(^|\\n|;|\\||&&|\\()\\s*(\\w+=\\S+\\s+)*git( -C \\S+)* (status|log|diff|branch)\\b";

describe("normalizeCommand", () => {
  describe("previously-allowed spellings normalise to a match", () => {
    const re = new RegExp(PREFLIGHT_BASH_MATCH);
    const cases: Array<{ label: string; command: string }> = [
      { label: "env -C <repo>", command: "env -C /tmp/repo git status" },
      { label: "env (bare)", command: "env git status" },
      { label: "env VAR=value", command: "env FOO=bar git status" },
      { label: "nice", command: "nice git status" },
      { label: "git --no-pager", command: "git --no-pager status" },
      { label: "double space between git and subcommand", command: "git  status" },
      {
        label: "git --git-dir=<x>/.git --work-tree=<x>",
        command: "git --git-dir=/tmp/repo/.git --work-tree=/tmp/repo status",
      },
    ];
    for (const c of cases) {
      it(`${c.label}: "${c.command}" normalises to a trigger match`, () => {
        const { normalized } = normalizeCommand(c.command);
        expect(re.test(normalized)).toBe(true);
      });
    }
  });

  describe("superset: previously-matching spellings keep matching", () => {
    const re = new RegExp(PREFLIGHT_BASH_MATCH);
    const cases = [
      "git status",
      "cd /tmp/repo; git status",
      "cd /tmp/repo && git status",
      "git -C /tmp/repo status",
      "sh -c 'cd /tmp/repo && git status'",
    ];
    for (const command of cases) {
      it(`"${command}" still normalises to a trigger match`, () => {
        const { normalized } = normalizeCommand(command);
        expect(re.test(normalized)).toBe(true);
      });
    }
  });

  describe("negative cases: must not become a git invocation", () => {
    // These must not just "fail to match" — they must come back
    // byte-identical, proving no wrapper/VAR= peeling was tentatively
    // applied and left half-committed.
    const cases = ["gitk", "digit=1 foo", 'echo "git status"', "mygit status", "git-foo status"];
    for (const command of cases) {
      it(`"${command}" is left unchanged`, () => {
        expect(normalizeCommand(command).normalized).toBe(command);
      });
    }
  });

  describe("whitespace and tail preservation", () => {
    it("collapses multiple spaces between git and its subcommand", () => {
      expect(normalizeCommand("git   status").normalized).toBe("git status");
    });

    it("preserves trailing arguments verbatim", () => {
      expect(normalizeCommand("git status --short").normalized).toBe("git status --short");
    });

    it("does not disturb a later git mention inside a quoted argument", () => {
      // ec2336c1 regression companion: the subcommand for THIS invocation
      // is "commit", not "push"/"status" — a quoted mention of "git push"
      // later in the string must never surface as a match.
      const command = 'git commit -m "remember to git push"';
      expect(normalizeCommand(command).normalized).toBe(command);
    });
  });

  describe("targetDir extraction", () => {
    it("env -C <dir>", () => {
      expect(normalizeCommand("env -C /tmp/repoA git status").targetDir).toBe("/tmp/repoA");
    });
    it("env --chdir <dir>", () => {
      expect(normalizeCommand("env --chdir /tmp/repoA git status").targetDir).toBe("/tmp/repoA");
    });
    it("env --chdir=<dir>", () => {
      expect(normalizeCommand("env --chdir=/tmp/repoA git status").targetDir).toBe("/tmp/repoA");
    });
    it("env -C<dir> (glued)", () => {
      expect(normalizeCommand("env -C/tmp/repoA git status").targetDir).toBe("/tmp/repoA");
    });
    it("git -C <dir>", () => {
      expect(normalizeCommand("git -C /tmp/repoB status").targetDir).toBe("/tmp/repoB");
    });
    it("git --work-tree=<dir>", () => {
      expect(normalizeCommand("git --work-tree=/tmp/repoB status").targetDir).toBe(
        "/tmp/repoB",
      );
    });
    it("git --work-tree <dir> (space form)", () => {
      expect(normalizeCommand("git --work-tree /tmp/repoB status").targetDir).toBe(
        "/tmp/repoB",
      );
    });
    it("git --git-dir=<x>/.git resolves to the parent <x>", () => {
      expect(normalizeCommand("git --git-dir=/tmp/repoC/.git status").targetDir).toBe(
        "/tmp/repoC",
      );
    });
    it("git --git-dir <x>/.git (space form) resolves to the parent <x>", () => {
      expect(normalizeCommand("git --git-dir /tmp/repoC/.git status").targetDir).toBe(
        "/tmp/repoC",
      );
    });
    it("leading cd <dir> && ... (fallback, no git-level target named)", () => {
      expect(normalizeCommand("cd /tmp/repoD && git status").targetDir).toBe("/tmp/repoD");
    });
    it("leading cd <dir>; ... (fallback, no git-level target named)", () => {
      expect(normalizeCommand("cd /tmp/repoD; git status").targetDir).toBe("/tmp/repoD");
    });
    it("is null when the command names no target", () => {
      expect(normalizeCommand("git status").targetDir).toBe(null);
    });
    it("is null for a non-git command", () => {
      expect(normalizeCommand("ls -la").targetDir).toBe(null);
    });
  });

  describe("never throws", () => {
    const malformed = [
      "",
      "   ",
      "git",
      "'",
      '"',
      "cd '",
      "env -C",
      "git -C",
      "git --git-dir",
      "git --work-tree",
      "\n\n\n",
      ";;;;&&&&||||((((",
      "git".repeat(10000),
      String.fromCharCode(0, 1, 2, 3) + "git status",
      "FOO=" + "x".repeat(5000) + " git status",
      "env -S 'echo hi; git status'",
    ];
    for (const command of malformed) {
      it(`does not throw on ${JSON.stringify(command.slice(0, 40))}`, () => {
        expect(() => normalizeCommand(command)).not.toThrow();
      });
    }

    it("does not throw on non-string input", () => {
      expect(() => normalizeCommand(null as unknown as string)).not.toThrow();
      expect(() => normalizeCommand(undefined as unknown as string)).not.toThrow();
      expect(normalizeCommand(null as unknown as string)).toEqual({
        normalized: "",
        targetDir: null,
      });
    });

    it("property: many generated adversarial strings never throw", () => {
      // Deterministic LCG so the test is reproducible, never flaky.
      let seed = 42;
      const rand = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      const alphabet = [
        "git",
        "env",
        "nice",
        "command",
        "-C",
        "--chdir",
        "--git-dir=",
        "--work-tree=",
        "&&",
        ";",
        "|",
        "(",
        ")",
        "\n",
        "'",
        '"',
        "=",
        " ",
        "FOO",
        "1",
        "status",
      ];
      for (let i = 0; i < 300; i++) {
        const len = 1 + Math.floor(rand() * 12);
        let s = "";
        for (let j = 0; j < len; j++) {
          s += alphabet[Math.floor(rand() * alphabet.length)];
        }
        expect(() => normalizeCommand(s)).not.toThrow();
        const result = normalizeCommand(s);
        expect(typeof result.normalized).toBe("string");
        expect(result.targetDir === null || typeof result.targetDir === "string").toBe(true);
      }
    });
  });
});
