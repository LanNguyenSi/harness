import { describe, expect, it } from "vitest";
import { parseBashPrefix } from "../../src/runtime/bash-prefix-parse.js";

describe("parseBashPrefix", () => {
  describe("inline env", () => {
    it("parses a single VAR=value prefix", () => {
      const r = parseBashPrefix("DATABASE_URL=postgres://prod terraform destroy");
      expect(r.inlineEnv).toEqual({ DATABASE_URL: "postgres://prod" });
      expect(r.cdTarget).toBe(null);
    });

    it("parses multiple chained assignments", () => {
      const r = parseBashPrefix("A=1 B=2 C=3 ./run");
      expect(r.inlineEnv).toEqual({ A: "1", B: "2", C: "3" });
    });

    it("supports single-quoted values verbatim", () => {
      const r = parseBashPrefix("URL='postgres://prod-host/db?x=y' cmd");
      expect(r.inlineEnv).toEqual({ URL: "postgres://prod-host/db?x=y" });
    });

    it("supports double-quoted values without $ interpolation", () => {
      const r = parseBashPrefix('URL="postgres://prod-host/$x" cmd');
      expect(r.inlineEnv).toEqual({ URL: "postgres://prod-host/$x" });
    });

    it("returns empty when the command does not start with VAR=", () => {
      const r = parseBashPrefix("terraform destroy");
      expect(r.inlineEnv).toEqual({});
    });

    it("bails cleanly on an unterminated quoted value", () => {
      const r = parseBashPrefix("URL='unterminated terraform destroy");
      expect(r.inlineEnv).toEqual({});
    });

    it("accepts tab-separated assignments and empty values", () => {
      const r = parseBashPrefix("A=\tB= C=v\tcmd");
      expect(r.inlineEnv).toEqual({ A: "", B: "", C: "v" });
    });
  });

  describe("cd prefix", () => {
    it("parses cd <abs-path> && rest", () => {
      const r = parseBashPrefix("cd /tmp/risk-gate-test && terraform destroy");
      expect(r.cdTarget).toBe("/tmp/risk-gate-test");
    });

    it("parses cd <path>; rest", () => {
      const r = parseBashPrefix("cd /tmp/x; terraform destroy");
      expect(r.cdTarget).toBe("/tmp/x");
    });

    it("supports quoted paths with spaces", () => {
      const r = parseBashPrefix('cd "/tmp/risk gate" && terraform destroy');
      expect(r.cdTarget).toBe("/tmp/risk gate");
    });

    it("returns null when cd is missing the separator", () => {
      const r = parseBashPrefix("cd /tmp/risk-gate-test terraform destroy");
      expect(r.cdTarget).toBe(null);
    });

    it("does not match commands that merely START with 'cd' (cdex, cd&&)", () => {
      expect(parseBashPrefix("cdex /tmp && rm").cdTarget).toBe(null);
      expect(parseBashPrefix("cd&& rm").cdTarget).toBe(null);
    });

    it("does not match pushd (out of scope in v1)", () => {
      expect(parseBashPrefix("pushd /tmp/x && rm").cdTarget).toBe(null);
    });
  });

  describe("git switch/checkout branch (task 341e024b)", () => {
    it("parses `git switch <branch> && rest`", () => {
      const r = parseBashPrefix("git switch main && rm -rf /tmp/x");
      expect(r.branchTarget).toBe("main");
    });

    it("parses `git checkout <branch> && rest`", () => {
      const r = parseBashPrefix("git checkout main && rm -rf /tmp/x");
      expect(r.branchTarget).toBe("main");
    });

    it("parses `git switch <branch>; rest` (semicolon separator)", () => {
      const r = parseBashPrefix("git switch main; rm -rf /tmp/x");
      expect(r.branchTarget).toBe("main");
    });

    it("supports slashed branch names", () => {
      const r = parseBashPrefix("git switch task/foo && rm -rf /tmp/x");
      expect(r.branchTarget).toBe("task/foo");
    });

    it("skips an optional leading `-C <path>`", () => {
      const r = parseBashPrefix("git -C /some/repo switch main && rm -rf /tmp/x");
      expect(r.branchTarget).toBe("main");
    });

    it("does not treat `git checkout -- <path>` (file restore) as a branch signal", () => {
      const r = parseBashPrefix("git checkout -- src/foo.ts && rm -rf /tmp/x");
      expect(r.branchTarget).toBe(null);
    });

    it("does not guess a `$VAR` branch name", () => {
      const r = parseBashPrefix("git switch $BRANCH && rm -rf /tmp/x");
      expect(r.branchTarget).toBe(null);
    });

    it("does not guess a `${VAR}` branch name", () => {
      const r = parseBashPrefix("git switch ${BRANCH} && rm -rf /tmp/x");
      expect(r.branchTarget).toBe(null);
    });

    it("does not guess `git checkout -` (previous branch)", () => {
      const r = parseBashPrefix("git checkout - && rm -rf /tmp/x");
      expect(r.branchTarget).toBe(null);
    });

    it("does not guess a branch-creation flag as a branch name", () => {
      expect(parseBashPrefix("git switch -c newbranch && rm").branchTarget).toBe(null);
      expect(parseBashPrefix("git checkout -b newbranch && rm").branchTarget).toBe(null);
    });

    it("returns null when the separator is missing (nothing to gate)", () => {
      const r = parseBashPrefix("git switch main rm -rf /tmp/x");
      expect(r.branchTarget).toBe(null);
    });

    it("does not match commands that merely START with 'git' (github, gitk)", () => {
      expect(parseBashPrefix("github switch main && rm").branchTarget).toBe(null);
      expect(parseBashPrefix("gitk switch main && rm").branchTarget).toBe(null);
    });

    it("does not match a bare 'checkout'/'switch' without a leading 'git'", () => {
      expect(parseBashPrefix("switch main && rm").branchTarget).toBe(null);
      expect(parseBashPrefix("checkout main && rm").branchTarget).toBe(null);
    });

    // Fix round 1 (reviewer MEDIUM finding, task 341e024b): a quoted
    // branch name used to be read INCLUDING the quote characters
    // (`branchTarget` = the 6-char string `"main"`), which never matches
    // a `branch_patterns` entry like `main` and silently defeated the
    // gate. The quoted forms must now strip the quotes.
    it("strips double quotes from a quoted branch literal", () => {
      const r = parseBashPrefix('git switch "main" && rm -rf /tmp/x');
      expect(r.branchTarget).toBe("main");
    });

    it("strips single quotes from a quoted branch literal", () => {
      const r = parseBashPrefix("git switch 'main' && rm -rf /tmp/x");
      expect(r.branchTarget).toBe("main");
    });

    it("strips quotes from a quoted branch literal with `git checkout`", () => {
      expect(parseBashPrefix('git checkout "main" && rm -rf /tmp/x').branchTarget).toBe(
        "main",
      );
      expect(parseBashPrefix("git checkout 'main' && rm -rf /tmp/x").branchTarget).toBe(
        "main",
      );
    });

    it("strips quotes from a quoted, slashed branch literal", () => {
      expect(parseBashPrefix('git switch "task/foo" && rm').branchTarget).toBe("task/foo");
      expect(parseBashPrefix("git switch 'task/foo' && rm").branchTarget).toBe("task/foo");
    });

    it("handles a quoted branch literal after a leading `-C <path>`", () => {
      const r = parseBashPrefix('git -C /some/repo switch "main" && rm -rf /tmp/x');
      expect(r.branchTarget).toBe("main");
    });

    it("does not guess a `$VAR` branch name inside double quotes", () => {
      expect(parseBashPrefix('git switch "$BRANCH" && rm').branchTarget).toBe(null);
      expect(parseBashPrefix('git switch "${BRANCH}" && rm').branchTarget).toBe(null);
      expect(parseBashPrefix('git switch "release/$X" && rm').branchTarget).toBe(null);
    });

    it("takes a `$`-containing single-quoted branch literally (single quotes never interpolate)", () => {
      // Deliberately different from the double-quoted case above: real
      // bash never interpolates inside single quotes, so the literal
      // text — however unusual as a branch name — is exactly what git
      // would receive. It simply will not match a normal
      // `branch_patterns` entry.
      expect(parseBashPrefix("git switch '$BRANCH' && rm").branchTarget).toBe("$BRANCH");
    });

    it("bails cleanly on an unterminated quoted branch literal", () => {
      expect(parseBashPrefix("git switch \"main && rm -rf /tmp/x").branchTarget).toBe(null);
      expect(parseBashPrefix("git switch 'main && rm -rf /tmp/x").branchTarget).toBe(null);
    });

    it("does not match an empty quoted branch literal", () => {
      expect(parseBashPrefix('git switch "" && rm').branchTarget).toBe(null);
      expect(parseBashPrefix("git switch '' && rm").branchTarget).toBe(null);
    });

    it("requires the trailing separator for a quoted branch literal too", () => {
      expect(parseBashPrefix('git switch "main" rm -rf /tmp/x').branchTarget).toBe(null);
    });

    it("captures only the first branch target across a chained double switch (first-switch-wins, documented limit)", () => {
      // Deliberately NOT resolving the second switch — see the module
      // doc's "LIMIT" note on `consumeLeadingGitSwitch`. This pins the
      // current (first-wins) behavior so a future change to it is a
      // conscious, reviewed decision rather than an accidental drift.
      const r = parseBashPrefix("git switch dev && git switch main && rm -rf /tmp/x");
      expect(r.branchTarget).toBe("dev");
    });
  });

  describe("combined prefixes", () => {
    it("parses inline-env then cd in either order", () => {
      const a = parseBashPrefix("A=1 cd /tmp/x && terraform destroy");
      expect(a.inlineEnv).toEqual({ A: "1" });
      expect(a.cdTarget).toBe("/tmp/x");

      const b = parseBashPrefix("cd /tmp/x && A=1 terraform destroy");
      expect(b.inlineEnv).toEqual({ A: "1" });
      expect(b.cdTarget).toBe("/tmp/x");
    });

    it("captures inline-env even when a later cd does not parse", () => {
      const r = parseBashPrefix("A=1 cd /tmp/x terraform");
      expect(r.inlineEnv).toEqual({ A: "1" });
      expect(r.cdTarget).toBe(null);
    });

    it("captures only the first cd target", () => {
      const r = parseBashPrefix("cd /tmp/x && cd /tmp/y && rm");
      expect(r.cdTarget).toBe("/tmp/x");
    });

    it("parses a leading cd followed by a git switch (both candidates)", () => {
      const r = parseBashPrefix("cd /tmp/x && git switch main && rm -rf /tmp/x");
      expect(r.cdTarget).toBe("/tmp/x");
      expect(r.branchTarget).toBe("main");
    });
  });

  describe("degenerate input", () => {
    it("returns empty for empty / whitespace-only command", () => {
      expect(parseBashPrefix("")).toEqual({
        inlineEnv: {},
        cdTarget: null,
        branchTarget: null,
        remainderStart: 0,
      });
      expect(parseBashPrefix("   \t  ")).toEqual({
        inlineEnv: {},
        cdTarget: null,
        branchTarget: null,
        // Pure whitespace is fully consumed by the inline-env skip pass
        // even though it finds no VAR=value token, so the remainder starts
        // at the end of the string, not 0.
        remainderStart: 6,
      });
    });

    it("returns empty for non-string input", () => {
      // @ts-expect-error testing runtime guard
      expect(parseBashPrefix(undefined)).toEqual({
        inlineEnv: {},
        cdTarget: null,
        branchTarget: null,
        remainderStart: 0,
      });
      // @ts-expect-error testing runtime guard
      expect(parseBashPrefix(null)).toEqual({
        inlineEnv: {},
        cdTarget: null,
        branchTarget: null,
        remainderStart: 0,
      });
    });
  });

  describe("remainderStart (task a7eb1a71)", () => {
    it("is 0 when no prefix clause matches", () => {
      expect(parseBashPrefix("terraform destroy").remainderStart).toBe(0);
    });

    it("points right after a consumed cd prefix", () => {
      const cmd = "cd /tmp && kubectl delete namespace payments";
      const r = parseBashPrefix(cmd);
      expect(cmd.slice(r.remainderStart)).toBe("kubectl delete namespace payments");
    });

    it("points right after a consumed inline-env prefix", () => {
      const cmd = "KUBECONFIG=/tmp/k kubectl delete namespace payments";
      const r = parseBashPrefix(cmd);
      expect(cmd.slice(r.remainderStart)).toBe("kubectl delete namespace payments");
    });

    it("points right after both a cd and an inline-env prefix, in either order", () => {
      const a = "cd /tmp && KUBECONFIG=/tmp/k kubectl delete namespace payments";
      const b = "KUBECONFIG=/tmp/k cd /tmp && kubectl delete namespace payments";
      expect(a.slice(parseBashPrefix(a).remainderStart)).toBe("kubectl delete namespace payments");
      expect(b.slice(parseBashPrefix(b).remainderStart)).toBe("kubectl delete namespace payments");
    });

    it("points right after a consumed cd prefix with a quoted path", () => {
      const cmd = 'cd "/tmp/risk gate" && kubectl delete namespace payments';
      const r = parseBashPrefix(cmd);
      expect(cmd.slice(r.remainderStart)).toBe("kubectl delete namespace payments");
    });

    it("points right after a consumed git switch prefix", () => {
      const cmd = "git switch main && kubectl delete namespace payments";
      const r = parseBashPrefix(cmd);
      expect(cmd.slice(r.remainderStart)).toBe("kubectl delete namespace payments");
    });
  });
});
