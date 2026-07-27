import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { FULL_TEMPLATE } from "../../src/cli/init/templates.js";
import { normalizeCommand } from "../../src/runtime/command-normalize.js";
import { parseManifest } from "../../src/schema/index.js";

// Read the real `bash_match` straight out of FULL_TEMPLATE instead of a
// hand-copied literal (F7 fix, review round 2026-07-27, run
// 2026-07-27-gate-target-repo-resolution): a literal here would keep
// passing against the OLD pattern after a future edit (open task
// `dbc6d303` tightens this exact regex), silently certifying stale
// behaviour. Mirrors the precedent in
// tests/cli/init-full-template-kill-switch-deny.test.ts's
// `policyBashMatch` helper.
function policyBashMatch(name: string): RegExp {
  const parsed = parseManifest(parseYaml(FULL_TEMPLATE));
  const policy = parsed.policies.find((p) => p.name === name);
  if (!policy) throw new Error(`policy ${name} missing from FULL_TEMPLATE`);
  const pattern = policy.trigger.bash_match;
  if (!pattern) throw new Error(`policy ${name} declares no trigger.bash_match`);
  return new RegExp(pattern);
}

describe("normalizeCommand", () => {
  describe("previously-allowed spellings normalise to a match", () => {
    const re = policyBashMatch("preflight-before-investigation");
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
      // F4 fix (HIGH, review round 2026-07-27): each of these was
      // measured as a live bypass against the shipped binary.
      { label: "sudo", command: "sudo git status" },
      { label: "sudo with its own value flag", command: "sudo -u root git status" },
      { label: "doas", command: "doas git status" },
      { label: "time", command: "time git status" },
      { label: "timeout with duration", command: "timeout 5 git status" },
      { label: "timeout with its own flag", command: "timeout -k 1 5 git status" },
      { label: "stdbuf glued mode flag", command: "stdbuf -o0 git status" },
      { label: "setsid", command: "setsid git status" },
      { label: "path-qualified git (basename match)", command: "/usr/bin/git status" },
      { label: "relative path-qualified git", command: "./git status" },
    ];
    for (const c of cases) {
      it(`${c.label}: "${c.command}" normalises to a trigger match`, () => {
        const { normalized } = normalizeCommand(c.command);
        expect(re.test(normalized)).toBe(true);
      });
    }
  });

  // F4 fix: the DELIBERATELY-NOT-SUPPORTED spellings (module header) are
  // pinned here so the ceiling is ASSERTED, not merely described in a
  // comment — a future accidental fix to one of these should surface as a
  // newly-passing test to update, not silent, unverified progress.
  describe("F4: still-unsupported spellings stay unmatched (documented ceiling)", () => {
    const re = policyBashMatch("preflight-before-investigation");
    const cases: Array<{ label: string; command: string }> = [
      { label: "xargs (deliberately excluded, not a peeled wrapper)", command: "xargs git status" },
      { label: "quoted subcommand", command: 'git "status"' },
      {
        label: "backtick command substitution",
        command: "echo `env -C /tmp git status`",
      },
    ];
    for (const c of cases) {
      it(`"${c.command}" does NOT normalise to a trigger match`, () => {
        const { normalized } = normalizeCommand(c.command);
        expect(re.test(normalized)).toBe(false);
        // Also confirm the raw form doesn't accidentally match either —
        // these are genuine bypasses, not merely "normalisation didn't
        // help".
        expect(re.test(c.command)).toBe(false);
      });
    }
  });

  describe("superset: previously-matching spellings keep matching", () => {
    const re = policyBashMatch("preflight-before-investigation");
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

  // F3 fix (HIGH, review round 2026-07-27): `findNextBoundary` used to do
  // up to 5 `indexOf` scans per segment, and confirming a token's ABSENCE
  // requires scanning to the end of the remaining string every time, so a
  // command with many segments and at least one boundary kind that never
  // occurs anywhere degenerated to O(segments × length). Measured
  // end-to-end (`node dist/cli/main.js policy intercept`) at 2790ms /
  // 2715ms for a 360k-char command against a shipped-binary control that
  // stayed flat at ~190ms/~110ms — `require-preflight-evidence` declares
  // `budget_ms: 1000`, so command SIZE alone could drive the hook past
  // its own timeout budget (a fail-open class). `findNextBoundary` is now
  // a single combined-alternation regex scan (O(length) total), and
  // `MAX_NORMALIZE_LENGTH` bounds the worst case to a small constant
  // regardless.
  describe("F3: bounded cost for large commands", () => {
    it("returns the input unchanged above MAX_NORMALIZE_LENGTH (100_000 chars)", () => {
      const oversized = "git status " + "x".repeat(100_000);
      expect(oversized.length).toBeGreaterThan(100_000);
      const result = normalizeCommand(oversized);
      expect(result).toEqual({ normalized: oversized, targetDir: null, targetBase: null });
    });

    it("stays at or under the length bound: a 100_000-char command is still normalised (not just passed through)", () => {
      const atBound = "git status " + "x".repeat(100_000 - "git status ".length);
      expect(atBound.length).toBe(100_000);
      // "git status" is still recognised and canonicalised — proves this
      // exercises the REAL normalisation path, not the length-bound
      // short-circuit, so the timing assertion below is meaningful.
      expect(normalizeCommand(atBound).normalized.startsWith("git status")).toBe(true);
    });

    it("a >=100KB adversarial command (many segments, one boundary kind that never occurs) stays under a fixed time budget", () => {
      // Reproduces the exact shape that degenerated under the OLD
      // per-token `indexOf` scan: many `;`-joined segments and NO `(`
      // anywhere in the whole command, so confirming "(" absent used to
      // cost O(remaining length) on EVERY segment.
      const segment = "a;";
      const command = segment.repeat(Math.floor(100_000 / segment.length));
      expect(command.length).toBeGreaterThanOrEqual(99_998);
      expect(command).not.toContain("(");

      const start = process.hrtime.bigint();
      normalizeCommand(command);
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

      // Measured ~5ms for this exact shape on the fixed implementation
      // (vs. multi-second blowup pre-fix at comparable sizes, scaled
      // from the reviewer's end-to-end measurements). 300ms leaves
      // generous headroom for slower CI machines while still catching a
      // reintroduced quadratic path outright.
      expect(elapsedMs).toBeLessThan(300);
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
        targetBase: null,
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
