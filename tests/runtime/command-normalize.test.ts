import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { FULL_TEMPLATE } from "../../src/cli/init/templates.js";
import {
  AMP_BOUNDARY_RE,
  MAX_NORMALIZE_LENGTH,
  normalizeCommand,
  normalizeCommandAmpAware,
  segmentViewOf,
} from "../../src/runtime/command-normalize.js";
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
      // G3 fix (MEDIUM, review round 2, 2026-07-27): `nice -10 cmd` is
      // `nice(1)`'s PRIMARY documented spelling (increment glued to the
      // leading dash, no `n`); `nice` was already SUPPORTED but only the
      // `-n`-prefixed forms were recognised.
      { label: "nice bare -N (primary nice(1) spelling)", command: "nice -10 git status" },
      { label: "nice bare +N (BSD positive form)", command: "nice +10 git status" },
      // G6 fix (LOW, review round 2, 2026-07-27): the module header's
      // motivating divergence example — `read-only-bash.ts` peeled this
      // via its generic glued-long-flag catch-all, this module had none.
      { label: "env --default-signal=INT (generic glued long flag)", command: "env --default-signal=INT git status" },
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

  // G2 fix (MEDIUM, review round 2, 2026-07-27): ten more spellings
  // measured as live bypasses against the shipped binary, none of them
  // previously named in the module header's NOT-SUPPORTED list or the
  // CHANGELOG — same rationale as the F4 block above: assert the
  // ceiling, don't just describe it in a comment.
  describe("G2: still-unsupported spellings stay unmatched (documented ceiling, review round 2)", () => {
    const re = policyBashMatch("preflight-before-investigation");
    const cases: Array<{ label: string; command: string }> = [
      { label: "exec", command: "exec git status" },
      { label: "nohup", command: "nohup git status" },
      { label: "ionice", command: "ionice -c3 git status" },
      { label: "flock", command: "flock /tmp/l git status" },
      { label: "script", command: "script -q /dev/null git status" },
      { label: "chrt", command: "chrt -b 0 git status" },
      { label: "taskset", command: "taskset -c 0 git status" },
      { label: "backslash-escaped git", command: "\\git status" },
      { label: "quoted git binary name", command: '"git" status' },
      { label: "env -S (split-string, opaque re-parse)", command: 'env -S "git status"' },
    ];
    for (const c of cases) {
      it(`"${c.command}" does NOT normalise to a trigger match`, () => {
        const { normalized } = normalizeCommand(c.command);
        expect(re.test(normalized)).toBe(false);
        expect(re.test(c.command)).toBe(false);
      });
    }
  });

  // G2 fix, other direction: CHANGELOG.md used to lump "backtick/$()
  // command substitution" together as open. Only the backtick case
  // (above) genuinely is — `$(...)` ACCIDENTALLY blocks today because
  // its opening paren is the same `(` character `BOUNDARY_RE` already
  // treats as a shell boundary (see the module header). Pinned here so a
  // future, unrelated `BOUNDARY_RE` edit that silently drops this
  // coincidental coverage shows up as a newly-failing test.
  describe("G2: $(...) command substitution is accidentally covered (pin, not a deliberate feature)", () => {
    const re = policyBashMatch("preflight-before-investigation");
    it('"echo $(env -C /tmp git status)" DOES normalise to a trigger match', () => {
      const command = "echo $(env -C /tmp git status)";
      const { normalized } = normalizeCommand(command);
      expect(re.test(normalized)).toBe(true);
    });
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

  // T-001 (run 2026-07-28-nongit-trigger-wrappers, D-001): the head-token
  // condition generalised from "literally `git`" to the closed set `git`,
  // `gh`, `npm`, `harness`. Byte-identity for every OTHER head token is an
  // acceptance criterion, not a nice-to-have — a near-miss must never be
  // silently coerced into the recognised spelling, and a wrapper peeled off
  // in front of a near-miss must not be dropped either (mirrors the
  // `digit=1 foo` / `env -C X ls` invariant above for the three new heads).
  describe("negative cases: gh/npm/harness near-misses must not become a recognised invocation (byte-identity, T-001)", () => {
    const cases = [
      "ghx pr merge 123",
      "npmx publish",
      "harnessy pause",
      "env ghx pr merge 123",
      "env npmx publish",
      "env harnessy pause",
    ];
    for (const command of cases) {
      it(`"${command}" is left unchanged`, () => {
        expect(normalizeCommand(command).normalized).toBe(command);
      });
    }
  });

  // Fix round 2, finding F7: a path-qualified `gh`/`npm`/`harness`
  // invocation is out of scope for the closed head-token set (EXACT
  // literal equality, not basename like `GIT_TOKEN_RE` — see the module
  // header's NOT-SUPPORTED list). Byte-identity pins this ceiling
  // directly, mirroring the near-misses block above.
  describe("negative cases: path-qualified gh/npm invocations stay unmatched (byte-identity, F7)", () => {
    const cases = ["/usr/local/bin/gh pr merge 1", "./node_modules/.bin/npm publish"];
    for (const command of cases) {
      it(`"${command}" is left unchanged`, () => {
        expect(normalizeCommand(command).normalized).toBe(command);
      });
    }
  });

  // Fix round 2, finding F7 (other direction): `harness`'s OWN trigger
  // regex already covers a path-qualified spelling at the RAW-match level
  // (`(?:npx\s+|\S*/)?harness` in `deny-kill-switch-bypass`) — this
  // module's normaliser does not need to help here, and does not (the
  // byte-identity pin above would be a false alarm if it did: the RAW
  // string alone already satisfies the trigger). Positive control so this
  // module's own byte-identity choice for `harness` is never mistaken for
  // a live bypass.
  describe("F7: /usr/local/bin/harness pause still denies via the trigger's own raw \\S*/ alternative (no normalisation needed)", () => {
    const re = policyBashMatch("deny-kill-switch-bypass");
    it('"/usr/local/bin/harness pause" matches the RAW regex directly', () => {
      expect(re.test("/usr/local/bin/harness pause")).toBe(true);
    });
  });

  // T-001: canonicalisation pins for the three new non-git heads, mirroring
  // the git-focused "previously-allowed spellings normalise to a match"
  // block above. Real regexes read straight out of FULL_TEMPLATE via
  // `policyBashMatch` (never hand-copied — same rationale as that block).
  // Constraint from the task spec: non-git heads get wrapper peeling PLUS
  // whitespace collapsing between the head token and its subcommand only —
  // no tool-specific option dropping (`gh -R`, `npm --loglevel` stay
  // unsupported, see the module header).
  describe("non-git head tokens (gh/npm/harness): previously-allowed spellings normalise to a match (T-001)", () => {
    describe("gh pr merge (review-before-merge-bash)", () => {
      const re = policyBashMatch("review-before-merge-bash");
      const cases: Array<{ label: string; command: string }> = [
        { label: "env gh pr merge", command: "env gh pr merge 123" },
        { label: "env -C <dir> gh pr merge", command: "env -C /tmp/repo gh pr merge 123" },
        { label: "nice gh pr merge", command: "nice gh pr merge 123" },
        { label: "double space between gh and its subcommand", command: "gh  pr merge 123" },
        // Fix round 2, finding F2: an interior whitespace run FURTHER INTO
        // the multi-word trigger (between "pr" and "merge", not "gh" and
        // "pr") used to survive the head-to-next-token-only collapse.
        { label: "double space between pr and merge (F2)", command: "gh pr  merge 123" },
        { label: "tab between pr and merge (F2)", command: "gh pr\tmerge 123" },
      ];
      for (const c of cases) {
        it(`${c.label}: "${c.command}" normalises to a trigger match`, () => {
          const { normalized } = normalizeCommand(c.command);
          expect(re.test(normalized)).toBe(true);
        });
      }
    });

    describe("gh pr create (review-subagent-before-pr-create-bash)", () => {
      const re = policyBashMatch("review-subagent-before-pr-create-bash");
      const cases: Array<{ label: string; command: string }> = [
        { label: "env gh pr create", command: "env gh pr create" },
        // Fix round 2, finding F2.
        { label: "double space between pr and create (F2)", command: "gh pr  create" },
      ];
      for (const c of cases) {
        it(`${c.label}: "${c.command}" normalises to a trigger match`, () => {
          const { normalized } = normalizeCommand(c.command);
          expect(re.test(normalized)).toBe(true);
        });
      }
    });

    describe("npm publish (dogfood-before-release)", () => {
      const re = policyBashMatch("dogfood-before-release");
      const cases: Array<{ label: string; command: string }> = [
        { label: "env npm publish", command: "env npm publish" },
        { label: "nice npm publish", command: "nice npm publish" },
        // Fix round 2, finding F2/F7: double space / tab between npm and
        // its subcommand (the head-to-next-token gap this collapse
        // already covered, re-pinned here alongside the F2 additions for
        // the other two heads so all three get the same whitespace-run
        // coverage documented in one place).
        { label: "double space between npm and publish (F2/F7)", command: "npm  publish" },
        { label: "tab between npm and publish (F2/F7)", command: "npm\tpublish" },
      ];
      for (const c of cases) {
        it(`${c.label}: "${c.command}" normalises to a trigger match`, () => {
          const { normalized } = normalizeCommand(c.command);
          expect(re.test(normalized)).toBe(true);
        });
      }
    });

    describe("harness pause (deny-kill-switch-bypass)", () => {
      const re = policyBashMatch("deny-kill-switch-bypass");
      const cases: Array<{ label: string; command: string }> = [
        { label: "env harness pause", command: "env harness pause" },
        { label: "nice harness pause", command: "nice harness pause" },
        { label: "command harness pause", command: "command harness pause" },
        { label: "env -C <dir> harness pause", command: "env -C /tmp harness pause" },
      ];
      for (const c of cases) {
        it(`${c.label}: "${c.command}" normalises to a trigger match`, () => {
          const { normalized } = normalizeCommand(c.command);
          expect(re.test(normalized)).toBe(true);
        });
      }
    });
  });

  // T-001: gh/npm/harness must never drop the TOOL's OWN options the way
  // git's global options are dropped — that stays deliberately
  // NOT-SUPPORTED (module header). `gh -R owner/repo pr merge` inserts a
  // flag+value BETWEEN the head token and its subcommand tokens, which this
  // module's non-git path never looks past — pinned as a documented
  // ceiling, not silently left to a comment.
  describe("T-001: gh/npm tool-specific option flags stay unsupported (documented ceiling)", () => {
    const re = policyBashMatch("review-before-merge-bash");
    it('"gh -R owner/repo pr merge 123" does NOT normalise to a trigger match', () => {
      const command = "gh -R owner/repo pr merge 123";
      const { normalized } = normalizeCommand(command);
      expect(re.test(normalized)).toBe(false);
      expect(re.test(command)).toBe(false);
    });
  });

  // Fix round 2, finding F1: a shipped `bash_match` trigger actually keys
  // on EIGHT distinct head-token spellings, not the four this module
  // covers — `deny-session-env-strip` also keys on `env`/`unset`,
  // `deny-pause-sentinel-forgery` also keys on `tee`/`cp`. None of these
  // four are reachable by this module (see the module header's "SHIPPED
  // BUT NOT COVERED" paragraph for the structural reason `env` specifically
  // can never be added by a simple set-membership change). Pinned here so
  // the ceiling is ASSERTED, not merely described in a comment — mirrors
  // the F4/G2/T-001 documented-ceiling precedent above.
  describe("fix round 2, finding F1: env/unset/tee/cp stay unmatched even wrapped (documented ceiling, still structurally out of reach)", () => {
    it('"nice env -u CLAUDE_SESSION_ID ls" does NOT normalise to a deny-session-env-strip match', () => {
      const re = policyBashMatch("deny-session-env-strip");
      const command = "nice env -u CLAUDE_SESSION_ID ls";
      const { normalized } = normalizeCommand(command);
      expect(re.test(normalized)).toBe(false);
      expect(re.test(command)).toBe(false);
    });

    it('"nice unset CLAUDE_SESSION_ID" does NOT normalise to a deny-session-env-strip match', () => {
      const re = policyBashMatch("deny-session-env-strip");
      const command = "nice unset CLAUDE_SESSION_ID";
      const { normalized } = normalizeCommand(command);
      expect(re.test(normalized)).toBe(false);
      expect(re.test(command)).toBe(false);
    });

    it('"nice tee /tmp/.harness-paused" does NOT normalise to a deny-pause-sentinel-forgery match', () => {
      const re = policyBashMatch("deny-pause-sentinel-forgery");
      const command = "nice tee /tmp/.harness-paused";
      const { normalized } = normalizeCommand(command);
      expect(re.test(normalized)).toBe(false);
      expect(re.test(command)).toBe(false);
    });

    it('"nice cp a /tmp/.harness-paused" does NOT normalise to a deny-pause-sentinel-forgery match', () => {
      const re = policyBashMatch("deny-pause-sentinel-forgery");
      const command = "nice cp a /tmp/.harness-paused";
      const { normalized } = normalizeCommand(command);
      expect(re.test(normalized)).toBe(false);
      expect(re.test(command)).toBe(false);
    });

    it('"nice CLAUDE_SESSION_ID= npm publish" does NOT match deny-session-env-strip (headless VAR= alternative, wrapped)', () => {
      // The policy's third alternative has no command-name head token at
      // all (bare `<SESSION_VAR>=` empty assignment). Unwrapped it matches
      // RAW; wrapped, the peel loop consumes the assignment as an ordinary
      // `VAR=value` prefix, so neither raw nor normalised matches. Same
      // documented ceiling as the four cases above (verify-pass finding).
      const re = policyBashMatch("deny-session-env-strip");
      const command = "nice CLAUDE_SESSION_ID= npm publish";
      const { normalized } = normalizeCommand(command);
      expect(re.test(normalized)).toBe(false);
      expect(re.test(command)).toBe(false);
    });
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

  // Groundwork for task aabbad63 (the BOUNDARY_RE bare-`&` fix). These pin
  // targetDir invariants that are TRUE TODAY and that a future BOUNDARY_RE
  // edit could disturb — see scripts/measure-command-normalize.mjs (arm
  // C) for the reusable measurement instrument these mirror.
  describe("aabbad63 groundwork: targetDir invariants a future BOUNDARY_RE edit must not disturb", () => {
    it("git -C /x log 2>&1 still resolves /x (redirect after the invocation)", () => {
      expect(normalizeCommand("git -C /x log 2>&1").targetDir).toBe("/x");
    });
    it("git -C /x status &> out still resolves /x (combined stdout+stderr redirect)", () => {
      expect(normalizeCommand("git -C /x status &> out").targetDir).toBe("/x");
    });
    it("git -C /x push & still resolves /x (trailing background job)", () => {
      expect(normalizeCommand("git -C /x push &").targetDir).toBe("/x");
    });
    // Currently UNPINNED before this task: guards the `&&` agreement/
    // ordering invariant (both invocations name the SAME explicit target)
    // that a future quote-aware BOUNDARY_RE edit could break.
    it("git -C /tmp/repoB status && git -C /tmp/repoB log resolves /tmp/repoB (&& agreement/ordering)", () => {
      expect(
        normalizeCommand("git -C /tmp/repoB status && git -C /tmp/repoB log").targetDir,
      ).toBe("/tmp/repoB");
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

  // G1 fix (HIGH, review round 2, 2026-07-27): unit-level pins on
  // `targetDir` itself, complementing the end-to-end
  // tests/runtime/intercept-cli.test.ts coverage (which asserts the
  // resulting ${REPO}/${BRANCH} through the real `review-before-merge-
  // bash` / `review-subagent-before-pr-create-bash` gates).
  describe("G1: an explicit git -C target must not leak into a different, non-git command sharing the chain", () => {
    it("git -C <B> rev-parse HEAD && gh pr merge — targetDir is null (gh pr merge does not run in B)", () => {
      expect(
        normalizeCommand("git -C /tmp/repoB rev-parse HEAD && gh pr merge 123").targetDir,
      ).toBe(null);
    });
    it("git -C <B> rev-parse HEAD && gh pr create — targetDir is null", () => {
      expect(
        normalizeCommand("git -C /tmp/repoB rev-parse HEAD && gh pr create").targetDir,
      ).toBe(null);
    });
    it("git -C <B> rev-parse HEAD && npm publish — targetDir is null", () => {
      expect(
        normalizeCommand("git -C /tmp/repoB rev-parse HEAD && npm publish").targetDir,
      ).toBe(null);
    });
    it("git -C /x status | head — pipe is NOT a new command, stays scoped to /x", () => {
      expect(normalizeCommand("git -C /tmp/repoB status | head").targetDir).toBe(
        "/tmp/repoB",
      );
    });
    it("cd <B> && git status — still resolves to B (F5, unaffected by G1)", () => {
      expect(normalizeCommand("cd /tmp/repoB && git status").targetDir).toBe(
        "/tmp/repoB",
      );
    });
    it("cd <B> && gh pr create — resolves to B too: cd genuinely persists for the rest of the chain, unlike a per-invocation git -C", () => {
      expect(normalizeCommand("cd /tmp/repoB && gh pr create").targetDir).toBe(
        "/tmp/repoB",
      );
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
      expect(result).toEqual({
        normalized: oversized,
        targetDir: null,
        targetBase: null,
        // G4 fix (MEDIUM, review round 2, 2026-07-27): the length-bound
        // skip is now reported back, not silent — see the `truncated`
        // end-to-end assertions in tests/runtime/intercept-cli.test.ts.
        truncated: true,
      });
    });

    it("truncated is false at/under the bound, even though nothing matched (G4 fix)", () => {
      expect(normalizeCommand("ls -la").truncated).toBe(false);
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
        truncated: false,
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

  // Task 13e55484: a QUOTED env-assignment value with embedded whitespace
  // (`VAR='hello world' git push`) was measured as a live bypass against
  // the shipped 0.42.0 binary on BOTH matching layers: the raw regex's
  // `(\w+=\S+\s+)*` cannot span the space, and this module's whitespace
  // tokenizer split the assignment into two tokens, the second of which
  // aborted the peel loop, so the segment came back byte-identical.
  // The fix continues an assignment's VALUE across tokens while an
  // opening quote from the same token is unbalanced — nothing else about
  // tokenization changed.
  describe("13e55484: quoted env-assignment values with whitespace normalise to a match", () => {
    const pushRe = policyBashMatch("preflight-before-push");
    const mergeRe = policyBashMatch("review-before-merge-bash");
    const cases: Array<{ label: string; command: string; re: RegExp }> = [
      {
        label: "measured spelling, single quotes (push gate)",
        command: "VAR='hello world' git push origin master",
        re: pushRe,
      },
      {
        label: "double quotes",
        command: 'VAR="hello world" git push origin master',
        re: pushRe,
      },
      {
        label: "multiple assignments, mixed quoting",
        command: "A='x y' B=\"z w\" git push origin master",
        re: pushRe,
      },
      {
        label: "assignment plus peeled wrapper (nice)",
        command: "VAR='a b' nice git push origin master",
        re: pushRe,
      },
      {
        label: "assignment INSIDE env (peelEnv's own assignment scan)",
        command: "env VAR='a b' git push origin master",
        re: pushRe,
      },
      {
        label: "tab instead of space in the value",
        command: "VAR='a\tb' git push origin master",
        re: pushRe,
      },
      {
        label: "multi-quote-run value ('a b'\"c d\")",
        command: "VAR='a b'\"c d\" git push origin master",
        re: pushRe,
      },
      {
        label: "second gated verb (gh pr merge)",
        command: "VAR='hello world' gh pr merge 4242 --squash",
        re: mergeRe,
      },
    ];
    for (const c of cases) {
      it(`${c.label}: normalises to a trigger match, raw stays a miss`, () => {
        // Raw MUST miss: these cases exist precisely because the raw
        // layer cannot span the quoted whitespace. If a future regex
        // edit makes raw match, this pin flags that the case now tests
        // nothing on the normalised layer and must move blocks.
        expect(c.re.test(c.command)).toBe(false);
        const { normalized } = normalizeCommand(c.command);
        expect(c.re.test(normalized)).toBe(true);
      });
    }
  });

  // Task 13e55484, behaviour-preservation pins: the assignment-value
  // continuation must engage ONLY on an unbalanced opening quote with a
  // later close. Everything else keeps the pre-task byte behaviour.
  describe("13e55484: quoted-assignment continuation does not change anything else", () => {
    const pushRe = policyBashMatch("preflight-before-push");
    it("unterminated quote keeps the pre-task one-token consume (never-unmatch)", () => {
      // `VAR='a git push ...` normalised to `git push ...` BEFORE this
      // task (the open quote never closes, so the old one-token consume
      // saw `git` as the head). That match must survive the fix.
      const cmd = "VAR='a git push origin master";
      expect(pushRe.test(normalizeCommand(cmd).normalized)).toBe(true);
    });
    it("a quoted assignment before a non-invocation stays byte-identical", () => {
      const cmd = "VAR='a b' foo bar";
      expect(normalizeCommand(cmd).normalized).toBe(cmd);
    });
    it("backslash-escaped whitespace WITHOUT quotes stays a bypass (task b093911d's class, deliberately not handled here)", () => {
      const cmd = "VAR=a\\ b git push origin master";
      expect(pushRe.test(cmd)).toBe(false);
      expect(pushRe.test(normalizeCommand(cmd).normalized)).toBe(false);
    });
    it("a boundary character INSIDE the quoted value stays a bypass (quote-unaware BOUNDARY_RE splits first; measured still-open residual)", () => {
      // BOUNDARY_RE segments the command BEFORE tokenisation and has no
      // quote awareness, so `VAR='a; b' git push` splits at the `;` and
      // neither resulting segment carries a recognisable invocation.
      // Same class as the closure but a different mechanism (segmenting,
      // not tokenising); halt criterion 1 puts BOUNDARY_RE out of this
      // task's budget, so the residual is pinned instead of closed.
      const cmd = "VAR='a; b' git push origin master";
      expect(pushRe.test(cmd)).toBe(false);
      expect(pushRe.test(normalizeCommand(cmd).normalized)).toBe(false);
    });
    it("accepted over-block: a quoted assignment inside TEXT after a boundary char now matches (fail-closed direction, decided not discovered)", () => {
      // The quote-unaware segment split puts `VAR='x y' git push` at a
      // segment start inside the string literal, and the continuation
      // now normalises it to a match. Direction is over-block (deny),
      // consistent with the module's KNOWN OVER-MATCHING stance; this
      // pin asserts the boundary of the accepted false-positive class.
      const cmd = "echo \"a; VAR='x y' git push\"";
      expect(pushRe.test(normalizeCommand(cmd).normalized)).toBe(true);
    });
  });

  // Task 13e55484, review round 1 (CRITICAL): differential regression
  // pins. The first shipped version of consumeAssignment diverged from
  // bash on ANSI-C quoting (`$'...\'...'` — bash escapes the quote, a
  // plain-'...' scanner closes on it), producing a phantom-open state
  // that swallowed the gated head token: each command below BLOCKED on
  // master and produced "no policy matched" with the un-guarded helper,
  // measured at the real hook entry point with PATH shims proving bash
  // executes the gated verb. The one-directional guard restores master's
  // one-token consume the moment the continuation would swallow a
  // recognised head token, so these must match (normalised) again.
  describe("13e55484 review round 1: continuation must never swallow a recognised head token", () => {
    const pushRe = policyBashMatch("preflight-before-push");
    const mergeRe = policyBashMatch("review-before-merge-bash");
    const killRe = policyBashMatch("deny-kill-switch-bypass");
    const cases: Array<{ label: string; command: string; re: RegExp }> = [
      {
        label: "ANSI-C phantom-open before the push gate",
        command: "A=$'don\\'t' env git push origin master # '",
        re: pushRe,
      },
      {
        label: "ANSI-C phantom-open before the merge gate",
        command: "A=$'don\\'t' env gh pr merge 4242 --squash # '",
        re: mergeRe,
      },
      {
        label: "ANSI-C phantom-open before the operator-only kill switch",
        command: "A=$'don\\'t' env harness pause # '",
        re: killRe,
      },
      {
        label: "wrapper-swallow: quoted value opening over a real git invocation",
        command: "env VAR='a git push origin master' foo",
        re: pushRe,
      },
    ];
    for (const c of cases) {
      it(`${c.label}: "${c.command}" matches via normalisation again`, () => {
        expect(c.re.test(c.command)).toBe(false);
        expect(c.re.test(normalizeCommand(c.command).normalized)).toBe(true);
      });
    }

    // Round-2 review: the guard is NOT a universal monotonicity
    // guarantee. When the continuation closes on a wrapper's glued flag
    // token, the peel resumes at that wrapper's next ARGUMENT and
    // breaks where master's peel completed. Every found member of the
    // class is a MASTER FALSE POSITIVE (PATH-shim-verified: bash treats
    // the quoted run as one assignment word and executes the next word,
    // never the gated verb), so the branch is the bash-accurate side.
    // Pinned so the class cannot silently widen into spellings where
    // bash DOES invoke the gated verb — if this pin starts failing,
    // re-measure with shims before accepting either direction.
    it("wrapper-argument-list resume: master-false-positive class stays unmatched (bash never runs the gated verb here)", () => {
      const cmd = "A='x timeout --signal=INT' 5 git push origin master";
      expect(pushRe.test(cmd)).toBe(false);
      expect(pushRe.test(normalizeCommand(cmd).normalized)).toBe(false);
    });
    // Round-2 review, complementary guard boundary: a PATH-QUALIFIED
    // head glued to the closing quote is NOT abandoned (the token is
    // `/usr/bin/git'`, which GIT_TOKEN_RE rejects), the continuation
    // completes, and the REAL invocation behind it matches — a measured
    // fail-closed GAIN over master (master allowed this real git push).
    it("path-qualified head glued to the closing quote: the real invocation behind it now matches (gain over master)", () => {
      const cmd = "VAR='a /usr/bin/git' git push origin master";
      expect(pushRe.test(cmd)).toBe(false);
      expect(pushRe.test(normalizeCommand(cmd).normalized)).toBe(true);
    });
  });

  // Task 13e55484, never-unmatch property with an ENGAGEMENT assurance
  // (the dbc6d303 lesson: a property test that never exercises the layer
  // under test certifies nothing). The corpus below re-lists every
  // matching spelling family this file already pins plus the new quoted
  // forms; the engagement assertion requires a minimum number of entries
  // to match ONLY via normalisation, so the property cannot rot into an
  // all-raw (vacuously additive) corpus.
  describe("13e55484: never-unmatch property over the matching corpus", () => {
    const re = policyBashMatch("preflight-before-investigation");
    const pushRe = policyBashMatch("preflight-before-push");
    const corpus: Array<{ command: string; re: RegExp; family?: "quoted-assign" }> = [
      { command: "git status", re },
      { command: "env git status", re },
      { command: "env -C /tmp/repo git status", re },
      { command: "env FOO=bar git status", re },
      { command: "FOO=bar git status", re },
      { command: "nice git status", re },
      { command: "nice -10 git status", re },
      { command: "sudo git status", re },
      { command: "timeout 5 git status", re },
      { command: "stdbuf -o0 git status", re },
      { command: "/usr/bin/git status", re },
      { command: "git  status", re },
      { command: "git --no-pager status", re },
      { command: "env --default-signal=INT git status", re },
      { command: "VAR='a git status", re },
      { command: "git push origin master", re: pushRe },
      { command: "FOO=bar git push origin master", re: pushRe },
      { command: "VAR='hello world' git push origin master", re: pushRe, family: "quoted-assign" },
      { command: "env VAR='a b' git push origin master", re: pushRe, family: "quoted-assign" },
      { command: "VAR='a b'\"c d\" git push origin master", re: pushRe, family: "quoted-assign" },
      { command: "A='x y' B=\"z w\" git push origin master", re: pushRe, family: "quoted-assign" },
      { command: "VAR='a\tb' nice git push origin master", re: pushRe, family: "quoted-assign" },
    ];
    it("every corpus entry matches raw-or-normalised", () => {
      for (const c of corpus) {
        const hit = c.re.test(c.command) || c.re.test(normalizeCommand(c.command).normalized);
        expect(hit, `corpus entry stopped matching: ${c.command}`).toBe(true);
      }
    });
    // Engagement assurance, reworked in review round 1: the first
    // version asserted ">=8 corpus entries match normalized-only" over
    // the WHOLE corpus — measured NOT load-bearing, because 12-13
    // pre-existing wrapper spellings satisfied it with every
    // quoted-assignment entry deleted (and the mutation probe left it
    // green). This version scopes the assurance to the family that
    // exercises consumeAssignment: every quoted-assign entry must match
    // ONLY via normalisation, and there must be at least 4 of them, so
    // disabling the continuation turns THIS assertion red.
    it("engagement assurance: every quoted-assign corpus entry matches ONLY via normalisation (>=4 entries)", () => {
      const family = corpus.filter((c) => c.family === "quoted-assign");
      expect(family.length).toBeGreaterThanOrEqual(4);
      for (const c of family) {
        expect(c.re.test(c.command), `raw unexpectedly matches: ${c.command}`).toBe(false);
        expect(
          c.re.test(normalizeCommand(c.command).normalized),
          `normalisation no longer closes: ${c.command}`,
        ).toBe(true);
      }
    });
  });
});

describe("normalizeCommandAmpAware (task aabbad63: closes the bare-& gating gap via a second normalisation pass)", () => {
  describe("closes the two measured bare-& bypasses BOUNDARY_RE cannot see", () => {
    it('"A=x&env -C /tmp git status" (glued ampersand, no space before the wrapper) normalises to a trigger match', () => {
      const re = policyBashMatch("preflight-before-investigation");
      const command = "A=x&env -C /tmp git status";
      // Genuinely a NEW match the third arm adds: both the raw form and
      // the EXISTING (BOUNDARY_RE) normalised form still miss.
      expect(re.test(command)).toBe(false);
      expect(re.test(normalizeCommand(command).normalized)).toBe(false);
      expect(re.test(normalizeCommandAmpAware(command).normalized)).toBe(true);
    });

    it('"echo hi & nice git status" (genuine bash background job) normalises to a trigger match', () => {
      const re = policyBashMatch("preflight-before-investigation");
      const command = "echo hi & nice git status";
      expect(re.test(command)).toBe(false);
      expect(re.test(normalizeCommand(command).normalized)).toBe(false);
      expect(re.test(normalizeCommandAmpAware(command).normalized)).toBe(true);
    });
  });

  // Fix round 1, finding F1: corrects an inaccurate closure claim measured
  // against a realistic corpus (7 wrappers {env, nice, sudo, command,
  // setsid, stdbuf, nohup} x 4 gated verbs x 2 shapes — `A=x&<wrapper>
  // <verb>` and `echo hi & <wrapper> <verb>` — 56 spellings): 28/56 were
  // ALREADY gated before this task (raw or the primary BOUNDARY_RE arm),
  // 52/56 gate after, a delta of 24 attributable to this arm alone, and 4
  // remain ungated — all of the shape pinned here. The pre-change 28/56 is
  // high because the shipped trigger regexes' own `(\w+=\S+\s+)*` leading-
  // assignment group lets `\S+` swallow a glued `&<wrapper>` (`A=x&nice git
  // push` already matched the RAW regex before this task ever ran), so the
  // GLUED family was never actually what this task closed — the
  // background-job family (`echo hi & <wrapper> <verb>`) is, and `nohup`
  // specifically stays out of reach of BOTH normalisation passes: it is not
  // one of `canonicalizeSegment`'s recognised wrapper names (`env`,
  // `command`, `nice`, `sudo`, `doas`, `time`, `timeout`, `stdbuf`,
  // `setsid`), a pre-existing, already-documented gap in the module
  // header's NOT-SUPPORTED list (`nohup git status` was measured as a
  // bypass back in task `ea8becf5`) — not something a boundary alphabet
  // (BOUNDARY_RE or AMP_BOUNDARY_RE) can reach, since the gap is in the
  // wrapper-name vocabulary, not the segmentation.
  describe("fix round 1, finding F1: 'echo hi & nohup <gated verb>' stays ungated (documented ceiling, not closed by either pass)", () => {
    const cases: Array<{ label: string; policyName: string; command: string }> = [
      {
        label: "preflight-before-investigation (read gate)",
        policyName: "preflight-before-investigation",
        command: "echo hi & nohup git status",
      },
      {
        label: "preflight-before-push",
        policyName: "preflight-before-push",
        command: "echo hi & nohup git push origin master",
      },
      {
        label: "deny-kill-switch-bypass (operator_only, no in-session recovery)",
        policyName: "deny-kill-switch-bypass",
        command: "echo hi & nohup harness pause",
      },
      // Fix round 2: these two complete the pin. The measured residual is
      // FOUR spellings, one per gated verb; round 1 pinned only two of
      // them (plus the read gate, which is not one of the four), so a
      // change to the merge or publish spelling could have passed
      // silently while the CHANGELOG claimed the residual was pinned.
      {
        label: "review-before-merge-bash",
        policyName: "review-before-merge-bash",
        command: "echo hi & nohup gh pr merge 1 --squash",
      },
      {
        label: "dogfood-before-release",
        policyName: "dogfood-before-release",
        command: "echo hi & nohup npm publish",
      },
    ];
    for (const c of cases) {
      it(`${c.label}: "${c.command}" does NOT normalise to a trigger match via either pass`, () => {
        const re = policyBashMatch(c.policyName);
        expect(re.test(c.command)).toBe(false);
        expect(re.test(normalizeCommand(c.command).normalized)).toBe(false);
        expect(re.test(normalizeCommandAmpAware(c.command).normalized)).toBe(false);
      });
    }
  });

  describe("return type carries no targetDir/targetBase (hard constraint: impossible to wire up by mistake)", () => {
    it("the returned object has exactly {normalized, truncated} — no targetDir/targetBase key at all", () => {
      const result = normalizeCommandAmpAware("git -C /x log 2>&1");
      expect(Object.keys(result).sort()).toEqual(["normalized", "truncated"]);
      expect("targetDir" in result).toBe(false);
      expect("targetBase" in result).toBe(false);
    });
  });

  // The primary pass's own targetDir invariants (git -C /x log 2>&1, etc.)
  // are pinned above in the "aabbad63 groundwork" describe block, which
  // exercises ONLY `normalizeCommand` — never this function. Nothing here
  // duplicates those; this just confirms this function has no field for a
  // future consumer to misread in the first place (previous describe
  // block) rather than re-asserting the primary pass is unaffected.

  describe("AMP_BOUNDARY_RE alternation order (&& must stand left of bare &)", () => {
    // MEASURED (see the regex's own module comment): for this module's
    // segment-and-rejoin architecture, swapping this order does NOT
    // change `normalizeCommandAmpAware`'s own `.normalized` output for
    // any input tried (a genuine `&&` is two ADJACENT `&` characters, so
    // two single-character boundary matches sandwich an always-empty,
    // no-op segment) — verified directly by temporarily swapping the
    // alternation, rebuilding, and diffing output on several `&&`-bearing
    // commands. So the meaningful pin is on the regex's own match
    // behaviour, not on the string it feeds into.
    //
    // Fix round 1, finding F9: exec a CLONE of the exported regex, not the
    // shared module-level object itself. `AMP_BOUNDARY_RE` is exported and
    // consumed elsewhere (`findNextBoundary`, `segmentAndCanonicalize`) as a
    // `/g` regex with mutable `lastIndex` state; execing the shared object
    // directly here would leave `lastIndex` non-zero for whatever runs
    // next. `new RegExp(AMP_BOUNDARY_RE.source, AMP_BOUNDARY_RE.flags)`
    // still pins THIS source's actual alternation, it just does not touch
    // the shared object's own scan position.
    //
    // Fix round 2: the prior wording here claimed a swapped order reddens
    // "these two tests". Measured, it reddens exactly ONE — the `&&` test
    // below (`expected '&' to be '&&'`). The lone-`&` test stays green
    // under the swap, because a single `&` with no adjacent second one
    // matches identically whichever alternative the engine tries first;
    // it is order-INSENSITIVE by construction and exists to pin the
    // single-character token, not the ordering. Only the `&&` test is the
    // ordering pin.
    it("matches && as ONE two-character token, not two consecutive bare-& tokens", () => {
      const re = new RegExp(AMP_BOUNDARY_RE.source, AMP_BOUNDARY_RE.flags);
      const m = re.exec("git status && git log");
      expect(m?.[0]).toBe("&&");
    });

    it("a lone & with no adjacent second & still matches as a single-character token", () => {
      const re = new RegExp(AMP_BOUNDARY_RE.source, AMP_BOUNDARY_RE.flags);
      const m = re.exec("echo hi & nice git status");
      expect(m?.[0]).toBe("&");
    });
  });

  describe("MAX_NORMALIZE_LENGTH bound (same contract as normalizeCommand)", () => {
    it("skips normalisation and reports truncated:true above the length bound", () => {
      const big = "a".repeat(100_001);
      const result = normalizeCommandAmpAware(big);
      expect(result.truncated).toBe(true);
      expect(result.normalized).toBe(big);
    });

    it("does not truncate at exactly the bound", () => {
      const atBound = "a".repeat(100_000);
      expect(normalizeCommandAmpAware(atBound).truncated).toBe(false);
    });
  });

  describe("never throws (same fail-safe contract as normalizeCommand)", () => {
    it("returns the empty string unchanged for an empty command", () => {
      expect(normalizeCommandAmpAware("")).toEqual({ normalized: "", truncated: false });
    });

    it("returns a non-string input coerced to the empty-string fallback (defensive)", () => {
      // @ts-expect-error deliberately probing the runtime guard with a non-string
      expect(normalizeCommandAmpAware(null)).toEqual({ normalized: "", truncated: false });
    });
  });

  // Fail-CLOSED false-positive cost, measured and named rather than
  // implied (hard constraint / honesty rule): the amp pass is
  // quote-unaware, same as BOUNDARY_RE, so a wrapper spelling sitting
  // behind a bare `&` INSIDE a quoted string can now be peeled and
  // canonicalised as though it were a real invocation. This BLOCKS a
  // harmless `echo` that merely PRINTS the spelling — never a missed
  // real gate, but a real, measured cost, not "no false positives".
  describe("known false-positive cost of the amp pass (fail-closed, expected)", () => {
    it('echo "x & nice git push" is picked up by the push gate\'s trigger via the amp pass alone', () => {
      const re = policyBashMatch("preflight-before-push");
      const command = 'echo "x & nice git push"';
      expect(re.test(command)).toBe(false);
      expect(re.test(normalizeCommand(command).normalized)).toBe(false);
      expect(re.test(normalizeCommandAmpAware(command).normalized)).toBe(true);
    });

    it('echo "a & nice npm publish" is picked up by the release gate\'s trigger via the amp pass alone', () => {
      const re = policyBashMatch("dogfood-before-release");
      const command = 'echo "a & nice npm publish"';
      expect(re.test(command)).toBe(false);
      expect(re.test(normalizeCommand(command).normalized)).toBe(false);
      expect(re.test(normalizeCommandAmpAware(command).normalized)).toBe(true);
    });
  });

  describe("the quoted-value family still matches via the EXISTING pass, unaffected by the amp pass's existence", () => {
    it("env FOO='a&b' git push origin master matches via the existing (BOUNDARY_RE) pass alone", () => {
      const re = policyBashMatch("preflight-before-push");
      const command = "env FOO='a&b' git push origin master";
      expect(re.test(normalizeCommand(command).normalized)).toBe(true);
    });

    it("nice FOO='x & y' harness pause matches via the existing (BOUNDARY_RE) pass alone", () => {
      const re = policyBashMatch("deny-kill-switch-bypass");
      const command = "nice FOO='x & y' harness pause";
      expect(re.test(normalizeCommand(command).normalized)).toBe(true);
    });
  });
});

// T-002 of run 2026-08-02-per-repo-gate-scoping-redesign (task `98ad072f`
// groundwork): the per-segment view export. `normalizeCommand`'s own
// `targetDir`/`targetBase` behaviour is untouched by any of this — see the
// "existing behaviour is unaffected" describe block below, which re-runs a
// representative slice of the pre-existing `targetDir extraction` /
// `G1` fixtures through `normalizeCommand` alone to pin that explicitly.
describe("segmentViewOf", () => {
  // The K1 divergence table's 8 forms, docs/okf/quote-model-divergence.md
  // (`bash-prefix-parse.cdTarget` vs. `command-normalize.targetDir`, "6 of
  // 8 divergent"): 7 rows are printed in the doc's table (the 8th, a bare
  // `git status` with no cd and no own target, is the boring baseline both
  // models already agree is `null` and is omitted from a table whose whole
  // point is to show divergence — included here for completeness). This
  // describe block asserts what `segmentViewOf` — a THIRD, deliberately
  // more conservative model — computes for the segment carrying the git
  // invocation in each form, per `CommandSegment.effectiveTarget`'s own
  // composition rules.
  describe("K1 8-forms table (docs/okf/quote-model-divergence.md)", () => {
    it("cd <T> && git status -> T (absolute cd basis adopted by the bare git segment)", () => {
      const segs = segmentViewOf("cd /tmp/repoD && git status");
      expect(segs).not.toBeNull();
      expect(segs![1]!.effectiveTarget).toBe("/tmp/repoD");
      expect(segs![1]!.ownTarget).toBe(null);
    });

    it("cd ~ && git status -> null (tilde cd target resets the basis to null, not left at whatever preceded it)", () => {
      const segs = segmentViewOf("cd ~ && git status");
      expect(segs).not.toBeNull();
      expect(segs![0]!.ownTarget).toBe(null);
      expect(segs![0]!.effectiveTarget).toBe(null);
      expect(segs![1]!.effectiveTarget).toBe(null);
    });

    // D-014 (fix round, run 2026-08-02-per-repo-gate-scoping-redesign): the
    // test right above never actually exercises "not left at whatever
    // preceded it" — there is nothing preceding it to leave stale (no
    // earlier `cd` at all), so pre-fix code passed it vacuously too (an
    // unset basis inheriting is still null either way). THIS test
    // establishes a REAL preceding basis first, so reset-vs-inherit is
    // genuinely discriminated. RED against pre-fix `computeSegmentTarget`
    // (measured: the trailing git-status segment's `effectiveTarget` was
    // `"/tmp/repoD"`, the STALE preceding basis, not `null`).
    it("cd /tmp/repoD && cd ~ && git status -> null: the tilde cd RESETS a real preceding basis, does not inherit it", () => {
      const segs = segmentViewOf("cd /tmp/repoD && cd ~ && git status");
      expect(segs).not.toBeNull();
      expect(segs![0]!.effectiveTarget).toBe("/tmp/repoD"); // the real preceding basis, established
      expect(segs![1]!.ownTarget).toBe(null); // the tilde cd itself names nothing
      expect(segs![1]!.effectiveTarget).toBe(null); // and does not inherit /tmp/repoD either
      expect(segs![2]!.text).toBe("git status");
      expect(segs![2]!.effectiveTarget).toBe(null); // the reset reaches the later segment
    });

    it("git -C <T> status (no cd) -> T (absolute own target)", () => {
      const segs = segmentViewOf("git -C /tmp/repoB status");
      expect(segs).not.toBeNull();
      expect(segs![0]!.ownTarget).toBe("/tmp/repoB");
      expect(segs![0]!.effectiveTarget).toBe("/tmp/repoB");
    });

    // D-017 (fix round 2, run 2026-08-02-per-repo-gate-scoping-redesign):
    // this test previously pinned `effectiveTarget` at "/tmp/repoB" as
    // CORRECT — that was the pre-fix defect, not a spec. `--work-tree`
    // sets a git invocation's working tree but does NOT relocate its
    // `--git-dir` search: `git --work-tree=/tmp/repoB status` still
    // operates on whatever repo the invocation's ACTUAL directory names,
    // never `/tmp/repoB` alone. Pass-2 review measured this pin's old
    // value feeding a live cross-repo fail-open once `ownTarget`/
    // `effectiveTarget` were wired to `resolveAttributedContexts`'
    // REPLACE branch (D-011): `git --work-tree=<B> push` from cwd A was
    // attributed to B alone, dropping the cwd (A) demand a real `git
    // push` there still has to satisfy. `null` here (falling through to
    // whatever cd-basis was known, none in this no-cd case) is the fix,
    // not a regression — same cwd-fallback shape D-003 already documents
    // for every other unattributable form.
    it("git --work-tree=<T> status (no cd) -> null (--work-tree is NOT a repo-relocating flag, D-017)", () => {
      const segs = segmentViewOf("git --work-tree=/tmp/repoB status");
      expect(segs).not.toBeNull();
      expect(segs![0]!.ownTarget).toBe(null);
      expect(segs![0]!.effectiveTarget).toBe(null);
    });

    it("git --git-dir=<T>/.git status (no cd) -> T (parent-of-.git, same as targetDir)", () => {
      const segs = segmentViewOf("git --git-dir=/tmp/repoC/.git status");
      expect(segs).not.toBeNull();
      expect(segs![0]!.ownTarget).toBe("/tmp/repoC");
      expect(segs![0]!.effectiveTarget).toBe("/tmp/repoC");
    });

    // D-017: the combo case — `--git-dir` IS repo-relocating, `--work-
    // tree` is not, so attribution follows `--git-dir` (A), never the
    // work-tree (B), regardless of which flag appears first on the
    // command line (the priority is "which FLAG produced the value", not
    // "which flag came first" — `--work-tree` never contributes to this
    // field at all).
    it("git --git-dir=<A>/.git --work-tree=<B> status -> A (--git-dir wins, --work-tree ignored for identity)", () => {
      const segs = segmentViewOf("git --git-dir=/tmp/repoA/.git --work-tree=/tmp/repoB status");
      expect(segs).not.toBeNull();
      expect(segs![0]!.ownTarget).toBe("/tmp/repoA");
      expect(segs![0]!.effectiveTarget).toBe("/tmp/repoA");
    });

    it("git --work-tree=<B> --git-dir=<A>/.git status -> A even with --work-tree spelled first (order-independent)", () => {
      const segs = segmentViewOf("git --work-tree=/tmp/repoB --git-dir=/tmp/repoA/.git status");
      expect(segs).not.toBeNull();
      expect(segs![0]!.ownTarget).toBe("/tmp/repoA");
      expect(segs![0]!.effectiveTarget).toBe("/tmp/repoA");
    });

    it("env -C <T> git status (no cd) -> T", () => {
      const segs = segmentViewOf("env -C /tmp/repoA git status");
      expect(segs).not.toBeNull();
      expect(segs![0]!.effectiveTarget).toBe("/tmp/repoA");
    });

    // D-017: `env -C` DOES relocate (it chdirs before running git), so it
    // still wins as the identity target even when the SAME invocation
    // also carries a `--work-tree` — the work-tree flag simply never
    // competes for this field.
    it("env -C <A> git --work-tree=<B> status -> A (env -C relocates, --work-tree does not)", () => {
      const segs = segmentViewOf("env -C /tmp/repoA git --work-tree=/tmp/repoB status");
      expect(segs).not.toBeNull();
      expect(segs![0]!.ownTarget).toBe("/tmp/repoA");
      expect(segs![0]!.effectiveTarget).toBe("/tmp/repoA");
    });

    // D-017: a preceding `cd` DOES persist (bash-truthful — this module's
    // whole cd-basis mechanism), so `--work-tree` on the later git
    // invocation still does not override it: the segment falls through to
    // "no own target -> inherits the incoming cd-basis" exactly like a
    // bare `git status` after a `cd` would.
    it("cd <A> && git --work-tree=<B> status -> A (inherits the cd basis; --work-tree does not redirect it)", () => {
      const segs = segmentViewOf("cd /tmp/repoA && git --work-tree=/tmp/repoB status");
      expect(segs).not.toBeNull();
      expect(segs![1]!.ownTarget).toBe(null);
      expect(segs![1]!.effectiveTarget).toBe("/tmp/repoA");
    });

    it("cd <T> && git -C sub status -> null (K1 divergence case: relative own target after a known cd basis is UNATTRIBUTABLE, not composed to T/sub)", () => {
      const segs = segmentViewOf("cd /tmp/T && git -C sub status");
      expect(segs).not.toBeNull();
      expect(segs![0]!.effectiveTarget).toBe("/tmp/T");
      expect(segs![1]!.ownTarget).toBe("sub");
      expect(segs![1]!.effectiveTarget).toBe(null);
    });

    it("git status (bare, no cd, no own target) -> null (the boring baseline both bp and cn already agree on)", () => {
      const segs = segmentViewOf("git status");
      expect(segs).not.toBeNull();
      expect(segs![0]!.ownTarget).toBe(null);
      expect(segs![0]!.effectiveTarget).toBe(null);
    });
  });

  describe("-C . and absolute paths stay as ownTarget verbatim (resolution against cwd is a future consumer's job)", () => {
    it("git -C . status, no preceding cd -> ownTarget and effectiveTarget are both '.'", () => {
      const segs = segmentViewOf("git -C . status");
      expect(segs).not.toBeNull();
      expect(segs![0]!.ownTarget).toBe(".");
      expect(segs![0]!.effectiveTarget).toBe(".");
    });

    it("git -C sub status, no preceding cd -> ownTarget and effectiveTarget both stay the raw relative value", () => {
      const segs = segmentViewOf("git -C sub status");
      expect(segs).not.toBeNull();
      expect(segs![0]!.ownTarget).toBe("sub");
      expect(segs![0]!.effectiveTarget).toBe("sub");
    });

    it("git -C /tmp/repoB status -> absolute ownTarget always wins as effectiveTarget", () => {
      const segs = segmentViewOf("git -C /tmp/repoB status");
      expect(segs![0]!.effectiveTarget).toBe("/tmp/repoB");
    });
  });

  // Orchestrator follow-up after the initial T-002 round (07-27 review
  // precedent: "relative and ~ target dirs resolve to a confidently wrong
  // repo"): a same-invocation `env -C <base>` + relative own `-C` mix must
  // NOT hand a future consumer a raw relative value that consumer would
  // resolve against ITS OWN cwd — that would land on a repo unrelated to
  // the `<base>` the command itself named. Pinned in both directions.
  describe("same-invocation env -C base + relative own -C is unattributable (both fields null, never the raw relative value)", () => {
    it("(i) env -C /tmp/base git -C sub status -> ownTarget and effectiveTarget are both null (the mixed case)", () => {
      const segs = segmentViewOf("env -C /tmp/base git -C sub status");
      expect(segs).not.toBeNull();
      expect(segs![0]!.ownTarget).toBe(null);
      expect(segs![0]!.effectiveTarget).toBe(null);
    });

    it("(ii) env -C /tmp/base git status (no relative own -C) -> ownTarget/effectiveTarget stay /tmp/base, unaffected", () => {
      const segs = segmentViewOf("env -C /tmp/base git status");
      expect(segs).not.toBeNull();
      expect(segs![0]!.ownTarget).toBe("/tmp/base");
      expect(segs![0]!.effectiveTarget).toBe("/tmp/base");
    });

    it("(iii) git -C sub status with NO env -C base at all -> still the raw relative value 'sub' (the pre-existing deferred rule)", () => {
      const segs = segmentViewOf("git -C sub status");
      expect(segs).not.toBeNull();
      expect(segs![0]!.ownTarget).toBe("sub");
      expect(segs![0]!.effectiveTarget).toBe("sub");
    });

    it("a preceding cd basis does not rescue the mixed case either — the env -C/relative-own-C check applies first and independently", () => {
      const segs = segmentViewOf("cd /tmp/X && env -C /tmp/base git -C sub status");
      expect(segs).not.toBeNull();
      expect(segs![0]!.effectiveTarget).toBe("/tmp/X"); // the cd segment itself, unaffected
      expect(segs![1]!.ownTarget).toBe(null);
      expect(segs![1]!.effectiveTarget).toBe(null);
    });
  });

  // D-017 differential table (fix round 2, run 2026-08-02-per-repo-gate-
  // scoping-redesign, missing_test adopted from pass-2 review): a single
  // pass over the git-global-option matrix that names, per option, whether
  // it is REPO-RELOCATING (contributes to `ownTarget`/`effectiveTarget`) or
  // repo-NEUTRAL (does not) — so a future path-valued option added to
  // `peelGitGlobalOptions` without updating `relocateTargetDir` shows up
  // here as a silent flip from `null` to a real path, not just a missing
  // dedicated test. All cases run with NO preceding cd (isolates the
  // per-invocation flag classification from cd-basis composition, already
  // covered separately above).
  describe("D-017: repo-relocating vs repo-neutral git global options (differential, no preceding cd)", () => {
    const cases: Array<{ label: string; command: string; expectedTarget: string | null }> = [
      { label: "-C <dir> (relocating)", command: "git -C /tmp/repoX status", expectedTarget: "/tmp/repoX" },
      {
        label: "env -C <dir> (relocating, wraps the invocation)",
        command: "env -C /tmp/repoX git status",
        expectedTarget: "/tmp/repoX",
      },
      {
        label: "--git-dir=<dir>/.git (relocating, parent-of-.git)",
        command: "git --git-dir=/tmp/repoX/.git status",
        expectedTarget: "/tmp/repoX",
      },
      {
        label: "--work-tree=<dir> ALONE (NOT relocating, D-017)",
        command: "git --work-tree=/tmp/repoX status",
        expectedTarget: null,
      },
      {
        label: "--git-dir=<dir>/.git + --work-tree=<other> (relocating flag wins)",
        command: "git --git-dir=/tmp/repoX/.git --work-tree=/tmp/repoOTHER status",
        expectedTarget: "/tmp/repoX",
      },
      // D-018 (fix round 3, pass-3 CRITICAL) rows, adopted per the review's
      // "extend the D-017 differential table" missing test: more than one
      // repo-relocating option is unattributable, never a first-token
      // guess — so a future regression that reinstates first-wins flips
      // these two rows from `null` back to a real path.
      {
        label: "-C <B> -C <A> (two -C, DIVERGENT: unattributable, D-018)",
        command: "git -C /tmp/repoB -C /tmp/repoA status",
        expectedTarget: null,
      },
      {
        label: "-C <X> + --git-dir=<X>/.git (idempotent SAME value: stays X, D-018)",
        command: "git -C /tmp/repoX --git-dir=/tmp/repoX/.git status",
        expectedTarget: "/tmp/repoX",
      },
    ];
    for (const c of cases) {
      it(`${c.label}: "${c.command}" -> ownTarget/effectiveTarget = ${JSON.stringify(c.expectedTarget)}`, () => {
        const segs = segmentViewOf(c.command);
        expect(segs).not.toBeNull();
        expect(segs![0]!.ownTarget).toBe(c.expectedTarget);
        expect(segs![0]!.effectiveTarget).toBe(c.expectedTarget);
      });
    }
  });

  // D-018 (fix round 3, pass-3 CRITICAL, run 2026-08-02-per-repo-gate-
  // scoping-redesign): pass 3 measured (against real git 2.34.1) that
  // `git -C <forge> -C <realA> push` was attributed to the FIRST `-C`
  // (`<forge>`) while git composes ALL `-C`/`--git-dir` options
  // cumulatively and actually runs in `<realA>` — letting an agent name a
  // decoy repo first and have a gate's evidence demand follow it instead
  // of the repo the verb truly targets. The fix confines the own-target
  // REPLACE (`relocateTargetDir`) to invocations naming EXACTLY ONE
  // resolved repo-relocating option; two or more (in any combination, or
  // via a wrapping `env -C` that diverges from git's own flag) fall back
  // to unattributable (`null`) — the same cwd-fallback shape D-003
  // already documents for every other unattributable form, never worse
  // than the shipped cwd-only engine.
  describe("D-018: more than one repo-relocating option is unattributable, not a first-token guess (fix round 3, pass-3 CRITICAL)", () => {
    it("git -C <B> -C <A> status -> null (RED before the fix: was <B>, the first -C, not what real git runs in)", () => {
      const segs = segmentViewOf("git -C /tmp/repoB -C /tmp/repoA status");
      expect(segs).not.toBeNull();
      expect(segs![0]!.ownTarget).toBe(null);
      expect(segs![0]!.effectiveTarget).toBe(null);
    });

    it("git -C <B> -C ../A status -> null (second -C RELATIVE: still two options, not composed to a guessed path)", () => {
      const segs = segmentViewOf("git -C /tmp/repoB -C ../A status");
      expect(segs).not.toBeNull();
      expect(segs![0]!.ownTarget).toBe(null);
      expect(segs![0]!.effectiveTarget).toBe(null);
    });

    it("git -C <B> --git-dir=<A>/.git status -> null (-C then --git-dir, divergent)", () => {
      const segs = segmentViewOf("git -C /tmp/repoB --git-dir=/tmp/repoA/.git status");
      expect(segs).not.toBeNull();
      expect(segs![0]!.ownTarget).toBe(null);
      expect(segs![0]!.effectiveTarget).toBe(null);
    });

    it("git --git-dir=<A>/.git -C <B> status -> null (--git-dir then -C, order-independent, divergent)", () => {
      const segs = segmentViewOf("git --git-dir=/tmp/repoA/.git -C /tmp/repoB status");
      expect(segs).not.toBeNull();
      expect(segs![0]!.ownTarget).toBe(null);
      expect(segs![0]!.effectiveTarget).toBe(null);
    });

    it("git --git-dir=<A>/.git --git-dir=<B>/.git status -> null (--git-dir doubled, divergent)", () => {
      const segs = segmentViewOf("git --git-dir=/tmp/repoA/.git --git-dir=/tmp/repoB/.git status");
      expect(segs).not.toBeNull();
      expect(segs![0]!.ownTarget).toBe(null);
      expect(segs![0]!.effectiveTarget).toBe(null);
    });

    it("env -C <A> git -C <B> status -> null (env -C wrap diverges from git's own absolute -C)", () => {
      const segs = segmentViewOf("env -C /tmp/repoA git -C /tmp/repoB status");
      expect(segs).not.toBeNull();
      expect(segs![0]!.ownTarget).toBe(null);
      expect(segs![0]!.effectiveTarget).toBe(null);
    });

    it("env -C <A> git -C <A> status -> A (env -C wrap AGREES with git's own -C: idempotent, not ambiguous)", () => {
      const segs = segmentViewOf("env -C /tmp/repoA git -C /tmp/repoA status");
      expect(segs).not.toBeNull();
      expect(segs![0]!.ownTarget).toBe("/tmp/repoA");
      expect(segs![0]!.effectiveTarget).toBe("/tmp/repoA");
    });

    it("git -C <X> -C <X> status -> X (same value repeated: idempotent, not ambiguous)", () => {
      const segs = segmentViewOf("git -C /tmp/repoX -C /tmp/repoX status");
      expect(segs).not.toBeNull();
      expect(segs![0]!.ownTarget).toBe("/tmp/repoX");
      expect(segs![0]!.effectiveTarget).toBe("/tmp/repoX");
    });

    it("git -C <X> status (single -C, unaffected regression check) -> X", () => {
      const segs = segmentViewOf("git -C /tmp/repoX status");
      expect(segs).not.toBeNull();
      expect(segs![0]!.ownTarget).toBe("/tmp/repoX");
      expect(segs![0]!.effectiveTarget).toBe("/tmp/repoX");
    });

    it("git --git-dir=<X>/.git status (single --git-dir, unaffected regression check) -> X", () => {
      const segs = segmentViewOf("git --git-dir=/tmp/repoX/.git status");
      expect(segs).not.toBeNull();
      expect(segs![0]!.ownTarget).toBe("/tmp/repoX");
      expect(segs![0]!.effectiveTarget).toBe("/tmp/repoX");
    });

    it("cwd=A, -C B -C A push: cd-basis unaffected, still falls through to whatever preceding cd named (none here) -> null, same as bare unattributable", () => {
      const segs = segmentViewOf("git -C /tmp/repoB -C /tmp/repoA push");
      expect(segs).not.toBeNull();
      expect(segs![0]!.effectiveTarget).toBe(null);
    });
  });

  describe("multi-segment cd-basis propagation across every BOUNDARY_RE separator", () => {
    const cases: Array<{ label: string; command: string }> = [
      { label: "&&", command: "cd /tmp/repoD && git status" },
      { label: ";", command: "cd /tmp/repoD ; git status" },
      { label: "\\n", command: "cd /tmp/repoD\ngit status" },
      { label: "( (subshell)", command: "cd /tmp/repoD && (git status)" },
    ];
    for (const c of cases) {
      it(`separator ${c.label}: the cd basis reaches the later git segment`, () => {
        const segs = segmentViewOf(c.command);
        expect(segs).not.toBeNull();
        const gitSeg = segs!.find((s) => /\bgit status\)?$/.test(s.text));
        expect(gitSeg).toBeDefined();
        expect(gitSeg!.effectiveTarget).toBe("/tmp/repoD");
      });
    }

    // D-014 (fix round, run 2026-08-02-per-repo-gate-scoping-redesign):
    // REPLACES the pre-fix pin, which asserted the basis propagating
    // across a bare `|` (mirroring the OLD aggregate's G1 "same directory"
    // precedent) — that was the measured shape of the CRITICAL bypass this
    // fix round closes: `cd <forged> | git push` genuinely runs `git push`
    // at the real cwd (each side of a pipe is bash's own subshell; a `cd`
    // on one side cannot affect the other), so a basis that crossed `|`
    // let the attribution point at a forged target the real push never
    // touched. RED against pre-fix `computeSegmentTarget` (measured: the
    // git-status segment's `effectiveTarget` was `"/tmp/repoD"`, not
    // `null`, before this fix round's basis-tracking change) — this is
    // NOT the same "same directory" precedent the old aggregate's G1 rule
    // uses for a non-cd segment; that rule is about a READ that never
    // itself changes directory, not about a `cd`'s effect crossing a pipe
    // boundary.
    it("separator | (bare pipe): the cd basis does NOT cross it — each side of a pipe is its own subshell", () => {
      const segs = segmentViewOf("cd /tmp/repoD | git status");
      expect(segs).not.toBeNull();
      const gitSeg = segs!.find((s) => /\bgit status\)?$/.test(s.text));
      expect(gitSeg).toBeDefined();
      expect(gitSeg!.effectiveTarget).toBe(null);
    });

    // D-014: a subshell's `cd` stops applying once the subshell closes —
    // measured bypass shape: `(cd <forged> ; echo hi) && git push` let
    // `<forged>` reach `git push`, which bash actually runs at the real
    // cwd after the subshell exits. RED against pre-fix code (no `)`
    // boundary handling at all — the basis carried straight through).
    it("subshell close ')' resets the basis for everything AFTER it, while the segment ending in ')' still sees the basis itself", () => {
      const segs = segmentViewOf("(cd /tmp/repoD ; echo hi) && git status");
      expect(segs).not.toBeNull();
      // "echo hi)" is still inside the (still-open, from its own
      // perspective) subshell — its own effectiveTarget correctly reflects
      // the basis, unaffected (irrelevant for gating, echo isn't a trigger,
      // but proves the reset is scoped to what carries FORWARD, not this
      // segment's own attribution).
      const echoSeg = segs!.find((s) => s.text.includes("echo hi"));
      expect(echoSeg).toBeDefined();
      expect(echoSeg!.effectiveTarget).toBe("/tmp/repoD");
      const gitSeg = segs!.find((s) => s.text === "git status");
      expect(gitSeg).toBeDefined();
      expect(gitSeg!.effectiveTarget).toBe(null);
    });

    it("a non-cd segment between two cd segments does not reset the basis on its own", () => {
      // "echo hi" never changes directory; the basis established by the
      // leading cd must still reach the trailing git segment.
      const segs = segmentViewOf("cd /tmp/repoD && echo hi && git status");
      expect(segs).not.toBeNull();
      expect(segs![2]!.text).toBe("git status");
      expect(segs![2]!.effectiveTarget).toBe("/tmp/repoD");
    });

    it("a second cd overrides the first for everything after it", () => {
      const segs = segmentViewOf("cd /tmp/repoD && cd /tmp/repoE && git status");
      expect(segs).not.toBeNull();
      expect(segs![2]!.effectiveTarget).toBe("/tmp/repoE");
    });
  });

  describe("unattributable forms (all -> null, never a guess)", () => {
    it("~-prefixed cd target", () => {
      const segs = segmentViewOf("cd ~/repo && git status");
      expect(segs).not.toBeNull();
      expect(segs![0]!.ownTarget).toBe(null);
      expect(segs![1]!.effectiveTarget).toBe(null);
    });

    it("~-prefixed git -C target", () => {
      const segs = segmentViewOf("git -C ~/repo status");
      expect(segs).not.toBeNull();
      expect(segs![0]!.ownTarget).toBe(null);
      expect(segs![0]!.effectiveTarget).toBe(null);
    });

    it("quoted git -C value (double-quoted, no internal whitespace) -> null, not the quote-included garbage the old aggregate's targetDir still carries", () => {
      const command = 'git -C "/tmp/repoB" status';
      expect(normalizeCommand(command).targetDir).toBe('"/tmp/repoB"'); // pre-existing, unchanged aggregate behaviour
      const segs = segmentViewOf(command);
      expect(segs).not.toBeNull();
      expect(segs![0]!.ownTarget).toBe(null);
      expect(segs![0]!.effectiveTarget).toBe(null);
    });

    it("quoted+whitespace git -C value (single-quoted, internal whitespace) -> null on every fragment", () => {
      const segs = segmentViewOf("git -C '/tmp/repo B' status");
      expect(segs).not.toBeNull();
      for (const seg of segs!) {
        expect(seg.ownTarget).toBe(null);
        expect(seg.effectiveTarget).toBe(null);
      }
    });

    it("quoted cd target (single-quoted, internal whitespace) -> null, not the dequoted value the old aggregate's leadingCd still carries", () => {
      const command = "cd '/tmp/repo B' && git status";
      expect(normalizeCommand(command).targetDir).toBe("/tmp/repo B"); // pre-existing, unchanged aggregate behaviour
      const segs = segmentViewOf(command);
      expect(segs).not.toBeNull();
      expect(segs![0]!.ownTarget).toBe(null);
      expect(segs![1]!.effectiveTarget).toBe(null);
    });

    it("command substitution in a cd target ($(pwd)/T) -> null on every fragment, not the bare '$' fragment left by the boundary split", () => {
      const segs = segmentViewOf("cd $(pwd)/T && git status");
      expect(segs).not.toBeNull();
      for (const seg of segs!) {
        expect(seg.ownTarget).toBe(null);
        expect(seg.effectiveTarget).toBe(null);
      }
    });

    it("command substitution in a git -C target ($(pwd)/sub) -> null (already isGit:false via the pre-existing malformed/no-subcommand path)", () => {
      const segs = segmentViewOf("git -C $(pwd)/sub status");
      expect(segs).not.toBeNull();
      for (const seg of segs!) {
        expect(seg.ownTarget).toBe(null);
        expect(seg.effectiveTarget).toBe(null);
      }
    });

    it("backtick command substitution in a cd target -> null", () => {
      const segs = segmentViewOf("cd `pwd` && git status");
      expect(segs).not.toBeNull();
      expect(segs![0]!.ownTarget).toBe(null);
      expect(segs![1]!.effectiveTarget).toBe(null);
    });

    it("bare cd with no argument -> names nothing itself", () => {
      const segs = segmentViewOf("cd && git status");
      expect(segs).not.toBeNull();
      expect(segs![0]!.ownTarget).toBe(null);
      expect(segs![0]!.effectiveTarget).toBe(null);
      expect(segs![1]!.effectiveTarget).toBe(null);
    });

    // D-014 (fix round, run 2026-08-02-per-repo-gate-scoping-redesign): the
    // test right above never actually exercises "does not touch the
    // basis" in a way that could tell RESET apart from INHERIT — there is
    // no preceding basis to either touch or leave alone (null either way).
    // A bare `cd` genuinely changes directory (to `$HOME`), so it must
    // RESET a real preceding basis, not silently keep carrying it forward.
    // RED against pre-fix `computeSegmentTarget` (measured: the trailing
    // git-status segment's `effectiveTarget` was `"/tmp/repoD"`, not
    // `null` — the pre-fix code left a bare `cd` untouched as "not
    // cd-shaped", which passed the basis through unchanged).
    it("cd /tmp/repoD && cd && git status -> null: a bare cd RESETS a real preceding basis (it moves to $HOME)", () => {
      const segs = segmentViewOf("cd /tmp/repoD && cd && git status");
      expect(segs).not.toBeNull();
      expect(segs![0]!.effectiveTarget).toBe("/tmp/repoD");
      expect(segs![1]!.ownTarget).toBe(null);
      expect(segs![1]!.effectiveTarget).toBe(null);
      expect(segs![2]!.text).toBe("git status");
      expect(segs![2]!.effectiveTarget).toBe(null);
    });

    it("cd with a flag -> not recognised as cd-shaped (three tokens, not two)", () => {
      const segs = segmentViewOf("cd -P /tmp/x && git status");
      expect(segs).not.toBeNull();
      expect(segs![0]!.ownTarget).toBe(null);
      expect(segs![1]!.effectiveTarget).toBe(null);
    });

    // D-014, same discipline as the bare-`cd` pair right above: a flagged
    // `cd` (`cd -P /tmp/x`) genuinely changes directory too — it must
    // RESET a real preceding basis, not inherit it. RED against pre-fix
    // code (measured: `"/tmp/repoD"`, not `null`, for the trailing
    // git-status segment).
    it("cd /tmp/repoD && cd -P /tmp/x && git status -> null: a flagged cd RESETS a real preceding basis", () => {
      const segs = segmentViewOf("cd /tmp/repoD && cd -P /tmp/x && git status");
      expect(segs).not.toBeNull();
      expect(segs![0]!.effectiveTarget).toBe("/tmp/repoD");
      expect(segs![1]!.ownTarget).toBe(null);
      expect(segs![1]!.effectiveTarget).toBe(null);
      expect(segs![2]!.text).toBe("git status");
      expect(segs![2]!.effectiveTarget).toBe(null);
    });

    // D-014: `pushd`/`popd` are not tracked as directory-changing by this
    // module's own OWN-target extraction (module header: "pushd/popd ...
    // mirrors bash-prefix-parse.ts's own scope"), but both genuinely
    // change the shell's directory — a real preceding basis must not
    // survive one either. Not one of the "vacuum-green" trio named in the
    // fix task, but the identical reset class, so pinned alongside them.
    it("cd /tmp/repoD && pushd /tmp/other && git status -> null: pushd RESETS a real preceding basis", () => {
      const segs = segmentViewOf("cd /tmp/repoD && pushd /tmp/other && git status");
      expect(segs).not.toBeNull();
      expect(segs![0]!.effectiveTarget).toBe("/tmp/repoD");
      expect(segs![2]!.text).toBe("git status");
      expect(segs![2]!.effectiveTarget).toBe(null);
    });

    it("cd /tmp/repoD && popd && git status -> null: popd RESETS a real preceding basis", () => {
      const segs = segmentViewOf("cd /tmp/repoD && popd && git status");
      expect(segs).not.toBeNull();
      expect(segs![0]!.effectiveTarget).toBe("/tmp/repoD");
      expect(segs![2]!.text).toBe("git status");
      expect(segs![2]!.effectiveTarget).toBe(null);
    });

    // D-014: `cd -` (goes to `$OLDPWD`) is its own explicit member of the
    // reset list, distinct from "flagged cd" — pinned on its own.
    it("cd /tmp/repoD && cd - && git status -> null: 'cd -' RESETS a real preceding basis", () => {
      const segs = segmentViewOf("cd /tmp/repoD && cd - && git status");
      expect(segs).not.toBeNull();
      expect(segs![0]!.effectiveTarget).toBe("/tmp/repoD");
      expect(segs![2]!.text).toBe("git status");
      expect(segs![2]!.effectiveTarget).toBe(null);
    });

    it("VAR=value before cd -> narrower than the old aggregate's leadingCd on purpose (documented ceiling): not recognised, basis stays null", () => {
      const command = "A=1 cd /tmp/T && git status";
      expect(normalizeCommand(command).targetDir).toBe("/tmp/T"); // pre-existing aggregate DOES resolve this one
      const segs = segmentViewOf(command);
      expect(segs).not.toBeNull();
      expect(segs![0]!.ownTarget).toBe(null);
      expect(segs![1]!.effectiveTarget).toBe(null);
    });
  });

  describe("truncated (> MAX_NORMALIZE_LENGTH) -> null, not an array", () => {
    it("returns null above the length bound", () => {
      const oversized = "git status " + "x".repeat(MAX_NORMALIZE_LENGTH);
      expect(oversized.length).toBeGreaterThan(MAX_NORMALIZE_LENGTH);
      expect(segmentViewOf(oversized)).toBe(null);
    });

    it("does not truncate at exactly the bound", () => {
      const atBound = "git status " + "x".repeat(MAX_NORMALIZE_LENGTH - "git status ".length);
      expect(atBound.length).toBe(MAX_NORMALIZE_LENGTH);
      expect(segmentViewOf(atBound)).not.toBeNull();
    });
  });

  describe("empty / non-string input -> [] (never null, null is reserved for truncation)", () => {
    it("empty string", () => {
      expect(segmentViewOf("")).toEqual([]);
    });

    it("non-string input", () => {
      expect(segmentViewOf(null as unknown as string)).toEqual([]);
      expect(segmentViewOf(undefined as unknown as string)).toEqual([]);
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
      "cd",
      "cd -P /tmp/x",
    ];
    for (const command of malformed) {
      it(`does not throw on ${JSON.stringify(command.slice(0, 40))}`, () => {
        expect(() => segmentViewOf(command)).not.toThrow();
      });
    }
  });

  // O(length): the length-bound test above already exercises the largest
  // permitted input; this pins that a large, many-segment command still
  // returns promptly, mirroring `normalizeCommand`'s own F3 perf guard —
  // `computeSegmentTarget`'s extra per-segment work is O(1) additional
  // work inside the SAME walk, not a second pass over the string.
  describe("O(length): bounded cost, no additional pass", () => {
    it("a >=100KB adversarial command (many segments, one boundary kind that never occurs) stays under a fixed time budget", () => {
      const segment = "cd /tmp/x;";
      const command = segment.repeat(Math.floor(MAX_NORMALIZE_LENGTH / segment.length));
      expect(command.length).toBeGreaterThanOrEqual(MAX_NORMALIZE_LENGTH - 10);
      expect(command).not.toContain("(");

      const start = process.hrtime.bigint();
      segmentViewOf(command);
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
      expect(elapsedMs).toBeLessThan(300);
    });
  });

  // amp-aware pass stays target-free: the type-level pin
  // (`AmpAwareNormalizedCommand` has exactly `{normalized, truncated}`,
  // asserted in the "return type carries no targetDir/targetBase" describe
  // block above) is untouched by this task — `segmentViewOf` offers no
  // amp-aware variant at all, so there is nothing new to pin here beyond
  // that existing guard staying green.

  describe("existing behaviour is unaffected (spot-check: normalizeCommand's aggregate is untouched by this task)", () => {
    it("targetDir extraction still resolves the pre-existing forms exactly as before", () => {
      expect(normalizeCommand("env -C /tmp/repoA git status").targetDir).toBe("/tmp/repoA");
      expect(normalizeCommand("git -C /tmp/repoB status").targetDir).toBe("/tmp/repoB");
      expect(normalizeCommand("cd /tmp/repoD && git status").targetDir).toBe("/tmp/repoD");
      expect(normalizeCommand("cd /tmp/T && git -C sub status").targetDir).toBe("sub");
      expect(normalizeCommand("cd /tmp/T && git -C sub status").targetBase).toBe("/tmp/T");
    });

    it("G1 non-git-segment ambiguity is still null, unaffected by the new per-segment cd-basis tracking", () => {
      expect(
        normalizeCommand("git -C /tmp/repoB rev-parse HEAD && gh pr merge 123").targetDir,
      ).toBe(null);
    });
  });
});
